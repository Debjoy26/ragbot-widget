-- P3-D2 fixes (re-review P3-R2): N1 settle after expiry, N2 stuck-run reaper, N3 durable question pairing
-- (messages.reply_to_message_id), N5 audit_logs TRUNCATE block, N7b release ownership/locking.
-- (N7a is in 130_begin_request_run, N7c in 030.) All fixtures are synthetic. Sequential behaviour only:
-- true concurrent races need two connections (P5 integration tests).
begin;
select plan(80);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', 'd2-admin@example.test');
insert into public.admin_memberships (user_id, role) values ('a1000000-0000-4000-8000-0000000000f2', 'admin');

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000f1', 'd2-budget', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000f2', 'd2-other', 'x', array['en'], 'm', 1536),
  ('b3000000-0000-4000-8000-0000000000f3', 'd2-nosettings', 'x', array['en'], 'm', 1536),
  ('b4000000-0000-4000-8000-0000000000f4', 'd2-runs', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000f1', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b2000000-0000-4000-8000-0000000000f2', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b4000000-0000-4000-8000-0000000000f4', array['https://e.test'], '{"concurrent_requests_per_session": 1}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}');

insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-0000000000f1', 'b1000000-0000-4000-8000-0000000000f1', now() + interval '1 hour'),
  ('a4000000-0000-4000-8000-0000000000f4', 'b4000000-0000-4000-8000-0000000000f4', now() + interval '1 hour'),
  ('a6000000-0000-4000-8000-0000000000f6', 'b1000000-0000-4000-8000-0000000000f1', now() + interval '1 hour');

-- Runs for the budget scenarios (bot 1, session 1): R1..R5.
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash) values
  ('91000000-0000-4000-8000-0000000000f1', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f1', repeat('a', 64)),
  ('92000000-0000-4000-8000-0000000000f2', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2', repeat('a', 64)),
  ('93000000-0000-4000-8000-0000000000f3', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f3', repeat('a', 64)),
  ('94000000-0000-4000-8000-0000000000f4', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f4', repeat('a', 64)),
  ('95000000-0000-4000-8000-0000000000f5', 'b1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f5', repeat('a', 64));

-- ===========================================================================
-- N5: audit_logs TRUNCATE is blocked even for the table owner (row triggers do not fire on TRUNCATE).
-- ===========================================================================
insert into public.audit_logs (id, action, resource_type) values ('a0d17000-0000-4000-8000-0000000000f5', 'fixture', 'test');
select throws_ok($q$truncate public.audit_logs$q$, '42501', null, 'N5: owner TRUNCATE of audit_logs is blocked by trigger');
select throws_ok($q$truncate public.audit_logs, public.rate_limit_buckets$q$, '42501', null, 'N5: owner multi-table TRUNCATE including audit_logs is blocked');
select is((select count(*)::int from public.audit_logs where id = 'a0d17000-0000-4000-8000-0000000000f5'), 1, 'N5: the blocked TRUNCATE left the row in place');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.audit_logs'::regclass and tgname = 'audit_logs_no_truncate' and not tgisinternal and (tgtype & 32) = 32), 1, 'N5: a TRUNCATE trigger is installed on audit_logs');

-- ===========================================================================
-- N1: settle after expiry (swept and unswept) and the cap accounting (daily_cap_usd = 5)
-- ===========================================================================
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table res1 as select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '91000000-0000-4000-8000-0000000000f1', 2, 60) as id;
create temp table res2 as select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '92000000-0000-4000-8000-0000000000f2', 2, 60) as id;
reset role;
-- res1: reserved but past expires_at (unswept). res2: past expires_at AND swept to 'expired'.
update public.budget_reservations set expires_at = now() - interval '1 minute' where id in (select id from res1 union select id from res2);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select state from public.budget_reservations where id = (select id from res1)), 'reserved', 'N1 setup: res1 is reserved and past expiry (unswept)');

