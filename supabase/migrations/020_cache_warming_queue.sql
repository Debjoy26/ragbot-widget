-- C8 foundation: opt-in, versioned queue and monotonic lease identity.
-- Accounting/publication are integrated separately; this migration grants no
-- browser access and never calls a provider or writes cached answer content.
alter table public.jobs add column warm_generation integer not null default 0
  check (warm_generation >= 0);
update public.jobs set warm_generation = greatest(attempts, 1)
  where type = 'warm_answer_cache' and state = 'running';

create function public.bump_warm_generation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.type = 'warm_answer_cache' and new.state = 'running'
     and (old.state <> 'running' or new.attempts <> old.attempts
       or new.locked_by is distinct from old.locked_by) then
    new.warm_generation := old.warm_generation + 1;
  end if;
  return new;
end;
$$;
create trigger jobs_warm_generation before update on public.jobs
  for each row execute function public.bump_warm_generation();

-- Include terminal rows: replaying one version event must not spend again.
-- Normal terminal-job retention eventually removes these historical keys.
create unique index jobs_warm_versions_key on public.jobs
  ((payload->>'bot_id'), (payload->>'corpus_version'), (payload->>'settings_version'))
  where type = 'warm_answer_cache';

create function public.warm_policy_enabled(p_policy jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_policy) = 'object'
    and p_policy->'warm_enabled' = 'true'::jsonb
    and p_policy->'enabled' is distinct from 'false'::jsonb
    and p_policy->'kill_switch' is distinct from 'true'::jsonb
    and p_policy->'killSwitch' is distinct from 'true'::jsonb, false);
$$;

create function public.queue_warm_job(p_bot_id uuid) returns uuid
language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot public.bot_profiles%rowtype; v_policy jsonb; v_id uuid; v_max_attempts integer;
begin
  select * into v_bot from public.bot_profiles b where b.id = p_bot_id;
  if not found or not v_bot.enabled then return null; end if;
  select cs.cache_policy into v_policy from public.client_settings cs where cs.bot_id = p_bot_id;
  if not public.warm_policy_enabled(v_policy) then return null; end if;
  -- Explicit operator policy, no retry default. Validate before casting so
  -- nulls, strings, fractions and out-of-range numbers fail with a stable code.
  if jsonb_typeof(v_policy->'warm_max_attempts') is distinct from 'number'
     or v_policy->>'warm_max_attempts' !~ '^(10|[1-9])$' then
    raise exception 'warm job: retry limit must be an integer from 1 to 10' using errcode = '22023';
  end if;
  v_max_attempts := (v_policy->>'warm_max_attempts')::integer;
  insert into public.jobs(type, payload, max_attempts)
    values('warm_answer_cache', jsonb_build_object('bot_id', v_bot.id,
      'corpus_version', v_bot.corpus_version, 'settings_version', v_bot.settings_version), v_max_attempts)
    on conflict ((payload->>'bot_id'), (payload->>'corpus_version'), (payload->>'settings_version'))
      where type = 'warm_answer_cache' do nothing returning id into v_id;
  if v_id is null then
    select j.id into v_id from public.jobs j where j.type = 'warm_answer_cache'
      and j.payload->>'bot_id' = v_bot.id::text
      and j.payload->>'corpus_version' = v_bot.corpus_version::text
      and j.payload->>'settings_version' = v_bot.settings_version::text;
  end if;
  return v_id;
end;
$$;

create function public.enqueue_warm_after_version_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.corpus_version is distinct from old.corpus_version
     or new.settings_version is distinct from old.settings_version then
    perform public.queue_warm_job(new.id);
  end if;
  return new;
end;
$$;
-- Observe final row versions, including changes made by the existing BEFORE
-- settings trigger when the original statement targets tone/identity/enabled.
create trigger bot_profiles_warm_version after update on public.bot_profiles
  for each row when (old.corpus_version is distinct from new.corpus_version
    or old.settings_version is distinct from new.settings_version)
  execute function public.enqueue_warm_after_version_change();

-- Lock only the job here. Callers that reserve/publish must subsequently lock
-- client_settings, then bot_profiles, then recheck the current snapshot.
create function public.warm_job_fence(p_job_id uuid, p_worker text, p_generation integer)
returns uuid language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_job public.jobs%rowtype; v_bot uuid;
begin
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  if not found or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or v_job.type <> 'warm_answer_cache' or v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker
     or v_job.warm_generation <> p_generation
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp() then
    raise exception 'warm job: lease not held' using errcode = 'RB013';
  end if;
  begin v_bot := (v_job.payload->>'bot_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'warm job: invalid payload' using errcode = '22023';
  end;
  if v_bot is null then raise exception 'warm job: invalid payload' using errcode = '22023'; end if;
  return v_bot;
end;
$$;

create function public.get_warm_job_context(p_job_id uuid, p_worker text, p_generation integer)
returns jsonb language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_payload jsonb; v_suggested jsonb; v_faq jsonb; v_questions jsonb; v_languages jsonb;
begin
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id;
  if not found then return jsonb_build_object('state', 'superseded'); end if;
  select j.payload into v_payload from public.jobs j where j.id = p_job_id;
  if v_payload->>'corpus_version' is distinct from v_bot.corpus_version::text
     or v_payload->>'settings_version' is distinct from v_bot.settings_version::text then
    return jsonb_build_object('state', 'superseded');
  end if;
  select cs.cache_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot_id;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy) then
    return jsonb_build_object('state', 'disabled');
  end if;
  select c.suggested_questions into v_suggested from public.public_bot_config c where c.bot_id = v_bot_id;
  v_suggested := coalesce(v_suggested, '[]'::jsonb);
  v_faq := coalesce(v_policy->'warm_questions', '[]'::jsonb);
  if jsonb_typeof(v_suggested) <> 'array' or jsonb_typeof(v_faq) <> 'array'
     or jsonb_array_length(v_faq) > 12 then
    raise exception 'warm job: invalid questions policy' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(v_suggested || v_faq) q(value)
    where jsonb_typeof(q.value) <> 'string'
      or char_length(q.value #>> '{}') not between 1 and 2000) then
    raise exception 'warm job: invalid question' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(q.value order by q.ord), '[]'::jsonb) into v_questions
    from (select value, ord from jsonb_array_elements(v_suggested || v_faq)
      with ordinality q(value, ord) order by ord limit 12) q;
  select coalesce(jsonb_agg(q.value order by q.value), '[""]'::jsonb) into v_languages
    from (select distinct value from jsonb_array_elements_text(
      '[""]'::jsonb || to_jsonb(v_bot.allowed_languages)) q(value)) q;
  if jsonb_array_length(v_languages) > 21 then
    raise exception 'warm job: invalid language policy' using errcode = '22023';
  end if;
  return jsonb_build_object('state', 'ready', 'context', public.get_chat_context(v_bot_id),
    'questions', v_questions, 'languages', v_languages);
end;
$$;

revoke all on function public.bump_warm_generation(), public.warm_policy_enabled(jsonb),
  public.queue_warm_job(uuid), public.enqueue_warm_after_version_change(),
  public.warm_job_fence(uuid,text,integer), public.get_warm_job_context(uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.warm_policy_enabled(jsonb), public.queue_warm_job(uuid),
  public.warm_job_fence(uuid,text,integer), public.get_warm_job_context(uuid,text,integer)
  to service_role;
create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 20; $$;
