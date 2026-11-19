-- T09: warm settlement and recovery. Real grants and transitions; no
-- providers. Synthetic rows and role changes are contained in this transaction
-- and rolled back.
begin;
set local lock_timeout = '2s';
lock table public.jobs in share row exclusive mode;
select plan(32);

select has_function('public','settle_warm_budget',
  array['uuid','text','integer','text','uuid','numeric'],
  'warm settle RPC exists');
select has_function('public','settle_orphaned_warm_reservations',array['integer'],
  'warm orphan sweep exists');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches warm settle contract: ' || f.signature)
from (values
  ('public.settle_warm_budget(uuid,text,integer,text,uuid,numeric)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches warm sweep contract: ' || f.signature)
from (values
  ('public.settle_orphaned_warm_reservations(integer)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'warm settle is invoker with fixed empty search path')
from (values
  ('public.settle_warm_budget(uuid,text,integer,text,uuid,numeric)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'warm sweep is invoker with fixed empty search path')
from (values
  ('public.settle_orphaned_warm_reservations(integer)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'warm settle RPC has bounded lock waits')
from (values
  ('public.settle_warm_budget(uuid,text,integer,text,uuid,numeric)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'warm sweep has bounded lock waits')
from (values
  ('public.settle_orphaned_warm_reservations(integer)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

do $$ begin
  perform set_config('ragbot_test.b1',gen_random_uuid()::text,true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values
  (current_setting('ragbot_test.b1')::uuid,'warm-set-' || current_setting('ragbot_test.b1'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
  retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
values
  (current_setting('ragbot_test.b1')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}');

set local role anon;
select throws_ok($q$select public.settle_warm_budget(null::uuid,'w',1,repeat('a',64),null::uuid,0)$q$,
  '42501',null,'anon warm settle is actually denied');
reset role;
set local role authenticated;
select throws_ok($q$select public.settle_warm_budget(null::uuid,'w',1,repeat('a',64),null::uuid,0)$q$,
  '42501',null,'authenticated warm settle is actually denied');
reset role;

do $$ declare j uuid; g integer; begin
  perform public.queue_warm_job(current_setting('ragbot_test.b1')::uuid);
  select (x).id, (x).warm_generation into j, g from (
    select public.claim_jobs('w-use',1,600,array['warm_answer_cache']) as x) s;
  perform set_config('ragbot_test.j1', j::text, true);
  perform set_config('ragbot_test.g1', g::text, true);
  perform set_config('ragbot_test.r1', public.reserve_warm_budget(
    j, 'w-use', g, repeat('a',64), 0.05, 300)::text, true);
  perform set_config('ragbot_test.r2', public.reserve_warm_budget(
    j, 'w-use', g, repeat('b',64), 0.05, 300)::text, true);
  perform set_config('ragbot_test.r3', public.reserve_warm_budget(
    j, 'w-use', g, repeat('c',64), 0.05, 300)::text, true);
  perform set_config('ragbot_test.r4', public.reserve_warm_budget(
    j, 'w-use', g, repeat('d',64), 0.05, 300)::text, true);
end $$;

select throws_ok($q$select public.settle_warm_budget(null::uuid,'w',1,repeat('a',64),null::uuid,0)$q$,
  '22023',null,'null job is rejected');
select throws_ok(format($q$select public.settle_warm_budget(%L::uuid,'w',1,repeat('a',64),%L::uuid,-1)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1')),'22023',null,'negative actual is rejected');
select throws_ok(format($q$select public.settle_warm_budget(%L::uuid,'w',1,'not-hex',%L::uuid,0)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1')),'22023',null,'non-hex question hash is rejected');

select throws_ok(format($q$select public.settle_warm_budget(%L::uuid,'nope',%L::text::integer,repeat('a',64),%L::uuid,0.1)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.r1')),'RB013',null,'foreign worker cannot settle');

select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,
  current_setting('ragbot_test.g1')::integer,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,gen_random_uuid(),
  'gemini','gemini-embedding-001','embedding_query',10,5,0.5,7,true);
select public.settle_warm_budget(current_setting('ragbot_test.j1')::uuid,'w-use',
  current_setting('ragbot_test.g1')::integer,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,0.3);
select is((select state from public.budget_reservations where id = current_setting('ragbot_test.r1')::uuid),
  'settled','settle reconciles the invocation');
select is((select amount from public.budget_reservations where id = current_setting('ragbot_test.r1')::uuid),
  0.5::numeric,'settle keeps the greater of actual and recorded usage');

select throws_ok(format($q$select public.settle_warm_budget(%L::uuid,'w-use',%L::text::integer,repeat('a',64),%L::uuid,0.1)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.r1')),'RB003',null,'settled invocation cannot settle again');
select throws_ok(format($q$select public.settle_warm_budget(%L::uuid,'w-use',%L::text::integer,repeat('a',64),gen_random_uuid(),0.1)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1')),'RB003',null,'unknown reservation cannot settle');

select public.settle_warm_budget(current_setting('ragbot_test.j1')::uuid,'w-use',
  current_setting('ragbot_test.g1')::integer,repeat('b',64),
  current_setting('ragbot_test.r2')::uuid,0);
select is((select state from public.budget_reservations where id = current_setting('ragbot_test.r2')::uuid),
  'released','zero-cost call with no usage releases the hold');

select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,
  current_setting('ragbot_test.g1')::integer,repeat('c',64),
  current_setting('ragbot_test.r3')::uuid,gen_random_uuid(),
  'openai','omni-moderation-latest','moderation',0,0,0,1,true);
select public.settle_warm_budget(current_setting('ragbot_test.j1')::uuid,'w-use',
  current_setting('ragbot_test.g1')::integer,repeat('c',64),
  current_setting('ragbot_test.r3')::uuid,0);
select is((select (state, amount)::text from public.budget_reservations where id = current_setting('ragbot_test.r3')::uuid),
  '(settled,0.000000)','recorded zero-cost call still settles');

update public.budget_reservations set expires_at = now() - interval '1 second'
  where id = current_setting('ragbot_test.r4')::uuid;
select public.settle_warm_budget(current_setting('ragbot_test.j1')::uuid,'w-use',
  current_setting('ragbot_test.g1')::integer,repeat('d',64),
  current_setting('ragbot_test.r4')::uuid,0.2);
select is((select state from public.budget_reservations where id = current_setting('ragbot_test.r4')::uuid),
  'settled','lapsed reservation still settles');

do $$ declare j uuid; r uuid; g integer; begin
  update public.bot_profiles set corpus_version = corpus_version + 1
    where id = current_setting('ragbot_test.b1')::uuid;
  select (x).id, (x).warm_generation into j, g from (
    select public.claim_jobs('w-use',1,600,array['warm_answer_cache']) as x) s;
  perform set_config('ragbot_test.j2', j::text, true);
  perform set_config('ragbot_test.g2', g::text, true);
  perform set_config('ragbot_test.r5', public.reserve_warm_budget(
    j, 'w-use', g, repeat('e',64), 0.05, 300)::text, true);
  perform public.record_warm_usage(j, g, repeat('e',64),
    public.reserve_warm_budget(j,'w-use',g,repeat('e',64),0.05,300),
    gen_random_uuid(),'gemini','gemini-2.5-flash-lite','chat',20,10,0.1,30,true);
  perform public.complete_job(j,'w-use');
end $$;
select is(public.settle_orphaned_warm_reservations(10),1,'orphan sweep recovers one reservation');
select is((select (state, amount)::text from public.budget_reservations where id = current_setting('ragbot_test.r5')::uuid),
  '(settled,0.100000)','orphan keeps its recorded spend');

do $$ declare j uuid; r uuid; g integer; begin
  update public.bot_profiles set corpus_version = corpus_version + 1
    where id = current_setting('ragbot_test.b1')::uuid;
  select (x).id, (x).warm_generation into j, g from (
    select public.claim_jobs('w-use',1,600,array['warm_answer_cache']) as x) s;
  perform set_config('ragbot_test.j3', j::text, true);
  perform set_config('ragbot_test.r6', public.reserve_warm_budget(
    j, 'w-use', g, repeat('f',64), 0.06, 300)::text, true);
  perform public.complete_job(j,'w-use');
end $$;
select is(public.settle_orphaned_warm_reservations(10),1,'spend-free orphan is swept');
select is((select (state, amount)::text from public.budget_reservations where id = current_setting('ragbot_test.r6')::uuid),
  '(settled,0.060000)','unknown orphan spend retains its estimate');

select throws_ok($q$select public.settle_orphaned_warm_reservations(0)$q$,'22023',null,'empty batch is rejected');

do $$ declare j uuid; r uuid; g integer; begin
  update public.bot_profiles set corpus_version = corpus_version + 1
    where id = current_setting('ragbot_test.b1')::uuid;
  select (x).id, (x).warm_generation into j, g from (
    select public.claim_jobs('w-use',1,600,array['warm_answer_cache']) as x) s;
  perform set_config('ragbot_test.j4', j::text, true);
  perform set_config('ragbot_test.r7', public.reserve_warm_budget(
    j, 'w-use', g, repeat('1',64), 0.04, 300)::text, true);
  perform public.complete_job(j,'w-use');
end $$;
select is(public.settle_orphaned_index_reservations(10),0,'index sweep ignores warm holds');
select is((select state from public.budget_reservations where id = current_setting('ragbot_test.r7')::uuid),
  'reserved','warm hold survives the index sweep');

select * from finish();
rollback;
