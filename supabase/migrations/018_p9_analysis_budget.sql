-- P9-D3: analysis-specific, attempt-fenced budget and result APIs.
-- Unknown spend remains reserved conservatively; late usage is attached to its
-- original reservation rather than assigned to a retry by wall-clock windows.
alter table public.jobs add column analysis_generation integer not null default 0 check (analysis_generation >= 0);
update public.jobs set analysis_generation = greatest(attempts, 1) where type = 'analyze_conversation' and state = 'running';
create function public.bump_analysis_generation() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type = 'analyze_conversation' and new.state = 'running'
     and (old.state <> 'running' or new.attempts <> old.attempts or new.locked_by is distinct from old.locked_by) then
    new.analysis_generation := old.analysis_generation + 1;
  end if;
  return new;
end;
$$;
revoke all on function public.bump_analysis_generation() from public, anon, authenticated;
create trigger jobs_analysis_generation before update on public.jobs for each row execute function public.bump_analysis_generation();
alter table public.budget_reservations add column analysis_generation integer
  check (analysis_generation > 0);
create unique index budget_reservations_analysis_generation_key
  on public.budget_reservations(job_id, analysis_generation) where analysis_generation is not null;
alter table public.usage_events add column budget_reservation_id uuid
  references public.budget_reservations(id) on delete set null;
create unique index usage_events_analysis_reservation_key
  on public.usage_events(budget_reservation_id) where budget_reservation_id is not null;

create function public.analysis_job_fence(p_job_id uuid, p_worker text, p_generation integer)
returns table(bot_id uuid, conversation_id uuid)
language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  if not found or p_worker is null or btrim(p_worker) = '' or p_generation is null or p_generation < 1
     or v_job.type <> 'analyze_conversation' or v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker or v_job.analysis_generation <> p_generation
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp() then
    raise exception 'analysis job: lease not held' using errcode = 'RB013';
  end if;
  return query select c.bot_id, c.id from public.conversations c
    where c.id::text = v_job.payload ->> 'conversation_id'
      and c.bot_id::text = v_job.payload ->> 'bot_id' for share of c;
  if not found then
    raise exception 'analysis job: conversation not found' using errcode = 'RB037';
  end if;
end;
$$;

create function public.get_analysis_job_context(p_job_id uuid, p_worker text, p_generation integer)
returns jsonb language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_conversation uuid;
begin
  select f.conversation_id into v_conversation from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  return public.get_analysis_context(v_conversation);
end;
$$;

create function public.reserve_analysis_budget(p_job_id uuid, p_worker text, p_generation integer, p_amount numeric, p_ttl_seconds integer)
returns uuid language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot uuid; v_policy jsonb; v_cap text; v_spent numeric; v_id uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount >= 100000000
     or p_ttl_seconds is null or p_ttl_seconds not between 1 and 86400 then
    raise exception 'analysis budget: invalid amount or TTL' using errcode = '22023';
  end if;
  select f.bot_id into v_bot from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  select cs.budget_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot for update;
  v_cap := v_policy ->> 'daily_cap_usd';
  if v_cap is null or v_cap !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'analysis budget: policy missing' using errcode = 'RB002';
  end if;
  select br.id into v_id from public.budget_reservations br
    where br.job_id = p_job_id and br.analysis_generation = p_generation;
  if found then
    if exists(select 1 from public.budget_reservations br where br.id = v_id and br.state in ('reserved', 'expired'))
       and not exists(select 1 from public.usage_events ue where ue.budget_reservation_id = v_id) then
      return v_id;
    end if;
    raise exception 'analysis budget: invocation already accounted' using errcode = 'RB003';
  end if;

  update public.budget_reservations br set state = 'settled',
    amount = coalesce((select sum(ue.estimated_cost) from public.usage_events ue where ue.budget_reservation_id = br.id), br.amount)
    where br.job_id = p_job_id and br.analysis_generation is not null and br.state in ('reserved', 'expired');
  select coalesce(sum(br.amount), 0) into v_spent from public.budget_reservations br
    where br.bot_id = v_bot
      and br.created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
      and (br.state = 'settled' or (br.state = 'reserved' and (br.job_id is not null or br.expires_at > now()))
        or (br.state = 'expired' and br.job_id is not null));
  if v_spent + ceil(p_amount * 1000000) / 1000000 > v_cap::numeric then
    raise exception 'analysis budget: daily cap exceeded' using errcode = 'RB001';
  end if;
  insert into public.budget_reservations(bot_id, job_id, analysis_generation, amount, state, expires_at)
    values(v_bot, p_job_id, p_generation, ceil(p_amount * 1000000) / 1000000, 'reserved', now() + make_interval(secs => p_ttl_seconds)) returning id into v_id;
  return v_id;
