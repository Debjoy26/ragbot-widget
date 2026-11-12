-- 015_p75_cache_l2.sql — P7.5 L2 RPCs + missing columns + schema_version 15.
-- Backend-only caches: service_role only (bypass RLS). Validates hashes, TTL enforced on read.
-- Adds embedding_dimensions to query_embedding_cache and moderation_model to moderation_cache
-- so L2 records can be validated against the request.

-- 1. Missing columns for L2 validation.
alter table public.query_embedding_cache
  add column if not exists embedding_dimensions integer;
alter table public.query_embedding_cache
  drop constraint if exists query_embedding_cache_dimensions_check;
alter table public.query_embedding_cache
  add constraint query_embedding_cache_dimensions_check check (embedding_dimensions is null or embedding_dimensions = 1536);

alter table public.moderation_cache
  add column if not exists moderation_model text;

-- 2. query_embedding L2: get + set (upsert). Embedding passed as text '[v1,v2,...]' cast to vector.
create or replace function public.cache_get_query_embedding(p_key_hash text)
returns table (key_hash text, embedding_model text, embedding_dimensions integer, embedding text, expires_at timestamptz)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_query_embedding: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.key_hash, c.embedding_model, c.embedding_dimensions, c.embedding::text, c.expires_at
    from public.query_embedding_cache c
   where c.key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$$;
revoke all on function public.cache_get_query_embedding(text) from public, anon, authenticated;
grant execute on function public.cache_get_query_embedding(text) to service_role;

create or replace function public.cache_set_query_embedding(p_key_hash text, p_model text, p_dimensions integer, p_embedding_text text, p_expires_at timestamptz)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_query_embedding: invalid key hash' using errcode = '22023';
  end if;
  if p_model is null or p_model = '' or length(p_model) > 128 then
    raise exception 'cache_set_query_embedding: invalid model' using errcode = '22023';
  end if;
  if p_dimensions is null or p_dimensions != 1536 then
    raise exception 'cache_set_query_embedding: dimensions must be 1536' using errcode = '22023';
  end if;
  if p_embedding_text is null or p_embedding_text = '' then
    raise exception 'cache_set_query_embedding: invalid embedding' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_query_embedding: invalid expiry' using errcode = '22023';
  end if;
  insert into public.query_embedding_cache (key_hash, embedding_model, embedding_dimensions, embedding, expires_at, last_hit_at)
  values (p_key_hash, p_model, p_dimensions, p_embedding_text::extensions.vector(1536), p_expires_at, null)
  on conflict (key_hash) do update set
    embedding_model = excluded.embedding_model,
    embedding_dimensions = excluded.embedding_dimensions,
    embedding = excluded.embedding,
    expires_at = excluded.expires_at,
    last_hit_at = now();
