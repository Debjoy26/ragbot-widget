-- 008: debug cycle P3-D5 (audit gaps G-1 to G-8). Forward-only: 001-007 are never edited.
-- CREATE OR REPLACE keeps the owner, the EXECUTE grants (service_role only) and the search_path of
-- existing functions. New functions are SECURITY INVOKER with an empty search_path and no PUBLIC,
-- anon or authenticated EXECUTE.

-- ---------------------------------------------------------------------------
-- G-3: dedupe_key is unique only among live jobs (queued, running). A finished job's key can be
-- reused, so a second delete or reindex of the same resource is not silently swallowed forever.
-- The new index is built before the old constraint goes, so there is no window without protection.
-- ---------------------------------------------------------------------------
create unique index jobs_dedupe_key_live_key on public.jobs (dedupe_key)
  where state in ('queued', 'running');
alter table public.jobs drop constraint jobs_dedupe_key_key;

-- ---------------------------------------------------------------------------
-- G-1: the cleanup payload is the shape shared/src/schemas.ts accepts:
-- {"bot_id": uuid, "scope": "document", "resource_id": document uuid}.
-- G-3: the conflict target is the live-job partial index.
-- Signature unchanged (P3.5 changes it).
-- ---------------------------------------------------------------------------
create or replace function public.mark_document_deleted(
  p_document_id          uuid,
  p_cleanup_max_attempts integer
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_doc    public.documents%rowtype;
  v_corpus bigint;
begin
  if p_document_id is null or p_cleanup_max_attempts is null or p_cleanup_max_attempts < 1 then
    raise exception 'mark_document_deleted: document and positive max attempts are required'
      using errcode = '22023';
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then
    raise exception 'mark_document_deleted: document not found' using errcode = 'RB010';
  end if;

  if v_doc.deleted_at is null then
    update public.documents set deleted_at = now(), status = 'deleted' where id = p_document_id;
    update public.bot_profiles set corpus_version = corpus_version + 1
     where id = v_doc.bot_id
    returning corpus_version into v_corpus;
  else
    select b.corpus_version into v_corpus from public.bot_profiles b where b.id = v_doc.bot_id;
  end if;

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values (
    'cleanup',
    'cleanup:document:' || p_document_id::text,
    jsonb_build_object('bot_id', v_doc.bot_id, 'scope', 'document', 'resource_id', p_document_id),
    p_cleanup_max_attempts
  )
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing;

  return v_corpus;
end;
$$;

-- A live cleanup job queued by the old function carries the old shape, which the job schema rejects.
-- Rewrite it so it can run; terminal jobs stay as they were.
update public.jobs
   set payload = jsonb_build_object(
         'bot_id', payload -> 'bot_id', 'scope', 'document', 'resource_id', payload -> 'document_id')
 where type = 'cleanup'
   and state in ('queued', 'running')
   and payload ? 'document_id'
   and not payload ? 'scope';

-- ---------------------------------------------------------------------------
-- G-2: settings_version moves whenever answer-affecting settings change, so stale answer_cache rows
-- stop being served (purge_expired_caches already drops rows below the bot's settings_version).
-- It does not move on corpus_version, on updated_at-only changes, or on no-op updates.
-- ---------------------------------------------------------------------------

-- bot_profiles: BEFORE UPDATE, only when a listed column really changes. The trigger lists those
-- columns, so the bump (settings_version only) and corpus_version updates never fire it again.
create function public.bot_profiles_bump_settings_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.settings_version := old.settings_version + 1;
  return new;
end;
$$;
revoke all on function public.bot_profiles_bump_settings_version() from public, anon, authenticated;
create trigger bot_profiles_bump_settings_version
  before update of identity_prompt, tone, scope, allowed_languages, enabled on public.bot_profiles
  for each row
  when (old.identity_prompt is distinct from new.identity_prompt
     or old.tone is distinct from new.tone
     or old.scope is distinct from new.scope
     or old.allowed_languages is distinct from new.allowed_languages
     or old.enabled is distinct from new.enabled)
  execute function public.bot_profiles_bump_settings_version();

-- client_settings and public_bot_config: AFTER UPDATE, any real column change bumps the bot once.
-- updated_at is maintained by trigger and is_published is derived from bot_profiles.enabled (whose
-- change already bumped in the BEFORE trigger above), so neither counts as a change here. That keeps
-- bot_profiles_sync_published and public_bot_config_sync_published from double counting.
-- The UPDATE below touches settings_version only, so no bot_profiles trigger above fires again.
create function public.bump_bot_settings_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'updated_at' - 'is_published') is distinct from (to_jsonb(old) - 'updated_at' - 'is_published') then
    update public.bot_profiles set settings_version = settings_version + 1 where id = new.bot_id;
  end if;
  return null;
end;
$$;
revoke all on function public.bump_bot_settings_version() from public, anon, authenticated;
create trigger client_settings_bump_settings_version after update on public.client_settings
  for each row when (old.* is distinct from new.*)
  execute function public.bump_bot_settings_version();
create trigger public_bot_config_bump_settings_version after update on public.public_bot_config
  for each row when (old.* is distinct from new.*)
  execute function public.bump_bot_settings_version();

-- ---------------------------------------------------------------------------
-- G-4: a citation snapshot may only point at its own bot's chunk and version, and the chunk must
-- belong to that version. Null links stay allowed (deletion sets them null, retention keeps the row).
-- On UPDATE only a link that changes to a non-null value (or a changed message) is checked, so the
-- referential set-null during a document or version delete is never blocked.
-- ---------------------------------------------------------------------------
create function public.message_sources_check_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bot       uuid;
  v_ver_bot   uuid;
  v_chunk_bot uuid;
  v_chunk_ver uuid;
  v_chunk_chg boolean;
  v_ver_chg   boolean;
begin
  if tg_op = 'UPDATE' then
    v_chunk_chg := new.chunk_id is not null and new.chunk_id is distinct from old.chunk_id;
    v_ver_chg   := new.document_version_id is not null and new.document_version_id is distinct from old.document_version_id;
    if new.message_id is not distinct from old.message_id and not v_chunk_chg and not v_ver_chg then
      return new;
    end if;
  end if;
  if new.chunk_id is null and new.document_version_id is null then
    return new;
  end if;

  select c.bot_id into v_bot
    from public.messages m join public.conversations c on c.id = m.conversation_id
   where m.id = new.message_id;
  if not found then
    raise exception 'message_sources: message not found' using errcode = '23514';
  end if;

  if new.document_version_id is not null then
    select d.bot_id into v_ver_bot
      from public.document_versions v join public.documents d on d.id = v.document_id
     where v.id = new.document_version_id;
    if not found or v_ver_bot <> v_bot then
      raise exception 'message_sources: document version does not belong to the message bot' using errcode = '23514';
    end if;
  end if;

  if new.chunk_id is not null then
    select ch.document_version_id, d.bot_id into v_chunk_ver, v_chunk_bot
      from public.document_chunks ch
      join public.document_versions v on v.id = ch.document_version_id
      join public.documents d on d.id = v.document_id
     where ch.id = new.chunk_id;
    if not found or v_chunk_bot <> v_bot then
      raise exception 'message_sources: chunk does not belong to the message bot' using errcode = '23514';
    end if;
    if new.document_version_id is not null and v_chunk_ver <> new.document_version_id then
      raise exception 'message_sources: chunk does not belong to the document version' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.message_sources_check_ownership() from public, anon, authenticated;
create trigger message_sources_check_ownership before insert or update on public.message_sources
  for each row execute function public.message_sources_check_ownership();

-- ---------------------------------------------------------------------------
-- G-5: members never read 'system' messages (plan.md section 1a). Same name, same grant.
-- ---------------------------------------------------------------------------
alter policy messages_select_members on public.messages
  using (role <> 'system' and (select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));

-- ---------------------------------------------------------------------------
-- G-6: index progress, failure and pipeline versions on document_versions. All nullable, no defaults.
-- failure_code values are the contract list. batches_done may not exceed batches_total when both are set.
-- ---------------------------------------------------------------------------
alter table public.document_versions
  add column failure_code       text,
  add column batches_done       integer,
  add column batches_total      integer,
  add column chunking_version   text,
  add column extraction_version text,
  add constraint document_versions_failure_code_check check (
    failure_code is null
    or failure_code in ('FILE_UNSUPPORTED', 'OCR_REQUIRED', 'INDEXING_FAILED', 'BUDGET_EXCEEDED', 'SUPERSEDED')),
  add constraint document_versions_batches_done_check check (batches_done is null or batches_done >= 0),
  add constraint document_versions_batches_total_check check (batches_total is null or batches_total >= 0),
  add constraint document_versions_batches_order_check check (
    batches_done is null or batches_total is null or batches_done <= batches_total),
  add constraint document_versions_chunking_version_check check (
    chunking_version is null or char_length(chunking_version) between 1 and 64),
  add constraint document_versions_extraction_version_check check (
    extraction_version is null or char_length(extraction_version) between 1 and 64);

-- ---------------------------------------------------------------------------
-- G-7: purge finished jobs. Age clock is coalesce(completed_at, created_at) (cancelled jobs may have
-- no completed_at). Bounded and lock-skipping like the other purge helpers. p_older_than_days 1..3650,
-- p_batch 1..10000, both required (no defaults). Returns the number of rows deleted.
-- ---------------------------------------------------------------------------
create index jobs_terminal_age_idx on public.jobs ((coalesce(completed_at, created_at)))
  where state in ('succeeded', 'failed', 'cancelled');

create function public.purge_terminal_jobs(p_older_than_days integer, p_batch integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare v_n integer;
begin
  if p_older_than_days is null or p_older_than_days < 1 or p_older_than_days > 3650 then
    raise exception 'purge_terminal_jobs: older-than days must be 1..3650' using errcode = '22023';
  end if;
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'purge_terminal_jobs: batch must be 1..10000' using errcode = '22023';
  end if;
  with doomed as (
    select j.id from public.jobs j
     where j.state in ('succeeded', 'failed', 'cancelled')
       and coalesce(j.completed_at, j.created_at) < now() - make_interval(days => p_older_than_days)
     order by coalesce(j.completed_at, j.created_at)
     limit p_batch
     for update skip locked
  )
  delete from public.jobs j using doomed where j.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_terminal_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.purge_terminal_jobs(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- G-8: storage_path is {bot uuid}/{document uuid}/{version uuid}/{filename}. Lowercase uuids, a
-- filename of 1..255 characters with no slash and no control character, no '..' anywhere and not '.'.
-- Validates existing rows: the remote has none.
-- ---------------------------------------------------------------------------
alter table public.document_versions
  add constraint document_versions_storage_path_check check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/[:cntrl:]]{1,255}$'
    and storage_path !~ '\.\.'
    and storage_path !~ '/\.$'
  );
