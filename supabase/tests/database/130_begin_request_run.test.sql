-- P3-D1 M5: begin_request_run (atomic idempotent request start + per-session concurrency cap) and the
-- request_runs format CHECKs. Limitation: the FOR UPDATE session lock cannot be exercised with two real
-- connections inside one pgTAP transaction (P5 integration tests must add that); here sequential
-- behaviour of every outcome is asserted.
begin;
select plan(56);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000a1', 'q-bot', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000a2', 'q-bot-nocfg', 'x', array['en'], 'm', 1536),
  ('b3000000-0000-4000-8000-0000000000a3', 'q-bot-nocap', 'x', array['en'], 'm', 1536),
  ('b4000000-0000-4000-8000-0000000000a4', 'q-bot-badcap', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000a1', array['https://e.test'], '{"concurrent_requests_per_session": 2}', '{}', '{}', '{}', '{}', '{}'),
  ('b3000000-0000-4000-8000-0000000000a3', array['https://e.test'], '{"message_per_session": {"limit": 1, "window_seconds": 60}}', '{}', '{}', '{}', '{}', '{}'),
  ('b4000000-0000-4000-8000-0000000000a4', array['https://e.test'], '{"concurrent_requests_per_session": 0}', '{}', '{}', '{}', '{}', '{}');

insert into public.visitor_sessions (id, bot_id, expires_at, revoked_at) values
  ('a1000000-0000-4000-8000-0000000000a1', 'b1000000-0000-4000-8000-0000000000a1', now() + interval '1 hour', null),
  ('a2000000-0000-4000-8000-0000000000a2', 'b1000000-0000-4000-8000-0000000000a1', now() + interval '1 hour', null),
  ('a3000000-0000-4000-8000-0000000000a3', 'b1000000-0000-4000-8000-0000000000a1', now() - interval '1 second', null),
  ('a4000000-0000-4000-8000-0000000000a4', 'b1000000-0000-4000-8000-0000000000a1', now() + interval '1 hour', now()),
  ('a5000000-0000-4000-8000-0000000000a5', 'b2000000-0000-4000-8000-0000000000a2', now() + interval '1 hour', null),
  ('a6000000-0000-4000-8000-0000000000a6', 'b3000000-0000-4000-8000-0000000000a3', now() + interval '1 hour', null),
  ('a7000000-0000-4000-8000-0000000000a7', 'b4000000-0000-4000-8000-0000000000a4', now() + interval '1 hour', null);

-- ---- request_runs CHECKs (as the migration owner, so only the constraint can reject) ----
select throws_ok($q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash) values ('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 'k1', repeat('a', 64))$q$, '23514', null, 'request_runs CHECK: idempotency_key must be a uuid (plain string rejected)');
select throws_ok($q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash) values ('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 'ABCDEF00-0000-4000-8000-000000000001', repeat('a', 64))$q$, '23514', null, 'request_runs CHECK: uppercase uuid is not canonical');
select throws_ok($q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash) values ('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', '00000000000040008000000000000001', repeat('a', 64))$q$, '23514', null, 'request_runs CHECK: uuid without hyphens is not canonical');
select throws_ok($q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash) values ('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'h')$q$, '23514', null, 'request_runs CHECK: request_hash must be 64 hex (short string rejected)');
select throws_ok($q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash) values ('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', repeat('A', 64))$q$, '23514', null, 'request_runs CHECK: uppercase hash rejected');
select throws_ok($q$insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash) values ('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', repeat('a', 63))$q$, '23514', null, 'request_runs CHECK: 63-char hash rejected');
select lives_ok($q$insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state) values ('91000000-0000-4000-8000-0000000000a1', 'b1000000-0000-4000-8000-0000000000a1', 'a2000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000001', repeat('a', 64), 'succeeded')$q$, 'request_runs CHECK: canonical uuid + 64 lowercase hex accepted');
delete from public.request_runs;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---- outcome: new ----
create temp table n1 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64));
select is((select outcome from n1), 'new', 'begin_request_run: first call -> new');
select isnt((select run_id from n1), null, 'begin_request_run: new run has an id');
select is((select state || ':' || request_hash from public.request_runs where id = (select run_id from n1)), 'reserved:' || repeat('a', 64), 'begin_request_run: the run is stored in state reserved with its hash');

