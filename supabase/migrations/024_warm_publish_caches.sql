-- T10: fenced C4-C6 publication. A warm claim may persist shared L2 records only
-- while its lease is live, its versions are current, the bot and the layer are
-- enabled, and the record matches the bot's current model. Stale, disabled,
-- cross-bot or model-mismatched writes are refused (false, like queue_warm_job);
-- malformed calls fail loudly (22023). Publication delegates the actual upsert
-- to the existing cache_set_* RPCs, so insert semantics stay in one place.
-- No browser access; service_role only.
create function public.warm_layer_enabled(p_policy jsonb, p_layer text) returns boolean
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
      else false end, false);
$$;

create function public.publish_warm_embedding(p_job_id uuid, p_worker text, p_generation integer,
  p_key_hash text, p_model text, p_dimensions integer, p_embedding_text text, p_expires_at timestamptz)
returns boolean language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_model is null or p_model = '' or length(p_model) > 128
     or p_dimensions is null or p_dimensions < 1 or p_dimensions > 100000
     or p_embedding_text is null or p_embedding_text = ''
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid embedding record' using errcode = '22023';
  end if;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
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
     or not public.warm_layer_enabled(v_policy, 'c4') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version then
    return false;
  end if;
  if p_model is distinct from v_bot.embedding_model
     or p_dimensions is distinct from v_bot.embedding_dimensions then
    return false;
  end if;
  perform public.cache_set_query_embedding(p_key_hash, p_model, p_dimensions,
    p_embedding_text, p_expires_at);
  return true;
end;
$$;

create function public.publish_warm_moderation(p_job_id uuid, p_worker text, p_generation integer,
  p_key_hash text, p_policy_version text, p_verdict text, p_model text, p_expires_at timestamptz)
returns boolean language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_policy_version is null or p_policy_version = '' or length(p_policy_version) > 64
     or p_verdict is null or p_verdict not in ('allow', 'block')
     or p_model is null or p_model = '' or length(p_model) > 128
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid moderation record' using errcode = '22023';
  end if;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
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
     or not public.warm_layer_enabled(v_policy, 'c6') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version then
    return false;
  end if;
  -- No per-bot moderation model lives in the database: identity matching rests
  -- on the T06-validated worker configuration, deployed equal to the API's.
  perform public.cache_set_moderation(p_key_hash, p_policy_version, p_verdict,
    p_model, p_expires_at);
  return true;
end;
$$;

create function public.publish_warm_retrieval(p_job_id uuid, p_worker text, p_generation integer,
  p_key_hash text, p_bot_id uuid, p_corpus_version bigint, p_embedding_hash text, p_k integer,
  p_threshold double precision, p_language text, p_chunk_refs jsonb, p_expires_at timestamptz)
returns boolean language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer;
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
  -- Retrieval may only reference a live embedding record: warmed lookups can
  -- never point at an evicted or foreign vector.
  if not exists(select 1 from public.query_embedding_cache c
      where c.key_hash = p_embedding_hash and c.expires_at > now()) then
    raise exception 'warm publish: embedding not cached' using errcode = 'RB003';
  end if;
  perform public.cache_set_retrieval(p_key_hash, p_bot_id, p_corpus_version, p_embedding_hash,
    p_k, p_threshold, p_language, p_chunk_refs, p_expires_at);
  return true;
end;
$$;

revoke all on function public.warm_layer_enabled(jsonb,text),
  public.publish_warm_embedding(uuid,text,integer,text,text,integer,text,timestamptz),
  public.publish_warm_moderation(uuid,text,integer,text,text,text,text,timestamptz),
  public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)
  from public, anon, authenticated;
grant execute on function public.warm_layer_enabled(jsonb,text),
  public.publish_warm_embedding(uuid,text,integer,text,text,integer,text,timestamptz),
  public.publish_warm_moderation(uuid,text,integer,text,text,text,text,timestamptz),
  public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 24; $$;