end;
$$;

-- One provider invocation per analysis attempt. No lease check here: recording
-- money already spent must remain possible after takeover. It cannot write a result.
create function public.record_analysis_usage(p_job_id uuid, p_generation integer, p_reservation_id uuid,
  p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_estimated_cost numeric, p_latency_ms integer)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot uuid; v_state text; v_cost numeric;
begin
  if p_input_tokens is null or p_input_tokens < 0 or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or p_latency_ms is null or p_latency_ms < 0 or p_provider is null or char_length(p_provider) > 100
     or p_model is null or char_length(p_model) > 200 then
    raise exception 'analysis usage: invalid counts' using errcode = '22023';
  end if;
  select br.bot_id into v_bot from public.budget_reservations br
    where br.id = p_reservation_id and br.job_id = p_job_id and br.analysis_generation = p_generation;
  if not found then raise exception 'analysis usage: reservation mismatch' using errcode = 'RB003'; end if;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then raise exception 'analysis usage: policy missing' using errcode = 'RB002'; end if;
  select br.state into v_state from public.budget_reservations br where br.id = p_reservation_id for update;
  v_cost := ceil(p_estimated_cost * 1000000) / 1000000;
  insert into public.usage_events as ue(bot_id, job_id, budget_reservation_id, provider, model, operation, input_tokens, output_tokens, estimated_cost, latency_ms)
    values(v_bot, p_job_id, p_reservation_id, p_provider, p_model, 'analysis', p_input_tokens, p_output_tokens, v_cost, p_latency_ms)
    on conflict (budget_reservation_id) where budget_reservation_id is not null do update
    set input_tokens = greatest(ue.input_tokens, excluded.input_tokens), output_tokens = greatest(ue.output_tokens, excluded.output_tokens),
        estimated_cost = greatest(ue.estimated_cost, excluded.estimated_cost), latency_ms = greatest(ue.latency_ms, excluded.latency_ms);
  if v_state in ('settled', 'released') then
    update public.budget_reservations br set state = 'settled', amount = greatest(br.amount, v_cost) where br.id = p_reservation_id;
  end if;
end;
$$;

-- actual=0 releases only if no usage was recorded. A recorded zero-cost call
-- is still settled. Failed usage writes retain the worker's conservative cost.
create function public.settle_analysis_budget(p_job_id uuid, p_worker text, p_generation integer, p_reservation_id uuid, p_actual numeric)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot uuid; v_used numeric; v_state text;
begin
  if p_actual is null or p_actual < 0 or p_actual >= 100000000 then
    raise exception 'analysis budget: invalid actual cost' using errcode = '22023';
  end if;
  select f.bot_id into v_bot from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then raise exception 'analysis budget: policy missing' using errcode = 'RB002'; end if;
  select br.state into v_state from public.budget_reservations br
    where br.id = p_reservation_id and br.job_id = p_job_id and br.bot_id = v_bot and br.analysis_generation = p_generation for update;
  if not found or v_state not in ('reserved', 'expired') then
    raise exception 'analysis budget: reservation not active' using errcode = 'RB003';
  end if;
  select sum(ue.estimated_cost) into v_used from public.usage_events ue where ue.budget_reservation_id = p_reservation_id;
  update public.budget_reservations br set
    state = case when p_actual = 0 and v_used is null then 'released' else 'settled' end,
    amount = greatest(ceil(p_actual * 1000000) / 1000000, coalesce(v_used, 0)) where br.id = p_reservation_id;
