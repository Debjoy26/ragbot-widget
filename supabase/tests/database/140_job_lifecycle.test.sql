-- P3-D1 L3: complete_job / fail_job / heartbeat_job prove lease ownership (state running AND locked_by = worker).
-- Limitation: sequential only (a stale worker is simulated by re-claiming after lease expiry).
begin;
select plan(39);

insert into public.jobs (id, type, dedupe_key, max_attempts, available_at) values
  ('20000000-0000-4000-8000-000000000001', 'index_document', 'l1', 3, now() - interval '5 minutes'),
  ('20000000-0000-4000-8000-000000000002', 'index_document', 'l2', 2, now() - interval '4 minutes'),
  ('20000000-0000-4000-8000-000000000003', 'index_document', 'l3', 3, now() - interval '3 minutes'),
  ('20000000-0000-4000-8000-000000000004', 'cleanup', 'l4', 3, now() - interval '2 minutes'),
  ('20000000-0000-4000-8000-000000000005', 'cleanup', 'l5', 3, now() + interval '1 hour');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table cl as select id from public.claim_jobs('worker-a', 4, 60);
select is((select count(*)::int from cl), 4, 'setup: worker-a holds four leases');

-- ---- complete_job ----
select lives_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000001', 'worker-a')$q$, 'complete_job: the lease holder completes');
select is((select state from public.jobs where id = '20000000-0000-4000-8000-000000000001'), 'succeeded', 'complete_job: state succeeded');
select isnt((select completed_at from public.jobs where id = '20000000-0000-4000-8000-000000000001'), null, 'complete_job: completed_at set');
select is((select coalesce(locked_by, '-') || ':' || coalesce(locked_until::text, '-') from public.jobs where id = '20000000-0000-4000-8000-000000000001'), '-:-', 'complete_job: lease cleared');
select throws_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000001', 'worker-a')$q$, 'RB013', null, 'complete_job: completing an already finished job -> lease not held');
select throws_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000002', 'worker-b')$q$, 'RB013', null, 'complete_job: another worker cannot complete the job');
select is((select state from public.jobs where id = '20000000-0000-4000-8000-000000000002'), 'running', 'complete_job: the rejected call left the job running');
select throws_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000005', 'worker-a')$q$, 'RB013', null, 'complete_job: a queued (never claimed) job -> lease not held');
select throws_ok($q$select public.complete_job('00000000-0000-4000-8000-00000000dead', 'worker-a')$q$, 'RB013', null, 'complete_job: unknown job -> lease not held');
select throws_ok($q$select public.complete_job(null, 'worker-a')$q$, '22023', null, 'complete_job: null job rejected');
select throws_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000002', '')$q$, '22023', null, 'complete_job: empty worker rejected');
select throws_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000002', null)$q$, '22023', null, 'complete_job: null worker rejected');

-- ---- fail_job: retry vs dead-letter ----
select is(public.fail_job('20000000-0000-4000-8000-000000000003', 'worker-a', 'boom'), 'queued', 'fail_job: attempts (1) < max (3) -> requeued');
select is((select state || '/' || attempts::text || '/' || coalesce(last_error, '') || '/' || (locked_by is null)::text || '/' || (completed_at is null)::text from public.jobs where id = '20000000-0000-4000-8000-000000000003'), 'queued/1/boom/true/true', 'fail_job: requeued job keeps attempts, stores the error, drops the lease');
select is((select count(*)::int from public.claim_jobs('worker-c', 5, 60, array['index_document']) where id = '20000000-0000-4000-8000-000000000003'), 1, 'fail_job: a requeued job is claimable again');
select is((select attempts from public.jobs where id = '20000000-0000-4000-8000-000000000003'), 2, 'fail_job: re-claim increments attempts');
-- worker-a is now stale for job 3 (worker-c re-claimed it).
select throws_ok($q$select public.fail_job('20000000-0000-4000-8000-000000000003', 'worker-a', 'late')$q$, 'RB013', null, 'stale worker: fail_job after re-claim -> lease not held');
select throws_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000003', 'worker-a')$q$, 'RB013', null, 'stale worker: complete_job after re-claim -> lease not held');
select throws_ok($q$select public.heartbeat_job('20000000-0000-4000-8000-000000000003', 'worker-a', 60)$q$, 'RB013', null, 'stale worker: heartbeat_job after re-claim -> lease not held');
select is((select locked_by || '/' || state from public.jobs where id = '20000000-0000-4000-8000-000000000003'), 'worker-c/running', 'stale worker: the new owner is unaffected');
select lives_ok($q$select public.complete_job('20000000-0000-4000-8000-000000000003', 'worker-c')$q$, 'stale worker: the new owner can complete');

