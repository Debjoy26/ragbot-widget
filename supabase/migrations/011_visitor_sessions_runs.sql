-- 011: P5 data layer for the visitor API (ADR 0007, 0010; status 3a items ae, am, az, bf).
-- Forward-only: 001-010 are never edited. Everything here is SECURITY INVOKER with an empty search_path,
-- EXECUTE for service_role only (the API role). Every function sets lock_timeout = '2s', so a stuck
-- lock fails the request with 55P03 instead of holding a pooled connection (bf, az).
-- New SQLSTATE (contract): RB039 bot_disabled. Existing: RB036 policy_missing (session policy absent or
-- invalid), 22023 bad argument, 23514 forbidden run-state move (007 trigger).
--
-- Disabled-bot rule: a bot that is disabled or switched off during a request must not start new work.
-- The functions that start work (create_visitor_session, begin_request_run, reserve_request_budget) read
-- bot_profiles.enabled with FOR SHARE, which conflicts with the UPDATE that admin_set_bot_enabled runs.
-- So a start either sees the bot disabled, or finishes before the disable commits. Lock order is always
-- bot_profiles, then visitor_sessions or client_settings, then request_runs (the order admin writers use).
-- A bot that does not exist keeps each function's earlier outcome (RB004 or RB002); only a disabled bot
-- raises RB039. Finishing work already started (set_request_run_state, settle, release) is not blocked.

-- ---------------------------------------------------------------------------
-- get_session_policy: what POST /session needs before it creates anything. Unknown slug: no rows.
-- A disabled bot still returns its row (enabled = false), the API decides the answer.
-- turnstile_required fails closed: only a JSON boolean false in feature_flags turns the check off (ADR 0010).
-- The per-IP session limit comes from rate_policy.session_create_per_ip and must be complete:
-- {"limit": positive integer, "window_seconds": 1..86400}. Anything else is RB036, and so is a bot with
-- no client_settings row.
-- ---------------------------------------------------------------------------
create function public.get_session_policy(p_bot_slug text)
returns table (bot_id uuid, enabled boolean, turnstile_required boolean, session_limit integer, session_window_seconds integer)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_bot_id  uuid;
  v_enabled boolean;
  v_rate    jsonb;
  v_flags   jsonb;
  v_pol     jsonb;
  v_limit   text;
  v_window  text;
begin
  if p_bot_slug is null or p_bot_slug = '' then
    raise exception 'get_session_policy: bot slug is required' using errcode = '22023';
  end if;

  select b.id, b.enabled into v_bot_id, v_enabled from public.bot_profiles b where b.slug = p_bot_slug;
  if not found then
    return;
  end if;

  select cs.rate_policy, cs.feature_flags into v_rate, v_flags
    from public.client_settings cs where cs.bot_id = v_bot_id;
  if not found then
    raise exception 'get_session_policy: no client settings for bot' using errcode = 'RB036';
  end if;

  v_pol := v_rate -> 'session_create_per_ip';
  if v_pol is null or jsonb_typeof(v_pol) <> 'object'
     or jsonb_typeof(v_pol -> 'limit') is distinct from 'number'
     or jsonb_typeof(v_pol -> 'window_seconds') is distinct from 'number' then
    raise exception 'get_session_policy: session_create_per_ip is missing or invalid' using errcode = 'RB036';
  end if;
  v_limit  := v_pol ->> 'limit';
  v_window := v_pol ->> 'window_seconds';
  if v_limit !~ '^[1-9][0-9]{0,8}$' or v_window !~ '^[1-9][0-9]{0,5}$' or v_window::integer > 86400 then
    raise exception 'get_session_policy: session_create_per_ip is missing or invalid' using errcode = 'RB036';
  end if;

  return query select v_bot_id, v_enabled,
    case when jsonb_typeof(v_flags -> 'turnstile_required') = 'boolean'
         then (v_flags ->> 'turnstile_required')::boolean else true end,
    v_limit::integer, v_window::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_visitor_session: inserts a session row (token_version 1) and returns it. The signed token is the
-- API's business. Refused (RB039) for a missing or disabled bot. ttl 60..86400 seconds.
-- ---------------------------------------------------------------------------
create function public.create_visitor_session(p_bot_id uuid, p_ttl_seconds integer)
returns table (session_id uuid, token_version integer, expires_at timestamptz)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_enabled boolean;
  v_id      uuid;
  v_version integer;
  v_expires timestamptz;
