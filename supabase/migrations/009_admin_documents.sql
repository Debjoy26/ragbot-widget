-- 009: P3.5 admin data layer, part 1 (ADR 0017): documents, Storage policies, job-based budget.
-- Forward-only: 001-008 are never edited. Browser-callable functions are SECURITY DEFINER with an empty
-- search_path, EXECUTE for authenticated only, and start with public.admin_require(). Helpers are not
-- executable by any API role. Custom SQLSTATEs (all listed in the P3.5 contract):
--   RB030 conflict / wrong state   RB031 file too large   RB032 mfa required   RB033 forbidden
--   RB034 quota exceeded           RB036 policy missing   RB037 not found      RB038 upload missing

-- ---------------------------------------------------------------------------
-- Reindex reuses the active version's original, so several versions may share a storage_path.
-- Replace the unique constraint with a plain index (the Storage INSERT policy looks paths up).
-- P6 CLEANUP MUST delete an object only when no other document_versions row references its path.
-- ---------------------------------------------------------------------------
alter table public.document_versions drop constraint document_versions_storage_path_key;
create index document_versions_storage_path_idx on public.document_versions (storage_path);

-- ---------------------------------------------------------------------------
-- Job-based budget reservations: the worker has no request run, so a reservation may belong to a job
-- instead. Same table, same daily cap. A reservation belongs to a request or a job, never both
-- (neither is allowed: set null when the run or job is purged).
-- ---------------------------------------------------------------------------
alter table public.budget_reservations
  add column job_id uuid references public.jobs (id) on delete set null,
  add constraint budget_reservations_owner_check check (request_id is null or job_id is null);
-- One ACTIVE reservation per job. A settled, released or expired one stays as history, so a requeued job
-- (a new attempt) can reserve again and its new spend counts toward the daily cap.
create unique index budget_reservations_job_id_key on public.budget_reservations (job_id)
  where job_id is not null and state = 'reserved';

-- The object's eTag as Storage reported it when the upload was confirmed. P6 compares it with the object's current eTag before reading the original.
alter table public.document_versions add column upload_etag text;

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY INVOKER: they run as the definer RPC's owner. Not executable by any API role.
-- ---------------------------------------------------------------------------

