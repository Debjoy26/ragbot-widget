-- T11: fenced C7 publication. A warm claim may persist the shared answer_cache
-- L2 record only while its lease is live, its versions are current, the bot
-- and the C8 policy are enabled, the answer cache is explicitly opted in
-- (c7 layer), and the answer is eligible: completed + moderated, not truncated,
-- with validated citations (or a deliberate non-blocked handoff), no PII or
-- contact details, current prompt template, and every cited chunk still active
-- (ready version, non-deleted, public_answer). Anything else returns false
-- instead of writing, like queue_warm_job; malformed calls fail loudly
-- (22023). Upsert delegates to cache_set_answer, so insert semantics stay in
-- one place. No browser access; service_role only.
-- Chat-model identity rests on the T06-validated worker configuration deployed
-- equal to the API's (no per-bot chat model lives in the database), like C6
-- moderation. Contact details are never stored: the record carries only
-- answer_text + source_refs; contact is served from current public_bot_config
-- at read time.

-- Extend the layer gate with explicit C7 opt-in (default off). Existing
-- c4/c5/c6 branches are unchanged.
create or replace function public.warm_layer_enabled(p_policy jsonb, p_layer text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_policy) = 'object'
    and p_policy->'kill_switch' is distinct from 'true'::jsonb
    and p_policy->'enabled' is distinct from 'false'::jsonb
    and case p_layer
      when 'c4' then p_policy->'c4' is distinct from 'false'::jsonb
        and p_policy->'embedding' is distinct from 'false'::jsonb
        and p_policy->'embeddings' is distinct from 'false'::jsonb
        and p_policy->'query_embedding' is distinct from 'false'::jsonb
      when 'c5' then p_policy->'c5' is distinct from 'false'::jsonb
        and p_policy->'retrieval' is distinct from 'false'::jsonb
        and p_policy->'retrieval_cache' is distinct from 'false'::jsonb
      when 'c6' then p_policy->'c6' is distinct from 'false'::jsonb
        and p_policy->'moderation' is distinct from 'false'::jsonb
        and p_policy->'moderation_cache' is distinct from 'false'::jsonb
      when 'c7' then p_policy->'c7' is distinct from 'false'::jsonb
        and p_policy->'answer_cache' is distinct from 'false'::jsonb
        and p_policy->'answer' is distinct from 'false'::jsonb
        and (p_policy->'c7' = 'true'::jsonb
          or p_policy->'answer_cache' = 'true'::jsonb
          or p_policy->'answer' = 'true'::jsonb
          or p_policy->'enabled' = 'true'::jsonb)
      else false end, false);
$$;

create function public.publish_warm_answer(p_job_id uuid, p_worker text, p_generation integer,
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
  -- Each citation must be a well-formed {chunk_id, document_version_id} pair.
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
  -- Eligibility mirrors the shared C7 safety rules at write time.
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
  -- Blocked handoffs are never warmed; the visitor sees a refusal, not a cache hit.
  if p_handoff_reason = 'blocked' then
    return false;
  end if;
  -- PII and contact details are never stored.
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
  -- Citations only from retrieved chunk IDs, or a deliberate non-blocked handoff.
  if jsonb_array_length(p_source_refs) = 0 and p_handoff_reason is null then
    return false;
  end if;
  -- Every cited chunk must still be servable: ready version, non-deleted,
  -- public_answer disclosure, and the exact cited version.
  for r in select value from jsonb_array_elements(p_source_refs) as value loop
    v_chunk := (r->>'chunk_id')::uuid;
    v_version := (r->>'document_version_id')::uuid;
    if not exists(select 1 from public.document_chunks c
        join public.document_versions v on v.id = c.document_version_id
        join public.documents d on d.id = v.document_id
        where c.id = v_chunk and c.document_version_id = v_version
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

revoke all on function public.warm_layer_enabled(jsonb,text),
  public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz)
  from public, anon, authenticated;
grant execute on function public.warm_layer_enabled(jsonb,text),
  public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 25; $$;
