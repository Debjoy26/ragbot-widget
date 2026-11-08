-- 012: P6 data layer for the ingestion worker (status 3a item ae; plan P6).
-- Forward-only: 001-011 are never edited. Everything here is SECURITY INVOKER with an empty search_path and
-- lock_timeout = '2s', EXECUTE for service_role only (the worker role). Nothing here is callable from a browser.
-- SQLSTATEs (existing contract): RB010 document unknown or deleted, RB011 activation refused (from
-- activate_document_version), RB013 lease not held (the job fence), RB030 wrong state, RB036 policy missing,
-- 22023 bad argument.
--
-- THE FENCE. A worker writes only while it still owns the job. Every function marked "fenced" first checks, in
-- public.index_job_fence: the job exists, state = 'running', locked_by = the caller, locked_until is still in the
-- future (checked against the wall clock, not the transaction start, so a call that waited for a lock cannot pass
-- on an old lease), type = 'index_document', and the payload names this version (and this version's document when
-- the payload names one). Any miss is RB013. Then the document must not be deleted (RB010). A worker whose lease
-- ran out, a worker of another job, a terminal job and a job of another type or version all stop at the fence.
--
-- LOCK ORDER for everything below (the same as the admin functions of 009, which lock the document first):
--   1. documents row  (FOR NO KEY UPDATE; activate_document_version takes FOR UPDATE on the same row)
--   2. jobs row       (FOR SHARE in the fence; the UPDATE in retry_job_later)
--   3. document_versions row (FOR UPDATE)
-- complete_job, fail_job, heartbeat_job and claim_jobs (004) take only the job row, so they cannot close a cycle.
-- retry_job_later reads the job unlocked first to learn the document, then locks in the order above.
--
-- State machine (board contract): document_versions.status uploaded -> extracting -> embedding -> ready (ready only
-- through activate_version_for_job); any active state -> failed with a failure_code. documents.status becomes
-- 'failed' only when the document has no active version; a ready document stays ready.

-- ---------------------------------------------------------------------------
-- Pending uploads are looked up by age (expire_abandoned_uploads); a partial index keeps that scan small.
-- ---------------------------------------------------------------------------
create index document_versions_pending_upload_idx on public.document_versions (created_at)
  where status = 'pending_upload';

-- ---------------------------------------------------------------------------
-- index_job_fence: the fence above. Locks the document (NO KEY UPDATE) and the job (SHARE) and returns the
-- bot and document of the version. Granted to service_role only, like the functions that call it; it changes
-- nothing, it only takes locks and raises.
-- ---------------------------------------------------------------------------
create function public.index_job_fence(p_job_id uuid, p_worker text, p_version_id uuid)
returns table (bot_id uuid, document_id uuid)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_doc_id  uuid;
  v_bot_id  uuid;
  v_deleted timestamptz;
  v_job     public.jobs%rowtype;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' or p_version_id is null then
    raise exception 'index_job_fence: job, worker and version are required' using errcode = '22023';
  end if;

  select v.document_id into v_doc_id from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'index job: lease not held' using errcode = 'RB013';
  end if;

  perform 1 from public.documents d where d.id = v_doc_id for no key update;
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  if not found
     or v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp()
     or v_job.type <> 'index_document'
     or (v_job.payload ->> 'version_id') is distinct from p_version_id::text
     or ((v_job.payload ? 'document_id') and (v_job.payload ->> 'document_id') is distinct from v_doc_id::text) then
    raise exception 'index job: lease not held' using errcode = 'RB013';
  end if;

  select d.bot_id, d.deleted_at into v_bot_id, v_deleted from public.documents d where d.id = v_doc_id;
  if not found or v_deleted is not null then
    raise exception 'index job: document not found or deleted' using errcode = 'RB010';
  end if;

  return query select v_bot_id, v_doc_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_index_job_context: everything the worker needs to start, in one row. Fenced.
