-- 013: P7 data layer for the chat endpoint (POST /v1/chat, GET /v1/conversations/:id; plan P7).
-- Forward-only: 001-012 are never edited. Everything here is SECURITY INVOKER with an empty search_path and
-- lock_timeout = '2s', EXECUTE for service_role only (the API role). Nothing here is callable from a browser.
-- SQLSTATEs (existing contract): RB036 settings missing, RB037 not found or not owned (one answer for both, so the
-- caller cannot tell which), RB030 wrong state (a repeated turn for one run), 22023 bad argument. A duplicate assistant
-- message id is the primary key's 23505.
--
-- WHAT A CHAT TURN WRITES (all by the API, none by the browser):
--   get_chat_context        one read of the bot, its settings and its contact data, in one snapshot.
--   start_chat_turn         the conversation (new or reused) and the visitor's question, in one transaction.
--   finish_chat_turn        the assistant's reply and its sources, in one transaction. The sources are checked
--                           against the corpus of THIS bot before anything is written.
--   record_request_usage    one usage row per provider call, keyed by the run.
--   get_conversation_history  the visitor-visible messages of an owned conversation, paged.
--
-- OWNERSHIP. A function that takes a visitor session checks, in the database, that the run, the conversation and
-- the messages it names belong to that bot AND that session. A mismatch is RB037 whatever the reason, so a visitor
-- cannot probe for ids of other sessions. The API's own check of the token is not the only line of defence.
--
-- LOCK ORDER (the 011 order is bot, session or settings, run; this adds the conversation after the run):
--   1. visitor_sessions row (FOR KEY SHARE, start_chat_turn only: the conversation insert references it, and a
--                            session cleanup deletes the session before its runs)
--   2. request_runs row     (FOR NO KEY UPDATE: two calls for one run take turns; set_request_run_state and
--                            reserve_request_budget conflict with it, inserts that only reference the run do not)
--   3. conversations row    (FOR NO KEY UPDATE: admin_delete_conversation takes FOR UPDATE on it, so a turn either
--                            finishes before the delete or finds the conversation gone, RB037; no message is orphaned)
--   4. document_chunks rows (FOR KEY SHARE, finish_chat_turn: a chunk cannot be deleted while a source points at it)
-- Nothing that takes a conversation or chunk lock then waits for a session or run lock, so no cycle closes.

-- ---------------------------------------------------------------------------
-- message_sources: the citation snapshot gains the page and section (B-9), so a citation keeps what the visitor saw
-- after the chunk is gone. Both are null for sources written before this migration. Members read them exactly as
-- they read the other columns (table-level SELECT and the existing RLS policy; nothing is granted per column).
-- ---------------------------------------------------------------------------
alter table public.message_sources
  add column page_number integer,
  add column section     text,
  add constraint message_sources_page_number_check check (page_number is null or page_number >= 1);

