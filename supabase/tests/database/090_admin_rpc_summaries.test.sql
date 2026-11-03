-- knowledge_gaps / job_status_summary / usage_daily_summary: membership-checked, bounded, aggregate-only.
begin;
select plan(31);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', 's-analyst@example.test'),
  ('a1000000-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', 's-admin@example.test'),
  ('a1000000-0000-4000-8000-0000000000f3', 'authenticated', 'authenticated', 's-owner@example.test'),
  ('a1000000-0000-4000-8000-0000000000f4', 'authenticated', 'authenticated', 's-nonmember@example.test');
insert into public.admin_memberships (user_id, role) values
  ('a1000000-0000-4000-8000-0000000000f1', 'analyst'),
  ('a1000000-0000-4000-8000-0000000000f2', 'admin'),
  ('a1000000-0000-4000-8000-0000000000f3', 'owner');

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000f1', 's-bot', 'x', array['en'], 'm', 1536);
insert into public.visitor_sessions (id, bot_id, expires_at) values ('a1000000-0000-4000-8000-0000000000a1', 'b1000000-0000-4000-8000-0000000000f1', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c1000000-0000-4000-8000-0000000000f1', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000a1'),
  ('c2000000-0000-4000-8000-0000000000f2', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000a1'),
  ('c3000000-0000-4000-8000-0000000000f3', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000a1');

-- Knowledge-gap fixtures (question text is synthetic).
-- c1, c2: same question -> no_knowledge (2 occurrences). c3: different question -> out_of_scope.
-- Also: an answered turn (no handoff), an old turn outside the range, and a non-gap in c3.
insert into public.messages (conversation_id, role, content, handoff_reason, created_at) values
  ('c1000000-0000-4000-8000-0000000000f1', 'user', '  What is the warranty period?  ', null, now() - interval '2 hours'),
  ('c1000000-0000-4000-8000-0000000000f1', 'assistant', 'I do not know.', 'no_knowledge', now() - interval '2 hours' + interval '1 second'),
  ('c2000000-0000-4000-8000-0000000000f2', 'user', 'What is the warranty period?', null, now() - interval '1 hour'),
  ('c2000000-0000-4000-8000-0000000000f2', 'assistant', 'I do not know.', 'no_knowledge', now() - interval '1 hour' + interval '1 second'),
  ('c3000000-0000-4000-8000-0000000000f3', 'user', 'Who won the cricket match?', null, now() - interval '30 minutes'),
  ('c3000000-0000-4000-8000-0000000000f3', 'assistant', 'Out of scope.', 'out_of_scope', now() - interval '30 minutes' + interval '1 second'),
  ('c3000000-0000-4000-8000-0000000000f3', 'user', 'How do I reset my password?', null, now() - interval '20 minutes'),
  ('c3000000-0000-4000-8000-0000000000f3', 'assistant', 'Here is how.', null, now() - interval '20 minutes' + interval '1 second'),
  ('c3000000-0000-4000-8000-0000000000f3', 'user', 'Ancient question', null, now() - interval '200 days'),
  ('c3000000-0000-4000-8000-0000000000f3', 'assistant', 'No idea.', 'no_knowledge', now() - interval '200 days' + interval '1 second');

insert into public.jobs (type, dedupe_key, max_attempts, state, payload, last_error) values
  ('index_document', 's1', 3, 'queued', '{"secret_like":"payload-body"}', null),
  ('index_document', 's2', 3, 'queued', '{}', null),
  ('index_document', 's3', 3, 'failed', '{}', 'provider said: boom'),
  ('cleanup', 's4', 3, 'succeeded', '{}', null);

insert into public.usage_events (bot_id, operation, input_tokens, output_tokens, estimated_cost, created_at) values
  ('b1000000-0000-4000-8000-0000000000f1', 'chat', 100, 50, 0.010000, now()),
  ('b1000000-0000-4000-8000-0000000000f1', 'chat', 200, 80, 0.020000, now()),
  ('b1000000-0000-4000-8000-0000000000f1', 'answer_cache_hit', 0, 0, 0, now()),
  ('b1000000-0000-4000-8000-0000000000f1', 'chat', 999, 999, 9.000000, now() - interval '200 days');

-- ===== nonmember + anon: nothing / denied =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f4","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 10)$q$, '42501', null, 'nonmember: knowledge_gaps denied');
select throws_ok($q$select * from public.job_status_summary()$q$, '42501', null, 'nonmember: job_status_summary denied');
select throws_ok($q$select * from public.usage_daily_summary((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date)$q$, '42501', null, 'nonmember: usage_daily_summary denied');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 10)$q$, '42501', null, 'anon: knowledge_gaps EXECUTE denied');
select throws_ok($q$select * from public.job_status_summary()$q$, '42501', null, 'anon: job_status_summary EXECUTE denied');
select throws_ok($q$select * from public.usage_daily_summary((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date)$q$, '42501', null, 'anon: usage_daily_summary EXECUTE denied');
reset role;

-- ===== analyst: aggregates only =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f1","aal":"aal2","role":"authenticated"}', true);

select results_eq(
  $q$select job_type, job_state, job_count from public.job_status_summary() order by 1, 2$q$,
  $q$values ('cleanup'::text, 'succeeded'::text, 1::bigint), ('index_document', 'failed', 1), ('index_document', 'queued', 2)$q$,
  'analyst: job_status_summary returns counts by type/state');
select is(
  pg_get_function_result('public.job_status_summary()'::regprocedure),
  'TABLE(job_type text, job_state text, job_count bigint)',
  'job_status_summary exposes no payload / progress / last_error columns');

select results_eq(
  $q$select operation, event_count, input_tokens, output_tokens, estimated_cost
       from public.usage_daily_summary((now() at time zone 'UTC')::date - 1, (now() at time zone 'UTC')::date) order by operation$q$,
  $q$values ('answer_cache_hit'::text, 1::bigint, 0::bigint, 0::bigint, 0::numeric), ('chat', 2, 300, 130, 0.030000)$q$,
  'analyst: usage_daily_summary aggregates by day/operation (old event excluded, cache-hit rate derivable)');
select is(
  pg_get_function_result('public.usage_daily_summary(date, date)'::regprocedure),
  'TABLE(usage_day date, bot_id uuid, operation text, event_count bigint, input_tokens bigint, output_tokens bigint, estimated_cost numeric)',
  'usage_daily_summary exposes aggregates only (no request/job ids, no per-event rows)');
select lives_ok($q$select * from public.usage_daily_summary((now() at time zone 'UTC')::date - 91, (now() at time zone 'UTC')::date)$q$, 'usage_daily_summary: 92-day inclusive range accepted');
select throws_ok($q$select * from public.usage_daily_summary((now() at time zone 'UTC')::date - 92, (now() at time zone 'UTC')::date)$q$, '22023', null, 'usage_daily_summary: 93-day range rejected');
select throws_ok($q$select * from public.usage_daily_summary((now() at time zone 'UTC')::date - 1000, (now() at time zone 'UTC')::date)$q$, '22023', null, 'usage_daily_summary: huge range rejected');
select throws_ok($q$select * from public.usage_daily_summary((now() at time zone 'UTC')::date, (now() at time zone 'UTC')::date - 1)$q$, '22023', null, 'usage_daily_summary: reversed range rejected');
select throws_ok($q$select * from public.usage_daily_summary(null, (now() at time zone 'UTC')::date)$q$, '22023', null, 'usage_daily_summary: null bound rejected');

select results_eq(
  $q$select handoff_reason, question, occurrences from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 10) order by occurrences desc, handoff_reason$q$,
  $q$values ('no_knowledge'::text, 'What is the warranty period?'::text, 2::bigint), ('out_of_scope', 'Who won the cricket match?', 1)$q$,
  'analyst: knowledge_gaps groups by reason + normalised question with counts (answered turns and out-of-range rows excluded)');