select lives_ok(format('select public.settle_budget_reservation(%L, %L, 1.5)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res1)), 'N1: settle of a reserved-but-expired (unswept) reservation succeeds');
select is((select state || ':' || amount::text from public.budget_reservations where id = (select id from res1)), 'settled:1.500000', 'N1: unswept late settle -> settled with the actual amount');

select is(public.expire_stale_budget_reservations(100), 1, 'N1 setup: the sweeper expires exactly the unsettled stale reservation (res2)');
select is((select state from public.budget_reservations where id = (select id from res2)), 'expired', 'N1 setup: res2 is now swept to expired');
select lives_ok(format('select public.settle_budget_reservation(%L, %L, 1.0)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res2)), 'N1: settle of a swept (expired) reservation succeeds');
select is((select state || ':' || amount::text from public.budget_reservations where id = (select id from res2)), 'settled:1.000000', 'N1: swept late settle -> settled with the actual amount');

-- Settled spend (1.5 + 1.0 = 2.5) now counts toward the cap.
select is((select sum(amount) from public.budget_reservations where bot_id = 'b1000000-0000-4000-8000-0000000000f1' and state = 'settled'), 2.500000::numeric, 'N1: settled total is 2.5');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '93000000-0000-4000-8000-0000000000f3', 2.6, 60)$q$, 'RB001', null, 'N1: late-settled spend counts toward the cap (2.5 + 2.6 > 5 refused)');
create temp table res3 as select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '93000000-0000-4000-8000-0000000000f3', 2.5, 60) as id;
select isnt((select id from res3), null, 'N1: exactly up to the cap (2.5 + 2.5 = 5) is still allowed');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '94000000-0000-4000-8000-0000000000f4', 0.1, 60)$q$, 'RB001', null, 'N1: the cap is now full');

-- Still rejected: settled and released.
select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.1)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res1)), 'RB003', null, 'N1: an already settled reservation cannot be settled again');
select lives_ok(format('select public.release_budget_reservation(%L, %L)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res3)), 'N7b: owning bot releases an active reservation');
select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.1)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res3)), 'RB003', null, 'N1: a released reservation cannot be settled');
select is((select state from public.budget_reservations where id = (select id from res3)), 'released', 'N1: the rejected settle left the released reservation as it was');
select is((select sum(amount) from public.budget_reservations where bot_id = 'b1000000-0000-4000-8000-0000000000f1' and state = 'settled'), 2.500000::numeric, 'N1: rejected settles added no spend');

-- Ownership is kept for late settles: another bot cannot settle (or release) bot 1's expired reservation.
create temp table res4 as select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '94000000-0000-4000-8000-0000000000f4', 1, 60) as id;
reset role;
update public.budget_reservations set expires_at = now() - interval '1 minute' where id = (select id from res4);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.5)', 'b2000000-0000-4000-8000-0000000000f2', (select id from res4)), 'RB003', null, 'N1: a foreign bot cannot settle an expired reservation (ownership kept)');
select is((select state from public.budget_reservations where id = (select id from res4)), 'reserved', 'N1: the foreign settle left the reservation untouched');

