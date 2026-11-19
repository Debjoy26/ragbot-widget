-- T08: per-invocation warm usage ledger. A pending charge is registered before
-- each provider call; the final report upserts the same (reservation,
-- invocation) row, so retries never double-count and late reports stay bound
-- to their original reservation. Finalized spend only grows (greatest merge).
-- No lease check here: money already spent must remain recordable after a
-- takeover. Settlement lives in T09. No browser access; service_role only.
alter table public.usage_events
  add column warm_reservation_id uuid references public.budget_reservations (id) on delete set null,
  add column warm_invocation_id uuid,
  add column state text not null default 'final' check (state in ('pending', 'final')),
  add constraint usage_events_warm_purpose_check check (
    not (budget_reservation_id is not null and warm_reservation_id is not null));
create unique index usage_events_warm_invocation_key
  on public.usage_events (warm_reservation_id, warm_invocation_id)
  where warm_reservation_id is not null;

-- record_warm_usage: idempotent per (reservation, invocation) ledger write.
-- p_final=false registers the pending charge (zero counts allowed); p_final=true
-- records the real cost. Repeating a final report merges with greatest(), so a
-- late or retried report can never shrink finalized spend.
create function public.record_warm_usage(p_job_id uuid, p_generation integer, p_question_hash text,
  p_reservation_id uuid, p_invocation_id uuid, p_provider text, p_model text, p_operation text,
  p_input_tokens integer, p_output_tokens integer, p_estimated_cost numeric, p_latency_ms integer,
  p_final boolean)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare
  v_bot uuid;
  v_cost numeric;
begin
  if p_job_id is null or p_generation is null or p_generation < 1
     or p_question_hash is null or p_question_hash !~ '^[0-9a-f]{64}$'
     or p_reservation_id is null or p_invocation_id is null
     or p_provider is null or char_length(p_provider) > 100
     or p_model is null or char_length(p_model) > 200
     or p_operation is null or p_operation not in
       ('chat', 'embedding_query', 'embedding_index', 'moderation', 'analysis', 'answer_cache_hit')
     or p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or p_latency_ms is null or p_latency_ms < 0 or p_final is null then
    raise exception 'warm usage: invalid invocation report' using errcode = '22023';
  end if;

  -- Original binding only: the reservation must belong to this job, generation
  -- and question. No lease or job-state check, so a late report after a
  -- takeover still lands on its own reservation.
  select br.bot_id into v_bot from public.budget_reservations br
   where br.id = p_reservation_id and br.job_id = p_job_id
     and br.warm_generation = p_generation and br.question_hash = p_question_hash;
  if not found then
    raise exception 'warm usage: reservation mismatch' using errcode = 'RB003';
  end if;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then
    raise exception 'warm usage: policy missing' using errcode = 'RB002';
  end if;
  perform 1 from public.budget_reservations br where br.id = p_reservation_id for update;

  v_cost := ceil(p_estimated_cost * 1000000) / 1000000;
  insert into public.usage_events as ue(bot_id, job_id, warm_reservation_id, warm_invocation_id,
    provider, model, operation, input_tokens, output_tokens, estimated_cost, latency_ms, state)
    values(v_bot, p_job_id, p_reservation_id, p_invocation_id, p_provider, p_model, p_operation,
      p_input_tokens, p_output_tokens, v_cost, p_latency_ms,
      case when p_final then 'final' else 'pending' end)
    on conflict (warm_reservation_id, warm_invocation_id)
      where warm_reservation_id is not null do update
    set input_tokens = greatest(ue.input_tokens, excluded.input_tokens),
        output_tokens = greatest(ue.output_tokens, excluded.output_tokens),
        estimated_cost = greatest(ue.estimated_cost, excluded.estimated_cost),
        latency_ms = greatest(ue.latency_ms, excluded.latency_ms),
        state = case when excluded.state = 'final' then 'final' else ue.state end;
end;
$$;

revoke all on function public.record_warm_usage(uuid,integer,text,uuid,uuid,text,text,text,integer,integer,numeric,integer,boolean)
  from public, anon, authenticated;
grant execute on function public.record_warm_usage(uuid,integer,text,uuid,uuid,text,text,text,integer,integer,numeric,integer,boolean)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 22; $$;
