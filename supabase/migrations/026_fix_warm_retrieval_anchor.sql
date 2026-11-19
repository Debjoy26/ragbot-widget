-- T14: fix the C5 anchor. T10 required query_embedding_cache.key_hash =
-- p_embedding_hash, but the two layers use different key spaces by design: a C4
-- key hashes model|dimensions|normalized-question while a C5 embedding_hash
-- hashes the embedding vector itself (queryEmbeddingHash). Key equality can
-- therefore never hold on the real path, and every fenced C5 publish failed
-- closed with RB003 (found by the T14 local round trip; C4/C6/C7 unaffected).
-- The replacement anchor keeps the intent (no foreign or evicted vector): a
-- live, unexpired C4 row for the bot's CURRENT embedding model and dimensions
-- must exist. The same fenced variant always publishes that C4 row first, and
-- the handler's adapter-identity check pins the model; a caller pointing at a
-- model with no live cache row is still refused. Signature unchanged.
create or replace function public.publish_warm_retrieval(p_job_id uuid, p_worker text, p_generation integer,
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
  -- The embedding behind this record must be live under the bot's current
  -- model: the same variant publishes that C4 row first.
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

revoke all on function public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)
  from public, anon, authenticated;
grant execute on function public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 26; $$;