-- ===========================================================================
-- N7b: release_budget_reservation(p_bot_id, p_reservation_id): ownership + client_settings lock
-- ===========================================================================
select throws_ok(format('select public.release_budget_reservation(%L, %L)', 'b2000000-0000-4000-8000-0000000000f2', (select id from res4)), 'RB003', null, 'N7b: a foreign bot cannot release the reservation (ownership)');
select is((select state from public.budget_reservations where id = (select id from res4)), 'reserved', 'N7b: the foreign release left the reservation active');
select throws_ok(format('select public.release_budget_reservation(%L, %L)', 'b3000000-0000-4000-8000-0000000000f3', (select id from res4)), 'RB002', null, 'N7b: a bot without client_settings fails closed');
select throws_ok($q$select public.release_budget_reservation(null, gen_random_uuid())$q$, '22023', null, 'N7b: null bot rejected');
select throws_ok($q$select public.release_budget_reservation('b1000000-0000-4000-8000-0000000000f1', null)$q$, '22023', null, 'N7b: null reservation rejected');
select throws_ok($q$select public.release_budget_reservation('b1000000-0000-4000-8000-0000000000f1', gen_random_uuid())$q$, 'RB003', null, 'N7b: unknown reservation -> RB003');
select ok((select prosrc ilike '%from public.client_settings cs where cs.bot_id = p_bot_id for update%' from pg_proc where proname = 'release_budget_reservation' and pronamespace = 'public'::regnamespace), 'N7b: release locks the bot''s client_settings row FOR UPDATE (source smoke check, not a race test)');
select is((select count(*)::int from pg_proc where proname = 'release_budget_reservation' and pronamespace = 'public'::regnamespace), 1, 'N7b: the old one-argument release_budget_reservation no longer exists');
-- The late settle of bot 1's expired reservation by its owner still works.
select lives_ok(format('select public.settle_budget_reservation(%L, %L, 1.0)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res4)), 'N1: the owner can still settle its own expired reservation');
-- Active release by the owner for a fresh reservation.
create temp table res5 as select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000f1', '95000000-0000-4000-8000-0000000000f5', 0.5, 60) as id;
select lives_ok(format('select public.release_budget_reservation(%L, %L)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res5)), 'N7b: owner release of a second active reservation succeeds');
select throws_ok(format('select public.release_budget_reservation(%L, %L)', 'b1000000-0000-4000-8000-0000000000f1', (select id from res5)), 'RB003', null, 'N7b: releasing twice is rejected');

-- ===========================================================================
-- N2: expire_stuck_request_runs frees stuck runs and releases their reservations
-- ===========================================================================
create temp table x1 as select * from public.begin_request_run('b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', 1, '00000000-0000-4000-8000-0000000000a1', repeat('a', 64));
select is((select outcome from x1), 'new', 'N2 setup: first run starts');
create temp table xres as select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000f4', (select run_id from x1), 0.4, 3600) as id;
select is((select outcome from public.begin_request_run('b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', 1, '00000000-0000-4000-8000-0000000000a2', repeat('b', 64))), 'concurrency_limited', 'N2 setup: the stuck run blocks the session (cap 1)');

select is(public.expire_stuck_request_runs(60, 100), 0, 'N2: a recent run is untouched');
select is((select state from public.request_runs where id = (select run_id from x1)), 'reserved', 'N2: the recent run is still reserved');
select is((select state from public.budget_reservations where id = (select id from xres)), 'reserved', 'N2: the recent run''s reservation is still active');

reset role;
update public.request_runs set started_at = now() - interval '2 hours' where id = (select run_id from x1);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.expire_stuck_request_runs(3600, 100), 1, 'N2: a run older than the threshold is failed');
select is((select state from public.request_runs where id = (select run_id from x1)), 'failed', 'N2: the stuck run is failed');
select isnt((select finished_at from public.request_runs where id = (select run_id from x1)), null, 'N2: finished_at is set');
select is((select state from public.budget_reservations where id = (select id from xres)), 'released', 'N2: the stuck run''s active reservation is released');
select is((select outcome from public.begin_request_run('b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', 1, '00000000-0000-4000-8000-0000000000a2', repeat('b', 64))), 'new', 'N2: the slot is free again, begin_request_run returns new');
select is(public.expire_stuck_request_runs(3600, 100), 0, 'N2: idempotent, a second sweep fails nothing more (the new run is recent)');

-- 'running' runs are reaped too; terminal runs and settled reservations are not touched; batch bound is honoured.
reset role;
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('c1000000-0000-4000-8000-0000000000f1', 'b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000b1', repeat('a', 64), 'running', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-0000000000f2', 'b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000b2', repeat('a', 64), 'running', now() - interval '3 hours'),
  ('c3000000-0000-4000-8000-0000000000f3', 'b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000b3', repeat('a', 64), 'running', now() - interval '3 hours'),
  ('c4000000-0000-4000-8000-0000000000f4', 'b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000b4', repeat('a', 64), 'succeeded', now() - interval '3 hours'),
  ('c5000000-0000-4000-8000-0000000000f5', 'b4000000-0000-4000-8000-0000000000f4', 'a4000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000b5', repeat('a', 64), 'reserved', now() - interval '3 hours');
insert into public.budget_reservations (id, bot_id, request_id, amount, state, expires_at) values
  ('e5000000-0000-4000-8000-0000000000f5', 'b4000000-0000-4000-8000-0000000000f4', 'c5000000-0000-4000-8000-0000000000f5', 0.3, 'settled', now() + interval '1 hour');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.expire_stuck_request_runs(60, 2), 2, 'N2: batch bound: at most p_batch runs per call (2 of 4 stuck)');
select is(public.expire_stuck_request_runs(60, 2), 2, 'N2: the next call reaps the remaining two');
select is(public.expire_stuck_request_runs(60, 2), 0, 'N2: nothing left to reap');
select is((select state from public.request_runs where id = 'c4000000-0000-4000-8000-0000000000f4'), 'succeeded', 'N2: a succeeded run is never touched');
select is((select state from public.request_runs where id = 'c1000000-0000-4000-8000-0000000000f1'), 'failed', 'N2: a stuck running run is failed');
select is((select state || ':' || amount::text from public.budget_reservations where id = 'e5000000-0000-4000-8000-0000000000f5'), 'settled:0.300000', 'N2: a settled reservation of a stuck run stays settled (the spend happened)');

select throws_ok($q$select public.expire_stuck_request_runs(59, 10)$q$, '22023', null, 'N2: older-than below 60s rejected (would reap live requests)');
select throws_ok($q$select public.expire_stuck_request_runs(86401, 10)$q$, '22023', null, 'N2: older-than above 86400s rejected');
select throws_ok($q$select public.expire_stuck_request_runs(null, 10)$q$, '22023', null, 'N2: null threshold rejected (no default)');
select throws_ok($q$select public.expire_stuck_request_runs(60, 0)$q$, '22023', null, 'N2: batch 0 rejected');
select throws_ok($q$select public.expire_stuck_request_runs(60, 10001)$q$, '22023', null, 'N2: batch above 10000 rejected');
select throws_ok($q$select public.expire_stuck_request_runs(60, null)$q$, '22023', null, 'N2: null batch rejected (no default)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f2","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.expire_stuck_request_runs(60, 10)$q$, '42501', null, 'N2: authenticated (even an MFA admin) cannot call expire_stuck_request_runs');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select public.expire_stuck_request_runs(60, 10)$q$, '42501', null, 'N2: anon cannot call expire_stuck_request_runs');
reset role;

-- ===========================================================================
-- N3: messages.reply_to_message_id (durable question pairing + integrity)
-- ===========================================================================
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash) values
  ('d1000000-0000-4000-8000-0000000000f1', 'b1000000-0000-4000-8000-0000000000f1', 'a6000000-0000-4000-8000-0000000000f6', '00000000-0000-4000-8000-0000000000c1', repeat('a', 64)),
  ('d2000000-0000-4000-8000-0000000000f2', 'b1000000-0000-4000-8000-0000000000f1', 'a6000000-0000-4000-8000-0000000000f6', '00000000-0000-4000-8000-0000000000c2', repeat('a', 64));
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c1000000-0000-4000-8000-0000000000c1', 'b1000000-0000-4000-8000-0000000000f1', 'a6000000-0000-4000-8000-0000000000f6'),
  ('c2000000-0000-4000-8000-0000000000c2', 'b1000000-0000-4000-8000-0000000000f1', 'a6000000-0000-4000-8000-0000000000f6'),
  ('c3000000-0000-4000-8000-0000000000c3', 'b1000000-0000-4000-8000-0000000000f1', 'a6000000-0000-4000-8000-0000000000f6');

-- Conversation 1: two OVERLAPPING requests; both answers arrive after question 2.
insert into public.messages (id, conversation_id, request_id, role, content, created_at) values
  ('e1000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-0000000000f1', 'user', 'Q-one', now() - interval '3 hours'),
  ('e1000000-0000-4000-8000-0000000000a2', 'c1000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000f2', 'user', 'Q-two', now() - interval '3 hours' + interval '1 second'),
  ('e1000000-0000-4000-8000-0000000000a5', 'c1000000-0000-4000-8000-0000000000c1', null, 'system', 'sys', now() - interval '3 hours' + interval '1500 milliseconds');
select lives_ok($q$insert into public.messages (id, conversation_id, request_id, reply_to_message_id, role, content, handoff_reason, created_at) values
  ('e1000000-0000-4000-8000-0000000000b1', 'c1000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-0000000000f1', 'e1000000-0000-4000-8000-0000000000a1', 'assistant', 'idk', 'no_knowledge', now() - interval '3 hours' + interval '2 seconds'),
  ('e1000000-0000-4000-8000-0000000000b2', 'c1000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000f2', 'e1000000-0000-4000-8000-0000000000a2', 'assistant', 'out', 'out_of_scope', now() - interval '3 hours' + interval '3 seconds'),
  ('e1000000-0000-4000-8000-0000000000b3', 'c1000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000f2', 'e1000000-0000-4000-8000-0000000000a1', 'assistant', 'human', 'human_requested', now() - interval '3 hours' + interval '4 seconds')$q$,
  'N3: assistant messages with a valid reply_to_message_id (same conversation, user target) insert');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f2","aal":"aal2","role":"authenticated"}', true);
select set_eq(
  $q$select handoff_reason, question from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)$q$,
  $q$values ('no_knowledge'::text, 'Q-one'::text), ('out_of_scope', 'Q-two'), ('human_requested', 'Q-one')$q$,
  'N3: reply_to_message_id pairing wins, also over a conflicting request_id (b3 carries Q-two''s request_id but replies to Q-one)');
reset role;

-- Purge the visitor session: request_runs cascade, messages.request_id is set null (as retention does).
delete from public.visitor_sessions where id = 'a6000000-0000-4000-8000-0000000000f6';
select is((select count(*)::int from public.messages where conversation_id = 'c1000000-0000-4000-8000-0000000000c1' and request_id is not null), 0, 'N3 setup: session purge nulled every messages.request_id');
select is((select count(*)::int from public.messages where conversation_id = 'c1000000-0000-4000-8000-0000000000c1' and reply_to_message_id is not null), 3, 'N3: reply_to_message_id survives the session / request_runs purge');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000f2","aal":"aal2","role":"authenticated"}', true);
select set_eq(
  $q$select handoff_reason, question from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)$q$,
  $q$values ('no_knowledge'::text, 'Q-one'::text), ('out_of_scope', 'Q-two'), ('human_requested', 'Q-one')$q$,
  'N3: pairing is unchanged after the purge, with overlapping requests (the latest-earlier fallback would have paired all three with Q-two)');
reset role;

-- Integrity: target must be a user message of the SAME conversation; only assistants may reply.
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content) values ('c2000000-0000-4000-8000-0000000000c2', 'e1000000-0000-4000-8000-0000000000a1', 'assistant', 'x')$q$, '23514', null, 'N3: reply_to a message of ANOTHER conversation is rejected');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content) values ('c1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000b1', 'assistant', 'x')$q$, '23514', null, 'N3: reply_to an ASSISTANT message is rejected');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content) values ('c1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a5', 'assistant', 'x')$q$, '23514', null, 'N3: reply_to a SYSTEM message is rejected');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content) values ('c1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a1', 'user', 'x')$q$, '23514', null, 'N3: a user message cannot carry reply_to_message_id (CHECK)');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content) values ('c1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a1', 'system', 'x')$q$, '23514', null, 'N3: a system message cannot carry reply_to_message_id (CHECK)');
select throws_ok($q$insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values ('e1000000-0000-4000-8000-0000000000b9', 'c1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000b9', 'assistant', 'x')$q$, '23514', null, 'N3: a message cannot reply to itself');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content) values ('c1000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000dead', 'assistant', 'x')$q$, '23503', null, 'N3: a nonexistent target is rejected by the foreign key');
select throws_ok($q$update public.messages set reply_to_message_id = 'e1000000-0000-4000-8000-0000000000a5' where id = 'e1000000-0000-4000-8000-0000000000b1'$q$, '23514', null, 'N3: UPDATE re-pointing to a non-user message is rejected');
select throws_ok($q$update public.messages set conversation_id = 'c2000000-0000-4000-8000-0000000000c2' where id = 'e1000000-0000-4000-8000-0000000000b1'$q$, '23514', null, 'N3: UPDATE moving the answer to another conversation is rejected');
select throws_ok($q$update public.messages set conversation_id = 'c2000000-0000-4000-8000-0000000000c2' where id = 'e1000000-0000-4000-8000-0000000000a1'$q$, '23514', null, 'N3: moving a question that has answers to another conversation is rejected');
select throws_ok($q$update public.messages set role = 'system' where id = 'e1000000-0000-4000-8000-0000000000a1'$q$, '23514', null, 'N3: changing the role of a question that has answers is rejected');
select throws_ok($q$update public.messages set role = 'user' where id = 'e1000000-0000-4000-8000-0000000000b1'$q$, '23514', null, 'N3: turning an answer into a user message is rejected (CHECK)');
select lives_ok($q$update public.messages set content = 'Q-one edited' where id = 'e1000000-0000-4000-8000-0000000000a1'$q$, 'N3: editing the question content is still allowed');
select is((select reply_to_message_id from public.messages where id = 'e1000000-0000-4000-8000-0000000000b1'), 'e1000000-0000-4000-8000-0000000000a1'::uuid, 'N3: rejected updates changed nothing');