-- Not an active member (or wrong role): RB033. Active member without an aal2 session: RB032.
create function public.admin_require(p_roles text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_active_member(p_roles) then
    raise exception 'not authorized' using errcode = 'RB033';
  end if;
  if not public.is_active_member_mfa(p_roles) then
    raise exception 'multi-factor session required' using errcode = 'RB032';
  end if;
end;
$$;

-- Appends an audit row for auth.uid(). Metadata keys come from a fixed allowlist and values must be
-- short scalars, so content (titles, text, file names) can never reach audit_logs through here.
create function public.admin_audit(p_action text, p_resource_type text, p_resource_id uuid, p_metadata jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_allowed text[] := array['bot_id', 'document_id', 'version_id', 'version_number', 'media_type', 'byte_size', 'kind'];
  v_key     text;
  v_val     jsonb;
begin
  if v_actor is null then
    raise exception 'admin_audit: no signed-in user' using errcode = 'RB033';
  end if;
  if p_action is null or p_action !~ '^[a-z_]+(\.[a-z_]+)*$' or char_length(p_action) > 64
     or p_resource_type is null or p_resource_type !~ '^[a-z_]+$' or char_length(p_resource_type) > 64 then
    raise exception 'admin_audit: invalid action or resource type' using errcode = '22023';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'admin_audit: metadata must be an object' using errcode = '22023';
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p_metadata) e loop
    if v_key <> all (v_allowed) then
      raise exception 'admin_audit: metadata key is not allowed' using errcode = '22023';
    end if;
    if jsonb_typeof(v_val) not in ('string', 'number', 'boolean', 'null')
       or (jsonb_typeof(v_val) = 'string' and char_length(v_val #>> '{}') > 200) then
      raise exception 'admin_audit: metadata values must be short scalars' using errcode = '22023';
    end if;
  end loop;
  insert into public.audit_logs (actor_user_id, action, resource_type, resource_id, safe_metadata)
  values (v_actor, p_action, p_resource_type, p_resource_id::text, p_metadata);
end;
$$;

-- Reads an integer from client_settings.upload_policy. Missing, non-numeric, fractional or out of
-- range: RB036 (fail closed, no defaults).
create function public.admin_policy_int(p_bot_id uuid, p_key text, p_min bigint, p_max bigint)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_val jsonb;
  v_n   bigint;
begin
  select cs.upload_policy -> p_key into v_val from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found or v_val is null or jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}') !~ '^[0-9]{1,15}$' then
    raise exception 'upload policy % is missing or invalid', p_key using errcode = 'RB036';
  end if;
  v_n := (v_val #>> '{}')::bigint;
  if v_n < p_min or v_n > p_max then
    raise exception 'upload policy % is out of range', p_key using errcode = 'RB036';
  end if;
  return v_n;
end;
$$;

-- Counts one call against upload_policy.quotas.<kind> ({"limit": n, "window_seconds": s}) for the bot.
-- Kinds: register, upload, reindex, and write (download request, document delete, settings, enable, conversation delete).
-- Missing or invalid quota: RB036. Over the limit: RB034 (which also rolls the count back).
create function public.admin_consume_quota(p_bot_id uuid, p_kind text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_q   jsonb;
  v_lim text;
  v_win text;
  v_key text;
  v_ok  boolean;
begin
  if p_bot_id is null or p_kind is null or p_kind not in ('register', 'upload', 'reindex', 'write') then
    raise exception 'admin_consume_quota: bot and a known quota kind are required' using errcode = '22023';
  end if;
  select cs.upload_policy -> 'quotas' -> p_kind into v_q from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found or v_q is null or jsonb_typeof(v_q) <> 'object' then
    raise exception 'quota % is missing', p_kind using errcode = 'RB036';
  end if;
  v_lim := case when jsonb_typeof(v_q -> 'limit') = 'number' then v_q ->> 'limit' end;
  v_win := case when jsonb_typeof(v_q -> 'window_seconds') = 'number' then v_q ->> 'window_seconds' end;
  if v_lim is null or v_lim !~ '^[1-9][0-9]{0,5}$' or v_win is null or v_win !~ '^[1-9][0-9]{0,4}$'
     or v_win::integer > 86400 then
    raise exception 'quota % is invalid', p_kind using errcode = 'RB036';
  end if;
  v_key := encode(sha256(convert_to('admin_quota:' || p_bot_id::text || ':' || p_kind, 'utf8')), 'hex');
  select r.allowed into v_ok from public.record_rate_limit_attempt(v_key, v_win::integer, v_lim::integer) r;
  if not coalesce(v_ok, false) then
    raise exception 'quota % exceeded', p_kind using errcode = 'RB034';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_register_document: new document plus version 1 with a generated storage path.
-- ---------------------------------------------------------------------------
create function public.admin_register_document(
  p_bot_id            uuid,
  p_title             text,
  p_media_type        text,
  p_byte_size         bigint,
  p_disclosure_policy text
)
returns table (document_id uuid, version_id uuid, storage_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_title text;
  v_max   bigint;
  v_doc   uuid := gen_random_uuid();
  v_ver   uuid := gen_random_uuid();
  v_path  text;
begin
  perform public.admin_require(array['owner', 'admin']);

  if p_bot_id is null or p_title is null or p_media_type is null or p_byte_size is null
     or p_disclosure_policy is null then
    raise exception 'admin_register_document: all arguments are required' using errcode = '22023';
  end if;
  v_title := btrim(p_title);
  if char_length(v_title) not between 1 and 200 or p_title ~ '[[:cntrl:]]' then
    raise exception 'admin_register_document: title must be 1..200 characters without control characters'
      using errcode = '22023';
  end if;
  if p_media_type not in ('application/pdf', 'text/markdown', 'text/plain') then
    raise exception 'admin_register_document: unsupported media type' using errcode = '22023';
  end if;
  if p_byte_size < 1 then
    raise exception 'admin_register_document: byte size must be positive' using errcode = '22023';
  end if;
  if p_disclosure_policy not in ('public_answer', 'excluded') then
    raise exception 'admin_register_document: invalid disclosure policy' using errcode = '22023';
  end if;

  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'admin_register_document: bot not found' using errcode = 'RB037';
  end if;
  v_max := public.admin_policy_int(p_bot_id, 'max_bytes', 1, 1099511627776);
  if p_byte_size > v_max then
    raise exception 'admin_register_document: file is larger than the upload limit' using errcode = 'RB031';
  end if;
  perform public.admin_consume_quota(p_bot_id, 'register');

  v_path := p_bot_id::text || '/' || v_doc::text || '/' || v_ver::text || '/original.'
    || case p_media_type when 'application/pdf' then 'pdf' when 'text/markdown' then 'md' else 'txt' end;

  insert into public.documents (id, bot_id, title, disclosure_policy, created_by)
  values (v_doc, p_bot_id, v_title, p_disclosure_policy, auth.uid());
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size)
  values (v_ver, v_doc, 1, v_path, p_media_type, p_byte_size);

  perform public.admin_audit('document.register', 'document', v_doc,
    jsonb_build_object('bot_id', p_bot_id, 'document_id', v_doc, 'version_id', v_ver,
                       'media_type', p_media_type, 'byte_size', p_byte_size));
  return query select v_doc, v_ver, v_path;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_add_document_version: next version of an existing document (B-1). The document row is locked,
-- so concurrent calls get distinct numbers.
-- ---------------------------------------------------------------------------
create function public.admin_add_document_version(
  p_document_id uuid,
  p_media_type  text,
  p_byte_size   bigint
)
returns table (version_id uuid, version_number integer, storage_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_doc  public.documents%rowtype;
  v_max  bigint;
  v_ver  uuid := gen_random_uuid();
  v_num  integer;
  v_path text;
begin
  perform public.admin_require(array['owner', 'admin']);

  if p_document_id is null or p_media_type is null or p_byte_size is null then
    raise exception 'admin_add_document_version: all arguments are required' using errcode = '22023';
  end if;
  if p_media_type not in ('application/pdf', 'text/markdown', 'text/plain') then
    raise exception 'admin_add_document_version: unsupported media type' using errcode = '22023';
  end if;
  if p_byte_size < 1 then
    raise exception 'admin_add_document_version: byte size must be positive' using errcode = '22023';
  end if;

  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_add_document_version: document not found' using errcode = 'RB037';
  end if;

  v_max := public.admin_policy_int(v_doc.bot_id, 'max_bytes', 1, 1099511627776);
  if p_byte_size > v_max then
    raise exception 'admin_add_document_version: file is larger than the upload limit' using errcode = 'RB031';
  end if;
  perform public.admin_consume_quota(v_doc.bot_id, 'register');

  select coalesce(max(x.version_number), 0) + 1 into v_num
    from public.document_versions x where x.document_id = p_document_id;
  v_path := v_doc.bot_id::text || '/' || p_document_id::text || '/' || v_ver::text || '/original.'
    || case p_media_type when 'application/pdf' then 'pdf' when 'text/markdown' then 'md' else 'txt' end;

  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size)
  values (v_ver, p_document_id, v_num, v_path, p_media_type, p_byte_size);

  perform public.admin_audit('document.add_version', 'document_version', v_ver,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id, 'version_id', v_ver,
                       'version_number', v_num, 'media_type', p_media_type, 'byte_size', p_byte_size));
  return query select v_ver, v_num, v_path;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_complete_upload: confirm the object exists, then queue indexing. Lock order is document, then
-- version (the same order as activation). Calling it again after the first success changes nothing.
-- ---------------------------------------------------------------------------
create function public.admin_complete_upload(p_version_id uuid)
returns table (version_id uuid, status text, job_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_doc_id   uuid;
  v_doc      public.documents%rowtype;
  v_ver      public.document_versions%rowtype;
  v_attempts bigint;
  v_max      bigint;
  v_meta     jsonb;
  v_size_txt text;
  v_size     bigint;
  v_rows     integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_version_id is null then
    raise exception 'admin_complete_upload: version is required' using errcode = '22023';
  end if;

  select v.document_id into v_doc_id from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'admin_complete_upload: version not found' using errcode = 'RB037';
  end if;
  select * into v_doc from public.documents d where d.id = v_doc_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_complete_upload: version not found' using errcode = 'RB037';
  end if;
  select * into v_ver from public.document_versions v where v.id = p_version_id for update;

  if v_ver.status <> 'pending_upload' then
    return query select v_ver.id, v_ver.status, false;
    return;
  end if;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'index_max_attempts', 1, 20);
  v_max := public.admin_policy_int(v_doc.bot_id, 'max_bytes', 1, 1099511627776);

  select o.metadata into v_meta from storage.objects o
   where o.bucket_id = 'knowledge' and o.name = v_ver.storage_path;
  if not found then
    raise exception 'admin_complete_upload: the file has not been uploaded' using errcode = 'RB038';
  end if;
  v_size_txt := v_meta ->> 'size';
  if v_size_txt is null or v_size_txt !~ '^[0-9]{1,15}$' then
    raise exception 'admin_complete_upload: the uploaded file size is unknown' using errcode = 'RB038';
  end if;
  v_size := v_size_txt::bigint;
  if v_size > v_max then
    raise exception 'admin_complete_upload: file is larger than the upload limit' using errcode = 'RB031';
  end if;
  if v_ver.byte_size is null or v_size <> v_ver.byte_size then
    raise exception 'admin_complete_upload: file size differs from the registered size' using errcode = 'RB030';
  end if;
  -- The object's content type (parameters such as "; charset=" ignored) must be the registered media type.
  -- A missing content type is a mismatch (fail closed).
  if lower(btrim(split_part(coalesce(v_meta ->> 'mimetype', ''), ';', 1))) <> v_ver.media_type then
    raise exception 'admin_complete_upload: file type differs from the registered media type' using errcode = 'RB030';
  end if;

  perform public.admin_consume_quota(v_doc.bot_id, 'upload');

  update public.document_versions set status = 'uploaded', upload_etag = v_meta ->> 'eTag' where id = p_version_id;
  -- A draft (or failed, never live) document starts indexing; a ready document keeps serving its live version.
  update public.documents set status = 'indexing'
   where id = v_doc.id and status in ('draft', 'failed') and active_version_id is null;

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values ('index_document', 'index:version:' || p_version_id::text,
          jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id),
          v_attempts::integer)
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing;
  get diagnostics v_rows = row_count;

  perform public.admin_audit('document.complete_upload', 'document_version', p_version_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id,
                       'byte_size', v_size));
  return query select p_version_id, 'uploaded'::text, v_rows = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_retry_version: only a failed version goes back to uploaded and gets a new job.
-- ---------------------------------------------------------------------------
create function public.admin_retry_version(p_version_id uuid)
returns table (version_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_doc_id   uuid;
  v_doc      public.documents%rowtype;
  v_ver      public.document_versions%rowtype;
  v_attempts bigint;
  v_rows     integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_version_id is null then
    raise exception 'admin_retry_version: version is required' using errcode = '22023';
  end if;

  select v.document_id into v_doc_id from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'admin_retry_version: version not found' using errcode = 'RB037';
  end if;
  select * into v_doc from public.documents d where d.id = v_doc_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_retry_version: version not found' using errcode = 'RB037';
  end if;
  select * into v_ver from public.document_versions v where v.id = p_version_id for update;
  if v_ver.status <> 'failed' then
    raise exception 'admin_retry_version: only a failed version can be retried' using errcode = 'RB030';
  end if;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'index_max_attempts', 1, 20);
  perform public.admin_consume_quota(v_doc.bot_id, 'reindex');

  update public.document_versions
     set status = 'uploaded', failure_code = null, batches_done = null, batches_total = null, completed_at = null
   where id = p_version_id;
  update public.documents set status = 'indexing'
   where id = v_doc.id and status in ('draft', 'failed') and active_version_id is null;

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values ('index_document', 'index:version:' || p_version_id::text,
          jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id),
          v_attempts::integer)
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'admin_retry_version: indexing of this version is still in progress' using errcode = 'RB030';
  end if;

  perform public.admin_audit('document.retry_version', 'document_version', p_version_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id,
                       'version_number', v_ver.version_number));
  return query select p_version_id, 'uploaded'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_reindex_document: new version over the active version's original. The live version and its
