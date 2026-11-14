-- P9-T2 (migration 017): debounced analysis queue, bounded context, analysis upserts.
-- Debounce semantics; ownership (RB037, no oracle); fail-closed validation (22023);
-- grants and proconfig. All fixtures are synthetic. Ids end in 000000000231.
begin;
select plan(27);

insert into public.bot_profiles (id, slug, identity_prompt, tone, scope, allowed_languages, embedding_model, embedding_dimensions, enabled) values
  ('b1000000-0000-4000-8000-000000000231', 'p9a-main',  'x', 't', 's', array['en'], 'm', 1536, true),
  ('b2000000-0000-4000-8000-000000000231', 'p9a-other', 'x', 't', 's', array['en'], 'm', 1536, true);
insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-000000000231', 'b1000000-0000-4000-8000-000000000231', now() + interval '1 hour');
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state) values
  ('d1000000-0000-4000-8000-000000000231', 'b1000000-0000-4000-8000-000000000231', 'a1000000-0000-4000-8000-000000000231', '00000000-0000-4000-8000-000000000001', repeat('a', 64), 'succeeded');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c1000000-0000-4000-8000-000000000231', 'b1000000-0000-4000-8000-000000000231', 'a1000000-0000-4000-8000-000000000231'),
  ('c2000000-0000-4000-8000-000000000231', 'b2000000-0000-4000-8000-000000000231', null);
insert into public.messages (conversation_id, request_id, role, content, status) values
  ('c1000000-0000-4000-8000-000000000231', 'd1000000-0000-4000-8000-000000000231', 'user', 'q', 'complete'),
  ('c1000000-0000-4000-8000-000000000231', 'd1000000-0000-4000-8000-000000000231', 'assistant', 'a', 'complete'),
  ('c1000000-0000-4000-8000-000000000231', 'd1000000-0000-4000-8000-000000000231', 'system', 'sys', 'complete');

-- ===== queue: first call queues with the debounce window =====
create temp table q1 as
  select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c1000000-0000-4000-8000-000000000231', 300);
select isnt((select * from q1), null, 'queue_analysis_job: first call returns a job id');
select is((select count(*)::int from public.jobs where dedupe_key = 'analyze_conversation:c1000000-0000-4000-8000-000000000231' and state = 'queued'), 1, 'queue_analysis_job: one queued row');
select ok((select available_at > now() + interval '4 minutes' from public.jobs where id = (select * from q1)), 'queue_analysis_job: available_at is pushed back by the debounce');
select is((select payload ->> 'bot_id' from public.jobs where id = (select * from q1)), 'b1000000-0000-4000-8000-000000000231', 'queue_analysis_job: payload names the bot');
select is((select max_attempts from public.jobs where id = (select * from q1)), 5, 'queue_analysis_job: fixed attempt budget of 5');

-- ===== queue: a second message pushes the window back (debounce), no second row =====
create temp table q2 as
  select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c1000000-0000-4000-8000-000000000231', 300);
select is((select count(*)::int from public.jobs where dedupe_key = 'analyze_conversation:c1000000-0000-4000-8000-000000000231'), 1, 'queue_analysis_job: repeat message keeps one row');

-- ===== queue: a running run is joined =====
update public.jobs set state = 'running', locked_by = 'w-test', locked_until = now() + interval '1 minute' where id = (select * from q1);
create temp table q3 as
  select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c1000000-0000-4000-8000-000000000231', 300);
select is((select * from q3), (select * from q1), 'queue_analysis_job: joins the in-flight run');
select is((select count(*)::int from public.jobs where dedupe_key = 'analyze_conversation:c1000000-0000-4000-8000-000000000231'), 1, 'queue_analysis_job: join adds no row');
update public.jobs set state = 'queued', locked_by = null, locked_until = null where id = (select * from q1);

