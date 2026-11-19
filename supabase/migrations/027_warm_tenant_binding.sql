-- T15: tenant binding on warmed citation integrity (security review finding).
-- The C7 per-citation recheck and the new C5 chunk validation now require every
-- cited chunk to belong to the calling bot: shared L2 can no longer carry a
-- cross-bot chunk even from a lease-holding caller. get_chunks_by_ids takes an
-- optional bot filter that the live read paths pass (old single-arg calls keep
-- working). Signatures of the publish RPCs are unchanged. The old
-- single-argument get_chunks_by_ids is replaced (same name, optional second
-- argument); single-arg calls keep working through the default.
create or replace function public.publish_warm_answer(p_job_id uuid, p_worker text, p_generation integer,
  p_key_hash text, p_bot_id uuid, p_language text, p_raw_question text,
  p_answer_text text, p_source_refs jsonb, p_handoff_reason text,
  p_status text, p_moderated boolean, p_truncated boolean,
  p_prompt_template_version text, p_chat_model text,
  p_corpus_version bigint, p_settings_version integer, p_expires_at timestamptz)
returns boolean language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer; r jsonb;
  v_chunk uuid; v_version uuid;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_bot_id is null
     or p_language is null or char_length(p_language) > 16
     or p_raw_question is null or char_length(p_raw_question) < 1
     or char_length(p_raw_question) > 2000
     or p_answer_text is null or p_answer_text = ''
     or char_length(p_answer_text) > 20000
     or p_source_refs is null or jsonb_typeof(p_source_refs) != 'array'
     or jsonb_array_length(p_source_refs) > 20
     or (p_handoff_reason is not null and p_handoff_reason not in
       ('no_knowledge','out_of_scope','human_requested','blocked','unavailable','repeated_no_knowledge'))
     or p_status is null or p_status not in ('complete','partial','failed','blocked')
     or p_moderated is null
     or p_truncated is null
     or p_prompt_template_version is null or p_prompt_template_version = ''
     or char_length(p_prompt_template_version) > 64
     or p_chat_model is null or p_chat_model = '' or char_length(p_chat_model) > 128
     or p_corpus_version is null
     or p_settings_version is null
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid answer record' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_source_refs) as value loop
    if jsonb_typeof(r) != 'object'
       or r->>'chunk_id' is null
       or r->>'document_version_id' is null
       or lower(r->>'chunk_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or lower(r->>'document_version_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'warm publish: invalid answer citation' using errcode = '22023';
    end if;
  end loop;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  if p_bot_id is distinct from v_bot_id then
    raise exception 'warm publish: job not found for bot' using errcode = 'RB004';
  end if;
  select cs.cache_policy into v_policy from public.client_settings cs
    where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm publish: no client settings for bot' using errcode = 'RB002';
  end if;
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm publish: bot not found' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy)
     or not public.warm_layer_enabled(v_policy, 'c7') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version
     or p_corpus_version is distinct from v_bot.corpus_version
     or p_settings_version is distinct from v_bot.settings_version then
    return false;
  end if;
  if p_status is distinct from 'complete' then
    return false;
  end if;
  if not p_moderated then
    return false;
  end if;
  if p_truncated then
    return false;
  end if;
  if p_prompt_template_version is distinct from 'rag-v2' then
    return false;
  end if;
  if p_handoff_reason = 'blocked' then
    return false;
  end if;
  if p_raw_question ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
     or p_answer_text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
     or p_raw_question ~ '\+[1-9][0-9]{6,14}'
     or p_answer_text ~ '\+[1-9][0-9]{6,14}'
     or p_raw_question ~ '[0-9]{3}-[0-9]{3}-[0-9]{4}'
     or p_answer_text ~ '[0-9]{3}-[0-9]{3}-[0-9]{4}'
     or p_raw_question ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
     or p_answer_text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
     or p_raw_question ~ '[0-9]{9,12}'
     or p_answer_text ~ '[0-9]{9,12}' then
    return false;
  end if;
  if p_raw_question ~* 'mailto:|tel:|whatsapp|contact@'
     or p_answer_text ~* 'mailto:|tel:|whatsapp|contact@' then
    return false;
  end if;
  if jsonb_array_length(p_source_refs) = 0 and p_handoff_reason is null then
    return false;
  end if;
  for r in select value from jsonb_array_elements(p_source_refs) as value loop
    v_chunk := (r->>'chunk_id')::uuid;
    v_version := (r->>'document_version_id')::uuid;
    if not exists(select 1 from public.document_chunks c
        join public.document_versions v on v.id = c.document_version_id
        join public.documents d on d.id = v.document_id
        where c.id = v_chunk and c.document_version_id = v_version
          and d.bot_id = v_bot_id
          and v.status = 'ready'
          and d.deleted_at is null and d.status <> 'deleted'
          and d.disclosure_policy = 'public_answer') then
      return false;
    end if;
  end loop;
  perform public.cache_set_answer(p_bot_id, p_key_hash, p_language, p_answer_text,
    p_source_refs, p_handoff_reason, v_bot.corpus_version, v_bot.settings_version,
    p_prompt_template_version, p_chat_model, p_expires_at);
  return true;
end;
$$;

create or replace function public.publish_warm_retrieval(p_job_id uuid, p_worker text, p_generation integer,
  p_key_hash text, p_bot_id uuid, p_corpus_version bigint, p_embedding_hash text, p_k integer,
  p_threshold double precision, p_language text, p_chunk_refs jsonb, p_expires_at timestamptz)
returns boolean language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer; r jsonb;
  v_chunk uuid; v_version uuid;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_bot_id is null
     or p_embedding_hash is null or p_embedding_hash !~ '^[0-9a-f]{64}$'
     or p_k is null or p_k < 1 or p_k > 50 or p_threshold is null
     or p_chunk_refs is null or jsonb_typeof(p_chunk_refs) != 'array'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid retrieval record' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_chunk_refs) as value loop
    if jsonb_typeof(r) != 'object'
       or r->>'chunk_id' is null
       or r->>'document_version_id' is null
       or lower(r->>'chunk_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or lower(r->>'document_version_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'warm publish: invalid retrieval citation' using errcode = '22023';
    end if;
  end loop;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  if p_bot_id is distinct from v_bot_id then
    raise exception 'warm publish: job not found for bot' using errcode = 'RB004';
  end if;
  select cs.cache_policy into v_policy from public.client_settings cs
    where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm publish: no client settings for bot' using errcode = 'RB002';
  end if;
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm publish: bot not found' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy)
     or not public.warm_layer_enabled(v_policy, 'c5') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version
     or p_corpus_version is distinct from v_bot.corpus_version then
    return false;
  end if;
  for r in select value from jsonb_array_elements(p_chunk_refs) as value loop
    v_chunk := (r->>'chunk_id')::uuid;
    v_version := (r->>'document_version_id')::uuid;
    if not exists(select 1 from public.document_chunks c
        join public.document_versions v on v.id = c.document_version_id
        join public.documents d on d.id = v.document_id
        where c.id = v_chunk and c.document_version_id = v_version
          and d.bot_id = v_bot_id
          and v.status = 'ready'
          and d.deleted_at is null and d.status <> 'deleted'
          and d.disclosure_policy = 'public_answer') then
      return false;
    end if;
  end loop;
  if not exists(select 1 from public.query_embedding_cache c
      where c.embedding_model = v_bot.embedding_model
        and c.embedding_dimensions = v_bot.embedding_dimensions
        and c.expires_at > now()) then
    raise exception 'warm publish: no live embedding for bot model' using errcode = 'RB003';
  end if;
  perform public.cache_set_retrieval(p_key_hash, p_bot_id, p_corpus_version, p_embedding_hash,
    p_k, p_threshold, p_language, p_chunk_refs, p_expires_at);
  return true;
end;
$$;

drop function if exists public.get_chunks_by_ids(uuid[]);
create or replace function public.get_chunks_by_ids(p_chunk_ids uuid[], p_bot_id uuid default null)
returns table (chunk_id uuid, document_id uuid, document_version_id uuid, document_title text, chunk_index integer, content text, page_number integer, section text, similarity double precision)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_chunk_ids is null or array_length(p_chunk_ids, 1) is null or array_length(p_chunk_ids, 1) < 1 or array_length(p_chunk_ids, 1) > 50 then
    raise exception 'get_chunks_by_ids: 1..50 ids required' using errcode = '22023';
  end if;
  return query
  select c.id, d.id, c.document_version_id, d.title, c.chunk_index, c.content, c.page_number, c.section, 1.0::double precision
    from public.document_chunks c
    join public.document_versions v on v.id = c.document_version_id
    join public.documents d on d.id = v.document_id
   where c.id = any (p_chunk_ids)
     and (p_bot_id is null or d.bot_id = p_bot_id)
     and v.status = 'ready'
     and d.deleted_at is null
     and d.status <> 'deleted'
     and d.disclosure_policy = 'public_answer';
end;
$$;

revoke all on function public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz),
  public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz),
  public.get_chunks_by_ids(uuid[],uuid)
  from public, anon, authenticated;
grant execute on function public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz),
  public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz),
  public.get_chunks_by_ids(uuid[],uuid)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 27; $$;