-- chunks are untouched until the worker activates the new one.
-- ---------------------------------------------------------------------------
create function public.admin_reindex_document(p_document_id uuid)
returns table (version_id uuid, version_number integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_doc      public.documents%rowtype;
  v_act      public.document_versions%rowtype;
  v_attempts bigint;
  v_ver      uuid := gen_random_uuid();
  v_num      integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_document_id is null then
    raise exception 'admin_reindex_document: document is required' using errcode = '22023';
  end if;

  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_reindex_document: document not found' using errcode = 'RB037';
  end if;
  if v_doc.active_version_id is null then
    raise exception 'admin_reindex_document: the document has no active version' using errcode = 'RB030';
  end if;
  select * into v_act from public.document_versions x where x.id = v_doc.active_version_id;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'index_max_attempts', 1, 20);
  perform public.admin_consume_quota(v_doc.bot_id, 'reindex');

  select max(x.version_number) + 1 into v_num from public.document_versions x where x.document_id = p_document_id;
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status)
  values (v_ver, p_document_id, v_num, v_act.storage_path, v_act.media_type, v_act.byte_size, 'uploaded');

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values ('index_document', 'index:version:' || v_ver::text,
          jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id, 'version_id', v_ver),
          v_attempts::integer);

  perform public.admin_audit('document.reindex', 'document_version', v_ver,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id, 'version_id', v_ver,
                       'version_number', v_num));
  return query select v_ver, v_num;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_document_status: per-document state for the panel. Never last_error or any content.
