-- P5-A (migration 011): visitor sessions and request runs for the visitor API. Every function's success,
-- bounds and failure; the disabled-bot rule (RB039) on all four starting functions; the 'turnstile_required'
-- default; the run-state helper; the run read; lock_timeout and grants. All fixtures are synthetic.
-- Ids end in 000000000240: bots bN, sessions aN, runs dN, conversations cN, messages eN.
begin;
select plan(126);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions, enabled) values
  ('b1000000-0000-4000-8000-000000000240', 'p5-main',       'x', array['en'], 'm', 1536, true),
  ('b2000000-0000-4000-8000-000000000240', 'p5-off',        'x', array['en'], 'm', 1536, false),
  ('b3000000-0000-4000-8000-000000000240', 'p5-nosettings', 'x', array['en'], 'm', 1536, true),
  ('b4000000-0000-4000-8000-000000000240', 'p5-nolimit',    'x', array['en'], 'm', 1536, true),
  ('b5000000-0000-4000-8000-000000000240', 'p5-other',      'x', array['en'], 'm', 1536, true);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-000000000240', array['https://e.test'],
   '{"session_create_per_ip": {"limit": 10, "window_seconds": 3600}, "concurrent_requests_per_session": 2, "marker": "RATE-240"}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b2000000-0000-4000-8000-000000000240', array['https://e.test'],
   '{"session_create_per_ip": {"limit": 10, "window_seconds": 3600}, "concurrent_requests_per_session": 2}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b4000000-0000-4000-8000-000000000240', array['https://e.test'], '{"concurrent_requests_per_session": 2}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b5000000-0000-4000-8000-000000000240', array['https://e.test'],
   '{"session_create_per_ip": {"limit": 10, "window_seconds": 3600}, "concurrent_requests_per_session": 2}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}');

insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', now() + interval '1 hour'),
  ('a2000000-0000-4000-8000-000000000240', 'b2000000-0000-4000-8000-000000000240', now() + interval '1 hour'),
  ('a3000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', now() + interval '1 hour'),
  ('a5000000-0000-4000-8000-000000000240', 'b5000000-0000-4000-8000-000000000240', now() + interval '1 hour');
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state) values
  ('d1000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000001', repeat('a', 64), 'reserved'),
  ('d2000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000002', repeat('a', 64), 'running'),
  ('d3000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000003', repeat('a', 64), 'succeeded'),
  ('d4000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000004', repeat('a', 64), 'failed'),
  ('d5000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000005', repeat('a', 64), 'reserved'),
  ('d6000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000006', repeat('a', 64), 'running'),
  ('d7000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000007', repeat('a', 64), 'running'),
  ('d8000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000008', repeat('a', 64), 'running'),
  ('d9000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240', 'a1000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-000000000009', repeat('a', 64), 'running'),
  ('de000000-0000-4000-8000-000000000240', 'b2000000-0000-4000-8000-000000000240', 'a2000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-00000000000e', repeat('a', 64), 'running'),
  ('df000000-0000-4000-8000-000000000240', 'b5000000-0000-4000-8000-000000000240', 'a5000000-0000-4000-8000-000000000240', '00000000-0000-4000-8000-00000000000f', repeat('a', 64), 'running');

insert into public.conversations (id, bot_id) values
  ('c1000000-0000-4000-8000-000000000240', 'b1000000-0000-4000-8000-000000000240'),
  ('c5000000-0000-4000-8000-000000000240', 'b5000000-0000-4000-8000-000000000240');