select is(
  (select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 10) where question = 'Ancient question'),
  0, 'knowledge_gaps: rows outside the date range are excluded');
select results_eq(
  $q$select handoff_reason, occurrences from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 1)$q$,
  $q$values ('no_knowledge'::text, 2::bigint)$q$,
  'knowledge_gaps: limit 1 returns only the most frequent gap');
select is(
  pg_get_function_result('public.knowledge_gaps(date, date, integer)'::regprocedure),
  'TABLE(handoff_reason text, question text, occurrences bigint, last_seen timestamp with time zone)',
  'knowledge_gaps exposes no conversation/session/visitor identifiers');
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 91, (now() at time zone 'UTC')::date, 0)$q$, '22023', null, 'knowledge_gaps: limit 0 rejected');
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 91, (now() at time zone 'UTC')::date, 201)$q$, '22023', null, 'knowledge_gaps: limit 201 rejected');
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 91, (now() at time zone 'UTC')::date, null)$q$, '22023', null, 'knowledge_gaps: null limit rejected');
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 92, (now() at time zone 'UTC')::date, 10)$q$, '22023', null, 'knowledge_gaps: 93-day range rejected');
select throws_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date, (now() at time zone 'UTC')::date - 1, 10)$q$, '22023', null, 'knowledge_gaps: reversed range rejected');
select lives_ok($q$select * from public.knowledge_gaps((now() at time zone 'UTC')::date - 91, (now() at time zone 'UTC')::date, 200)$q$, 'knowledge_gaps: 92-day range and limit 200 accepted');
reset role;

-- ===== admin / owner: same RPCs work =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f2","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 10)), 2, 'admin: knowledge_gaps returns the two gaps');
select is((select sum(job_count)::int from public.job_status_summary()), 4, 'admin: job_status_summary counts all jobs');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f3","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.knowledge_gaps((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date, 10)), 2, 'owner: knowledge_gaps returns the two gaps');
select is((select count(*)::int from public.usage_daily_summary((now() at time zone 'UTC')::date - 1, (now() at time zone 'UTC')::date)), 2, 'owner: usage_daily_summary works');
reset role;

-- ===== direct table access stays closed for the same actors =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f1","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.jobs$q$, '42501', null, 'analyst: jobs table itself stays closed (RPC only)');
select throws_ok($q$select * from public.usage_events$q$, '42501', null, 'analyst: usage_events table itself stays closed (RPC only)');
reset role;

select * from finish();
rollback;
