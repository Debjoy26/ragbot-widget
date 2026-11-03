-- reserve_request_budget (fail closed, cap), settle/release, record_rate_limit_attempt, idempotency.
-- Limitation: true parallel reservation races need concurrent connections (P5 integration test);
-- here serialisation is by construction (client_settings row lock) and sequential behaviour is asserted.
begin;
select plan(64);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000d1', 'b-capped', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000d2', 'b-nocap', 'x', array['en'], 'm', 1536),
  ('b3000000-0000-4000-8000-0000000000d3', 'b-nosettings', 'x', array['en'], 'm', 1536),
  ('b4000000-0000-4000-8000-0000000000d4', 'b-badcap', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000d1', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b2000000-0000-4000-8000-0000000000d2', array['https://e.test'], '{}', '{}', '{}', '{}', '{}', '{}'),
  ('b4000000-0000-4000-8000-0000000000d4', array['https://e.test'], '{}', '{"daily_cap_usd": "lots"}', '{}', '{}', '{}', '{}');

insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-0000000000d1', 'b1000000-0000-4000-8000-0000000000d1', now() + interval '1 hour'),
  ('a2000000-0000-4000-8000-0000000000d2', 'b1000000-0000-4000-8000-0000000000d1', now() + interval '1 hour'),
  ('a3000000-0000-4000-8000-0000000000d3', 'b2000000-0000-4000-8000-0000000000d2', now() + interval '1 hour'),
  ('a4000000-0000-4000-8000-0000000000d4', 'b3000000-0000-4000-8000-0000000000d3', now() + interval '1 hour'),
  ('a5000000-0000-4000-8000-0000000000d5', 'b4000000-0000-4000-8000-0000000000d4', now() + interval '1 hour');

-- request_runs: r1..r6 on the capped bot, rn/rs/rb on the other bots.
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash) values
  ('91000000-0000-4000-8000-0000000000d1', 'b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('92000000-0000-4000-8000-0000000000d2', 'b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000002', repeat('a', 64)),
  ('93000000-0000-4000-8000-0000000000d3', 'b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000003', repeat('a', 64)),
  ('94000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000004', repeat('a', 64)),
  ('95000000-0000-4000-8000-0000000000d5', 'b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000005', repeat('a', 64)),
  ('96000000-0000-4000-8000-0000000000d6', 'b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000006', repeat('a', 64)),
  ('9a000000-0000-4000-8000-0000000000da', 'b2000000-0000-4000-8000-0000000000d2', 'a3000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('9b000000-0000-4000-8000-0000000000db', 'b3000000-0000-4000-8000-0000000000d3', 'a4000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('9c000000-0000-4000-8000-0000000000dc', 'b4000000-0000-4000-8000-0000000000d4', 'a5000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-000000000001', repeat('a', 64));

-- ---- Idempotency (handover §4.7): scoped unique key ----
select throws_ok(
  $q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash)
     values ('b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', repeat('b', 64))$q$,
  '23505', null, 'idempotency: duplicate (bot, visitor_session, key) is rejected');
select lives_ok(
  $q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash)
     values ('b1000000-0000-4000-8000-0000000000d1', 'a2000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$,
  'idempotency: the same key in another session is a different scope');
select throws_ok(
  $q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash)
     values ('b2000000-0000-4000-8000-0000000000d2', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000007', repeat('a', 64))$q$,
  '23503', null, 'ownership: request_run cannot pair a session with a different bot (composite FK)');
select throws_ok(
  $q$insert into public.conversations (bot_id, visitor_session_id) values ('b2000000-0000-4000-8000-0000000000d2', 'a1000000-0000-4000-8000-0000000000d1')$q$,
  '23503', null, 'ownership: conversation cannot pair a session with a different bot (composite FK)');
select throws_ok(
  $q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash, state)
     values ('b1000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000008', repeat('a', 64), 'bogus')$q$,
  '23514', null, 'request_runs: invalid state rejected');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---- reserve_request_budget: fail closed ----