-- Run d3: a user message, an older complete answer, a newer partial answer, and a newest answer in another bot's
-- conversation (never returned). Run d4: only a user message with the run id (never returned). Run d9: one failed answer.
insert into public.messages (id, conversation_id, request_id, role, content, status, created_at) values
  ('e1000000-0000-4000-8000-000000000240', 'c1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240', 'user',      'q',  'complete', now() - interval '5 minutes'),
  ('e2000000-0000-4000-8000-000000000240', 'c1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240', 'assistant', 'a1', 'complete', now() - interval '4 minutes'),
  ('e3000000-0000-4000-8000-000000000240', 'c1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240', 'assistant', 'a2', 'partial',  now() - interval '3 minutes'),
  ('e4000000-0000-4000-8000-000000000240', 'c5000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240', 'assistant', 'a3', 'complete', now() - interval '2 minutes'),
  ('e5000000-0000-4000-8000-000000000240', 'c1000000-0000-4000-8000-000000000240', 'd4000000-0000-4000-8000-000000000240', 'user',      'q',  'complete', now() - interval '2 minutes'),
  ('e6000000-0000-4000-8000-000000000240', 'c1000000-0000-4000-8000-000000000240', 'd9000000-0000-4000-8000-000000000240', 'assistant', 'a4', 'failed',   now() - interval '1 minute');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ===== get_session_policy =====
select results_eq(
  $q$select bot_id, enabled, turnstile_required, session_limit, session_window_seconds from public.get_session_policy('p5-main')$q$,
  $q$values ('b1000000-0000-4000-8000-000000000240'::uuid, true, true, 10, 3600)$q$,
  'get_session_policy: returns the bot, enabled, turnstile default true and the per-IP session limit');
select is_empty($q$select * from public.get_session_policy('p5-no-such-bot')$q$, 'get_session_policy: unknown slug returns no rows');
select is_empty($q$select * from public.get_session_policy('P5-MAIN')$q$, 'get_session_policy: the slug match is exact (case-sensitive)');
select throws_ok($q$select * from public.get_session_policy(null)$q$, '22023', null, 'get_session_policy: null slug -> 22023');
select throws_ok($q$select * from public.get_session_policy('')$q$, '22023', null, 'get_session_policy: empty slug -> 22023');
select results_eq(
  $q$select bot_id, enabled, turnstile_required from public.get_session_policy('p5-off')$q$,
  $q$values ('b2000000-0000-4000-8000-000000000240'::uuid, false, true)$q$,
  'get_session_policy: a disabled bot still returns its row, with enabled = false');
select throws_ok($q$select * from public.get_session_policy('p5-nosettings')$q$, 'RB036', null, 'get_session_policy: no client_settings row -> RB036');
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'get_session_policy: no session_create_per_ip -> RB036');

-- turnstile_required: only a JSON boolean false turns it off.
update public.client_settings set feature_flags = '{"turnstile_required": false}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), false, 'turnstile_required: boolean false -> false');
update public.client_settings set feature_flags = '{"turnstile_required": true}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), true, 'turnstile_required: boolean true -> true');
update public.client_settings set feature_flags = '{}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), true, 'turnstile_required: missing key -> true (fail closed)');
update public.client_settings set feature_flags = '{"turnstile_required": "false"}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), true, 'turnstile_required: the string "false" is not a boolean -> true');
update public.client_settings set feature_flags = '{"turnstile_required": 0}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), true, 'turnstile_required: the number 0 is not a boolean -> true');
update public.client_settings set feature_flags = '{"turnstile_required": null}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), true, 'turnstile_required: JSON null -> true');
update public.client_settings set feature_flags = '{"other_flag": false}' where bot_id = 'b1000000-0000-4000-8000-000000000240';
select is((select turnstile_required from public.get_session_policy('p5-main')), true, 'turnstile_required: other flags do not switch it off');
update public.client_settings set feature_flags = '{}' where bot_id = 'b1000000-0000-4000-8000-000000000240';