begin
  if p_bot_id is null or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'create_visitor_session: bot and ttl (60..86400s) are required' using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id for share;
  if not found or not v_enabled then
    raise exception 'create_visitor_session: bot is disabled or unknown' using errcode = 'RB039';
  end if;

  insert into public.visitor_sessions as s (bot_id, expires_at)
  values (p_bot_id, now() + make_interval(secs => p_ttl_seconds))
  returning s.id, s.token_version, s.expires_at into v_id, v_version, v_expires;

  return query select v_id, v_version, v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_rate_policy: the bot's rate_policy object. Missing or disabled bot: RB039. No settings row: RB036.
-- ---------------------------------------------------------------------------
create function public.get_rate_policy(p_bot_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_enabled boolean;
  v_rate    jsonb;
begin
  if p_bot_id is null then
    raise exception 'get_rate_policy: bot is required' using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id;
  if not found or not v_enabled then
    raise exception 'get_rate_policy: bot is disabled or unknown' using errcode = 'RB039';
  end if;

  select cs.rate_policy into v_rate from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'get_rate_policy: no client settings for bot' using errcode = 'RB036';
  end if;
  return v_rate;
end;
$$;

-- ---------------------------------------------------------------------------
-- begin_request_run: 004's function, same signature and outcomes, plus the disabled-bot check (RB039).
-- The bot row is read FOR SHARE before the session row is locked.
-- ---------------------------------------------------------------------------
create or replace function public.begin_request_run(
  p_bot_id             uuid,
  p_visitor_session_id uuid,
  p_token_version      integer,
  p_idempotency_key    text,
  p_request_hash       text
)
returns table (run_id uuid, outcome text)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_sess     public.visitor_sessions%rowtype;
  v_enabled  boolean;
  v_cap_text text;
  v_cap      integer;
  v_existing public.request_runs%rowtype;
  v_active   integer;
  v_id       uuid;
begin
  if p_bot_id is null or p_visitor_session_id is null or p_token_version is null or p_token_version < 1
     or p_idempotency_key is null or p_request_hash is null
     or p_idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'begin_request_run: bot, session, token version, canonical uuid idempotency key and sha256 hex hash are required'
      using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id for share;
  if found and not v_enabled then
    raise exception 'begin_request_run: bot is disabled' using errcode = 'RB039';
  end if;

  select * into v_sess from public.visitor_sessions s
   where s.id = p_visitor_session_id and s.bot_id = p_bot_id for update;
  if not found or v_sess.revoked_at is not null or v_sess.expires_at <= now()
     or v_sess.token_version <> p_token_version then
    raise exception 'begin_request_run: visitor session is not valid' using errcode = 'RB004';
  end if;

  select cs.rate_policy ->> 'concurrent_requests_per_session' into v_cap_text
    from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'begin_request_run: no client settings for bot' using errcode = 'RB002';
  end if;
  if v_cap_text is null or v_cap_text !~ '^[1-9][0-9]{0,3}$' then
    raise exception 'begin_request_run: concurrent_requests_per_session is missing or invalid' using errcode = 'RB002';
  end if;
  v_cap := v_cap_text::integer;

  select * into v_existing from public.request_runs r
   where r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash = p_request_hash then
      return query select v_existing.id, 'duplicate'::text;
    else
      return query select null::uuid, 'hash_mismatch'::text;
    end if;
    return;
  end if;

  select count(*)::integer into v_active from public.request_runs r
   where r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id
     and r.state in ('running', 'reserved');
  if v_active >= v_cap then
    return query select null::uuid, 'concurrency_limited'::text;
    return;
  end if;

  insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash)
  values (p_bot_id, p_visitor_session_id, p_idempotency_key, p_request_hash)
  returning id into v_id;
  return query select v_id, 'new'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_request_budget: 007's function, same signature and behaviour, plus the disabled-bot check (RB039)
-- and lock_timeout. The bot row is read FOR SHARE first, then the settings row FOR UPDATE as before.
-- A reserve that is an idempotent retry is refused too when the bot is disabled (no new work for a disabled bot).
-- ---------------------------------------------------------------------------
create or replace function public.reserve_request_budget(
  p_bot_id      uuid,
  p_request_id  uuid,
  p_amount      numeric,
  p_ttl_seconds integer
)
returns uuid
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_enabled   boolean;
  v_policy    jsonb;
  v_cap_text  text;
  v_cap       numeric;
  v_spent     numeric;
  v_day       timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_existing  public.budget_reservations%rowtype;
  v_run_state text;
  v_id        uuid;