-- ---------------------------------------------------------------------------
-- get_chat_context: everything the chat route needs about a bot, as one jsonb document read in one snapshot.
--   bot      {id, slug, enabled, display_name, identity_prompt, tone, scope, allowed_languages, embedding_model,
--             embedding_dimensions, settings_version, corpus_version}; tone and scope are '' when null.
--   settings {feature_flags, handoff_policy} (both jsonb objects).
--   contact  {supported_languages, escalation_label, escalation_messages, email, phone, whatsapp_url, page_url,
--             business_hours, timezone} from public_bot_config; unset values are JSON null.
-- A disabled bot is returned with enabled = false (the API answers it; this function does not). Unknown bot RB037;
-- a missing client_settings or public_bot_config row RB036; null argument 22023.
-- ---------------------------------------------------------------------------
create function public.get_chat_context(p_bot_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_bot public.bot_profiles%rowtype;
  v_set public.client_settings%rowtype;
  v_pub public.public_bot_config%rowtype;
begin
  if p_bot_id is null then
    raise exception 'get_chat_context: bot is required' using errcode = '22023';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: bot not found' using errcode = 'RB037';
  end if;
  select * into v_set from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: client settings are missing' using errcode = 'RB036';
  end if;
  select * into v_pub from public.public_bot_config pc where pc.bot_id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: public bot config is missing' using errcode = 'RB036';
  end if;

  return jsonb_build_object(
    'bot', jsonb_build_object(
      'id', v_bot.id,
      'slug', v_bot.slug,
      'enabled', v_bot.enabled,
      'display_name', v_pub.display_name,
      'identity_prompt', v_bot.identity_prompt,
      'tone', coalesce(v_bot.tone, ''),
      'scope', coalesce(v_bot.scope, ''),
      'allowed_languages', to_jsonb(v_bot.allowed_languages),
      'embedding_model', v_bot.embedding_model,
      'embedding_dimensions', v_bot.embedding_dimensions,
      'settings_version', v_bot.settings_version,
      'corpus_version', v_bot.corpus_version),
    'settings', jsonb_build_object(
      'feature_flags', v_set.feature_flags,
      'handoff_policy', v_set.handoff_policy),
    'contact', jsonb_build_object(
      'supported_languages', to_jsonb(v_pub.supported_languages),
      'escalation_label', v_pub.escalation_label,
      'escalation_messages', v_pub.escalation_messages,
      'email', v_pub.contact_email,
      'phone', v_pub.contact_phone,
      'whatsapp_url', v_pub.contact_whatsapp_url,
      'page_url', v_pub.contact_page_url,
      'business_hours', v_pub.business_hours,
      'timezone', v_pub.timezone));
end;
$$;

-- ---------------------------------------------------------------------------
-- start_chat_turn: the first write of a turn. The run must belong to this bot and session and still be 'reserved' or
-- 'running'; p_conversation_id null creates an 'open' conversation owned by the session, otherwise the conversation must
-- belong to this bot and session and be 'open'. All of those are RB037 when they fail.
-- p_content is 1..2000 characters after trimming (22023 otherwise); the trimmed text is stored as the 'user' message with
-- request_id = the run, and conversations.last_message_at moves. prior_no_knowledge counts the assistant rows of this
-- conversation (before this turn) whose handoff_reason is no_knowledge or repeated_no_knowledge.
-- A run takes one question: a second call for a run that already has its 'user' message is RB030, so a retried call can
-- never store the question twice.
-- ---------------------------------------------------------------------------
create function public.start_chat_turn(
  p_bot_id             uuid,
  p_visitor_session_id uuid,
  p_run_id             uuid,
  p_conversation_id    uuid,
  p_content            text
)
returns table (conversation_id uuid, user_message_id uuid, prior_no_knowledge integer)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_content text;
  v_state   text;
  v_conv    uuid;
  v_msg     uuid := gen_random_uuid();
  v_prior   integer := 0;
  v_now     timestamptz := clock_timestamp();
begin
  if p_bot_id is null or p_visitor_session_id is null or p_run_id is null then
    raise exception 'start_chat_turn: bot, session and run are required' using errcode = '22023';
  end if;
  if p_content is null then
    raise exception 'start_chat_turn: content is required' using errcode = '22023';
  end if;
  v_content := regexp_replace(p_content, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if char_length(v_content) not between 1 and 2000 then
    raise exception 'start_chat_turn: content must be 1..2000 characters' using errcode = '22023';
  end if;

  -- 1. The session (lock order above).
  perform 1 from public.visitor_sessions s
   where s.id = p_visitor_session_id and s.bot_id = p_bot_id
     for key share;
  if not found then
    raise exception 'start_chat_turn: not found' using errcode = 'RB037';
  end if;

  -- 2. The run: this bot, this session, still live.
  select r.state into v_state
    from public.request_runs r
   where r.id = p_run_id and r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id
     for no key update;
  if not found or v_state not in ('reserved', 'running') then
    raise exception 'start_chat_turn: not found' using errcode = 'RB037';
  end if;
  if exists (select 1 from public.messages m where m.request_id = p_run_id and m.role = 'user') then
    raise exception 'start_chat_turn: this run already has its question' using errcode = 'RB030';
  end if;

  -- 3. The conversation.
  if p_conversation_id is null then
    insert into public.conversations (bot_id, visitor_session_id, status, last_message_at)
    values (p_bot_id, p_visitor_session_id, 'open', v_now)
    returning id into v_conv;
  else
    select c.id into v_conv
      from public.conversations c
     where c.id = p_conversation_id and c.bot_id = p_bot_id and c.visitor_session_id = p_visitor_session_id
       and c.status = 'open'
       for no key update;
    if not found then
      raise exception 'start_chat_turn: not found' using errcode = 'RB037';
    end if;
    select count(*)::integer into v_prior
      from public.messages m
     where m.conversation_id = v_conv and m.role = 'assistant'
       and m.handoff_reason in ('no_knowledge', 'repeated_no_knowledge');
    update public.conversations c set last_message_at = v_now where c.id = v_conv;
  end if;

  insert into public.messages (id, conversation_id, request_id, role, content, status, created_at)
  values (v_msg, v_conv, p_run_id, 'user', v_content, 'complete', v_now);

  return query select v_conv, v_msg, v_prior;
end;
$$;

-- ---------------------------------------------------------------------------
-- finish_chat_turn: the last write of a turn. Inserts the assistant message with the id the API generated (so the
-- 'meta' event could carry it), reply_to_message_id = the question and request_id = the run, then its sources.
-- Ownership as in start_chat_turn (run live and owned, conversation owned and open), plus the question must be a 'user'
-- message of that conversation written for this run; any miss is RB037. A run takes one answer: another assistant message
-- already stored for the run under a different id is RB030; the same id again is the primary key's 23505. Either way
-- nothing is inserted, so a repeated call never stores a second reply.
-- p_status in complete, partial, failed, blocked; p_handoff_reason null or one of the six contract values; p_content may be
-- ''; p_provider up to 100 and p_model up to 200 characters. Any other value is 22023.
-- p_sources is a JSON array of at most 20 objects {chunk_id, document_version_id, source_label, excerpt, page_number,
-- section}. source_label is 1..300 characters, excerpt up to 500, section up to 300, page_number a positive integer or
-- null. Each chunk must exist, belong to that version, and that version's document must belong to THIS bot; otherwise
-- 22023 and nothing is written. The chunk rows are locked FOR KEY SHARE until commit, so a chunk cannot vanish between
-- the check and the insert.
-- conversations.last_message_at moves to the reply's time.
-- ---------------------------------------------------------------------------
create function public.finish_chat_turn(
  p_bot_id             uuid,
  p_visitor_session_id uuid,
  p_run_id             uuid,
  p_message_id         uuid,
  p_conversation_id    uuid,
  p_user_message_id    uuid,
  p_content            text,
  p_status             text,
  p_provider           text,
  p_model              text,
  p_handoff_reason     text,
  p_sources            jsonb
)
returns void
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_state   text;
  v_n       integer;
  v_e       jsonb;
  v_now     timestamptz := clock_timestamp();
begin
  if p_bot_id is null or p_visitor_session_id is null or p_run_id is null or p_message_id is null
     or p_conversation_id is null or p_user_message_id is null then
    raise exception 'finish_chat_turn: bot, session, run, message, conversation and question are required' using errcode = '22023';
  end if;
  if p_content is null then
    raise exception 'finish_chat_turn: content is required (it may be empty)' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('complete', 'partial', 'failed', 'blocked') then
    raise exception 'finish_chat_turn: unknown status' using errcode = '22023';
  end if;
  if p_handoff_reason is not null
     and p_handoff_reason not in ('no_knowledge', 'out_of_scope', 'human_requested', 'blocked', 'unavailable', 'repeated_no_knowledge') then
    raise exception 'finish_chat_turn: unknown handoff reason' using errcode = '22023';
  end if;
  if (p_provider is not null and char_length(p_provider) > 100) or (p_model is not null and char_length(p_model) > 200) then
    raise exception 'finish_chat_turn: provider or model is too long' using errcode = '22023';
  end if;

  -- The shape of every source, before any lock is taken.
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' then
    raise exception 'finish_chat_turn: sources must be a JSON array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_sources);
  if v_n > 20 then
    raise exception 'finish_chat_turn: at most 20 sources' using errcode = '22023';
  end if;
  -- Bounded loop: at most 20 elements.
  for i in 0 .. v_n - 1 loop
    v_e := p_sources -> i;
    if jsonb_typeof(v_e) is distinct from 'object' then
      raise exception 'finish_chat_turn: each source must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'chunk_id') is distinct from 'string' or (v_e ->> 'chunk_id') !~* v_uuid_re then
      raise exception 'finish_chat_turn: source chunk_id must be a uuid' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'document_version_id') is distinct from 'string' or (v_e ->> 'document_version_id') !~* v_uuid_re then
      raise exception 'finish_chat_turn: source document_version_id must be a uuid' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'source_label') is distinct from 'string' or char_length(v_e ->> 'source_label') not between 1 and 300 then
      raise exception 'finish_chat_turn: source_label must be 1..300 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'excerpt') is not null and jsonb_typeof(v_e -> 'excerpt') not in ('string', 'null') then
      raise exception 'finish_chat_turn: excerpt must be text' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'excerpt') = 'string' and char_length(v_e ->> 'excerpt') > 500 then
      raise exception 'finish_chat_turn: excerpt is longer than 500 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') is not null and jsonb_typeof(v_e -> 'section') not in ('string', 'null') then
      raise exception 'finish_chat_turn: section must be text' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') = 'string' and char_length(v_e ->> 'section') > 300 then
      raise exception 'finish_chat_turn: section is longer than 300 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') is not null and jsonb_typeof(v_e -> 'page_number') not in ('number', 'null') then
      raise exception 'finish_chat_turn: page_number must be a positive integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') = 'number' and (v_e ->> 'page_number') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'finish_chat_turn: page_number must be a positive integer' using errcode = '22023';
    end if;
  end loop;

  -- 2. The run (this function takes no session lock: it inserts no row that references the session).
  select r.state into v_state
    from public.request_runs r
   where r.id = p_run_id and r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id
     for no key update;
  if not found or v_state not in ('reserved', 'running') then
    raise exception 'finish_chat_turn: not found' using errcode = 'RB037';
  end if;

  -- 3. The conversation, then the question.
  perform 1 from public.conversations c
   where c.id = p_conversation_id and c.bot_id = p_bot_id and c.visitor_session_id = p_visitor_session_id
     and c.status = 'open'
     for no key update;
  if not found then
    raise exception 'finish_chat_turn: not found' using errcode = 'RB037';
  end if;
  perform 1 from public.messages m
   where m.id = p_user_message_id and m.conversation_id = p_conversation_id and m.role = 'user' and m.request_id = p_run_id;
  if not found then
    raise exception 'finish_chat_turn: not found' using errcode = 'RB037';
  end if;

  if exists (select 1 from public.messages m where m.request_id = p_run_id and m.role = 'assistant' and m.id <> p_message_id) then
    raise exception 'finish_chat_turn: this run already has its answer' using errcode = 'RB030';
  end if;

  -- 4. Every source must be a chunk of that version, of a document of THIS bot. The rows are locked until commit.
  for i in 0 .. v_n - 1 loop
    v_e := p_sources -> i;
    perform 1
      from public.document_chunks c
      join public.document_versions v on v.id = c.document_version_id
      join public.documents d on d.id = v.document_id
     where c.id = (v_e ->> 'chunk_id')::uuid
       and v.id = (v_e ->> 'document_version_id')::uuid
       and d.bot_id = p_bot_id
       for key share of c;
    if not found then
      raise exception 'finish_chat_turn: a source is not a chunk of this bot''s version' using errcode = '22023';
    end if;
  end loop;

  insert into public.messages (id, conversation_id, request_id, reply_to_message_id, role, content, status, provider, model,
                               handoff_reason, created_at)
  values (p_message_id, p_conversation_id, p_run_id, p_user_message_id, 'assistant', p_content, p_status, p_provider, p_model,
          p_handoff_reason, v_now);

  insert into public.message_sources (message_id, chunk_id, document_version_id, source_label, excerpt, page_number, section)
  select p_message_id,
         (t.x ->> 'chunk_id')::uuid,
         (t.x ->> 'document_version_id')::uuid,
         t.x ->> 'source_label',
         t.x ->> 'excerpt',
         (t.x ->> 'page_number')::integer,
         t.x ->> 'section'
    from jsonb_array_elements(p_sources) with ordinality as t(x, ord)
   order by t.ord;

  update public.conversations c set last_message_at = v_now where c.id = p_conversation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_request_usage: one usage row for a provider call of a chat run. The run must belong to this bot (RB037), in any