-- session_create_per_ip: complete and valid, or RB036.
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 999999999, "window_seconds": 86400}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select results_eq($q$select session_limit, session_window_seconds from public.get_session_policy('p5-nolimit')$q$, $q$values (999999999, 86400)$q$, 'session policy: the upper bounds are accepted');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 1, "window_seconds": 1}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select results_eq($q$select session_limit, session_window_seconds from public.get_session_policy('p5-nolimit')$q$, $q$values (1, 1)$q$, 'session policy: the lower bounds are accepted');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"window_seconds": 3600}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: missing limit -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 10}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: missing window -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 0, "window_seconds": 3600}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: limit 0 -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": -3, "window_seconds": 3600}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: negative limit -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 1.5, "window_seconds": 3600}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: fractional limit -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": "10", "window_seconds": 3600}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: limit as a string -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 1000000000, "window_seconds": 3600}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: limit above 999999999 -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 10, "window_seconds": 0}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: window 0 -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 10, "window_seconds": 86401}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: window above 86400 -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": {"limit": 10, "window_seconds": 99999999999}}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: a huge window -> RB036 (no overflow error)');
update public.client_settings set rate_policy = '{"session_create_per_ip": [10, 3600]}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: an array instead of an object -> RB036');
update public.client_settings set rate_policy = '{"session_create_per_ip": null}' where bot_id = 'b4000000-0000-4000-8000-000000000240';
select throws_ok($q$select * from public.get_session_policy('p5-nolimit')$q$, 'RB036', null, 'session policy: JSON null -> RB036');

-- ===== create_visitor_session =====
create temp table s1 as select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 900);
select isnt((select session_id from s1), null, 'create_visitor_session: returns a session id');
select is((select token_version from s1), 1, 'create_visitor_session: token_version starts at 1');
select is((select expires_at from s1), now() + interval '900 seconds', 'create_visitor_session: expires_at is now + ttl');
select is((select count(*)::int from public.visitor_sessions where id = (select session_id from s1) and bot_id = 'b1000000-0000-4000-8000-000000000240' and revoked_at is null and token_version = 1 and expires_at = (select expires_at from s1)), 1,
  'create_visitor_session: the row is stored for the bot, not revoked');
create temp table s2 as select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 900);
select isnt((select session_id from s2), (select session_id from s1), 'create_visitor_session: two calls give distinct ids');
select lives_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 60)$q$, 'create_visitor_session: ttl 60 accepted');
select lives_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 86400)$q$, 'create_visitor_session: ttl 86400 accepted');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 59)$q$, '22023', null, 'create_visitor_session: ttl 59 -> 22023');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 86401)$q$, '22023', null, 'create_visitor_session: ttl 86401 -> 22023');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 0)$q$, '22023', null, 'create_visitor_session: ttl 0 -> 22023');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', -60)$q$, '22023', null, 'create_visitor_session: negative ttl -> 22023');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', null)$q$, '22023', null, 'create_visitor_session: null ttl -> 22023');
select throws_ok($q$select * from public.create_visitor_session(null, 900)$q$, '22023', null, 'create_visitor_session: null bot -> 22023');
select throws_ok($q$select * from public.create_visitor_session('b2000000-0000-4000-8000-000000000240', 900)$q$, 'RB039', null, 'create_visitor_session: disabled bot -> RB039');
select is((select count(*)::int from public.visitor_sessions where bot_id = 'b2000000-0000-4000-8000-000000000240'), 1, 'create_visitor_session: a refused call inserted nothing (only the fixture session)');
select throws_ok($q$select * from public.create_visitor_session('b9000000-0000-4000-8000-000000000240', 900)$q$, 'RB039', null, 'create_visitor_session: unknown bot -> RB039');

-- ===== get_rate_policy =====
select is(public.get_rate_policy('b1000000-0000-4000-8000-000000000240') ->> 'marker', 'RATE-240', 'get_rate_policy: returns the bot''s rate_policy');
select is(jsonb_typeof(public.get_rate_policy('b1000000-0000-4000-8000-000000000240')), 'object', 'get_rate_policy: the result is a JSON object');
select throws_ok($q$select public.get_rate_policy('b2000000-0000-4000-8000-000000000240')$q$, 'RB039', null, 'get_rate_policy: disabled bot -> RB039');
select throws_ok($q$select public.get_rate_policy('b9000000-0000-4000-8000-000000000240')$q$, 'RB039', null, 'get_rate_policy: unknown bot -> RB039');
select throws_ok($q$select public.get_rate_policy('b3000000-0000-4000-8000-000000000240')$q$, 'RB036', null, 'get_rate_policy: no client_settings row -> RB036');
select throws_ok($q$select public.get_rate_policy(null)$q$, '22023', null, 'get_rate_policy: null bot -> 22023');