select throws_ok(
  $q$select public.reserve_request_budget('b2000000-0000-4000-8000-0000000000d2', '9a000000-0000-4000-8000-0000000000da', 0.01, 60)$q$,
  'RB002', null, 'budget: client_settings without daily_cap_usd fails closed');
select throws_ok(
  $q$select public.reserve_request_budget('b3000000-0000-4000-8000-0000000000d3', '9b000000-0000-4000-8000-0000000000db', 0.01, 60)$q$,
  'RB002', null, 'budget: bot without client_settings row fails closed');
select throws_ok(
  $q$select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000d4', '9c000000-0000-4000-8000-0000000000dc', 0.01, 60)$q$,
  'RB002', null, 'budget: non-numeric daily cap fails closed');
select is((select count(*)::int from public.budget_reservations where bot_id in ('b2000000-0000-4000-8000-0000000000d2', 'b3000000-0000-4000-8000-0000000000d3', 'b4000000-0000-4000-8000-0000000000d4')), 0,
  'budget: fail-closed paths reserved nothing');

-- Argument validation.
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-0000000000d1', 0, 60)$q$, '22023', null, 'budget: zero amount rejected');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-0000000000d1', -1, 60)$q$, '22023', null, 'budget: negative amount rejected');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-0000000000d1', 1, 0)$q$, '22023', null, 'budget: ttl 0 rejected');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', null, 1, 60)$q$, '22023', null, 'budget: null request rejected');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '9a000000-0000-4000-8000-0000000000da', 1, 60)$q$, 'RB004', null, 'budget: request belonging to another bot rejected');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000dead', 1, 60)$q$, 'RB004', null, 'budget: unknown request rejected');

-- ---- cap enforcement (daily_cap_usd = 5) ----
create temp table res as
  select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-0000000000d1', 3, 60) as id;
select isnt((select id from res), null, 'budget: reservation of 3 of 5 succeeds');
select throws_ok(
  $q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '92000000-0000-4000-8000-0000000000d2', 2.5, 60)$q$,
  'RB001', null, 'budget: 3 + 2.5 > 5 is refused (cap exceeded)');
select is(
  (select count(*)::int from public.budget_reservations where request_id = '92000000-0000-4000-8000-0000000000d2'), 0,
  'budget: a refused reservation leaves no row');
select is(
  public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-0000000000d1', 3, 60),
  (select id from res), 'budget: retry of the same request returns the existing reservation (no double spend)');
select is(
  (select sum(amount) from public.budget_reservations where bot_id = 'b1000000-0000-4000-8000-0000000000d1'),
  3.000000::numeric, 'budget: the retry did not add spend');
select lives_ok(
  $q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '92000000-0000-4000-8000-0000000000d2', 2, 60)$q$,
  'budget: reserving exactly up to the cap (3 + 2 = 5) is allowed');
select throws_ok(
  $q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '93000000-0000-4000-8000-0000000000d3', 0.01, 60)$q$,
  'RB001', null, 'budget: any further spend beyond the cap is refused');

-- Release frees capacity; settle reconciles to the actual amount.
select lives_ok(format('select public.release_budget_reservation(%L, %L)', 'b1000000-0000-4000-8000-0000000000d1', (select id from res)), 'budget: release of an active reservation succeeds');
select is((select state from public.budget_reservations where id = (select id from res)), 'released', 'budget: released reservation has state released');
select throws_ok(format('select public.release_budget_reservation(%L, %L)', 'b1000000-0000-4000-8000-0000000000d1', (select id from res)), 'RB003', null, 'budget: releasing twice is rejected');
select lives_ok(
  $q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '93000000-0000-4000-8000-0000000000d3', 3, 60)$q$,
  'budget: released capacity can be reserved again');
select throws_ok(
  $q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-0000000000d1', 3, 60)$q$,
  'RB004', null, 'budget: a released reservation for the same request is not silently reused');

