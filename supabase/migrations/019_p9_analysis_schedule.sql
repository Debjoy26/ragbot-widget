-- A09: every enqueue has a revision. A context snapshot records the revision
-- it covers, and terminal completion atomically schedules any newer work.
-- Scheduling metadata stays on jobs to preserve the job -> conversation lock order.
alter table public.jobs
  add column analysis_requested_revision bigint not null default 0 check (analysis_requested_revision >= 0),
  add column analysis_claim_revision bigint not null default 0 check (analysis_claim_revision >= 0),
  add column analysis_context_revision bigint not null default 0 check (analysis_context_revision >= 0),
  add column analysis_context_generation integer not null default 0 check (analysis_context_generation >= 0);

-- Existing in-flight snapshots predate the watermark: conservatively repeat once.
update public.jobs set analysis_requested_revision = 1
  where type = 'analyze_conversation' and state in ('queued', 'running');

create or replace function public.bump_analysis_generation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type = 'analyze_conversation' and new.state = 'running'
     and (old.state <> 'running' or new.attempts <> old.attempts or new.locked_by is distinct from old.locked_by) then
    new.analysis_generation := old.analysis_generation + 1;
    new.analysis_claim_revision := new.analysis_requested_revision;
    new.analysis_context_revision := 0;
    new.analysis_context_generation := 0;
  end if;
  return new;
end;
$$;

create or replace function public.queue_analysis_job(p_bot_id uuid, p_conversation_id uuid, p_debounce_seconds integer)
returns uuid language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_id uuid;
begin
  if p_bot_id is null or p_conversation_id is null or p_debounce_seconds is null
     or p_debounce_seconds not between 0 and 3600 then
    raise exception 'analysis queue: invalid arguments' using errcode = '22023';
  end if;
  if not exists(select 1 from public.conversations c where c.id = p_conversation_id and c.bot_id = p_bot_id) then
    raise exception 'analysis queue: conversation not found' using errcode = 'RB037';
  end if;
  insert into public.jobs as j(type, dedupe_key, payload, max_attempts, available_at, analysis_requested_revision)
    values('analyze_conversation', 'analyze_conversation:' || p_conversation_id::text,
      jsonb_build_object('bot_id', p_bot_id, 'conversation_id', p_conversation_id), 5,
      now() + make_interval(secs => p_debounce_seconds), 1)
    on conflict (dedupe_key) where state in ('queued', 'running') do update
      set analysis_requested_revision = j.analysis_requested_revision + 1,
          available_at = greatest(j.available_at, excluded.available_at)
    returning j.id into v_id;
  return v_id;
end;
$$;

create or replace function public.get_analysis_job_context(p_job_id uuid, p_worker text, p_generation integer)
returns jsonb language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_conversation uuid;
begin
  -- Take the stronger job lock first, before the fence takes the conversation
  -- share lock. Enqueue cannot advance the watermark while this snapshot is read.
  perform 1 from public.jobs j where j.id = p_job_id for update;
  select f.conversation_id into v_conversation
    from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  update public.jobs set analysis_context_revision = analysis_requested_revision,
    analysis_context_generation = p_generation where id = p_job_id;
  return public.get_analysis_context(v_conversation);
end;
$$;

create function public.schedule_analysis_successor()
returns trigger language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_covered bigint;
begin
  if old.type <> 'analyze_conversation' or old.state <> 'running'
     or new.state not in ('succeeded', 'failed') then return new; end if;
  v_covered := case when old.analysis_context_generation = old.analysis_generation
    then old.analysis_context_revision else old.analysis_claim_revision end;
  if new.analysis_requested_revision > v_covered
     and exists(select 1 from public.conversations c
       where c.id::text = new.payload ->> 'conversation_id' and c.bot_id::text = new.payload ->> 'bot_id') then
    -- Reuse the live row: no insert can race the partial unique dedupe index.
    -- The next claim increments generation, preserving earlier budget identity.
    new.state := 'queued';
    new.attempts := 0;
    new.available_at := greatest(new.available_at, now());
    new.locked_by := null;
    new.locked_until := null;
    new.completed_at := null;
    new.last_error := null;
  end if;
  return new;
end;
$$;
create trigger jobs_analysis_successor before update on public.jobs
  for each row execute function public.schedule_analysis_successor();

revoke all on function public.schedule_analysis_successor(), public.bump_analysis_generation()
  from public, anon, authenticated;
revoke all on function public.queue_analysis_job(uuid,uuid,integer), public.get_analysis_job_context(uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.queue_analysis_job(uuid,uuid,integer), public.get_analysis_job_context(uuid,text,integer)
  to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 19; $$;
