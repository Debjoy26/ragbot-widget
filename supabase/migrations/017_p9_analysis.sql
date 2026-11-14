-- 017_p9_analysis.sql — P9-T2: background conversation analysis (W-10) + schema_version 17.
--
-- After a chat turn is persisted, the API calls queue_analysis_job (debounced by dedupe key:
-- a new message pushes the window back; an in-flight run is joined instead of duplicated).
-- The worker's analyze_conversation handler reads bounded context via get_analysis_context,
-- calls the analysis model under an index-budget reservation, then writes the result with
-- save_conversation_analysis (or fail_conversation_analysis on a permanent failure).
-- Analysis rows live exactly as long as their conversation (ON DELETE CASCADE, ADR 0016).

-- ---------------------------------------------------------------------------
-- queue_analysis_job: debounce one analysis job per conversation. Returns the job id.
-- ---------------------------------------------------------------------------
create function public.queue_analysis_job(
  p_bot_id uuid,
  p_conversation_id uuid,
  p_debounce_seconds integer
)
returns uuid
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_key text := 'analyze_conversation:' || p_conversation_id::text;
  v_id uuid;
begin
  if p_bot_id is null then
    raise exception 'queue_analysis_job: bot is required' using errcode = '22023';
  end if;
  if p_conversation_id is null then
    raise exception 'queue_analysis_job: conversation is required' using errcode = '22023';
  end if;
  if p_debounce_seconds is null or p_debounce_seconds < 0 or p_debounce_seconds > 3600 then
    raise exception 'queue_analysis_job: debounce must be 0..3600 seconds' using errcode = '22023';
  end if;

  -- Same code for an unknown conversation, a foreign conversation and an unknown bot:
  -- the caller already authenticated the visitor, so this is no oracle.
  perform 1
    from public.conversations c
   where c.id = p_conversation_id
     and c.bot_id = p_bot_id;
  if not found then
    raise exception 'queue_analysis_job: conversation not found or not owned' using errcode = 'RB037';
  end if;

  -- An in-flight run already covers recent messages: join it instead of queueing another.
  select j.id into v_id
    from public.jobs j
   where j.dedupe_key = v_key
     and j.state = 'running'
   limit 1;
  if found then
    return v_id;
  end if;

  -- G-3 design (008): dedupe_key is unique only among live jobs (queued, running), so a
  -- finished analysis never blocks the next one and terminal rows stay for the scheduled
  -- purge — no delete here. The arbiter is the live-job partial index: a concurrent insert
  -- for the same key pushes the window back while the row is still queued; a concurrent
  -- claim (now running) matches nothing and falls through to the join below.
  insert into public.jobs as j (type, dedupe_key, payload, max_attempts, available_at)
  values (
    'analyze_conversation',
    v_key,
    jsonb_build_object('bot_id', p_bot_id, 'conversation_id', p_conversation_id),
    -- No analysis attempts policy exists in client_settings yet (follow-up): fixed budget of 5.
    5,
    now() + make_interval(secs => p_debounce_seconds)
  )
  on conflict (dedupe_key) where state in ('queued', 'running') do update
     set available_at = greatest(j.available_at, excluded.available_at)
   where j.state = 'queued'
  returning j.id into v_id;
  if found then
    return v_id;
  end if;

  select j.id into v_id
    from public.jobs j
   where j.dedupe_key = v_key
   limit 1;
  return v_id;