-- ---- outcome: duplicate (same key, same hash) ----
create temp table d1 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64));
select is((select outcome from d1), 'duplicate', 'begin_request_run: replay with same key + hash -> duplicate');
select is((select run_id from d1), (select run_id from n1), 'begin_request_run: duplicate returns the existing run id');
select is((select count(*)::int from public.request_runs), 1, 'begin_request_run: duplicate inserted nothing');

-- ---- outcome: hash_mismatch (same key, different hash) ----
create temp table m1 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('b', 64));
select is((select outcome from m1), 'hash_mismatch', 'begin_request_run: same key with a different hash -> hash_mismatch');
select is((select run_id from m1), null, 'begin_request_run: hash_mismatch does not hand out the existing run id');
select is((select count(*)::int from public.request_runs), 1, 'begin_request_run: hash_mismatch inserted nothing');
select is((select request_hash from public.request_runs where id = (select run_id from n1)), repeat('a', 64), 'begin_request_run: hash_mismatch did not overwrite the stored hash');

-- ---- outcome: concurrency_limited (cap = 2 per session) ----
create temp table n2 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000002', repeat('c', 64));
select is((select outcome from n2), 'new', 'begin_request_run: second concurrent run (cap 2) -> new');
create temp table c1 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000003', repeat('d', 64));
select is((select outcome from c1), 'concurrency_limited', 'begin_request_run: third concurrent run -> concurrency_limited');
select is((select run_id from c1), null, 'begin_request_run: concurrency_limited returns no run id');
select is((select count(*)::int from public.request_runs where visitor_session_id = 'a1000000-0000-4000-8000-0000000000a1'), 2, 'begin_request_run: concurrency_limited inserted nothing');
create temp table d2 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64));
select is((select outcome from d2), 'duplicate', 'begin_request_run: a replay at the cap is reported as duplicate, not limited');

-- Another session of the same bot has its own cap.
create temp table o1 as select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a2000000-0000-4000-8000-0000000000a2', 1, '00000000-0000-4000-8000-000000000003', repeat('d', 64));
select is((select outcome from o1), 'new', 'begin_request_run: the cap is per visitor session (another session starts fine)');
-- The same key in another session is a different idempotency scope.
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a2000000-0000-4000-8000-0000000000a2', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))), 'new', 'begin_request_run: same key in another session is a new run (scoped idempotency)');

-- Only reserved/running runs count: finishing one frees a slot; running still counts.
update public.request_runs set state = 'running' where id = (select run_id from n2);
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000003', repeat('d', 64))), 'concurrency_limited', 'begin_request_run: a running run still counts toward the cap');
update public.request_runs set state = 'failed', finished_at = now() where id = (select run_id from n2);
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000003', repeat('d', 64))), 'new', 'begin_request_run: a failed run frees a slot');
update public.request_runs set state = 'succeeded', finished_at = now() where visitor_session_id = 'a1000000-0000-4000-8000-0000000000a1' and state in ('reserved', 'running');
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000004', repeat('e', 64))), 'new', 'begin_request_run: succeeded runs do not count');

