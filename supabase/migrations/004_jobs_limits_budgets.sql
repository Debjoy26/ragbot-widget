-- 004_jobs_limits_budgets.sql — mutation RPCs for the API/worker. EXECUTE: service_role ONLY.
-- All functions are SECURITY INVOKER (they run with the service role's privileges; no escalation),
-- have a fixed empty search_path, and use fully qualified names.
--
-- Custom SQLSTATEs (stable contract for api/ P5):
--   RB001  budget_exceeded           reserve_request_budget: daily cap would be exceeded
--   RB002  budget_policy_missing     reserve_request_budget: client_settings/daily cap missing or invalid (fail closed)
--   RB003  reservation_not_active    settle/release on a reservation that is not in state 'reserved'
--   RB004  request_conflict          reserve_request_budget: request missing, wrong bot, or reservation not reusable
--   RB010  document_not_found        activate/mark_deleted: unknown or deleted document / wrong version
--   RB011  activation_failed         activate_document_version: validation failed (chunk count, status)

-- ---------------------------------------------------------------------------
-- claim_jobs: atomically claim due work with a lease. FOR UPDATE SKIP LOCKED, so concurrent
-- workers never receive the same job. Expired leases (state 'running', locked_until < now())
-- are recoverable; once attempts reach max_attempts an expired job is dead-lettered ('failed').
-- p_limit 1..100, p_lease_seconds 1..3600; no defaults (fail closed).
-- ---------------------------------------------------------------------------
create function public.claim_jobs(
  p_worker        text,
  p_limit         integer,
  p_lease_seconds integer,
  p_types         text[] default null
)
returns setof public.jobs
language plpgsql
set search_path = ''
as $$
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'claim_jobs: worker id is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'claim_jobs: limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'claim_jobs: lease seconds must be between 1 and 3600' using errcode = '22023';
  end if;

  -- Dead-letter expired leases that have no attempts left.
  update public.jobs j
     set state = 'failed',
         locked_until = null,
         locked_by = null,
         completed_at = now(),
         last_error = 'lease expired; max attempts reached'
   where j.id in (
     select x.id from public.jobs x
      where x.state = 'running'
        and x.locked_until < now()
        and x.attempts >= x.max_attempts
        and (p_types is null or x.type = any (p_types))
      for update skip locked
   );

  return query
  with due as (
    select j.id
      from public.jobs j
     where j.attempts < j.max_attempts
       and (p_types is null or j.type = any (p_types))
       and (
         (j.state = 'queued' and j.available_at <= now())
         or (j.state = 'running' and j.locked_until < now())
       )
     order by j.available_at, j.created_at
     limit p_limit
     for update skip locked
  )
  update public.jobs j
     set state = 'running',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds)
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- activate_document_version: atomic pointer switch. All-or-nothing in one transaction:
-- any validation failure raises and leaves the previously active version untouched
-- (handover §4.10). Increments bot_profiles.corpus_version in the same transaction.
-- Idempotent: re-activating the already-active version returns the current corpus_version.
-- Returns the bot's corpus_version after activation.
-- ---------------------------------------------------------------------------
create function public.activate_document_version(
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
  v_chunks  integer;
  v_corpus  bigint;
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

  if v_ver.status <> 'embedding' then
    raise exception 'activate_document_version: version status must be embedding' using errcode = 'RB011';
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
-- mark_document_deleted: immediately exclude from retrieval (deleted_at / status), bump
-- corpus_version in the same transaction, then enqueue one cleanup job (deduped).
-- p_cleanup_max_attempts comes from validated API config (no DB default).
-- Idempotent: an already-deleted document is not bumped again.
-- ---------------------------------------------------------------------------
create function public.mark_document_deleted(
  p_document_id         uuid,
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
    jsonb_build_object('document_id', p_document_id, 'bot_id', v_doc.bot_id),
    p_cleanup_max_attempts
  )
  on conflict (dedupe_key) do nothing;

  return v_corpus;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_request_budget: atomic daily-cap check + reservation before any external call.
-- Serialised per bot by locking the client_settings row. Fails CLOSED:
--   no client_settings row, or budget_policy.daily_cap_usd missing/non-numeric/negative -> RB002.
-- Cap exceeded -> RB001. Spend so far (UTC day) = settled + unexpired reserved amounts.
-- A second call for the same request_id returns the existing active reservation without
-- adding spend (an idempotent retry cannot spend twice).
-- ---------------------------------------------------------------------------
create function public.reserve_request_budget(
  p_bot_id      uuid,
  p_request_id  uuid,
  p_amount      numeric,
  p_ttl_seconds integer
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_policy   jsonb;
  v_cap_text text;
  v_cap      numeric;
  v_spent    numeric;
  v_day      timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_existing public.budget_reservations%rowtype;
  v_run_bot  uuid;
  v_id       uuid;
begin
  if p_bot_id is null or p_request_id is null or p_amount is null or p_amount <= 0
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'reserve_request_budget: bot, request, positive amount and ttl (1..86400s) are required'
      using errcode = '22023';
  end if;

  select cs.budget_policy into v_policy
    from public.client_settings cs where cs.bot_id = p_bot_id for update;
  if not found then
    raise exception 'reserve_request_budget: no client settings for bot' using errcode = 'RB002';
  end if;

  v_cap_text := v_policy ->> 'daily_cap_usd';
  if v_cap_text is null or v_cap_text !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'reserve_request_budget: daily cap is missing or invalid' using errcode = 'RB002';
  end if;
  v_cap := v_cap_text::numeric;

  select r.bot_id into v_run_bot from public.request_runs r where r.id = p_request_id;
  if v_run_bot is null or v_run_bot <> p_bot_id then
    raise exception 'reserve_request_budget: request not found for bot' using errcode = 'RB004';
  end if;

  select * into v_existing from public.budget_reservations br where br.request_id = p_request_id;
  if found then
    if v_existing.bot_id = p_bot_id and v_existing.state in ('reserved', 'settled') then
      return v_existing.id;
    end if;
    raise exception 'reserve_request_budget: existing reservation is not reusable' using errcode = 'RB004';
  end if;

  select coalesce(sum(br.amount), 0) into v_spent
    from public.budget_reservations br
   where br.bot_id = p_bot_id
     and br.created_at >= v_day
     and (br.state = 'settled' or (br.state = 'reserved' and br.expires_at > now()));

  if v_spent + p_amount > v_cap then
    raise exception 'reserve_request_budget: daily budget exceeded' using errcode = 'RB001';
  end if;

  insert into public.budget_reservations (bot_id, request_id, amount, state, expires_at)
  values (p_bot_id, p_request_id, p_amount, 'reserved', now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;

  return v_id;
end;
$$;

-- Reconcile a reservation with the actual (conservatively estimated) cost.
create function public.settle_budget_reservation(p_reservation_id uuid, p_actual_amount numeric)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reservation_id is null or p_actual_amount is null or p_actual_amount < 0 then
    raise exception 'settle_budget_reservation: reservation and non-negative amount are required'
      using errcode = '22023';
  end if;
  update public.budget_reservations
     set state = 'settled', amount = p_actual_amount
   where id = p_reservation_id and state = 'reserved';
  if not found then
    raise exception 'settle_budget_reservation: reservation is not active' using errcode = 'RB003';
  end if;
end;
$$;

create function public.release_budget_reservation(p_reservation_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reservation_id is null then
    raise exception 'release_budget_reservation: reservation is required' using errcode = '22023';
  end if;
  update public.budget_reservations set state = 'released'
   where id = p_reservation_id and state = 'reserved';
  if not found then
    raise exception 'release_budget_reservation: reservation is not active' using errcode = 'RB003';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_rate_limit_attempt: atomic fixed-window counter (upsert). Always counts the attempt;
-- returns the post-increment count and whether it is within p_limit. p_key_hash must be a
-- 64-char lowercase hex digest (table CHECK) so plain IPs/identifiers cannot be stored.
-- ---------------------------------------------------------------------------
create function public.record_rate_limit_attempt(
  p_key_hash       text,
  p_window_seconds integer,
  p_limit          integer
)
returns table (request_count integer, allowed boolean, window_start timestamptz, window_expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'record_rate_limit_attempt: key must be a 64-char lowercase hex digest' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'record_rate_limit_attempt: window must be 1..86400 seconds' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'record_rate_limit_attempt: limit must be positive' using errcode = '22023';
  end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_buckets as b (key_hash, window_start, window_seconds, request_count, expires_at)
  values (p_key_hash, v_start, p_window_seconds, 1, v_start + make_interval(secs => p_window_seconds))
  on conflict (key_hash, window_start, window_seconds)
  do update set request_count = b.request_count + 1
  returning b.request_count into v_count;

  return query
  select v_count, v_count <= p_limit, v_start, v_start + make_interval(secs => p_window_seconds);
end;
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE: service_role only. Postgres grants EXECUTE to PUBLIC by default; revoke explicitly.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_jobs(text, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.activate_document_version(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_document_deleted(uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_request_budget(uuid, uuid, numeric, integer) from public, anon, authenticated;
revoke all on function public.settle_budget_reservation(uuid, numeric) from public, anon, authenticated;
revoke all on function public.release_budget_reservation(uuid) from public, anon, authenticated;
revoke all on function public.record_rate_limit_attempt(text, integer, integer) from public, anon, authenticated;

grant execute on function public.claim_jobs(text, integer, integer, text[]) to service_role;
grant execute on function public.activate_document_version(uuid, uuid, integer) to service_role;
grant execute on function public.mark_document_deleted(uuid, integer) to service_role;
grant execute on function public.reserve_request_budget(uuid, uuid, numeric, integer) to service_role;
grant execute on function public.settle_budget_reservation(uuid, numeric) to service_role;
grant execute on function public.release_budget_reservation(uuid) to service_role;
grant execute on function public.record_rate_limit_attempt(text, integer, integer) to service_role;
