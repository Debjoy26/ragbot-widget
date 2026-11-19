-- T09: warm settlement and recovery. A fenced settle reconciles one warm
-- invocation against its recorded usage; an orphan sweep settles reservations
-- whose claim can no longer settle them. Unknown or late spend keeps its
-- conservative charge (the reservation estimate when nothing was recorded).
-- The indexing sweep must never interpret warm reservations as index spend.
-- No browser access; service_role only.
create function public.settle_warm_budget(p_job_id uuid, p_worker text, p_generation integer,
  p_question_hash text, p_reservation_id uuid, p_actual numeric)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot uuid; v_used numeric; v_state text;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_question_hash is null or p_question_hash !~ '^[0-9a-f]{64}$'
     or p_reservation_id is null or p_actual is null or p_actual < 0 or p_actual >= 100000000 then
    raise exception 'warm budget: invalid settle request' using errcode = '22023';
  end if;
  select public.warm_job_fence(p_job_id, p_worker, p_generation) into v_bot;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then raise exception 'warm budget: policy missing' using errcode = 'RB002'; end if;
  select br.state into v_state from public.budget_reservations br
   where br.id = p_reservation_id and br.job_id = p_job_id and br.bot_id = v_bot
     and br.warm_generation = p_generation and br.question_hash = p_question_hash for update;
  if not found or v_state not in ('reserved', 'expired') then
    raise exception 'warm budget: reservation not active' using errcode = 'RB003';
  end if;
  select sum(ue.estimated_cost) into v_used from public.usage_events ue
   where ue.warm_reservation_id = p_reservation_id;

  -- actual=0 releases only if no usage was recorded. A recorded zero-cost call
  -- is still settled. Failed usage writes retain the worker's conservative cost.
  update public.budget_reservations br set
    state = case when p_actual = 0 and v_used is null then 'released' else 'settled' end,
    amount = greatest(ceil(p_actual * 1000000) / 1000000, coalesce(v_used, 0))
    where br.id = p_reservation_id;
end;
$$;

create function public.settle_orphaned_warm_reservations(p_batch integer)
returns integer language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_ids uuid[]; v_n integer;
begin
  if p_batch is null or p_batch not between 1 and 1000 then
    raise exception 'warm recovery: invalid batch' using errcode = '22023';
  end if;
  select array_agg(x.id) into v_ids from (
    select br.id from public.budget_reservations br where br.warm_generation is not null
      and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'
        and j.warm_generation = br.warm_generation)
      order by br.created_at, br.id limit p_batch for update of br skip locked) x;
  update public.budget_reservations br set state = 'settled',
    amount = coalesce((select sum(ue.estimated_cost) from public.usage_events ue
      where ue.warm_reservation_id = br.id), br.amount)
    where br.id = any(v_ids) and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'
        and j.warm_generation = br.warm_generation);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The old indexing sweep must never interpret warm reservations as index
-- spend. Preserve its implementation and add only the warm exclusion.
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
           where br.analysis_generation is null and br.warm_generation is null and br.job_id is not null
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
      and br.analysis_generation is null and br.warm_generation is null and br.job_id is not null
      and br.state in ('reserved', 'expired')
      and (exists (select 1 from public.budget_reservations n
                    where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id))
           or not exists (select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.settle_warm_budget(uuid,text,integer,text,uuid,numeric),
  public.settle_orphaned_warm_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.settle_warm_budget(uuid,text,integer,text,uuid,numeric),
  public.settle_orphaned_warm_reservations(integer)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 23; $$;