-- state: usage is recorded after the run finishes too. p_operation is chat, embedding_query or moderation; token counts and
-- the cost are required and not negative (cost below 100000000); latency is null or not negative; provider up to 100 and
-- model up to 200 characters. Anything else is 22023. Writes usage_events.request_id. Returns the new row's id.
-- ---------------------------------------------------------------------------
create function public.record_request_usage(
  p_bot_id         uuid,
  p_run_id         uuid,
  p_provider       text,
  p_model          text,
  p_operation      text,
  p_input_tokens   integer,
  p_output_tokens  integer,
  p_estimated_cost numeric,
  p_latency_ms     integer
)
returns uuid
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if p_bot_id is null or p_run_id is null
     or p_operation is null or p_operation not in ('chat', 'embedding_query', 'moderation')
     or p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_provider is not null and char_length(p_provider) > 100)
     or (p_model is not null and char_length(p_model) > 200) then
    raise exception 'record_request_usage: bot, run, a known operation and non-negative counts are required' using errcode = '22023';
  end if;

  perform 1 from public.request_runs r where r.id = p_run_id and r.bot_id = p_bot_id for key share;
  if not found then
    raise exception 'record_request_usage: not found' using errcode = 'RB037';
  end if;

  insert into public.usage_events (bot_id, request_id, provider, model, operation, input_tokens, output_tokens,
                                   estimated_cost, latency_ms)
  values (p_bot_id, p_run_id, p_provider, p_model, p_operation, p_input_tokens, p_output_tokens,
          p_estimated_cost, p_latency_ms)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_conversation_history: the messages a visitor may see, paged. The conversation must belong to this bot and session