-- ---------------------------------------------------------------------------
create function public.admin_document_status(p_bot_id uuid)
returns table (
  document_id           uuid,
  title                 text,
  status                text,
  active_version_id     uuid,
  latest_version_id     uuid,
  latest_version_number integer,
  latest_version_status text,
  batches_done          integer,
  batches_total         integer,
  failure_code          text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.admin_require(array['owner', 'admin', 'analyst']);
  if p_bot_id is null then
    raise exception 'admin_document_status: bot is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'admin_document_status: bot not found' using errcode = 'RB037';
  end if;

  return query
  select d.id, d.title, d.status, d.active_version_id,
         lv.id, lv.version_number, lv.status, lv.batches_done, lv.batches_total, lv.failure_code
    from public.documents d
    left join lateral (
      select x.id, x.version_number, x.status, x.batches_done, x.batches_total, x.failure_code
        from public.document_versions x
       where x.document_id = d.id
       order by x.version_number desc
       limit 1
    ) lv on true
   where d.bot_id = p_bot_id and d.deleted_at is null
   order by d.created_at desc, d.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_request_download: audits, then returns the path for the panel's signed-URL request.
-- ---------------------------------------------------------------------------
create function public.admin_request_download(p_version_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ver public.document_versions%rowtype;
  v_doc public.documents%rowtype;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_version_id is null then
    raise exception 'admin_request_download: version is required' using errcode = '22023';
  end if;

  select * into v_ver from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'admin_request_download: version not found' using errcode = 'RB037';
  end if;
  select * into v_doc from public.documents d where d.id = v_ver.document_id;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_request_download: version not found' using errcode = 'RB037';
  end if;
  perform public.admin_consume_quota(v_doc.bot_id, 'write');

  perform public.admin_audit('document.download', 'document_version', p_version_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id));
  return v_ver.storage_path;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_delete_document: mark_document_deleted with the bot's cleanup attempts. A document that is already
-- deleted is a no-op (no job, no quota, no audit row). A first delete also cancels the document's queued
-- index jobs (a running one is left to the worker, which checks the document before it activates).
-- ---------------------------------------------------------------------------
create function public.admin_delete_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc      public.documents%rowtype;
  v_attempts bigint;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_document_id is null then
    raise exception 'admin_delete_document: document is required' using errcode = '22023';
  end if;

  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found then
    raise exception 'admin_delete_document: document not found' using errcode = 'RB037';
  end if;

  if v_doc.deleted_at is not null then
    return;
  end if;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'cleanup_max_attempts', 1, 20);
  perform public.admin_consume_quota(v_doc.bot_id, 'write');
  perform public.mark_document_deleted(p_document_id, v_attempts::integer);
  update public.jobs set state = 'cancelled', completed_at = now()
   where type = 'index_document' and state = 'queued' and payload ->> 'document_id' = p_document_id::text;

  perform public.admin_audit('document.delete', 'document', p_document_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- activate_document_version: an older version can never replace a newer live one (RB011).
-- Same signature, so the owner and service_role-only grant stay. Only the new check is added.
-- ---------------------------------------------------------------------------
create or replace function public.activate_document_version(
  p_document_id     uuid,
  p_version_id      uuid,
  p_expected_chunks integer
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_doc     public.documents%rowtype;
  v_ver     public.document_versions%rowtype;
  v_act_num integer;
  v_chunks  integer;
  v_corpus  bigint;
  v_model   text;
begin
  if p_document_id is null or p_version_id is null or p_expected_chunks is null or p_expected_chunks < 1 then
    raise exception 'activate_document_version: document, version and a positive expected chunk count are required'
      using errcode = '22023';
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'activate_document_version: document not found or deleted' using errcode = 'RB010';
  end if;

  select * into v_ver from public.document_versions
   where id = p_version_id and document_id = p_document_id for update;
  if not found then
    raise exception 'activate_document_version: version does not belong to document' using errcode = 'RB010';
  end if;

  if v_doc.active_version_id = p_version_id then
    select b.corpus_version into v_corpus from public.bot_profiles b where b.id = v_doc.bot_id;
    return v_corpus;
  end if;

  if v_doc.active_version_id is not null then
    select x.version_number into v_act_num from public.document_versions x where x.id = v_doc.active_version_id;
    if v_ver.version_number < v_act_num then
      raise exception 'activate_document_version: an older version cannot replace a newer active version'
        using errcode = 'RB011';
    end if;
  end if;

  if v_ver.status <> 'embedding' then
    raise exception 'activate_document_version: version status must be embedding' using errcode = 'RB011';
  end if;

  -- The version must have been embedded with the bot's current embedding model (never mix models).
  select b.embedding_model into v_model from public.bot_profiles b where b.id = v_doc.bot_id;
  if v_ver.embedding_model is null or v_model is null or v_ver.embedding_model <> v_model then
    raise exception 'activate_document_version: version embedding model does not match the bot embedding model'
      using errcode = 'RB011';
  end if;

  select count(*) into v_chunks from public.document_chunks where document_version_id = p_version_id;
  if v_chunks <> p_expected_chunks then
    raise exception 'activate_document_version: chunk count mismatch (expected %, found %)', p_expected_chunks, v_chunks
      using errcode = 'RB011';
  end if;
  -- Contiguous chunk indexes 0..n-1: no gaps.
  if exists (
    select 1 from public.document_chunks
     where document_version_id = p_version_id
    having min(chunk_index) <> 0 or max(chunk_index) <> v_chunks - 1
  ) then
    raise exception 'activate_document_version: chunk indexes are not contiguous' using errcode = 'RB011';
  end if;

  if v_doc.active_version_id is not null then
    update public.document_versions set status = 'superseded'
     where id = v_doc.active_version_id and status = 'ready';
  end if;

  update public.document_versions set status = 'ready', completed_at = now() where id = p_version_id;
  update public.documents set active_version_id = p_version_id, status = 'ready' where id = p_document_id;

  update public.bot_profiles set corpus_version = corpus_version + 1
   where id = v_doc.bot_id
  returning corpus_version into v_corpus;

  return v_corpus;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_job_budget: the worker's reservation before embedding. Same settings lock, same cap and the
-- same spend sum as reserve_request_budget, keyed by the running index_document job of the bot.
-- Idempotent only for an ACTIVE reservation: a 'reserved' row of the job that has not expired is returned
-- as it is. Otherwise (none, settled, released, expired, or reserved past its expiry, which is marked
-- expired here) the call is a new attempt: the job must be running and the cap is checked again, so
-- reserve, release, requeue, reserve works and a requeued job's new spend is counted.
-- Settle and release work unchanged.
-- ---------------------------------------------------------------------------
create function public.reserve_job_budget(
  p_bot_id      uuid,
  p_job_id      uuid,
  p_amount      numeric,
  p_ttl_seconds integer
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_policy    jsonb;
  v_cap_text  text;
  v_cap       numeric;
  v_spent     numeric;
  v_day       timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_job_state text;
  v_job_type  text;
  v_job_bot   text;
  v_existing  public.budget_reservations%rowtype;
  v_id        uuid;
begin
  if p_bot_id is null or p_job_id is null or p_amount is null or p_amount <= 0
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'reserve_job_budget: bot, job, positive amount and ttl (1..86400s) are required'
      using errcode = '22023';
  end if;

  select cs.budget_policy into v_policy
    from public.client_settings cs where cs.bot_id = p_bot_id for update;
  if not found then
    raise exception 'reserve_job_budget: no client settings for bot' using errcode = 'RB002';
  end if;

  v_cap_text := v_policy ->> 'daily_cap_usd';
  if v_cap_text is null or v_cap_text !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'reserve_job_budget: daily cap is missing or invalid' using errcode = 'RB002';
  end if;
  v_cap := v_cap_text::numeric;

  -- FOR SHARE keeps the job's state from changing under the reservation (claim and fail take row locks).
  select j.state, j.type, j.payload ->> 'bot_id' into v_job_state, v_job_type, v_job_bot
    from public.jobs j where j.id = p_job_id for share;
  if not found or v_job_type <> 'index_document' or v_job_bot is distinct from p_bot_id::text then
    raise exception 'reserve_job_budget: job not found for bot' using errcode = 'RB004';
  end if;

  -- The settings row is locked, so no other reservation of this bot runs now: at most one 'reserved' row per job.
  select * into v_existing from public.budget_reservations br where br.job_id = p_job_id and br.state = 'reserved';
  if found then
    if v_existing.bot_id <> p_bot_id then
      raise exception 'reserve_job_budget: existing reservation is not reusable' using errcode = 'RB004';
    end if;
    if v_existing.expires_at > now() then
      return v_existing.id;
    end if;
  end if;

  -- A new attempt: the job must be running.
  if v_job_state <> 'running' then
    raise exception 'reserve_job_budget: job is not running' using errcode = 'RB004';
  end if;
  if v_existing.id is not null then
    update public.budget_reservations set state = 'expired' where id = v_existing.id;
  end if;

  select coalesce(sum(br.amount), 0) into v_spent
    from public.budget_reservations br
   where br.bot_id = p_bot_id
     and br.created_at >= v_day
     and (br.state = 'settled'
          or (br.state = 'reserved' and br.expires_at > now())
          -- A stale worker can still settle an expired job reservation, so it keeps counting. Settling
          -- replaces it with the real amount; otherwise this errs on the side of the cap until the day ends.
          or (br.state = 'expired' and br.job_id is not null));

  if v_spent + p_amount > v_cap then
    raise exception 'reserve_job_budget: daily budget exceeded' using errcode = 'RB001';
  end if;

  insert into public.budget_reservations (bot_id, job_id, amount, state, expires_at)
  values (p_bot_id, p_job_id, p_amount, 'reserved', now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage policies on the private `knowledge` bucket. Always `to authenticated`, never `to public`:
-- anon holds table grants on storage.objects, so RLS is the only barrier. There is no UPDATE or DELETE
-- policy, so an object can never be overwritten or removed from a browser session.
-- ---------------------------------------------------------------------------
-- Upload only to the path of a pending_upload version of a live document, within 24 hours of creation.
create policy knowledge_insert_pending_version on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'knowledge'
    and (select public.is_active_member_mfa(array['owner', 'admin']))
    and exists (
      select 1
        from public.document_versions v
        join public.documents d on d.id = v.document_id
       where v.storage_path = objects.name
         and v.status = 'pending_upload'
         and d.deleted_at is null
         and v.created_at > now() - interval '24 hours'
    )
  );

-- Download (signed URL creation reads the object row): owner and admin only, and only an object that a
-- version of a live document owns (an orphan or a deleted document's original is not listed).
create policy knowledge_select_members on storage.objects
  for select to authenticated
  using (
    bucket_id = 'knowledge'
    and (select public.is_active_member_mfa(array['owner', 'admin']))
    and exists (
      select 1
        from public.document_versions v
        join public.documents d on d.id = v.document_id
       where v.storage_path = objects.name
         and d.deleted_at is null
    )
  );

-- ---------------------------------------------------------------------------
-- EXECUTE. Helpers: nobody (the SECURITY DEFINER owner runs them). Browser RPCs: authenticated only.
-- reserve_job_budget: service_role only. service_role is revoked explicitly: a default ACL may grant it.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_require(text[]) from public, anon, authenticated, service_role;
revoke all on function public.admin_audit(text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_policy_int(uuid, text, bigint, bigint) from public, anon, authenticated, service_role;
revoke all on function public.admin_consume_quota(uuid, text) from public, anon, authenticated, service_role;

revoke all on function public.admin_register_document(uuid, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_add_document_version(uuid, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.admin_complete_upload(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_retry_version(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_reindex_document(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_document_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_request_download(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_delete_document(uuid) from public, anon, authenticated, service_role;

grant execute on function public.admin_register_document(uuid, text, text, bigint, text) to authenticated;
grant execute on function public.admin_add_document_version(uuid, text, bigint) to authenticated;
grant execute on function public.admin_complete_upload(uuid) to authenticated;
grant execute on function public.admin_retry_version(uuid) to authenticated;
grant execute on function public.admin_reindex_document(uuid) to authenticated;
grant execute on function public.admin_document_status(uuid) to authenticated;
grant execute on function public.admin_request_download(uuid) to authenticated;
grant execute on function public.admin_delete_document(uuid) to authenticated;

revoke all on function public.reserve_job_budget(uuid, uuid, numeric, integer) from public, anon, authenticated;
grant execute on function public.reserve_job_budget(uuid, uuid, numeric, integer) to service_role;
