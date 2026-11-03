-- P3-D1 M4: knowledge_gaps pairs questions deterministically (request_id first, then latest earlier user
-- message ordered by created_at desc, id desc), counts assistant answers only, truncates the question to
-- 500 chars and hides moderation ('blocked') hits from analysts. Question text here is synthetic.
begin;
select plan(19);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', 'kg-analyst@example.test'),
  ('a1000000-0000-4000-8000-0000000000e2', 'authenticated', 'authenticated', 'kg-admin@example.test'),
  ('a1000000-0000-4000-8000-0000000000e3', 'authenticated', 'authenticated', 'kg-owner@example.test');
insert into public.admin_memberships (user_id, role) values
  ('a1000000-0000-4000-8000-0000000000e1', 'analyst'),
  ('a1000000-0000-4000-8000-0000000000e2', 'admin'),
  ('a1000000-0000-4000-8000-0000000000e3', 'owner');

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000e1', 'kg-bot', 'x', array['en'], 'm', 1536);
insert into public.visitor_sessions (id, bot_id, expires_at) values ('a1000000-0000-4000-8000-0000000000e9', 'b1000000-0000-4000-8000-0000000000e1', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c1000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9'),
  ('c2000000-0000-4000-8000-0000000000e2', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9'),
  ('c3000000-0000-4000-8000-0000000000e3', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9'),
  ('c4000000-0000-4000-8000-0000000000e4', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9'),
  ('c5000000-0000-4000-8000-0000000000e5', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9'),
  ('c6000000-0000-4000-8000-0000000000e6', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9'),
  ('c7000000-0000-4000-8000-0000000000e7', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9');
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash) values
  ('91000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-0000000000e1', repeat('a', 64)),
  ('92000000-0000-4000-8000-0000000000e2', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-0000000000e2', repeat('a', 64)),
  ('93000000-0000-4000-8000-0000000000e3', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-0000000000e3', repeat('a', 64)),
  ('94000000-0000-4000-8000-0000000000e4', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-0000000000e4', repeat('a', 64));

-- Scenario A (conv 1): two overlapping requests; the answer to request 1 arrives AFTER question 2.
--   latest-prior pairing would wrongly pair A1 with Q-two; request_id pairing pairs it with Q-one.
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d1000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-0000000000e1', 'user', 'Q-one', null, now() - interval '3 hours'),
  ('d1000000-0000-4000-8000-0000000000a2', 'c1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-0000000000e2', 'user', 'Q-two', null, now() - interval '3 hours' + interval '1 second'),
  ('d1000000-0000-4000-8000-0000000000a3', 'c1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-0000000000e1', 'assistant', 'idk', 'no_knowledge', now() - interval '3 hours' + interval '2 seconds'),
  ('d1000000-0000-4000-8000-0000000000a4', 'c1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-0000000000e2', 'assistant', 'out', 'out_of_scope', now() - interval '3 hours' + interval '3 seconds');

-- Scenario B (conv 2, no request ids): two user messages with IDENTICAL created_at; the tie breaks on id desc.
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d2000000-0000-4000-8000-0000000000b1', 'c2000000-0000-4000-8000-0000000000e2', null, 'user', 'Q-tie-low-id', null, now() - interval '2 hours'),
  ('d2000000-0000-4000-8000-0000000000b2', 'c2000000-0000-4000-8000-0000000000e2', null, 'user', 'Q-tie-high-id', null, now() - interval '2 hours'),
  ('d2000000-0000-4000-8000-0000000000b3', 'c2000000-0000-4000-8000-0000000000e2', null, 'assistant', 'idk', 'human_requested', now() - interval '2 hours' + interval '1 second');

-- Scenario C (conv 3): handoff reasons on non-assistant rows are not answers.
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d3000000-0000-4000-8000-0000000000c1', 'c3000000-0000-4000-8000-0000000000e3', null, 'user', 'Q-c-user', 'repeated_no_knowledge', now() - interval '90 minutes'),
  ('d3000000-0000-4000-8000-0000000000c2', 'c3000000-0000-4000-8000-0000000000e3', null, 'system', 'sys note', 'no_knowledge', now() - interval '90 minutes' + interval '1 second');

-- Scenario D (conv 4): 600-character question.
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d4000000-0000-4000-8000-0000000000d1', 'c4000000-0000-4000-8000-0000000000e4', null, 'user', repeat('L', 600), null, now() - interval '80 minutes'),
  ('d4000000-0000-4000-8000-0000000000d2', 'c4000000-0000-4000-8000-0000000000e4', null, 'assistant', 'idk', 'unavailable', now() - interval '80 minutes' + interval '1 second');

-- Scenario E (conv 5): moderation hit.
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d5000000-0000-4000-8000-0000000000e1', 'c5000000-0000-4000-8000-0000000000e5', null, 'user', 'Q-blocked', null, now() - interval '70 minutes'),
  ('d5000000-0000-4000-8000-0000000000e2', 'c5000000-0000-4000-8000-0000000000e5', null, 'assistant', 'no', 'blocked', now() - interval '70 minutes' + interval '1 second');

-- Scenario F (conv 6): assistant carries a request_id that no user message in its conversation shares,
-- although an earlier user message exists -> no guessed pairing, the row is not reported.
-- Scenario G (conv 7): the matching user message (same request_id) sits in a DIFFERENT conversation.
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d6000000-0000-4000-8000-0000000000f1', 'c6000000-0000-4000-8000-0000000000e6', null, 'user', 'Q-f-earlier', null, now() - interval '60 minutes'),
  ('d6000000-0000-4000-8000-0000000000f2', 'c6000000-0000-4000-8000-0000000000e6', '93000000-0000-4000-8000-0000000000e3', 'assistant', 'idk', 'no_knowledge', now() - interval '60 minutes' + interval '1 second'),
  ('d7000000-0000-4000-8000-0000000000f3', 'c7000000-0000-4000-8000-0000000000e7', '94000000-0000-4000-8000-0000000000e4', 'assistant', 'idk', 'no_knowledge', now() - interval '50 minutes'),
  ('d7000000-0000-4000-8000-0000000000f4', 'c6000000-0000-4000-8000-0000000000e6', '94000000-0000-4000-8000-0000000000e4', 'user', 'Q-g-elsewhere', null, now() - interval '55 minutes');

set local role authenticated;

-- ---- admin sees everything that is a genuine gap ----
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000e2","aal":"aal2","role":"authenticated"}', true);
select set_eq(
  $q$select handoff_reason, question, occurrences from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason <> 'unavailable'$q$,
  $q$values ('no_knowledge'::text, 'Q-one'::text, 1::bigint), ('out_of_scope', 'Q-two', 1), ('human_requested', 'Q-tie-high-id', 1), ('blocked', 'Q-blocked', 1)$q$,
  'M4 admin: request_id pairing, id tie-break, assistant-only, blocked visible; unpaired rows (F, G) absent');
select is((select question from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason = 'no_knowledge' and question = 'Q-two'), null,
  'M4: an overlapping answer is NOT paired with the latest earlier question (Q-two) when request_id says Q-one');
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where question = 'Q-tie-low-id'), 0,
  'M4: identical timestamps never pair with the lower id (deterministic order by created_at desc, id desc)');
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where question in ('Q-c-user', 'sys note')), 0,
  'M4: user/system messages carrying a handoff_reason are not answers');
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where question in ('Q-f-earlier', 'Q-g-elsewhere')), 0,
  'M4: assistant with a request_id never falls back to a guessed question, nor pairs across conversations');
select is((select length(question) from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason = 'unavailable'), 500,
  'M4: a 600-char question is truncated to 500 characters');
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)), 5,
  'M4 admin: exactly five gaps overall');

