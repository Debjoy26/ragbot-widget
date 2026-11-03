-- 002_vectors.sql — pgvector, fixed 1536-dim embeddings (ADR 0002 / 0014), HNSW cosine index,
-- and the bounded retrieval RPC. Changing model/dimension = explicit reindex + new migration (handover §4.9).

create extension if not exists vector with schema extensions;

alter table public.document_chunks
  add column embedding extensions.vector(1536) not null;

alter table public.query_embedding_cache
  add column embedding extensions.vector(1536) not null;

-- HNSW with the operator class matching the cosine metric. Re-evaluate after dataset testing.
create index document_chunks_embedding_hnsw_idx
  on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- match_document_chunks: bounded similarity search. SERVICE ROLE ONLY (EXECUTE revoked from
-- PUBLIC/anon/authenticated in this migration). SECURITY INVOKER: it runs with the caller's
-- (service_role) privileges, there is no privilege escalation.
--
-- Bounded k: p_match_count must be 1..50; anything else is REJECTED (not clamped).
-- Filters (all mandatory, none caller-controlled): bot, document.active_version_id = chunk's
-- version, version status 'ready', version embedding_model = the bot's embedding_model (chunks
-- embedded with another model are never compared with the query vector), document not deleted,
-- disclosure_policy = 'public_answer'.
-- Iterative scan keeps the filtered HNSW search from returning fewer rows than exist.
-- ---------------------------------------------------------------------------
create function public.match_document_chunks(
  p_bot_id          uuid,
  p_query_embedding extensions.vector(1536),
  p_match_count     integer,
  p_min_similarity  double precision default null
)
returns table (
  chunk_id            uuid,
  document_id         uuid,
  document_version_id uuid,
  document_title      text,
  chunk_index         integer,
  content             text,
  page_number         integer,
  section             text,
  metadata            jsonb,
  similarity          double precision
)
language plpgsql
stable
set search_path = ''
set hnsw.iterative_scan = 'strict_order'
as $$
begin
  if p_bot_id is null or p_query_embedding is null then
    raise exception 'match_document_chunks: bot id and query embedding are required'
      using errcode = '22023';
  end if;
  if p_match_count is null or p_match_count < 1 or p_match_count > 50 then
    raise exception 'match_document_chunks: match count must be between 1 and 50'
      using errcode = '22023';
  end if;
  if p_min_similarity is not null and (p_min_similarity < -1 or p_min_similarity > 1) then
    raise exception 'match_document_chunks: min similarity must be between -1 and 1'
      using errcode = '22023';
  end if;

  return query
  select
    c.id,
    d.id,
    c.document_version_id,
    d.title,
    c.chunk_index,
    c.content,
    c.page_number,
    c.section,
    c.metadata,
    (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::double precision as similarity
  from public.document_chunks c
  join public.document_versions v on v.id = c.document_version_id
  join public.documents d on d.id = v.document_id
  join public.bot_profiles b on b.id = d.bot_id
  where d.bot_id = p_bot_id
    and v.embedding_model = b.embedding_model
    and d.active_version_id = c.document_version_id
    and v.status = 'ready'
    and d.deleted_at is null
    and d.status <> 'deleted'
    and d.disclosure_policy = 'public_answer'
    and (
      p_min_similarity is null
      or (1 - (c.embedding operator(extensions.<=>) p_query_embedding)) >= p_min_similarity
    )
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_match_count;
end;
$$;

revoke all on function public.match_document_chunks(uuid, extensions.vector, integer, double precision)
  from public, anon, authenticated;
grant execute on function public.match_document_chunks(uuid, extensions.vector, integer, double precision)
  to service_role;

-- ---------------------------------------------------------------------------
-- Embedding model / dimension are immutable while the bot has chunks (handover §4.9):
-- changing them is an explicit reindex (delete the chunks / documents first, then change).
-- SQLSTATE RB012 embedding_change_requires_reindex.
-- ---------------------------------------------------------------------------
create function public.bot_profiles_guard_embedding_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.embedding_model is distinct from old.embedding_model
      or new.embedding_dimensions is distinct from old.embedding_dimensions)
     and exists (
       select 1
         from public.documents d
         join public.document_versions v on v.document_id = d.id
         join public.document_chunks c on c.document_version_id = v.id
        where d.bot_id = old.id
     ) then
    raise exception 'bot_profiles: embedding model change requires reindex' using errcode = 'RB012';
  end if;
  return new;
end;
$$;
revoke all on function public.bot_profiles_guard_embedding_change() from public, anon, authenticated;
create trigger bot_profiles_guard_embedding_change
  before update of embedding_model, embedding_dimensions on public.bot_profiles
  for each row execute function public.bot_profiles_guard_embedding_change();