select lives_ok(
  $q$select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d1', (select id from public.budget_reservations where request_id = '92000000-0000-4000-8000-0000000000d2'), 0.5)$q$,
  'budget: settle to the actual amount succeeds');
select is((select state || ':' || amount::text from public.budget_reservations where request_id = '92000000-0000-4000-8000-0000000000d2'), 'settled:0.500000', 'budget: settled reservation carries the actual amount');
select throws_ok(
  $q$select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d1', (select id from public.budget_reservations where request_id = '92000000-0000-4000-8000-0000000000d2'), 0.5)$q$,
  'RB003', null, 'budget: settling twice is rejected');
select throws_ok($q$select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d1', gen_random_uuid(), -1)$q$, '22023', null, 'budget: negative settle amount rejected');

-- Expired reservations stop counting and are swept.
reset role;
update public.budget_reservations set expires_at = now() - interval '1 minute' where request_id = '93000000-0000-4000-8000-0000000000d3';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
-- L2: settle ownership / locking. N1 (P3-D2) CHANGED the former L2 rule "an expired-but-unswept reservation
-- cannot be settled": the provider call already happened, so its real cost must still count toward the cap.
-- The 93 reservation is kept (reserved, past expires_at, unswept) for the sweep assertions below; the new
-- N1 behaviour is asserted here on a separate reservation (96) and in 170_p3d2_fixes.test.sql.
insert into public.budget_reservations (id, bot_id, request_id, amount, expires_at) values
  ('e6000000-0000-4000-8000-0000000000d6', 'b1000000-0000-4000-8000-0000000000d1', '96000000-0000-4000-8000-0000000000d6', 0.2, now() - interval '1 minute');
select lives_ok(
  $q$select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d1', 'e6000000-0000-4000-8000-0000000000d6', 0.1)$q$,
  'budget (N1): settling a reservation already past expires_at (unswept) is accepted');
select is((select state || ':' || amount::text from public.budget_reservations where id = 'e6000000-0000-4000-8000-0000000000d6'), 'settled:0.100000',
  'budget (N1): the late settle recorded the actual amount');
insert into public.budget_reservations (id, bot_id, request_id, amount, expires_at) values
  ('e5000000-0000-4000-8000-0000000000d5', 'b1000000-0000-4000-8000-0000000000d1', '95000000-0000-4000-8000-0000000000d5', 0.2, now() + interval '1 hour');
select throws_ok(
  $q$select public.settle_budget_reservation('b2000000-0000-4000-8000-0000000000d2', 'e5000000-0000-4000-8000-0000000000d5', 0.1)$q$,
  'RB003', null, 'budget (L2): settling another bot''s reservation is rejected (ownership check)');
select is((select state from public.budget_reservations where id = 'e5000000-0000-4000-8000-0000000000d5'), 'reserved',
  'budget (L2): the foreign-bot settle left the reservation active');
select lives_ok(
  $q$select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-0000000000d5', 0.1)$q$,
  'budget (L2): the owning bot can settle an unexpired reservation');
select throws_ok(
  $q$select public.settle_budget_reservation('b3000000-0000-4000-8000-0000000000d3', gen_random_uuid(), 0.1)$q$,
  'RB002', null, 'budget (L2): settle for a bot without client_settings fails closed');
select throws_ok(
  $q$select public.settle_budget_reservation(null, gen_random_uuid(), 0.1)$q$,
  '22023', null, 'budget (L2): settle requires a bot id');
select lives_ok(
  $q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d1', '94000000-0000-4000-8000-0000000000d4', 4, 60)$q$,
  'budget: an expired (unsettled) reservation no longer counts toward the cap (0.5 settled + 4 <= 5)');
select is(public.expire_stale_budget_reservations(100), 1, 'retention: expire_stale_budget_reservations marks the stale reservation');
select is((select state from public.budget_reservations where request_id = '93000000-0000-4000-8000-0000000000d3'), 'expired', 'retention: stale reservation state is expired');

-- ---- record_rate_limit_attempt ----
create temp table rl1 as select * from public.record_rate_limit_attempt(repeat('a', 64), 60, 2);
create temp table rl2 as select * from public.record_rate_limit_attempt(repeat('a', 64), 60, 2);
create temp table rl3 as select * from public.record_rate_limit_attempt(repeat('a', 64), 60, 2);
select is((select request_count from rl1), 1, 'rate limit: first attempt counts 1');
select is((select request_count from rl2), 2, 'rate limit: second attempt counts 2 (atomic increment)');
select is((select request_count from rl3), 3, 'rate limit: third attempt counts 3');
select is((select allowed from rl1), true, 'rate limit: attempt 1 of limit 2 allowed');
select is((select allowed from rl2), true, 'rate limit: attempt 2 of limit 2 allowed');
select is((select allowed from rl3), false, 'rate limit: attempt 3 of limit 2 refused');
select is((select window_start from rl1), (select window_start from rl3), 'rate limit: all attempts landed in the same window');
select is((select window_expires_at from rl1), (select window_start + interval '60 seconds' from rl1), 'rate limit: window expires one window length after start');
select is((select count(*)::int from public.rate_limit_buckets where key_hash = repeat('a', 64) and window_seconds = 60), 1, 'rate limit: one bucket row per key/window');
select is((select request_count from public.rate_limit_buckets where key_hash = repeat('a', 64) and window_seconds = 60), 3, 'rate limit: stored counter equals the number of attempts');
create temp table rl4 as select * from public.record_rate_limit_attempt(repeat('a', 64), 60, 2);
create temp table rl5 as select * from public.record_rate_limit_attempt(repeat('a', 64), 60, 2);
select is((select request_count from rl5), 3, 'rate limit (L10): counter stops at limit + 1 (5th attempt still reports 3)');
select is((select allowed from rl5), false, 'rate limit (L10): attempts past the limit stay refused');
select is((select request_count from public.rate_limit_buckets where key_hash = repeat('a', 64) and window_seconds = 60), 3, 'rate limit (L10): stored counter is clamped at limit + 1');
select is((select max(rc)::int from (select (public.record_rate_limit_attempt(repeat('c', 64), 60, 5)).request_count as rc from generate_series(1, 5)) s), 5, 'rate limit (L10): five attempts at limit 5 all counted');
select is((select request_count from public.record_rate_limit_attempt(repeat('c', 64), 60, 1)), 5, 'rate limit (L10): a lowered limit never rewinds the counter');
select is((select request_count from public.record_rate_limit_attempt(repeat('b', 64), 60, 2)), 1, 'rate limit: a different key has its own counter');
select is((select request_count from public.record_rate_limit_attempt(repeat('a', 64), 600, 2)), 1, 'rate limit: a different window size has its own counter');
select throws_ok($q$select * from public.record_rate_limit_attempt('203.0.113.7', 60, 2)$q$, '22023', null, 'rate limit: a plain IP is rejected (hex digest required)');
select throws_ok($q$select * from public.record_rate_limit_attempt(repeat('A', 64), 60, 2)$q$, '22023', null, 'rate limit: uppercase/non-canonical key rejected');
select throws_ok($q$select * from public.record_rate_limit_attempt(null, 60, 2)$q$, '22023', null, 'rate limit: null key rejected');
select throws_ok($q$select * from public.record_rate_limit_attempt(repeat('a', 64), 0, 2)$q$, '22023', null, 'rate limit: window 0 rejected');
select throws_ok($q$select * from public.record_rate_limit_attempt(repeat('a', 64), 86401, 2)$q$, '22023', null, 'rate limit: window > 86400 rejected');
select throws_ok($q$select * from public.record_rate_limit_attempt(repeat('a', 64), 60, 0)$q$, '22023', null, 'rate limit: limit 0 rejected (no default)');

reset role;
select * from finish();
rollback;