-- embedding_model is the bot's current model (what the worker must embed with). max_bytes and max_pages come
-- from upload_policy and fail closed (RB036) when missing or out of range, like the admin functions.
-- ---------------------------------------------------------------------------
create function public.get_index_job_context(p_job_id uuid, p_worker text, p_version_id uuid)
returns table (
  bot_id                uuid,
  document_id           uuid,
  version_id            uuid,
  version_number        integer,
  status                text,
  storage_path          text,
  media_type            text,
  byte_size             bigint,
  upload_etag           text,
  embedding_model       text,
  max_bytes             bigint,
  max_pages             bigint,
  active_version_id     uuid,
  active_version_number integer
)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_bot     uuid;
  v_doc     uuid;
  v_ver     public.document_versions%rowtype;
  v_active  uuid;
  v_act_num integer;
  v_model   text;
  v_policy  jsonb;
  v_bytes   bigint;
  v_pages   bigint;
begin
  select f.bot_id, f.document_id into v_bot, v_doc from public.index_job_fence(p_job_id, p_worker, p_version_id) f;

  select * into v_ver from public.document_versions v where v.id = p_version_id for update;
  select d.active_version_id into v_active from public.documents d where d.id = v_doc;
  if v_active is not null then
    select x.version_number into v_act_num from public.document_versions x where x.id = v_active;
  end if;
  select b.embedding_model into v_model from public.bot_profiles b where b.id = v_bot;

  select cs.upload_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot;
  if not found or v_policy is null
     or jsonb_typeof(v_policy -> 'max_bytes') is distinct from 'number' or (v_policy ->> 'max_bytes') !~ '^[0-9]{1,15}$'
     or jsonb_typeof(v_policy -> 'max_pages') is distinct from 'number' or (v_policy ->> 'max_pages') !~ '^[0-9]{1,15}$' then
    raise exception 'upload policy max_bytes and max_pages are missing or invalid' using errcode = 'RB036';
  end if;
  v_bytes := (v_policy ->> 'max_bytes')::bigint;
  v_pages := (v_policy ->> 'max_pages')::bigint;
  if v_bytes < 1 or v_bytes > 1099511627776 or v_pages < 1 or v_pages > 1000000 then
    raise exception 'upload policy max_bytes or max_pages is out of range' using errcode = 'RB036';
  end if;

  return query select v_bot, v_doc, v_ver.id, v_ver.version_number, v_ver.status, v_ver.storage_path, v_ver.media_type,
                      v_ver.byte_size, v_ver.upload_etag, v_model, v_bytes, v_pages, v_active, v_act_num;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_version_progress: a patch of allowed keys only. Fenced. The version must be in an active state
-- (uploaded, extracting, embedding), else RB030. status moves forward only (the same status is a no-op);
-- a backward move, an unknown key or a bad value is 22023. batches_done may not exceed batches_total.
-- ---------------------------------------------------------------------------
create function public.update_version_progress(p_job_id uuid, p_worker text, p_version_id uuid, p_patch jsonb)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_ver     public.document_versions%rowtype;
  v_status  text;
  v_done    integer;
  v_total   integer;
  v_sum     text;
  v_method  text;
  v_xver    text;
  v_cver    text;
  v_model   text;
  v_cur     integer;
  v_new     integer;