end;
$$;

create function public.save_analysis_job_result(p_job_id uuid, p_worker text, p_generation integer,
  p_summary text, p_sentiment text, p_intent text, p_analysis_version text)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_conversation uuid;
begin
  select f.conversation_id into v_conversation from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  perform public.save_conversation_analysis(v_conversation, p_summary, p_sentiment, p_intent, p_analysis_version);
end;
$$;

create function public.fail_analysis_job(p_job_id uuid, p_worker text, p_generation integer)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_conversation uuid;
begin
  select f.conversation_id into v_conversation from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  perform public.fail_conversation_analysis(v_conversation);
end;
$$;

create function public.settle_orphaned_analysis_reservations(p_batch integer)
returns integer language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_ids uuid[]; v_n integer;
begin
  if p_batch is null or p_batch not between 1 and 1000 then raise exception 'analysis recovery: invalid batch' using errcode = '22023'; end if;
  select array_agg(x.id) into v_ids from (
    select br.id from public.budget_reservations br where br.analysis_generation is not null and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running' and j.analysis_generation = br.analysis_generation)
      order by br.created_at, br.id limit p_batch for update of br skip locked) x;
  update public.budget_reservations br set state = 'settled',
    amount = coalesce((select sum(ue.estimated_cost) from public.usage_events ue where ue.budget_reservation_id = br.id), br.amount)
    where br.id = any(v_ids) and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running' and j.analysis_generation = br.analysis_generation);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The old indexing sweep must never interpret analysis reservations as index
-- spend. Preserve its implementation and add only the analysis exclusion.
create or replace function public.settle_orphaned_index_reservations(p_batch integer)
returns integer
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_n   integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'settle_orphaned_index_reservations: batch (1..1000) is required' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
    from (select br.id
            from public.budget_reservations br
           where br.analysis_generation is null and br.analysis_generation is null and br.job_id is not null
             and br.state in ('reserved', 'expired')
             and (exists (select 1 from public.budget_reservations n
                           where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id))
                  or not exists (select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'))
           order by br.created_at, br.id
           limit p_batch
             for update of br skip locked) x;

  update public.budget_reservations br
     set state = 'settled',
         amount = least(
           (select coalesce(sum(ue.estimated_cost), 0)
              from public.usage_events ue
             where ue.job_id = br.job_id
               and ue.operation = 'embedding_index'
               and ue.created_at >= br.created_at
               and ue.created_at < coalesce((select min(n.created_at) from public.budget_reservations n
                                              where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id)),
                                            'infinity'::timestamptz)),
           99999999.999999)
   where br.id = any (v_ids)
     and br.analysis_generation is null and br.job_id is not null
     and br.state in ('reserved', 'expired')
     and (exists (select 1 from public.budget_reservations n
                   where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id))
          or not exists (select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.analysis_job_fence(uuid,text,integer), public.get_analysis_job_context(uuid,text,integer),
  public.reserve_analysis_budget(uuid,text,integer,numeric,integer), public.record_analysis_usage(uuid,integer,uuid,text,text,integer,integer,numeric,integer),
  public.settle_analysis_budget(uuid,text,integer,uuid,numeric), public.save_analysis_job_result(uuid,text,integer,text,text,text,text),
  public.fail_analysis_job(uuid,text,integer), public.settle_orphaned_analysis_reservations(integer) from public, anon, authenticated;
grant execute on function public.analysis_job_fence(uuid,text,integer), public.get_analysis_job_context(uuid,text,integer),
  public.reserve_analysis_budget(uuid,text,integer,numeric,integer), public.record_analysis_usage(uuid,integer,uuid,text,text,integer,integer,numeric,integer),
  public.settle_analysis_budget(uuid,text,integer,uuid,numeric), public.save_analysis_job_result(uuid,text,integer,text,text,text,text),
  public.fail_analysis_job(uuid,text,integer), public.settle_orphaned_analysis_reservations(integer) to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 18; $$;