begin
  if p_bot_id is null or p_request_id is null or p_amount is null or p_amount <= 0
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'reserve_request_budget: bot, request, positive amount and ttl (1..86400s) are required'
      using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id for share;
  if found and not v_enabled then
    raise exception 'reserve_request_budget: bot is disabled' using errcode = 'RB039';
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

  select r.state into v_run_state
    from public.request_runs r where r.id = p_request_id and r.bot_id = p_bot_id
    for share;
  if not found then
    raise exception 'reserve_request_budget: request not found for bot' using errcode = 'RB004';
  end if;

  select * into v_existing from public.budget_reservations br where br.request_id = p_request_id;
  if found then
    if v_existing.bot_id = p_bot_id and v_existing.state in ('reserved', 'settled') then
      return v_existing.id;
    end if;
    raise exception 'reserve_request_budget: existing reservation is not reusable' using errcode = 'RB004';
  end if;

  -- New reservation only: the run must still be live.
  if v_run_state not in ('reserved', 'running') then
    raise exception 'reserve_request_budget: request is not active' using errcode = 'RB004';
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

-- ---------------------------------------------------------------------------
-- set_request_run_state: moves a live run (reserved or running) of this bot to a new state; true if it
-- moved, false if the run is unknown, belongs to another bot, is already terminal, or is already in the
-- target state. The 007 trigger decides which moves are allowed (reserved -> running, live -> terminal);
-- the row lock makes concurrent callers take turns, so exactly one of them moves a run to a given state.
-- Target: running, succeeded, failed or partial (anything else is 22023). A terminal target sets finished_at.
-- ---------------------------------------------------------------------------
create function public.set_request_run_state(p_bot_id uuid, p_run_id uuid, p_state text)
returns boolean
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_bot_id is null or p_run_id is null or p_state is null
     or p_state not in ('running', 'succeeded', 'failed', 'partial') then
    raise exception 'set_request_run_state: bot, run and a target state (running, succeeded, failed, partial) are required'
      using errcode = '22023';
  end if;

  update public.request_runs r
     set state = p_state,
         finished_at = case when p_state = 'running' then r.finished_at else now() end
   where r.id = p_run_id and r.bot_id = p_bot_id
     and r.state in ('reserved', 'running') and r.state <> p_state;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_request_run: the run's state, and the latest assistant message that carries request_id = the run
-- (with its conversation, which must belong to the same bot). The message columns are null when there is none.
-- Wrong bot or unknown run: no rows.
-- ---------------------------------------------------------------------------
create function public.get_request_run(p_bot_id uuid, p_run_id uuid)
returns table (run_state text, conversation_id uuid, message_id uuid, message_status text)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_bot_id is null or p_run_id is null then
    raise exception 'get_request_run: bot and run are required' using errcode = '22023';
  end if;

  return query
  select r.state, m.conversation_id, m.id, m.status
    from public.request_runs r
    left join lateral (
      select am.conversation_id, am.id, am.status
        from public.messages am
        join public.conversations c on c.id = am.conversation_id and c.bot_id = r.bot_id
       where am.request_id = r.id and am.role = 'assistant'
       order by am.created_at desc, am.id desc
       limit 1
    ) m on true
   where r.id = p_run_id and r.bot_id = p_bot_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- schema_version: 010 says to raise it with every new migration (220 compares it with the migration history).
-- Grants (authenticated only) are kept by create or replace.
-- ---------------------------------------------------------------------------
create or replace function public.schema_version()
returns integer
language sql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
  select 11;
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE: service_role only. Postgres grants EXECUTE to PUBLIC on new functions by default; revoke it.
-- (begin_request_run and reserve_request_budget keep the grants from 004; create or replace does not change them.)
-- ---------------------------------------------------------------------------
revoke all on function public.get_session_policy(text) from public, anon, authenticated;
revoke all on function public.create_visitor_session(uuid, integer) from public, anon, authenticated;
revoke all on function public.get_rate_policy(uuid) from public, anon, authenticated;
revoke all on function public.set_request_run_state(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_request_run(uuid, uuid) from public, anon, authenticated;

grant execute on function public.get_session_policy(text) to service_role;
grant execute on function public.create_visitor_session(uuid, integer) to service_role;
grant execute on function public.get_rate_policy(uuid) to service_role;
grant execute on function public.set_request_run_state(uuid, uuid, text) to service_role;
grant execute on function public.get_request_run(uuid, uuid) to service_role;