begin
  perform 1 from public.index_job_fence(p_job_id, p_worker, p_version_id);

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'update_version_progress: a non-empty patch object is required' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k
              where k <> all (array['status', 'batches_done', 'batches_total', 'checksum', 'extraction_method',
                                    'extraction_version', 'chunking_version', 'embedding_model'])) then
    raise exception 'update_version_progress: unknown key in patch' using errcode = '22023';
  end if;

  select * into v_ver from public.document_versions v where v.id = p_version_id for update;
  if v_ver.status not in ('uploaded', 'extracting', 'embedding') then
    raise exception 'update_version_progress: version is not being indexed' using errcode = 'RB030';
  end if;

  if p_patch ? 'status' then
    if jsonb_typeof(p_patch -> 'status') is distinct from 'string' or (p_patch ->> 'status') not in ('extracting', 'embedding') then
      raise exception 'update_version_progress: status must be extracting or embedding' using errcode = '22023';
    end if;
    v_status := p_patch ->> 'status';
    v_cur := case v_ver.status when 'uploaded' then 1 when 'extracting' then 2 else 3 end;
    v_new := case v_status when 'extracting' then 2 else 3 end;
    if v_new < v_cur then
      raise exception 'update_version_progress: status cannot move backward' using errcode = '22023';
    end if;
  end if;
  if p_patch ? 'batches_done' then
    if jsonb_typeof(p_patch -> 'batches_done') is distinct from 'number' or (p_patch ->> 'batches_done') !~ '^[0-9]{1,9}$' then
      raise exception 'update_version_progress: batches_done must be a non-negative integer' using errcode = '22023';
    end if;
    v_done := (p_patch ->> 'batches_done')::integer;
  end if;
  if p_patch ? 'batches_total' then
    if jsonb_typeof(p_patch -> 'batches_total') is distinct from 'number' or (p_patch ->> 'batches_total') !~ '^[0-9]{1,9}$' then
      raise exception 'update_version_progress: batches_total must be a non-negative integer' using errcode = '22023';
    end if;
    v_total := (p_patch ->> 'batches_total')::integer;
  end if;
  if coalesce(v_done, v_ver.batches_done) is not null and coalesce(v_total, v_ver.batches_total) is not null
     and coalesce(v_done, v_ver.batches_done) > coalesce(v_total, v_ver.batches_total) then
    raise exception 'update_version_progress: batches_done cannot exceed batches_total' using errcode = '22023';
  end if;
  if p_patch ? 'checksum' then
    if jsonb_typeof(p_patch -> 'checksum') is distinct from 'string' or (p_patch ->> 'checksum') !~ '^[0-9a-f]{64}$' then
      raise exception 'update_version_progress: checksum must be 64 lowercase hex characters' using errcode = '22023';
    end if;
    v_sum := p_patch ->> 'checksum';
  end if;
  if p_patch ? 'extraction_method' then
    if jsonb_typeof(p_patch -> 'extraction_method') is distinct from 'string'
       or (p_patch ->> 'extraction_method') not in ('pdf_text', 'markdown', 'plain_text') then
      raise exception 'update_version_progress: unknown extraction_method' using errcode = '22023';
    end if;
    v_method := p_patch ->> 'extraction_method';
  end if;
  if p_patch ? 'extraction_version' then
    if jsonb_typeof(p_patch -> 'extraction_version') is distinct from 'string'
       or char_length(p_patch ->> 'extraction_version') not between 1 and 64 then
      raise exception 'update_version_progress: extraction_version must be 1..64 characters' using errcode = '22023';
    end if;
    v_xver := p_patch ->> 'extraction_version';
  end if;
  if p_patch ? 'chunking_version' then
    if jsonb_typeof(p_patch -> 'chunking_version') is distinct from 'string'
       or char_length(p_patch ->> 'chunking_version') not between 1 and 64 then
      raise exception 'update_version_progress: chunking_version must be 1..64 characters' using errcode = '22023';
    end if;
    v_cver := p_patch ->> 'chunking_version';
  end if;
  if p_patch ? 'embedding_model' then
    if jsonb_typeof(p_patch -> 'embedding_model') is distinct from 'string'
       or char_length(p_patch ->> 'embedding_model') not between 1 and 200 then
      raise exception 'update_version_progress: embedding_model must be 1..200 characters' using errcode = '22023';
    end if;
    v_model := p_patch ->> 'embedding_model';
  end if;

  update public.document_versions v
     set status            = coalesce(v_status, v.status),
         batches_done      = coalesce(v_done, v.batches_done),
         batches_total     = coalesce(v_total, v.batches_total),
         checksum          = coalesce(v_sum, v.checksum),
         extraction_method = coalesce(v_method, v.extraction_method),
         extraction_version = coalesce(v_xver, v.extraction_version),
         chunking_version  = coalesce(v_cver, v.chunking_version),
         embedding_model   = coalesce(v_model, v.embedding_model)
   where v.id = p_version_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- write_document_chunks: one batch of chunks with their embeddings. Fenced; the version must be 'embedding'
-- (RB030). p_chunks is an array of 1..200 objects {chunk_index, content, token_count, page_number, section,
-- metadata, embedding}; embedding is an array of exactly 1536 numbers. Anything else is 22023 and nothing is
-- written. Idempotent: an upsert on (document_version_id, chunk_index), so repeating a batch changes nothing.
-- Returns the number of chunks written.
-- ---------------------------------------------------------------------------
create function public.write_document_chunks(p_job_id uuid, p_worker text, p_version_id uuid, p_chunks jsonb)
returns integer
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_status text;
  v_n      integer;
  v_e      jsonb;
  v_emb    jsonb;