-- ===== queue: ownership and bounds =====
select throws_ok($q$select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c2000000-0000-4000-8000-000000000231', 300)$q$, 'RB037', null, 'queue_analysis_job: another bot conversation -> RB037');
select throws_ok($q$select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c9000000-0000-4000-8000-000000000231', 300)$q$, 'RB037', null, 'queue_analysis_job: unknown conversation -> RB037');
select throws_ok($q$select * from public.queue_analysis_job('b9000000-0000-4000-8000-000000000231', null, 300)$q$, '22023', null, 'queue_analysis_job: null conversation -> 22023');
select throws_ok($q$select * from public.queue_analysis_job(null, 'c1000000-0000-4000-8000-000000000231', 300)$q$, '22023', null, 'queue_analysis_job: null bot -> 22023');
select throws_ok($q$select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c1000000-0000-4000-8000-000000000231', -1)$q$, '22023', null, 'queue_analysis_job: negative debounce -> 22023');
select throws_ok($q$select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c1000000-0000-4000-8000-000000000231', 3601)$q$, '22023', null, 'queue_analysis_job: debounce above 3600 -> 22023');

-- ===== context: bounded transcript, no system rows, bot identity =====
select is((select jsonb_array_length(public.get_analysis_context('c1000000-0000-4000-8000-000000000231') -> 'messages')), 2, 'get_analysis_context: user + assistant only (system excluded)');
select is((select public.get_analysis_context('c1000000-0000-4000-8000-000000000231') -> 'bot' ->> 'scope'), 's', 'get_analysis_context: bot identity included');
select throws_ok($q$select * from public.get_analysis_context('c9000000-0000-4000-8000-000000000231')$q$, 'RB037', null, 'get_analysis_context: unknown conversation -> RB037');
select throws_ok($q$select * from public.get_analysis_context(null)$q$, '22023', null, 'get_analysis_context: null conversation -> 22023');

-- ===== save / fail =====
select lives_ok($q$select * from public.save_conversation_analysis('c1000000-0000-4000-8000-000000000231', 's', 'neutral', 'pricing question', 'rag-analysis-v1')$q$, 'save_conversation_analysis: valid row saves');
select is((select status from public.conversation_analysis where conversation_id = 'c1000000-0000-4000-8000-000000000231'), 'complete', 'save_conversation_analysis: status complete');
select throws_ok($q$select * from public.save_conversation_analysis('c1000000-0000-4000-8000-000000000231', 's', 'happy', 'pricing question', 'rag-analysis-v1')$q$, '22023', null, 'save_conversation_analysis: bad sentiment -> 22023');
select throws_ok($q$select * from public.save_conversation_analysis('c9000000-0000-4000-8000-000000000231', 's', 'neutral', 'pricing question', 'rag-analysis-v1')$q$, 'RB037', null, 'save_conversation_analysis: unknown conversation -> RB037');
select lives_ok($q$select * from public.fail_conversation_analysis('c1000000-0000-4000-8000-000000000231')$q$, 'fail_conversation_analysis: marks failed');
select is((select status from public.conversation_analysis where conversation_id = 'c1000000-0000-4000-8000-000000000231'), 'failed', 'fail_conversation_analysis: status failed, summary kept');

-- ===== grants and configuration =====
select ok((select 'lock_timeout=2s' = any (proconfig) and 'search_path=""' = any (proconfig) and not prosecdef from pg_proc where oid = 'public.queue_analysis_job(uuid,uuid,integer)'::regprocedure), 'proconfig: queue_analysis_job sets lock_timeout, an empty search_path and is SECURITY INVOKER');
select ok(has_function_privilege('service_role', 'public.queue_analysis_job(uuid,uuid,integer)', 'EXECUTE') and not has_function_privilege('anon', 'public.queue_analysis_job(uuid,uuid,integer)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.queue_analysis_job(uuid,uuid,integer)', 'EXECUTE'), 'grants: queue_analysis_job is service_role only');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.queue_analysis_job('b1000000-0000-4000-8000-000000000231', 'c1000000-0000-4000-8000-000000000231', 300)$q$, '42501', null, 'anon: queue_analysis_job -> permission denied');
reset role;

select * from finish();
rollback;