-- max_attempts = 2: first failure requeues, the second dead-letters.
select is(public.fail_job('20000000-0000-4000-8000-000000000002', 'worker-a', 'first'), 'queued', 'fail_job: attempt 1 of 2 -> queued');
select is((select count(*)::int from public.claim_jobs('worker-d', 5, 60, array['index_document'])), 1, 'fail_job: job 2 re-claimed (attempt 2)');
select is(public.fail_job('20000000-0000-4000-8000-000000000002', 'worker-d', 'second'), 'failed', 'fail_job: attempts (2) >= max (2) -> dead-lettered (failed)');
select is((select (completed_at is not null)::text || '/' || coalesce(last_error, '') || '/' || (locked_by is null)::text from public.jobs where id = '20000000-0000-4000-8000-000000000002'), 'true/second/true', 'fail_job: dead-lettered job has completed_at, the last error and no lease');
select is((select count(*)::int from public.claim_jobs('worker-e', 5, 60)), 0, 'fail_job: a dead-lettered job is never handed out again');

-- error truncation
select is(public.fail_job('20000000-0000-4000-8000-000000000004', 'worker-a', repeat('x', 5000)), 'queued', 'fail_job: very long error accepted');
select is((select length(last_error) from public.jobs where id = '20000000-0000-4000-8000-000000000004'), 1000, 'fail_job: last_error truncated to 1000 characters');
select throws_ok($q$select public.fail_job('20000000-0000-4000-8000-000000000004', 'worker-a', 'again')$q$, 'RB013', null, 'fail_job: a requeued job is no longer held by the old worker');
select throws_ok($q$select public.fail_job('20000000-0000-4000-8000-000000000001', 'worker-a', 'x')$q$, 'RB013', null, 'fail_job: failing a succeeded job -> lease not held');
select throws_ok($q$select public.fail_job('20000000-0000-4000-8000-000000000005', 'worker-a', 'x')$q$, 'RB013', null, 'fail_job: failing a queued job -> lease not held');
select throws_ok($q$select public.fail_job('20000000-0000-4000-8000-000000000004', 'worker-a', null)$q$, '22023', null, 'fail_job: null error text rejected');

-- ---- heartbeat_job ----
create temp table hb as select * from public.claim_jobs('worker-f', 5, 5, array['cleanup']);
select is((select count(*)::int from hb), 1, 'setup: worker-f re-claims job 4 with a short lease');
create temp table hb_before as select locked_until from public.jobs where id = '20000000-0000-4000-8000-000000000004';
select cmp_ok(public.heartbeat_job('20000000-0000-4000-8000-000000000004', 'worker-f', 3000), '>', (select locked_until from hb_before), 'heartbeat_job: extends the lease and returns the new expiry');
select throws_ok($q$select public.heartbeat_job('20000000-0000-4000-8000-000000000004', 'worker-a', 60)$q$, 'RB013', null, 'heartbeat_job: a worker that does not hold the lease cannot extend it');
select throws_ok($q$select public.heartbeat_job('20000000-0000-4000-8000-000000000004', 'worker-f', 0)$q$, '22023', null, 'heartbeat_job: lease 0 rejected');
select throws_ok($q$select public.heartbeat_job('20000000-0000-4000-8000-000000000004', 'worker-f', 3601)$q$, '22023', null, 'heartbeat_job: lease 3601 rejected');
select throws_ok($q$select public.heartbeat_job('20000000-0000-4000-8000-000000000001', 'worker-a', 60)$q$, 'RB013', null, 'heartbeat_job: a finished job cannot be extended');

reset role;
select * from finish();
rollback;