begin
  perform 1 from public.index_job_fence(p_job_id, p_worker, p_version_id);

  select v.status into v_status from public.document_versions v where v.id = p_version_id for update;
  if v_status <> 'embedding' then
    raise exception 'write_document_chunks: version status must be embedding' using errcode = 'RB030';
  end if;

  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'write_document_chunks: chunks must be a JSON array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_chunks);
  if v_n < 1 or v_n > 200 then
    raise exception 'write_document_chunks: between 1 and 200 chunks per call' using errcode = '22023';
  end if;

  -- Bounded loop: at most 200 elements.
  for i in 0 .. v_n - 1 loop
    v_e := p_chunks -> i;
    if jsonb_typeof(v_e) is distinct from 'object' then
      raise exception 'write_document_chunks: each chunk must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'chunk_index') is distinct from 'number' or (v_e ->> 'chunk_index') !~ '^[0-9]{1,9}$' then
      raise exception 'write_document_chunks: chunk_index must be a non-negative integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'content') is distinct from 'string' or char_length(v_e ->> 'content') not between 1 and 100000 then
      raise exception 'write_document_chunks: content must be 1..100000 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'token_count') in ('number') and (v_e ->> 'token_count') !~ '^[0-9]{1,9}$' then
      raise exception 'write_document_chunks: token_count must be a non-negative integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'token_count') is not null and jsonb_typeof(v_e -> 'token_count') not in ('number', 'null') then
      raise exception 'write_document_chunks: token_count must be a non-negative integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') = 'number' and (v_e ->> 'page_number') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'write_document_chunks: page_number must be a positive integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') is not null and jsonb_typeof(v_e -> 'page_number') not in ('number', 'null') then
      raise exception 'write_document_chunks: page_number must be a positive integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') is not null and jsonb_typeof(v_e -> 'section') not in ('string', 'null') then
      raise exception 'write_document_chunks: section must be text' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') = 'string' and char_length(v_e ->> 'section') > 500 then
      raise exception 'write_document_chunks: section is longer than 500 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'metadata') is not null and jsonb_typeof(v_e -> 'metadata') not in ('object', 'null') then
      raise exception 'write_document_chunks: metadata must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'metadata') = 'object' and octet_length((v_e -> 'metadata')::text) > 20000 then
      raise exception 'write_document_chunks: metadata is larger than 20000 bytes' using errcode = '22023';
    end if;
    v_emb := v_e -> 'embedding';
    if jsonb_typeof(v_emb) is distinct from 'array' or jsonb_array_length(v_emb) <> 1536 then
      raise exception 'write_document_chunks: embedding must be an array of 1536 numbers' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_emb) x where jsonb_typeof(x) <> 'number') then
      raise exception 'write_document_chunks: embedding must contain numbers only' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (x ->> 'chunk_index')::integer) from jsonb_array_elements(p_chunks) x) <> v_n then
    raise exception 'write_document_chunks: duplicate chunk_index in one call' using errcode = '22023';
  end if;

  insert into public.document_chunks as c
    (document_version_id, chunk_index, content, token_count, page_number, section, metadata, embedding)
  select p_version_id,
         (x ->> 'chunk_index')::integer,
         x ->> 'content',
         (x ->> 'token_count')::integer,
         (x ->> 'page_number')::integer,
         x ->> 'section',
         case when jsonb_typeof(x -> 'metadata') = 'object' then x -> 'metadata' else '{}'::jsonb end,
         (x -> 'embedding')::text::extensions.vector(1536)
    from jsonb_array_elements(p_chunks) x
  on conflict (document_version_id, chunk_index) do update
     set content = excluded.content,
         token_count = excluded.token_count,
         page_number = excluded.page_number,
         section = excluded.section,
         metadata = excluded.metadata,
         embedding = excluded.embedding;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- activate_version_for_job: the fenced way to go live. Calls activate_document_version (all of its checks and
-- its RB011 for a version older than the active one). Returns the bot's corpus_version after activation.
-- ---------------------------------------------------------------------------
create function public.activate_version_for_job(p_job_id uuid, p_worker text, p_version_id uuid, p_expected_chunks integer)
returns bigint
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_doc    uuid;
  v_corpus bigint;