end;
$$;
revoke all on function public.queue_analysis_job(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.queue_analysis_job(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- get_analysis_context: bounded transcript plus the bot's public identity for the
-- analysis model. Excludes system rows (never analyzed). RB037 when unknown.
-- ---------------------------------------------------------------------------
create function public.get_analysis_context(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_bot_id uuid;
begin
  if p_conversation_id is null then
    raise exception 'get_analysis_context: conversation is required' using errcode = '22023';
  end if;

  select c.bot_id into v_bot_id
    from public.conversations c
   where c.id = p_conversation_id;
  if not found then
    raise exception 'get_analysis_context: conversation not found or not owned' using errcode = 'RB037';
  end if;

  return jsonb_build_object(
    'bot', (
      select jsonb_build_object(
        'identity_prompt', b.identity_prompt,
        'tone', b.tone,
        'scope', b.scope,
        'allowed_languages', b.allowed_languages
      )
        from public.bot_profiles b
       where b.id = v_bot_id
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) order by m.created_at, m.id)
        from (
          select m.role, m.content, m.created_at, m.id
            from public.messages m
           where m.conversation_id = p_conversation_id
             and m.role in ('user', 'assistant')
             and m.status in ('complete', 'partial')
           order by m.created_at desc, m.id desc
           limit 20
        ) m
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_analysis_context(uuid) from public, anon, authenticated;
grant execute on function public.get_analysis_context(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- save_conversation_analysis / fail_conversation_analysis: upsert the analysis row.
-- A failure keeps the previous summary (if any) and only flips the status.
-- ---------------------------------------------------------------------------
create function public.save_conversation_analysis(
  p_conversation_id uuid,
  p_summary text,
  p_sentiment text,
  p_intent text,
  p_analysis_version text
)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
begin
  if p_conversation_id is null then
    raise exception 'save_conversation_analysis: conversation is required' using errcode = '22023';
  end if;
  if p_summary is null or char_length(p_summary) = 0 or char_length(p_summary) > 2000 then
    raise exception 'save_conversation_analysis: summary is required (1..2000 chars)' using errcode = '22023';
  end if;
  if p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative') then
    raise exception 'save_conversation_analysis: sentiment must be positive, neutral or negative' using errcode = '22023';
  end if;
  if p_intent is null or char_length(p_intent) = 0 or char_length(p_intent) > 200 then
    raise exception 'save_conversation_analysis: intent is required (1..200 chars)' using errcode = '22023';
  end if;
  if p_analysis_version is null or p_analysis_version !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception 'save_conversation_analysis: analysis version is required' using errcode = '22023';
  end if;
  perform 1 from public.conversations c where c.id = p_conversation_id;
  if not found then
    raise exception 'save_conversation_analysis: conversation not found or not owned' using errcode = 'RB037';
  end if;

  insert into public.conversation_analysis as a
    (conversation_id, summary, sentiment, intent, analysis_version, status)
  values (p_conversation_id, p_summary, p_sentiment, p_intent, p_analysis_version, 'complete')
  on conflict (conversation_id) do update
     set summary = excluded.summary,
         sentiment = excluded.sentiment,
         intent = excluded.intent,
         analysis_version = excluded.analysis_version,
         status = 'complete';
end;
$$;
revoke all on function public.save_conversation_analysis(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_conversation_analysis(uuid, text, text, text, text) to service_role;

create function public.fail_conversation_analysis(p_conversation_id uuid)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
begin
  if p_conversation_id is null then
    raise exception 'fail_conversation_analysis: conversation is required' using errcode = '22023';
  end if;
  perform 1 from public.conversations c where c.id = p_conversation_id;
  if not found then
    raise exception 'fail_conversation_analysis: conversation not found or not owned' using errcode = 'RB037';
  end if;

  insert into public.conversation_analysis as a (conversation_id, status)
  values (p_conversation_id, 'failed')
  on conflict (conversation_id) do update
     set status = 'failed';
end;
$$;
revoke all on function public.fail_conversation_analysis(uuid) from public, anon, authenticated;
grant execute on function public.fail_conversation_analysis(uuid) to service_role;

-- schema_version: bump to 17.
create or replace function public.schema_version()
returns integer
language sql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
  select 17;
$$;
revoke all on function public.schema_version() from public, anon, authenticated, service_role;
grant execute on function public.schema_version() to authenticated;