end;
$$;
revoke all on function public.cache_set_query_embedding(text, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cache_set_query_embedding(text, text, integer, text, timestamptz) to service_role;

-- 3. moderation L2: get + set.
create or replace function public.cache_get_moderation(p_key_hash text)
returns table (key_hash text, policy_version text, verdict text, expires_at timestamptz)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_moderation: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.key_hash, c.policy_version, c.verdict, c.expires_at
    from public.moderation_cache c
   where c.key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$$;
revoke all on function public.cache_get_moderation(text) from public, anon, authenticated;
grant execute on function public.cache_get_moderation(text) to service_role;

create or replace function public.cache_set_moderation(p_key_hash text, p_policy_version text, p_verdict text, p_model text, p_expires_at timestamptz)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_moderation: invalid key hash' using errcode = '22023';
  end if;
  if p_policy_version is null or p_policy_version = '' or length(p_policy_version) > 64 then
    raise exception 'cache_set_moderation: invalid policy version' using errcode = '22023';
  end if;
  if p_verdict is null or p_verdict not in ('allow', 'block') then
    raise exception 'cache_set_moderation: invalid verdict' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_moderation: invalid expiry' using errcode = '22023';
  end if;
  insert into public.moderation_cache (key_hash, policy_version, verdict, moderation_model, expires_at)
  values (p_key_hash, p_policy_version, p_verdict, nullif(p_model, ''), p_expires_at)
  on conflict (key_hash) do update set
    policy_version = excluded.policy_version,
    verdict = excluded.verdict,
    moderation_model = excluded.moderation_model,
    expires_at = excluded.expires_at;
end;
$$;
revoke all on function public.cache_set_moderation(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cache_set_moderation(text, text, text, text, timestamptz) to service_role;

-- 4. answer L2: get + set + delete + touch. Contact never stored (no contact column exists).
create or replace function public.cache_get_answer(p_key_hash text)
returns table (bot_id uuid, cache_key_hash text, language text, answer_text text, source_refs jsonb, handoff_reason text, corpus_version bigint, settings_version integer, prompt_template_version text, chat_model text, expires_at timestamptz)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_answer: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.bot_id, c.cache_key_hash, c.language, c.answer_text, c.source_refs, c.handoff_reason, c.corpus_version, c.settings_version, c.prompt_template_version, c.chat_model, c.expires_at
    from public.answer_cache c
   where c.cache_key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$$;
revoke all on function public.cache_get_answer(text) from public, anon, authenticated;
grant execute on function public.cache_get_answer(text) to service_role;

create or replace function public.cache_set_answer(p_bot_id uuid, p_key_hash text, p_language text, p_answer_text text, p_source_refs jsonb, p_handoff_reason text, p_corpus_version bigint, p_settings_version integer, p_prompt_template_version text, p_chat_model text, p_expires_at timestamptz)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_bot_id is null then
    raise exception 'cache_set_answer: bot is required' using errcode = '22023';
  end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_answer: invalid key hash' using errcode = '22023';
  end if;
  if p_answer_text is null or p_answer_text = '' or length(p_answer_text) > 20000 then
    raise exception 'cache_set_answer: invalid answer' using errcode = '22023';
  end if;
  if p_source_refs is null or jsonb_typeof(p_source_refs) != 'array' then
    raise exception 'cache_set_answer: invalid sources' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_answer: invalid expiry' using errcode = '22023';
  end if;
  insert into public.answer_cache (bot_id, cache_key_hash, language, answer_text, source_refs, handoff_reason, corpus_version, settings_version, prompt_template_version, chat_model, expires_at, hit_count)
  values (p_bot_id, p_key_hash, p_language, p_answer_text, p_source_refs, p_handoff_reason, p_corpus_version, p_settings_version, p_prompt_template_version, p_chat_model, p_expires_at, 0)
  on conflict (cache_key_hash) do update set
    bot_id = excluded.bot_id,
    language = excluded.language,
    answer_text = excluded.answer_text,
    source_refs = excluded.source_refs,
    handoff_reason = excluded.handoff_reason,
    corpus_version = excluded.corpus_version,
    settings_version = excluded.settings_version,
    prompt_template_version = excluded.prompt_template_version,
    chat_model = excluded.chat_model,
    expires_at = excluded.expires_at;
end;
$$;
revoke all on function public.cache_set_answer(uuid, text, text, text, jsonb, text, bigint, integer, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cache_set_answer(uuid, text, text, text, jsonb, text, bigint, integer, text, text, timestamptz) to service_role;

create or replace function public.cache_delete_answer(p_key_hash text)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_delete_answer: invalid key hash' using errcode = '22023';
  end if;
  delete from public.answer_cache where cache_key_hash = p_key_hash;
end;
$$;
revoke all on function public.cache_delete_answer(text) from public, anon, authenticated;
grant execute on function public.cache_delete_answer(text) to service_role;

create or replace function public.cache_touch_answer(p_key_hash text)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_touch_answer: invalid key hash' using errcode = '22023';
  end if;
  update public.answer_cache set hit_count = hit_count + 1, last_hit_at = now() where cache_key_hash = p_key_hash;
end;
$$;
revoke all on function public.cache_touch_answer(text) from public, anon, authenticated;
grant execute on function public.cache_touch_answer(text) to service_role;

-- 5. retrieval L2: get + set + delete.
create or replace function public.cache_get_retrieval(p_key_hash text)
returns table (bot_id uuid, corpus_version bigint, embedding_hash text, k integer, threshold double precision, language text, chunk_refs jsonb, expires_at timestamptz)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_retrieval: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.bot_id, c.corpus_version, c.embedding_hash, c.k, c.threshold, c.language, c.chunk_refs, c.expires_at
    from public.retrieval_cache c
   where c.key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$$;
revoke all on function public.cache_get_retrieval(text) from public, anon, authenticated;
grant execute on function public.cache_get_retrieval(text) to service_role;

create or replace function public.cache_set_retrieval(p_key_hash text, p_bot_id uuid, p_corpus_version bigint, p_embedding_hash text, p_k integer, p_threshold double precision, p_language text, p_chunk_refs jsonb, p_expires_at timestamptz)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_retrieval: invalid key hash' using errcode = '22023';
  end if;
  if p_bot_id is null then
    raise exception 'cache_set_retrieval: bot is required' using errcode = '22023';
  end if;
  if p_embedding_hash is null or p_embedding_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_retrieval: invalid embedding hash' using errcode = '22023';
  end if;
  if p_k is null or p_k < 1 or p_k > 50 then
    raise exception 'cache_set_retrieval: invalid k' using errcode = '22023';
  end if;
  if p_chunk_refs is null or jsonb_typeof(p_chunk_refs) != 'array' then
    raise exception 'cache_set_retrieval: invalid refs' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_retrieval: invalid expiry' using errcode = '22023';
  end if;
  insert into public.retrieval_cache (key_hash, bot_id, corpus_version, embedding_hash, k, threshold, language, chunk_refs, expires_at)
  values (p_key_hash, p_bot_id, p_corpus_version, p_embedding_hash, p_k, p_threshold, p_language, p_chunk_refs, p_expires_at)
  on conflict (key_hash) do update set
    bot_id = excluded.bot_id,
    corpus_version = excluded.corpus_version,
    embedding_hash = excluded.embedding_hash,
    k = excluded.k,
    threshold = excluded.threshold,
    language = excluded.language,
    chunk_refs = excluded.chunk_refs,
    expires_at = excluded.expires_at;
end;
$$;
revoke all on function public.cache_set_retrieval(text, uuid, bigint, text, integer, double precision, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.cache_set_retrieval(text, uuid, bigint, text, integer, double precision, text, jsonb, timestamptz) to service_role;

create or replace function public.cache_delete_retrieval(p_key_hash text)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_delete_retrieval: invalid key hash' using errcode = '22023';
  end if;
  delete from public.retrieval_cache where key_hash = p_key_hash;
end;
$$;
revoke all on function public.cache_delete_retrieval(text) from public, anon, authenticated;
grant execute on function public.cache_delete_retrieval(text) to service_role;

-- 6. chunks by IDs for C5 rehydration (service_role only, bot-scoped by caller).
create or replace function public.get_chunks_by_ids(p_chunk_ids uuid[])
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
     and v.status = 'ready'
     and d.deleted_at is null
     and d.status <> 'deleted'
     and d.disclosure_policy = 'public_answer';
end;
$$;
revoke all on function public.get_chunks_by_ids(uuid[]) from public, anon, authenticated;
grant execute on function public.get_chunks_by_ids(uuid[]) to service_role;

-- 7. schema_version: bump to 15.
create or replace function public.schema_version()
returns integer
language sql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
  select 15;
$$;
revoke all on function public.schema_version() from public, anon, authenticated, service_role;
grant execute on function public.schema_version() to authenticated;