begin
  select f.document_id into v_doc from public.index_job_fence(p_job_id, p_worker, p_version_id) f;
  if p_expected_chunks is null or p_expected_chunks < 1 then
    raise exception 'activate_version_for_job: a positive expected chunk count is required' using errcode = '22023';
  end if;
  v_corpus := public.activate_document_version(v_doc, p_version_id, p_expected_chunks);
  return v_corpus;
end;
$$;

-- ---------------------------------------------------------------------------
-- fail_document_version: marks the version failed with a contract failure_code. Fenced. Chunks are kept.
-- Idempotent: an already failed version is left as it is (its first code stays). A ready or superseded version
-- cannot be failed (RB030). documents.status becomes 'failed' only when the document has no active version.
-- ---------------------------------------------------------------------------
create function public.fail_document_version(p_job_id uuid, p_worker text, p_version_id uuid, p_failure_code text)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_doc    uuid;
  v_status text;
begin
  select f.document_id into v_doc from public.index_job_fence(p_job_id, p_worker, p_version_id) f;
  if p_failure_code is null
     or p_failure_code not in ('FILE_UNSUPPORTED', 'OCR_REQUIRED', 'INDEXING_FAILED', 'BUDGET_EXCEEDED', 'SUPERSEDED') then
    raise exception 'fail_document_version: unknown failure code' using errcode = '22023';
  end if;

  select v.status into v_status from public.document_versions v where v.id = p_version_id for update;
  if v_status = 'failed' then
    return;
  end if;
  if v_status not in ('uploaded', 'extracting', 'embedding') then
    raise exception 'fail_document_version: version is not being indexed' using errcode = 'RB030';
  end if;

  update public.document_versions v
     set status = 'failed', failure_code = p_failure_code, completed_at = now()
   where v.id = p_version_id;
  update public.documents d set status = 'failed'
   where d.id = v_doc and d.active_version_id is null and d.status in ('draft', 'indexing');
end;
$$;