-- Deleting the question detaches (set null), keeps the answer.
insert into public.messages (id, conversation_id, role, content, created_at) values
  ('e3000000-0000-4000-8000-0000000000a1', 'c3000000-0000-4000-8000-0000000000c3', 'user', 'Q-three', now() - interval '1 hour');
insert into public.messages (id, conversation_id, reply_to_message_id, role, content, created_at) values
  ('e3000000-0000-4000-8000-0000000000b1', 'c3000000-0000-4000-8000-0000000000c3', 'e3000000-0000-4000-8000-0000000000a1', 'assistant', 'a', now() - interval '1 hour' + interval '1 second');
delete from public.messages where id = 'e3000000-0000-4000-8000-0000000000a1';
select is((select reply_to_message_id from public.messages where id = 'e3000000-0000-4000-8000-0000000000b1'), null, 'N3: deleting the question sets reply_to_message_id null and keeps the answer');
select is((select count(*)::int from pg_indexes where schemaname = 'public' and tablename = 'messages' and indexname = 'messages_reply_to_idx'), 1, 'N3: reply_to_message_id is indexed');
select ok((select prosrc like '%when a.reply_to_message_id is not null then u.id = a.reply_to_message_id%' from pg_proc where proname = 'knowledge_gaps' and pronamespace = 'public'::regnamespace), 'N3: knowledge_gaps pairs on reply_to_message_id first (source smoke check)');

select * from finish();
rollback;