-- ===== begin_request_run: the disabled-bot rule; the 004 outcomes are covered by 130 =====
select throws_ok($q$select * from public.begin_request_run('b2000000-0000-4000-8000-000000000240', 'a2000000-0000-4000-8000-000000000240', 1, '00000000-0000-4000-8000-0000000000a1', repeat('a', 64))$q$,
  'RB039', null, 'begin_request_run: disabled bot -> RB039');
select is((select count(*)::int from public.request_runs where bot_id = 'b2000000-0000-4000-8000-000000000240'), 1, 'begin_request_run: a refused call inserted no run (only the fixture run)');
select throws_ok($q$select * from public.begin_request_run('b2000000-0000-4000-8000-000000000240', 'a2000000-0000-4000-8000-000000000240', 1, '00000000-0000-4000-8000-00000000000e', repeat('a', 64))$q$,
  'RB039', null, 'begin_request_run: a disabled bot is refused even for an idempotent replay');
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-000000000240', 'a3000000-0000-4000-8000-000000000240', 1, '00000000-0000-4000-8000-0000000000a2', repeat('a', 64))), 'new',
  'begin_request_run: an enabled bot still starts a run');
select throws_ok($q$select * from public.begin_request_run('b9000000-0000-4000-8000-000000000240', 'a3000000-0000-4000-8000-000000000240', 1, '00000000-0000-4000-8000-0000000000a3', repeat('a', 64))$q$,
  'RB004', null, 'begin_request_run: an unknown bot keeps the earlier outcome (RB004), not RB039');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-000000000240', 'a3000000-0000-4000-8000-000000000240', 1, 'not-a-uuid', repeat('a', 64))$q$,
  '22023', null, 'begin_request_run: argument checks still come first (22023)');

-- ===== reserve_request_budget: the disabled-bot rule; the 007 behaviour is covered by 070, 170, 190 =====
select throws_ok($q$select public.reserve_request_budget('b2000000-0000-4000-8000-000000000240', 'de000000-0000-4000-8000-000000000240', 1, 3600)$q$,
  'RB039', null, 'reserve_request_budget: disabled bot -> RB039');
select is((select count(*)::int from public.budget_reservations where bot_id = 'b2000000-0000-4000-8000-000000000240'), 0, 'reserve_request_budget: a refused call reserved nothing');
select isnt(public.reserve_request_budget('b1000000-0000-4000-8000-000000000240', 'd2000000-0000-4000-8000-000000000240', 1, 3600), null, 'reserve_request_budget: an enabled bot still reserves');
select is(public.reserve_request_budget('b1000000-0000-4000-8000-000000000240', 'd2000000-0000-4000-8000-000000000240', 1, 3600),
  (select id from public.budget_reservations where request_id = 'd2000000-0000-4000-8000-000000000240'), 'reserve_request_budget: an idempotent retry returns the same reservation');
select throws_ok($q$select public.reserve_request_budget('b9000000-0000-4000-8000-000000000240', 'd2000000-0000-4000-8000-000000000240', 1, 3600)$q$,
  'RB002', null, 'reserve_request_budget: an unknown bot keeps the earlier outcome (RB002), not RB039');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-000000000240', 'd2000000-0000-4000-8000-000000000240', 0, 3600)$q$,
  '22023', null, 'reserve_request_budget: argument checks still come first (22023)');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240', 1, 3600)$q$,
  'RB004', null, 'reserve_request_budget: a finished run still refuses a new reservation (007)');