-- (RB037; a closed conversation can still be read). Only 'user' and 'assistant' rows are returned, never 'system'.
-- p_limit is 1..100 (22023 otherwise). p_before null: the newest page. p_before a message id: rows older than that message
-- (ordered by time, then id); the message must be a user or assistant message of this conversation, else RB037.
-- Rows come oldest first within the page. has_more is the same value on every row: true when older rows exist.
-- ---------------------------------------------------------------------------
create function public.get_conversation_history(
  p_bot_id             uuid,
  p_visitor_session_id uuid,
  p_conversation_id    uuid,
  p_before             uuid,
  p_limit              integer
)
returns table (
  id             uuid,
  role           text,
  content        text,
  status         text,
  handoff_reason text,
  created_at     timestamptz,
  has_more       boolean
)
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_before_at timestamptz;
begin
  if p_bot_id is null or p_visitor_session_id is null or p_conversation_id is null
     or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'get_conversation_history: bot, session, conversation and a limit of 1..100 are required' using errcode = '22023';
  end if;

  perform 1 from public.conversations c
   where c.id = p_conversation_id and c.bot_id = p_bot_id and c.visitor_session_id = p_visitor_session_id;
  if not found then
    raise exception 'get_conversation_history: not found' using errcode = 'RB037';
  end if;

  if p_before is not null then
    select m.created_at into v_before_at
      from public.messages m
     where m.id = p_before and m.conversation_id = p_conversation_id and m.role in ('user', 'assistant');
    if not found then
      raise exception 'get_conversation_history: not found' using errcode = 'RB037';
    end if;
  end if;

  return query
  with page as (
    select m.id, m.role, m.content, m.status, m.handoff_reason, m.created_at
      from public.messages m
     where m.conversation_id = p_conversation_id
       and m.role in ('user', 'assistant')
       and (p_before is null or (m.created_at, m.id) < (v_before_at, p_before))
     order by m.created_at desc, m.id desc
     limit p_limit + 1
  ), ranked as (
    select pg.id, pg.role, pg.content, pg.status, pg.handoff_reason, pg.created_at,
           row_number() over (order by pg.created_at desc, pg.id desc) as rn,
           count(*) over () as total
      from page pg
  )
  select rk.id, rk.role, rk.content, rk.status, rk.handoff_reason, rk.created_at, rk.total > p_limit
    from ranked rk
   where rk.rn <= p_limit
   order by rk.created_at, rk.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- schema_version: raised with every migration (220 compares it with the migration history).
-- ---------------------------------------------------------------------------
create or replace function public.schema_version()
returns integer
language sql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
  select 13;
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE: service_role only. Postgres grants EXECUTE to PUBLIC on new functions by default; revoke it.
-- (schema_version keeps the grants of 010.)
-- ---------------------------------------------------------------------------
revoke all on function public.get_chat_context(uuid) from public, anon, authenticated;
revoke all on function public.start_chat_turn(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_chat_turn(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_request_usage(uuid, uuid, text, text, text, integer, integer, numeric, integer) from public, anon, authenticated;
revoke all on function public.get_conversation_history(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.get_chat_context(uuid) to service_role;
grant execute on function public.start_chat_turn(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.finish_chat_turn(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.record_request_usage(uuid, uuid, text, text, text, integer, integer, numeric, integer) to service_role;
grant execute on function public.get_conversation_history(uuid, uuid, uuid, uuid, integer) to service_role;