-- ---------------------------------------------------------------------------
-- retry_job_later: like fail_job (004), but the next attempt waits p_delay_seconds (1..3600). The caller must
-- still hold the job (state running, locked_by = worker; as in fail_job the lease time is not compared, so a
-- worker whose lease ran out but was not reclaimed can still hand the job back). On the last attempt the job
-- dead-letters ('failed'); for an index_document job the same call fails the version with INDEXING_FAILED
-- (only while it is still being indexed) and sets documents.status to 'failed' when there is no active version.
-- p_error_code is a short code (^[a-z0-9_]{1,64}$), never free text. Returns the resulting job state.
-- ---------------------------------------------------------------------------
create function public.retry_job_later(p_job_id uuid, p_worker text, p_error_code text, p_delay_seconds integer)
returns text
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_type    text;
  v_payload jsonb;
  v_doc     uuid;
  v_ver     uuid;
  v_state   text;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' then
    raise exception 'retry_job_later: job and worker id are required' using errcode = '22023';
  end if;
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'retry_job_later: error code must be 1..64 characters of a-z, 0-9 and _' using errcode = '22023';
  end if;
  if p_delay_seconds is null or p_delay_seconds < 1 or p_delay_seconds > 3600 then
    raise exception 'retry_job_later: delay must be between 1 and 3600 seconds' using errcode = '22023';
  end if;

  -- Learn the document without a lock, so the document can be locked before the job (lock order above).
  select j.type, j.payload into v_type, v_payload from public.jobs j where j.id = p_job_id;
  if not found then
    raise exception 'retry_job_later: lease not held' using errcode = 'RB013';
  end if;
  if v_type = 'index_document' then
    if (v_payload ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_doc := (v_payload ->> 'document_id')::uuid;
    end if;
    if (v_payload ->> 'version_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_ver := (v_payload ->> 'version_id')::uuid;
    end if;
    if v_doc is not null then
      perform 1 from public.documents d where d.id = v_doc for no key update;
    end if;
  end if;

  update public.jobs j
     set state = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         completed_at = case when j.attempts >= j.max_attempts then now() else null end,
         available_at = case when j.attempts >= j.max_attempts then j.available_at
                             else now() + make_interval(secs => p_delay_seconds) end,
         locked_until = null,
         locked_by = null,
         last_error = p_error_code
   where j.id = p_job_id and j.state = 'running' and j.locked_by = p_worker
  returning j.state into v_state;
  if not found then
    raise exception 'retry_job_later: lease not held' using errcode = 'RB013';
  end if;

  if v_state = 'failed' and v_type = 'index_document' and v_ver is not null and v_doc is not null then
    update public.document_versions v
       set status = 'failed', failure_code = 'INDEXING_FAILED', completed_at = now()
     where v.id = v_ver and v.document_id = v_doc and v.status in ('uploaded', 'extracting', 'embedding');
    if found then
      update public.documents d set status = 'failed'
       where d.id = v_doc and d.active_version_id is null and d.status in ('draft', 'indexing');
    end if;
  end if;

  return v_state;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_usage_event: one usage row for a provider call. Not fenced (the worker records spend even when it has
-- just lost its lease). operation must be one of the six table values; counts and cost non-negative.
-- p_job_id is optional; when given it must exist and, if its payload names a bot, name this bot.
-- ---------------------------------------------------------------------------
create function public.record_usage_event(
  p_bot_id         uuid,
  p_job_id         uuid,
  p_provider       text,
  p_model          text,
  p_operation      text,
  p_input_tokens   integer,
  p_estimated_cost numeric,
  p_latency_ms     integer
)
returns uuid
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_job_bot text;
  v_id      uuid;
begin
  if p_bot_id is null
     or p_operation is null
        or p_operation not in ('chat', 'embedding_query', 'embedding_index', 'moderation', 'analysis', 'answer_cache_hit')
     or p_input_tokens is null or p_input_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_provider is not null and char_length(p_provider) > 100)
     or (p_model is not null and char_length(p_model) > 200) then
    raise exception 'record_usage_event: bot, a known operation and non-negative counts are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'record_usage_event: bot not found' using errcode = '22023';
  end if;
  if p_job_id is not null then
    select j.payload ->> 'bot_id' into v_job_bot from public.jobs j where j.id = p_job_id;
    if not found or (v_job_bot is not null and v_job_bot <> p_bot_id::text) then
      raise exception 'record_usage_event: job not found for bot' using errcode = '22023';
    end if;
  end if;

  insert into public.usage_events (bot_id, job_id, provider, model, operation, input_tokens, estimated_cost, latency_ms)
  values (p_bot_id, p_job_id, p_provider, p_model, p_operation, p_input_tokens, p_estimated_cost, p_latency_ms)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- cleanup_document: deletes up to p_batch (1..1000) chunks of a DELETED document's versions per call.
-- Unknown document RB010; a live document RB030 (a live document's chunks are never touched here).
-- done = no chunk of the document is left. Version rows stay: cleanup_storage_targets reads their paths.
-- ---------------------------------------------------------------------------
create function public.cleanup_document(p_document_id uuid, p_batch integer)
returns table (deleted_chunks integer, done boolean)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_deleted timestamptz;
  v_n       integer;
  v_left    boolean;
begin
  if p_document_id is null or p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'cleanup_document: document and batch (1..1000) are required' using errcode = '22023';
  end if;
  select d.deleted_at into v_deleted from public.documents d where d.id = p_document_id;
  if not found then
    raise exception 'cleanup_document: document not found' using errcode = 'RB010';
  end if;
  if v_deleted is null then
    raise exception 'cleanup_document: the document is not deleted' using errcode = 'RB030';
  end if;

  delete from public.document_chunks c
   where c.id in (
     select x.id
       from public.document_chunks x
       join public.document_versions v on v.id = x.document_version_id
      where v.document_id = p_document_id
      limit p_batch
      for update of x skip locked);
  get diagnostics v_n = row_count;

  select exists (
    select 1 from public.document_chunks x
      join public.document_versions v on v.id = x.document_version_id
     where v.document_id = p_document_id) into v_left;

  return query select v_n, not v_left;
end;
$$;

-- ---------------------------------------------------------------------------
-- cleanup_storage_targets: the Storage paths of a DELETED document's versions that no version of a
-- non-deleted document references (reindex makes several versions share one path; 009 requires this rule).
-- Unknown document RB010; a live document RB030.
-- ---------------------------------------------------------------------------
create function public.cleanup_storage_targets(p_document_id uuid)
returns table (storage_path text)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_deleted timestamptz;
begin
  if p_document_id is null then
    raise exception 'cleanup_storage_targets: document is required' using errcode = '22023';
  end if;
  select d.deleted_at into v_deleted from public.documents d where d.id = p_document_id;
  if not found then
    raise exception 'cleanup_storage_targets: document not found' using errcode = 'RB010';
  end if;
  if v_deleted is null then
    raise exception 'cleanup_storage_targets: the document is not deleted' using errcode = 'RB030';
  end if;

  return query
  select distinct v.storage_path
    from public.document_versions v
   where v.document_id = p_document_id
     and not exists (
       select 1
         from public.document_versions o
         join public.documents od on od.id = o.document_id
        where o.storage_path = v.storage_path and od.deleted_at is null);
end;
$$;

-- ---------------------------------------------------------------------------
-- expire_abandoned_uploads: pending_upload versions older than p_older_than_hours (1..8760) become failed with
-- INDEXING_FAILED, at most p_batch (1..1000) per call, oldest first. Their documents are locked first (lock
-- order), and a document with no active version that was draft or indexing becomes failed. Returns the version
-- and its path so the worker can remove the object; a path another version still references is not returned.
-- ---------------------------------------------------------------------------
create function public.expire_abandoned_uploads(p_older_than_hours integer, p_batch integer)
returns table (version_id uuid, storage_path text)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
begin
  if p_older_than_hours is null or p_older_than_hours < 1 or p_older_than_hours > 8760
     or p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'expire_abandoned_uploads: hours (1..8760) and batch (1..1000) are required' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
    from (select v.id
            from public.document_versions v
           where v.status = 'pending_upload' and v.created_at < now() - make_interval(hours => p_older_than_hours)
           order by v.created_at, v.id
           limit p_batch) x;

  perform 1 from public.documents d
   where d.id in (select v.document_id from public.document_versions v where v.id = any (v_ids))
   order by d.id
     for no key update;

  return query
  with f as (
    update public.document_versions v
       set status = 'failed', failure_code = 'INDEXING_FAILED', completed_at = now()
     where v.id = any (v_ids) and v.status = 'pending_upload'
    returning v.id, v.document_id, v.storage_path
  ), d as (
    update public.documents dd set status = 'failed'
     where dd.id in (select f.document_id from f) and dd.active_version_id is null and dd.status in ('draft', 'indexing')
    returning dd.id
  )
  select f.id, f.storage_path
    from f
   where not exists (select 1 from public.document_versions o where o.storage_path = f.storage_path and o.id <> f.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- schema_version: raised with every migration (220 compares it with the migration history).
-- ---------------------------------------------------------------------------
create or replace function public.schema_version()
returns integer
language sql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
  select 12;
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE: service_role only. Postgres grants EXECUTE to PUBLIC on new functions by default; revoke it.
-- ---------------------------------------------------------------------------
revoke all on function public.index_job_fence(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.get_index_job_context(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.update_version_progress(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.write_document_chunks(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.activate_version_for_job(uuid, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.fail_document_version(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.retry_job_later(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.record_usage_event(uuid, uuid, text, text, text, integer, numeric, integer) from public, anon, authenticated;
revoke all on function public.cleanup_document(uuid, integer) from public, anon, authenticated;
revoke all on function public.cleanup_storage_targets(uuid) from public, anon, authenticated;
revoke all on function public.expire_abandoned_uploads(integer, integer) from public, anon, authenticated;

grant execute on function public.index_job_fence(uuid, text, uuid) to service_role;
grant execute on function public.get_index_job_context(uuid, text, uuid) to service_role;
grant execute on function public.update_version_progress(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.write_document_chunks(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.activate_version_for_job(uuid, text, uuid, integer) to service_role;
grant execute on function public.fail_document_version(uuid, text, uuid, text) to service_role;
grant execute on function public.retry_job_later(uuid, text, text, integer) to service_role;
grant execute on function public.record_usage_event(uuid, uuid, text, text, text, integer, numeric, integer) to service_role;
grant execute on function public.cleanup_document(uuid, integer) to service_role;
grant execute on function public.cleanup_storage_targets(uuid) to service_role;
grant execute on function public.expire_abandoned_uploads(integer, integer) to service_role;