-- ---- session validity (RB004) ----
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a3000000-0000-4000-8000-0000000000a3', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB004', null, 'begin_request_run: expired session rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a4000000-0000-4000-8000-0000000000a4', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB004', null, 'begin_request_run: revoked session rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000dead', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB004', null, 'begin_request_run: unknown session rejected');
select throws_ok($q$select * from public.begin_request_run('b3000000-0000-4000-8000-0000000000a3', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB004', null, 'begin_request_run: a session of another bot is rejected (ownership)');
select is((select count(*)::int from public.request_runs where visitor_session_id in ('a3000000-0000-4000-8000-0000000000a3', 'a4000000-0000-4000-8000-0000000000a4')), 0, 'begin_request_run: rejected sessions created no run');

-- ---- fail closed on missing / invalid concurrency cap (RB002) ----
select throws_ok($q$select * from public.begin_request_run('b2000000-0000-4000-8000-0000000000a2', 'a5000000-0000-4000-8000-0000000000a5', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB002', null, 'begin_request_run: bot without client_settings fails closed');
select throws_ok($q$select * from public.begin_request_run('b3000000-0000-4000-8000-0000000000a3', 'a6000000-0000-4000-8000-0000000000a6', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB002', null, 'begin_request_run: rate_policy without concurrent_requests_per_session fails closed');
select throws_ok($q$select * from public.begin_request_run('b4000000-0000-4000-8000-0000000000a4', 'a7000000-0000-4000-8000-0000000000a7', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB002', null, 'begin_request_run: cap 0 is invalid and fails closed');
reset role;
update public.client_settings set rate_policy = '{"concurrent_requests_per_session": "lots"}' where bot_id = 'b4000000-0000-4000-8000-0000000000a4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select * from public.begin_request_run('b4000000-0000-4000-8000-0000000000a4', 'a7000000-0000-4000-8000-0000000000a7', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB002', null, 'begin_request_run: non-numeric cap fails closed');
reset role;
update public.client_settings set rate_policy = '{"concurrent_requests_per_session": 1.5}' where bot_id = 'b4000000-0000-4000-8000-0000000000a4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select * from public.begin_request_run('b4000000-0000-4000-8000-0000000000a4', 'a7000000-0000-4000-8000-0000000000a7', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB002', null, 'begin_request_run: fractional cap fails closed');
select is((select count(*)::int from public.request_runs where bot_id in ('b2000000-0000-4000-8000-0000000000a2', 'b3000000-0000-4000-8000-0000000000a3', 'b4000000-0000-4000-8000-0000000000a4')), 0, 'begin_request_run: fail-closed paths created no run');

-- ---- argument validation (22023) ----
select throws_ok($q$select * from public.begin_request_run(null, 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '22023', null, 'begin_request_run: null bot rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', null, 1, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '22023', null, 'begin_request_run: null session rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, null, repeat('a', 64))$q$, '22023', null, 'begin_request_run: null key rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', null)$q$, '22023', null, 'begin_request_run: null hash rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, 'not-a-uuid', repeat('a', 64))$q$, '22023', null, 'begin_request_run: non-uuid key rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, 'ABCDEF00-0000-4000-8000-000000000001', repeat('a', 64))$q$, '22023', null, 'begin_request_run: uppercase uuid key rejected (canonical form only)');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', 'short')$q$, '22023', null, 'begin_request_run: short hash rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000001', repeat('G', 64))$q$, '22023', null, 'begin_request_run: non-hex hash rejected');

-- Source smoke check only (NOT a concurrency test): the function takes the session row lock.
-- ---- P3-D2 N7a: p_token_version must match the locked session's token_version ----
insert into public.visitor_sessions (id, bot_id, expires_at, token_version) values
  ('a8000000-0000-4000-8000-0000000000a8', 'b1000000-0000-4000-8000-0000000000a1', now() + interval '1 hour', 3);
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', 3, '00000000-0000-4000-8000-000000000001', repeat('a', 64))), 'new', 'N7a: matching token_version -> new run');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', 1, '00000000-0000-4000-8000-000000000002', repeat('a', 64))$q$, 'RB004', null, 'N7a: a stale (lower) token_version is rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', 4, '00000000-0000-4000-8000-000000000002', repeat('a', 64))$q$, 'RB004', null, 'N7a: a higher-than-current token_version is rejected');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', null, '00000000-0000-4000-8000-000000000002', repeat('a', 64))$q$, '22023', null, 'N7a: null token_version rejected (required)');
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', 0, '00000000-0000-4000-8000-000000000002', repeat('a', 64))$q$, '22023', null, 'N7a: token_version 0 rejected');
select is((select count(*)::int from public.request_runs where visitor_session_id = 'a8000000-0000-4000-8000-0000000000a8'), 1, 'N7a: rejected token versions created no run');
update public.visitor_sessions set token_version = 4 where id = 'a8000000-0000-4000-8000-0000000000a8';
select throws_ok($q$select * from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', 3, '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, 'RB004', null, 'N7a: after rotation the old token_version is rejected, even for a replay of an existing key');
select is((select outcome from public.begin_request_run('b1000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-0000000000a8', 4, '00000000-0000-4000-8000-000000000001', repeat('a', 64))), 'duplicate', 'N7a: the rotated token_version is accepted');

select ok((select prosrc ilike '%from public.visitor_sessions s%for update%' from pg_proc where proname = 'begin_request_run' and pronamespace = 'public'::regnamespace), 'begin_request_run: locks the visitor_sessions row FOR UPDATE (source smoke check, not a race test)');
select is((select count(*)::int from pg_proc p where p.proname = 'begin_request_run' and p.pronamespace = 'public'::regnamespace and not p.prosecdef), 1, 'begin_request_run: SECURITY INVOKER (service role privileges only)');

reset role;
select * from finish();
rollback;