select is(public.reserve_request_budget('b1000000-0000-4000-8000-000000000240', 'd2000000-0000-4000-8000-000000000240', 100, 3600),
  (select id from public.budget_reservations where request_id = 'd2000000-0000-4000-8000-000000000240'), 'reserve_request_budget: an idempotent retry is not re-priced against the cap (007)');
-- ...disabling the bot later also stops an idempotent retry (no new work for a disabled bot).
update public.bot_profiles set enabled = false where id = 'b1000000-0000-4000-8000-000000000240';
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-000000000240', 'd2000000-0000-4000-8000-000000000240', 1, 3600)$q$,
  'RB039', null, 'reserve_request_budget: a bot disabled after the first reserve refuses the retry (RB039)');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-000000000240', 'a3000000-0000-4000-8000-000000000240', 1, '00000000-0000-4000-8000-0000000000a4', repeat('a', 64))$q$,
  'RB039', null, 'begin_request_run: the same bot, once disabled, is refused');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 900)$q$, 'RB039', null, 'create_visitor_session: the same bot, once disabled, is refused');
update public.bot_profiles set enabled = true where id = 'b1000000-0000-4000-8000-000000000240';
select lives_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 900)$q$, 'create_visitor_session: the bot, enabled again, is served again');

-- ===== set_request_run_state =====
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd1000000-0000-4000-8000-000000000240', 'running'), true, 'set_request_run_state: reserved -> running moves (true)');
select is((select state from public.request_runs where id = 'd1000000-0000-4000-8000-000000000240'), 'running', 'set_request_run_state: the run is now running');
select is((select finished_at from public.request_runs where id = 'd1000000-0000-4000-8000-000000000240'), null, 'set_request_run_state: running does not set finished_at');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd1000000-0000-4000-8000-000000000240', 'running'), false, 'set_request_run_state: running -> running is not a move (false)');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd1000000-0000-4000-8000-000000000240', 'succeeded'), true, 'set_request_run_state: running -> succeeded moves (true)');
select is((select state || ':' || (finished_at is not null)::text from public.request_runs where id = 'd1000000-0000-4000-8000-000000000240'), 'succeeded:true', 'set_request_run_state: a terminal state sets finished_at');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd5000000-0000-4000-8000-000000000240', 'failed'), true, 'set_request_run_state: reserved -> failed moves (true)');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd6000000-0000-4000-8000-000000000240', 'partial'), true, 'set_request_run_state: running -> partial moves (true)');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240', 'failed'), false, 'set_request_run_state: a succeeded run does not move (false)');
select is((select state from public.request_runs where id = 'd3000000-0000-4000-8000-000000000240'), 'succeeded', 'set_request_run_state: the succeeded run is unchanged');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd4000000-0000-4000-8000-000000000240', 'running'), false, 'set_request_run_state: a failed run does not move back to running (false)');
select is((select state from public.request_runs where id = 'd4000000-0000-4000-8000-000000000240'), 'failed', 'set_request_run_state: the failed run is unchanged');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd1000000-0000-4000-8000-000000000240', 'failed'), false, 'set_request_run_state: a run that just became terminal does not move again (false)');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'df000000-0000-4000-8000-000000000240', 'failed'), false, 'set_request_run_state: another bot''s run is refused (false)');
select is((select state from public.request_runs where id = 'df000000-0000-4000-8000-000000000240'), 'running', 'set_request_run_state: the other bot''s run is unchanged');
select is(public.set_request_run_state('b5000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', 'failed'), false, 'set_request_run_state: the run is not moved by a different bot id (false)');
select is((select state from public.request_runs where id = 'd7000000-0000-4000-8000-000000000240'), 'running', 'set_request_run_state: a wrong-bot call left the run unchanged');
select is(public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd0000000-0000-4000-8000-000000000240', 'failed'), false, 'set_request_run_state: an unknown run -> false');
select is(public.set_request_run_state('b2000000-0000-4000-8000-000000000240', 'de000000-0000-4000-8000-000000000240', 'failed'), true, 'set_request_run_state: a disabled bot''s live run can still be finished (true)');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', 'reserved')$q$, '22023', null, 'set_request_run_state: target reserved -> 22023');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', 'bogus')$q$, '22023', null, 'set_request_run_state: unknown target -> 22023');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', 'SUCCEEDED')$q$, '22023', null, 'set_request_run_state: upper-case target -> 22023');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', null)$q$, '22023', null, 'set_request_run_state: null target -> 22023');
select throws_ok($q$select public.set_request_run_state(null, 'd7000000-0000-4000-8000-000000000240', 'failed')$q$, '22023', null, 'set_request_run_state: null bot -> 22023');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', null, 'failed')$q$, '22023', null, 'set_request_run_state: null run -> 22023');
select is((select state from public.request_runs where id = 'd7000000-0000-4000-8000-000000000240'), 'running', 'set_request_run_state: refused calls left the run unchanged');

