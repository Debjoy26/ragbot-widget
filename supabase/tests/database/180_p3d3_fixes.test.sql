-- P3-D3 fixes (review P3-R3): R3-1 settle after the reaper, R3-2 reply_to lock and fail-closed target.
-- All fixtures are synthetic. Sequential only: the real two-connection race is in
-- docs/evidence/P3-D3/race_reply_to.sh.
begin;
select plan(20);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000d3', 'd3-one', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000d3', 'd3-two', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000d3', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b2000000-0000-4000-8000-0000000000d3', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}');
insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-0000000000d3', 'b1000000-0000-4000-8000-0000000000d3', now() + interval '1 hour'),
  ('a2000000-0000-4000-8000-0000000000d3', 'b2000000-0000-4000-8000-0000000000d3', now() + interval '1 hour');

-- r1 is the slow in-flight request. r2 and r3 are later requests on the same bot.
-- r4 and r5 (other bot) hold reservations that the reaper must leave alone.
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('91000000-0000-4000-8000-0000000000d3', 'b1000000-0000-4000-8000-0000000000d3', 'a1000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d1', repeat('a', 64), 'running', now() - interval '10 minutes'),
  ('92000000-0000-4000-8000-0000000000d3', 'b1000000-0000-4000-8000-0000000000d3', 'a1000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d2', repeat('a', 64), 'running', now()),
  ('93000000-0000-4000-8000-0000000000d3', 'b1000000-0000-4000-8000-0000000000d3', 'a1000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d3', repeat('a', 64), 'running', now()),
  ('94000000-0000-4000-8000-0000000000d3', 'b2000000-0000-4000-8000-0000000000d3', 'a2000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d4', repeat('a', 64), 'running', now() - interval '10 minutes'),
  ('95000000-0000-4000-8000-0000000000d3', 'b2000000-0000-4000-8000-0000000000d3', 'a2000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d5', repeat('a', 64), 'running', now() - interval '10 minutes');

select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d3', '91000000-0000-4000-8000-0000000000d3', 1.0, 3600);
select public.reserve_request_budget('b2000000-0000-4000-8000-0000000000d3', '94000000-0000-4000-8000-0000000000d3', 1.0, 3600);
select public.reserve_request_budget('b2000000-0000-4000-8000-0000000000d3', '95000000-0000-4000-8000-0000000000d3', 1.0, 3600);
select public.settle_budget_reservation('b2000000-0000-4000-8000-0000000000d3',
  (select id from public.budget_reservations where request_id = '94000000-0000-4000-8000-0000000000d3'), 0.5);
select public.release_budget_reservation('b2000000-0000-4000-8000-0000000000d3',
  (select id from public.budget_reservations where request_id = '95000000-0000-4000-8000-0000000000d3'));

create temp view r1_res as
  select * from public.budget_reservations where request_id = '91000000-0000-4000-8000-0000000000d3';

-- ---------------------------------------------------------------------------
-- R3-1: the reaper leaves an in-flight request settleable
-- ---------------------------------------------------------------------------
select is(public.expire_stuck_request_runs(60, 100), 3, 'R3-1: the three old runs are reaped');
select is((select state from public.request_runs where id = '91000000-0000-4000-8000-0000000000d3'), 'failed', 'R3-1: the reaped run is failed');
select is((select state from r1_res), 'expired', 'R3-1: the reaped reservation is expired, not released');
select is((select state from public.budget_reservations where request_id = '94000000-0000-4000-8000-0000000000d3'), 'settled', 'R3-1: the reaper leaves a settled reservation alone');
select is((select state from public.budget_reservations where request_id = '95000000-0000-4000-8000-0000000000d3'), 'released', 'R3-1: the reaper leaves a released reservation alone');

select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.1)', 'b2000000-0000-4000-8000-0000000000d3', (select id from r1_res)),
  'RB003', null, 'R3-1: another bot cannot settle a reaped reservation');
select is((select state from r1_res), 'expired', 'R3-1: the rejected foreign settle changed nothing');

-- While reaped and unsettled it does not hold budget: the full cap is available.
select lives_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d3', '92000000-0000-4000-8000-0000000000d3', 5.0, 3600)$q$,
  'R3-1: a reaped, unsettled reservation does not count toward the cap');
select public.release_budget_reservation('b1000000-0000-4000-8000-0000000000d3',
  (select id from public.budget_reservations where request_id = '92000000-0000-4000-8000-0000000000d3'));

select lives_ok(format('select public.settle_budget_reservation(%L, %L, 0.75)', 'b1000000-0000-4000-8000-0000000000d3', (select id from r1_res)),
  'R3-1: the slow request can settle after the reaper ran');
select is((select state from r1_res), 'settled', 'R3-1: the reservation is settled');
select is((select amount from r1_res), 0.75::numeric(14, 6), 'R3-1: the actual amount is recorded');

select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d3', '93000000-0000-4000-8000-0000000000d3', 4.5, 3600)$q$,
  'RB001', null, 'R3-1: the settled spend counts toward the cap (0.75 + 4.5 > 5)');
select lives_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d3', '93000000-0000-4000-8000-0000000000d3', 4.25, 3600)$q$,
  'R3-1: spend up to the cap is still allowed (0.75 + 4.25 = 5)');
select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.75)', 'b1000000-0000-4000-8000-0000000000d3', (select id from r1_res)),
  'RB003', null, 'R3-1: a reaped reservation cannot be settled twice');

-- ---------------------------------------------------------------------------
-- R3-2: the reply check locks its target and fails closed
-- ---------------------------------------------------------------------------
insert into public.conversations (id, bot_id) values ('c1000000-0000-4000-8000-0000000000d3', 'b1000000-0000-4000-8000-0000000000d3');
insert into public.messages (id, conversation_id, role, content) values
  ('e1000000-0000-4000-8000-0000000000d3', 'c1000000-0000-4000-8000-0000000000d3', 'user', 'question');

select ok((select prosrc ~* 'for\s+share' from pg_proc where oid = 'public.messages_check_reply_to()'::regprocedure), 'R3-2: the trigger locks the target row');
select ok((select not prosecdef from pg_proc where oid = 'public.messages_check_reply_to()'::regprocedure), 'R3-2: the trigger stays SECURITY INVOKER');

set local role service_role;
select lives_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content)
  values ('c1000000-0000-4000-8000-0000000000d3', 'e1000000-0000-4000-8000-0000000000d3', 'assistant', 'answer')$q$,
  'R3-2: service_role, the real writer, can still insert a reply (it holds the lock privilege)');
reset role;

-- A writer without BYPASSRLS cannot see the target. This used to skip the check.
create role p3d3_writer nologin nobypassrls;
grant p3d3_writer to current_user;
grant anon to p3d3_writer;  -- schema usage and pgTAP access; anon has no grant or policy on messages
grant select, insert, update on public.messages to p3d3_writer;
set local role p3d3_writer;
select is((select count(*)::int from public.messages), 0, 'R3-2: the target is invisible to this writer (RLS)');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content)
  values ('c1000000-0000-4000-8000-0000000000d3', 'e1000000-0000-4000-8000-0000000000d3', 'assistant', 'answer')$q$,
  '23514', 'messages: reply_to_message_id must reference a user message of the same conversation',
  'R3-2: an invisible target is rejected by the trigger, not skipped');
reset role;

select is((select count(*)::int from public.messages where conversation_id = 'c1000000-0000-4000-8000-0000000000d3'), 2,
  'R3-2: only the question and the valid reply exist');

select * from finish();
rollback;
