-- T07: warm reservation schema and reserve RPC (per-question, generation-bound).
-- One reservation per (job, generation, question); the allowance is immutable
-- (settle writes actuals to usage in T09, never mutates the reservation).
-- Reservations count toward the same daily cap as chat/index/analysis. No
-- browser access; service_role only.
alter table public.budget_reservations
  add column warm_generation integer check (warm_generation > 0),
  add column question_hash text check (question_hash ~ '^[0-9a-f]{64}$'),
  add constraint budget_reservations_warm_check check (
    (warm_generation is null) = (question_hash is null)),
  add constraint budget_reservations_warm_analysis_check check (
    not (analysis_generation is not null and warm_generation is not null));

-- The 009 one-active-reservation-per-job rule covers index_document claims.
-- Warm claims reserve per question, so narrow it to non-warm rows and give warm
-- rows their own per-(job, generation, question) key.
drop index public.budget_reservations_job_id_key;
create unique index budget_reservations_job_id_key on public.budget_reservations (job_id)
  where job_id is not null and state = 'reserved' and warm_generation is null;
create unique index budget_reservations_warm_key on public.budget_reservations
  (job_id, warm_generation, question_hash) where warm_generation is not null;

-- reserve_warm_budget: generation- and question-bound reservation for one warm
-- invocation. Same settings lock, same cap and the same spend sum as the other
-- reserve paths. Idempotent per (job, generation, question): an unaccounted
-- reservation is returned as-is, so a duplicate cannot spend twice; an
-- already-accounted one is rejected. A disabled bot, a switched-off policy or
-- a superseded version returns null (no spend), like queue_warm_job.
create function public.reserve_warm_budget(p_job_id uuid, p_worker text, p_generation integer,
  p_question_hash text, p_amount numeric, p_ttl_seconds integer)
returns uuid language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare
  v_job public.jobs%rowtype;
  v_job_found boolean;
  v_bot_id uuid;
  v_bot public.bot_profiles%rowtype;
  v_cache_policy jsonb;
  v_budget_policy jsonb;
  v_cap text;
  v_spent numeric;
  v_day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_existing uuid;
  v_existing_state text;
  v_rounded numeric;
  v_id uuid;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_question_hash is null or p_question_hash !~ '^[0-9a-f]{64}$'
     or p_amount is null or p_amount <= 0 or p_amount >= 100000000
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'warm budget: job, worker, generation, question hash, positive amount and ttl (1..86400s) are required'
      using errcode = '22023';
  end if;

  -- Lease first (fence order): only the holder of the live claim may reserve.
  -- Precise failures: unknown/wrong-type job (RB004), malformed payload
  -- (22023), then liveness of the held claim (RB013).
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  v_job_found := found;
  if not v_job_found then
    raise exception 'warm budget: job not found for bot' using errcode = 'RB004';
  end if;
  begin v_bot_id := (v_job.payload->>'bot_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'warm budget: invalid payload' using errcode = '22023';
  end;
  if v_bot_id is null then
    raise exception 'warm budget: invalid payload' using errcode = '22023';
  end if;
  if v_job.type is distinct from 'warm_answer_cache' then
    raise exception 'warm budget: job not found for bot' using errcode = 'RB004';
  end if;
  if v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker
     or v_job.warm_generation <> p_generation
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp() then
    raise exception 'warm budget: lease not held' using errcode = 'RB013';
  end if;

  -- Serialize on client_settings, then the bot row, then recheck the snapshot.
  select cs.cache_policy, cs.budget_policy into v_cache_policy, v_budget_policy
    from public.client_settings cs where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm budget: no client settings for bot' using errcode = 'RB002';
  end if;
  v_cap := v_budget_policy ->> 'daily_cap_usd';
  if v_cap is null or v_cap !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'warm budget: daily cap is missing or invalid' using errcode = 'RB002';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm budget: job not found for bot' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_cache_policy)
     or (v_job.payload->>'corpus_version') is distinct from v_bot.corpus_version::text
     or (v_job.payload->>'settings_version') is distinct from v_bot.settings_version::text then
    return null;
  end if;

  -- Idempotent per (job, generation, question). A settled or released row means
  -- this invocation was already accounted: it cannot reserve again.
  select br.id, br.state into v_existing, v_existing_state from public.budget_reservations br
   where br.job_id = p_job_id and br.warm_generation = p_generation
     and br.question_hash = p_question_hash;
  if found then
    if v_existing_state in ('reserved', 'expired') then
      return v_existing;
    end if;
    raise exception 'warm budget: invocation already accounted' using errcode = 'RB003';
  end if;

  select coalesce(sum(br.amount), 0) into v_spent
    from public.budget_reservations br
   where br.bot_id = v_bot_id
     and br.created_at >= v_day
     and (br.state = 'settled' or (br.state = 'reserved' and br.expires_at > now())
          -- A stale worker can still settle a lapsed job reservation, so it keeps
          -- counting until the day ends.
          or (br.state = 'expired' and br.job_id is not null));

  v_rounded := ceil(p_amount * 1000000) / 1000000;
  if v_spent + v_rounded > v_cap::numeric then
    raise exception 'warm budget: daily budget exceeded' using errcode = 'RB001';
  end if;

  insert into public.budget_reservations
    (bot_id, job_id, warm_generation, question_hash, amount, state, expires_at)
    values (v_bot_id, p_job_id, p_generation, p_question_hash,
      v_rounded, 'reserved', now() + make_interval(secs => p_ttl_seconds))
    returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.reserve_warm_budget(uuid,text,integer,text,numeric,integer)
  from public, anon, authenticated;
grant execute on function public.reserve_warm_budget(uuid,text,integer,text,numeric,integer)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 21; $$;
