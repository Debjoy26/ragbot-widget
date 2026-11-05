-- 007: debug cycle P3-D4 (findings R4-8, R3-9, R3-4, and the R4-8 comment fix).
-- 001-006 are applied to remote projects, so fixes are forward-only. CREATE OR REPLACE keeps the owner,
-- the EXECUTE grants (service_role only) and the search_path setting of the existing functions.

-- R4-8: a NEW reservation needs a live run. The bot is part of the locking query, so a foreign run is never locked (R5-3).
-- Without this, a reaped ('failed') or finished run could
-- still get a fresh reservation. The run row is read FOR SHARE (after the settings lock, as before), so
-- the reaper (FOR UPDATE SKIP LOCKED) skips the run while a reserve is in flight, and a reserve that
-- starts after the reaper committed sees 'failed' and is refused.
-- The existing-reservation early return is unchanged: an idempotent retry still returns the
-- reservation whatever the run state is now (the reply may be finishing after the run was reaped).
create or replace function public.reserve_request_budget(
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

-- R3-9: request_runs.state moves forward only. reserved -> running, and reserved or running -> a
-- terminal state (succeeded, failed, partial: see request_runs_state_check in 001). A terminal run never
-- changes state again, and running never goes back to reserved. A no-op update of state is allowed.
-- Fires on UPDATE OF state only, so other columns (finished_at, reserved_tokens) are not affected.
create function public.request_runs_check_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state is not distinct from old.state then
    return new;
  end if;
  if old.state = 'reserved' and new.state = 'running' then
    return new;
  end if;
  if old.state in ('reserved', 'running') and new.state in ('succeeded', 'failed', 'partial') then
    return new;
  end if;
  raise exception 'request_runs: state cannot change from % to %', old.state, new.state
    using errcode = '23514';
end;
$$;
revoke all on function public.request_runs_check_state_transition() from public, anon, authenticated;
create trigger request_runs_check_state_transition before update of state on public.request_runs
  for each row execute function public.request_runs_check_state_transition();

-- R3-4: comment only. The wording in 003 overstated the protection.
comment on function public.audit_logs_no_truncate() is
  'Trigger function: stops TRUNCATE of audit_logs by any role. A table owner can still drop or disable the trigger, so this is not protection against the owner.';

-- R4-8: comment only. Supersedes the 004/005 comments that say the reaper releases reservations.
comment on function public.expire_stuck_request_runs(integer, integer) is
  'Fails runs stuck in reserved/running and marks their reserved budget reservations expired (not released). An expired reservation stops counting toward the cap but remains settleable, so a slow request''s real spend is still counted. Supersedes older comments that say the reaper releases them.';