-- ===== get_request_run =====
select results_eq(
  $q$select run_state, conversation_id, message_id, message_status from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240')$q$,
  $q$values ('succeeded'::text, 'c1000000-0000-4000-8000-000000000240'::uuid, 'e3000000-0000-4000-8000-000000000240'::uuid, 'partial'::text)$q$,
  'get_request_run: the latest assistant message of the run (not the user message, not another bot''s conversation)');
select results_eq(
  $q$select run_state, conversation_id, message_id, message_status from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd9000000-0000-4000-8000-000000000240')$q$,
  $q$values ('running'::text, 'c1000000-0000-4000-8000-000000000240'::uuid, 'e6000000-0000-4000-8000-000000000240'::uuid, 'failed'::text)$q$,
  'get_request_run: a failed answer is returned with its status');
select results_eq(
  $q$select run_state, conversation_id, message_id, message_status from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd4000000-0000-4000-8000-000000000240')$q$,
  $q$values ('failed'::text, null::uuid, null::uuid, null::text)$q$,
  'get_request_run: only a user message carries the run -> message columns are null');
select results_eq(
  $q$select run_state, conversation_id, message_id, message_status from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd8000000-0000-4000-8000-000000000240')$q$,
  $q$values ('running'::text, null::uuid, null::uuid, null::text)$q$,
  'get_request_run: no message yet -> message columns are null');
select is_empty($q$select * from public.get_request_run('b5000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240')$q$, 'get_request_run: wrong bot -> no rows');
select is_empty($q$select * from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd0000000-0000-4000-8000-000000000240')$q$, 'get_request_run: unknown run -> no rows');
select is_empty($q$select * from public.get_request_run('b9000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240')$q$, 'get_request_run: unknown bot -> no rows');
select throws_ok($q$select * from public.get_request_run(null, 'd3000000-0000-4000-8000-000000000240')$q$, '22023', null, 'get_request_run: null bot -> 22023');
select throws_ok($q$select * from public.get_request_run('b1000000-0000-4000-8000-000000000240', null)$q$, '22023', null, 'get_request_run: null run -> 22023');

-- ===== lock_timeout, search_path, invoker (status 3a bf, az) =====
reset role;
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.get_session_policy(text)'::regprocedure, 'public.create_visitor_session(uuid,integer)'::regprocedure, 'public.get_rate_policy(uuid)'::regprocedure,
                    'public.begin_request_run(uuid,uuid,integer,text,text)'::regprocedure, 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure,
                    'public.set_request_run_state(uuid,uuid,text)'::regprocedure, 'public.get_request_run(uuid,uuid)'::regprocedure, 'public.schema_version()'::regprocedure)
      and 'lock_timeout=2s' = any (p.proconfig) and 'search_path=""' = any (p.proconfig) and not p.prosecdef),
  8, 'proconfig: all eight functions of migration 011 set lock_timeout = 2s and an empty search_path, and are SECURITY INVOKER');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.get_session_policy(text)'::regprocedure), 'proconfig: get_session_policy has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.create_visitor_session(uuid,integer)'::regprocedure), 'proconfig: create_visitor_session has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.get_rate_policy(uuid)'::regprocedure), 'proconfig: get_rate_policy has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.begin_request_run(uuid,uuid,integer,text,text)'::regprocedure), 'proconfig: begin_request_run has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure), 'proconfig: reserve_request_budget has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.set_request_run_state(uuid,uuid,text)'::regprocedure), 'proconfig: set_request_run_state has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.get_request_run(uuid,uuid)'::regprocedure), 'proconfig: get_request_run has lock_timeout');