-- ---- owner sees blocked too ----
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000e3","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason = 'blocked'), 1,
  'M4 owner: sees the blocked row');

-- ---- analyst: same minus blocked ----
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000e1","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)), 4,
  'M4 analyst: four gaps (blocked excluded)');
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason = 'blocked' or question = 'Q-blocked'), 0,
  'M4 analyst: moderation-blocked questions are hidden');
select set_eq(
  $q$select handoff_reason, question, occurrences from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason <> 'unavailable'$q$,
  $q$values ('no_knowledge'::text, 'Q-one'::text, 1::bigint), ('out_of_scope', 'Q-two', 1), ('human_requested', 'Q-tie-high-id', 1)$q$,
  'M4 analyst: the other pairings are identical to the admin view');
select is((select length(question) from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason = 'unavailable'), 500,
  'M4 analyst: question truncation applies too');
-- The "limit" still bounds the result.
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 2)), 2, 'M4: limit still bounds the result');

-- ---- aal1 analyst: denied ----
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000e1","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)$q$, '42501', null, 'M4/M1: aal1 analyst cannot call knowledge_gaps');
reset role;

-- ---- grouping: a repeated question under the same reason counts occurrences; trimming normalises ----
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c8000000-0000-4000-8000-0000000000e8', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e9');
insert into public.messages (id, conversation_id, request_id, role, content, handoff_reason, created_at) values
  ('d8000000-0000-4000-8000-0000000000a1', 'c8000000-0000-4000-8000-0000000000e8', null, 'user', '  Q-one  ', null, now() - interval '40 minutes'),
  ('d8000000-0000-4000-8000-0000000000a2', 'c8000000-0000-4000-8000-0000000000e8', null, 'assistant', 'idk', 'no_knowledge', now() - interval '40 minutes' + interval '1 second');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000e2","aal":"aal2","role":"authenticated"}', true);
select is((select occurrences from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50) where handoff_reason = 'no_knowledge' and question = 'Q-one'), 2::bigint,
  'M4: identical (trimmed) questions with the same reason are grouped and counted');
select is(pg_get_function_result('public.knowledge_gaps(date, date, integer)'::regprocedure), 'TABLE(handoff_reason text, question text, occurrences bigint, last_seen timestamp with time zone)', 'M4: result columns unchanged (no identifiers)');
reset role;

-- Source smoke checks (not behavioural tests).
select ok((select prosrc like '%order by u.created_at desc, u.id desc%' from pg_proc where proname = 'knowledge_gaps' and pronamespace = 'public'::regnamespace), 'M4: fallback pairing orders by created_at desc, id desc (source smoke check)');
select ok((select prosrc like '%a.role = ''assistant''%' from pg_proc where proname = 'knowledge_gaps' and pronamespace = 'public'::regnamespace), 'M4: only assistant messages are answers (source smoke check)');
select ok((select prosrc like '%left(btrim(q.content), 500)%' from pg_proc where proname = 'knowledge_gaps' and pronamespace = 'public'::regnamespace), 'M4: question truncation to 500 present (source smoke check)');

select * from finish();
rollback;
