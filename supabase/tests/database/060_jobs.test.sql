-- claim_jobs: leases, SKIP LOCKED semantics (sequential), expiry recovery, dead-lettering, dedupe.
-- Limitation: a true two-connection race cannot be expressed inside a single pgTAP transaction;
-- the P5/P6 integration tests must add concurrent-connection coverage.
begin;
select plan(32);

-- Seed DB has no jobs; this file only relies on its own rows.
insert into public.jobs (id, type, dedupe_key, max_attempts, available_at) values
  ('10000000-0000-4000-8000-000000000001', 'index_document', 'j1', 3, now() - interval '3 minutes'),
  ('10000000-0000-4000-8000-000000000002', 'index_document', 'j2', 3, now() - interval '2 minutes'),
  ('10000000-0000-4000-8000-000000000003', 'analyze_conversation', 'j3', 3, now() - interval '1 minute'),
  ('10000000-0000-4000-8000-000000000004', 'cleanup', 'j4-future', 3, now() + interval '1 hour');

-- dedupe_key is unique.
select throws_ok(
  $q$insert into public.jobs (type, dedupe_key, max_attempts) values ('cleanup', 'j1', 3)$q$,
  '23505', null, 'jobs: duplicate dedupe_key rejected');
select lives_ok(
  $q$insert into public.jobs (type, dedupe_key, max_attempts) values ('cleanup', null, 3), ('cleanup', null, 3)$q$,
  'jobs: null dedupe_key is allowed repeatedly');
delete from public.jobs where dedupe_key is null;
select throws_ok(
  $q$insert into public.jobs (type, dedupe_key) values ('cleanup', 'no-max')$q$,
  '23502', null, 'jobs: max_attempts has no default (fail closed)');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table claim_a as select * from public.claim_jobs('worker-a', 2, 60);
create temp table claim_b as select * from public.claim_jobs('worker-b', 2, 60);
create temp table claim_c as select * from public.claim_jobs('worker-c', 5, 60);

select is((select count(*)::int from claim_a), 2, 'claim_jobs: worker A claims 2 due jobs');
select is((select count(*)::int from claim_b), 1, 'claim_jobs: worker B gets only the remaining due job');
select is((select count(*)::int from claim_c), 0, 'claim_jobs: nothing left for worker C (future job is not due)');
select is(
  (select count(*)::int from (select id from claim_a union all select id from claim_b) u),
  (select count(distinct id)::int from (select id from claim_a union all select id from claim_b) u),
  'claim_jobs: two claims never return the same job');
select results_eq(
  $q$select id from claim_a order by id$q$,
  $q$values ('10000000-0000-4000-8000-000000000001'::uuid), ('10000000-0000-4000-8000-000000000002'::uuid)$q$,
  'claim_jobs: oldest available jobs are claimed first');
select is(
  (select count(*)::int from public.jobs where state = 'running' and attempts = 1 and locked_by is not null and locked_until > now()),
  3, 'claim_jobs: claimed rows are running, attempts=1, with owner and a future lease');
select is(
  (select state from public.jobs where id = '10000000-0000-4000-8000-000000000004'),
  'queued', 'claim_jobs: a not-yet-available job stays queued');
select is(
  (select locked_by from public.jobs where id = '10000000-0000-4000-8000-000000000001'),
  'worker-a', 'claim_jobs: locked_by records the claiming worker');

-- Live leases are not stolen.
select is((select count(*)::int from public.claim_jobs('worker-d', 5, 60)), 0, 'claim_jobs: a live lease is not reclaimable');

-- Expired lease becomes reclaimable.
reset role;
update public.jobs set locked_until = now() - interval '1 second' where id = '10000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temp table reclaim as select * from public.claim_jobs('worker-e', 5, 60);
select is((select count(*)::int from reclaim), 1, 'claim_jobs: exactly the expired-lease job is reclaimed');
select is((select id from reclaim), '10000000-0000-4000-8000-000000000001'::uuid, 'claim_jobs: reclaimed job is the one whose lease expired');
select is((select attempts from reclaim), 2, 'claim_jobs: reclaim increments attempts');
select is((select locked_by from reclaim), 'worker-e', 'claim_jobs: reclaim reassigns the lock owner');

-- Dead-letter: expired lease with attempts exhausted is failed, not re-run.
reset role;
update public.jobs set attempts = max_attempts, locked_until = now() - interval '1 second' where id = '10000000-0000-4000-8000-000000000002';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*)::int from public.claim_jobs('worker-f', 5, 60)), 0, 'claim_jobs: exhausted job is not handed out again');
select is(
  (select state || '/' || coalesce(last_error, '') from public.jobs where id = '10000000-0000-4000-8000-000000000002'),
  'failed/lease expired; max attempts reached', 'claim_jobs: exhausted expired job is dead-lettered (failed)');
select isnt((select completed_at from public.jobs where id = '10000000-0000-4000-8000-000000000002'), null, 'claim_jobs: dead-lettered job has completed_at');
select is((select locked_by from public.jobs where id = '10000000-0000-4000-8000-000000000002'), null, 'claim_jobs: dead-lettered job lock cleared');

-- Type filter.
reset role;
update public.jobs set available_at = now() - interval '1 minute' where id = '10000000-0000-4000-8000-000000000004';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*)::int from public.claim_jobs('worker-g', 5, 60, array['index_document'])), 0, 'claim_jobs: type filter excludes other types');
select results_eq(
  $q$select type from public.claim_jobs('worker-g', 5, 60, array['cleanup'])$q$,
  $q$values ('cleanup'::text)$q$, 'claim_jobs: type filter returns the matching type');

-- Terminal states are never claimed.
reset role;
insert into public.jobs (type, dedupe_key, max_attempts, state) values
  ('cleanup', 'done', 3, 'succeeded'), ('cleanup', 'cancelled', 3, 'cancelled'), ('cleanup', 'failed', 3, 'failed');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*)::int from public.claim_jobs('worker-h', 5, 60)), 0, 'claim_jobs: succeeded/failed/cancelled jobs are never claimed');

-- Argument bounds (fail closed, no defaults).
select throws_ok($q$select * from public.claim_jobs('w', 0, 60)$q$, '22023', null, 'claim_jobs: limit 0 rejected');
select throws_ok($q$select * from public.claim_jobs('w', 101, 60)$q$, '22023', null, 'claim_jobs: limit 101 rejected');
select throws_ok($q$select * from public.claim_jobs('w', 1, 0)$q$, '22023', null, 'claim_jobs: lease 0 rejected');
select throws_ok($q$select * from public.claim_jobs('w', 1, 3601)$q$, '22023', null, 'claim_jobs: lease 3601 rejected');
select throws_ok($q$select * from public.claim_jobs('', 1, 60)$q$, '22023', null, 'claim_jobs: empty worker id rejected');
select throws_ok($q$select * from public.claim_jobs(null, 1, 60)$q$, '22023', null, 'claim_jobs: null worker id rejected');

-- CHECK constraints.
reset role;
select throws_ok($q$insert into public.jobs (type, max_attempts) values ('bogus', 3)$q$, '23514', null, 'jobs: invalid type rejected');
select throws_ok($q$insert into public.jobs (type, max_attempts, state) values ('cleanup', 3, 'bogus')$q$, '23514', null, 'jobs: invalid state rejected');
select throws_ok($q$insert into public.jobs (type, max_attempts) values ('cleanup', 0)$q$, '23514', null, 'jobs: max_attempts 0 rejected');

select * from finish();
rollback;