select ok((select 'lock_timeout=2s' = any (proconfig) from pg_proc where oid = 'public.schema_version()'::regprocedure), 'proconfig: schema_version has lock_timeout');

-- ===== grants: service_role only =====
select ok(has_function_privilege('service_role', 'public.get_session_policy(text)', 'EXECUTE') and has_function_privilege('service_role', 'public.create_visitor_session(uuid,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_rate_policy(uuid)', 'EXECUTE') and has_function_privilege('service_role', 'public.set_request_run_state(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_request_run(uuid,uuid)', 'EXECUTE') and has_function_privilege('service_role', 'public.begin_request_run(uuid,uuid,integer,text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.reserve_request_budget(uuid,uuid,numeric,integer)', 'EXECUTE'),
  'grants: service_role can EXECUTE the five new functions and the two replaced ones');
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.get_session_policy(text)'::regprocedure, 'public.create_visitor_session(uuid,integer)'::regprocedure, 'public.get_rate_policy(uuid)'::regprocedure,
                    'public.begin_request_run(uuid,uuid,integer,text,text)'::regprocedure, 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure,
                    'public.set_request_run_state(uuid,uuid,text)'::regprocedure, 'public.get_request_run(uuid,uuid)'::regprocedure)
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))),
  0, 'grants: none of the seven is executable by anon, authenticated or PUBLIC');
select is((select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.schema_version()'::regprocedure and a.privilege_type = 'EXECUTE' and a.grantee = (select oid from pg_roles where rolname = 'authenticated')), 1,
  'grants: schema_version keeps its authenticated grant after create or replace');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.get_session_policy('p5-main')$q$, '42501', null, 'anon: get_session_policy -> permission denied');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 900)$q$, '42501', null, 'anon: create_visitor_session -> permission denied');
select throws_ok($q$select public.get_rate_policy('b1000000-0000-4000-8000-000000000240')$q$, '42501', null, 'anon: get_rate_policy -> permission denied');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', 'failed')$q$, '42501', null, 'anon: set_request_run_state -> permission denied');
select throws_ok($q$select * from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240')$q$, '42501', null, 'anon: get_request_run -> permission denied');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000240","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.get_session_policy('p5-main')$q$, '42501', null, 'authenticated: get_session_policy -> permission denied');
select throws_ok($q$select * from public.create_visitor_session('b1000000-0000-4000-8000-000000000240', 900)$q$, '42501', null, 'authenticated: create_visitor_session -> permission denied');
select throws_ok($q$select public.get_rate_policy('b1000000-0000-4000-8000-000000000240')$q$, '42501', null, 'authenticated: get_rate_policy -> permission denied');
select throws_ok($q$select public.set_request_run_state('b1000000-0000-4000-8000-000000000240', 'd7000000-0000-4000-8000-000000000240', 'failed')$q$, '42501', null, 'authenticated: set_request_run_state -> permission denied');
select throws_ok($q$select * from public.get_request_run('b1000000-0000-4000-8000-000000000240', 'd3000000-0000-4000-8000-000000000240')$q$, '42501', null, 'authenticated: get_request_run -> permission denied');
reset role;

select * from finish();
rollback;
