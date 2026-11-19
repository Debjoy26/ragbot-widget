-- T08: per-invocation warm usage ledger. Real grants andTransitions; no
-- providers. Synthetic rows and role changes are contained in this transaction
-- and rolled back.
begin;
set local lock_timeout = '2s';
lock table public.jobs in share row exclusive mode;
select plan(27);

select has_column('public','usage_events','warm_reservation_id','warm usage links its reservation');
select has_column('public','usage_events','warm_invocation_id','warm usage tracks invocations');
select has_column('public','usage_events','state','warm usage rows carry pending/final state');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches warm usage contract: ' || f.signature)
from (values
  ('public.record_warm_usage(uuid,integer,text,uuid,uuid,text,text,text,integer,integer,numeric,integer,boolean)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'warm usage function is invoker with fixed empty search path')
from (values
  ('public.record_warm_usage(uuid,integer,text,uuid,uuid,text,text,text,integer,integer,numeric,integer,boolean)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'warm usage RPC has bounded lock waits')
from (values
  ('public.record_warm_usage(uuid,integer,text,uuid,uuid,text,text,text,integer,integer,numeric,integer,boolean)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok(exists(select 1 from pg_indexes where schemaname = 'public'
  and indexname = 'usage_events_warm_invocation_key' and indexdef ilike '%UNIQUE%'),
  'warm per-(reservation, invocation) key exists');

do $$ begin
  perform set_config('ragbot_test.b1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b2',gen_random_uuid()::text,true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values
  (current_setting('ragbot_test.b1')::uuid,'warm-use-' || current_setting('ragbot_test.b1'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b2')::uuid,'warm-use-' || current_setting('ragbot_test.b2'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
  retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
values
  (current_setting('ragbot_test.b1')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b2')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}');
insert into public.jobs(type,payload,state,attempts,max_attempts,locked_by,locked_until,warm_generation)
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-use',now() + interval '60 seconds',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b1')::uuid
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-use',now() + interval '60 seconds',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b2')::uuid;

do $$ begin
  perform set_config('ragbot_test.j1',(select id::text from public.jobs
    where payload->>'bot_id' = current_setting('ragbot_test.b1') and locked_by = 'w-use'),true);
  perform set_config('ragbot_test.r1',public.reserve_warm_budget(
    (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b1') and locked_by = 'w-use'),
    'w-use',1,repeat('a',64),0.05,300)::text,true);
  perform set_config('ragbot_test.j2',(select id::text from public.jobs
    where payload->>'bot_id' = current_setting('ragbot_test.b2') and locked_by = 'w-use'),true);
  perform set_config('ragbot_test.r2',public.reserve_warm_budget(
    (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b2') and locked_by = 'w-use'),
    'w-use',1,repeat('c',64),0.01,300)::text,true);
  perform set_config('ragbot_test.inv1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.inv2',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.inv3',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.inv4',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.inv5',gen_random_uuid()::text,true);
end $$;

set local role anon;
select throws_ok($q$select public.record_warm_usage(null::uuid,1,repeat('a',64),null::uuid,null::uuid,'gemini','m','chat',0,0,0,0,true)$q$,
  '42501',null,'anon warm usage is actually denied');
reset role;
set local role authenticated;
select throws_ok($q$select public.record_warm_usage(null::uuid,1,repeat('a',64),null::uuid,null::uuid,'gemini','m','chat',0,0,0,0,true)$q$,
  '42501',null,'authenticated warm usage is actually denied');
reset role;

select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('a',64),null::uuid,%L::uuid,'gemini','m','chat',0,0,0,0,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.inv1')),'22023',null,'null reservation is rejected');
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('a',64),%L::uuid,%L::uuid,'gemini','m','chat',-1,0,0,0,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1'),current_setting('ragbot_test.inv1')),'22023',null,'negative tokens are rejected');
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('a',64),%L::uuid,%L::uuid,'gemini','m','chat',0,0,100000000,0,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1'),current_setting('ragbot_test.inv1')),'22023',null,'absurd cost is rejected');
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('a',64),%L::uuid,%L::uuid,'gemini','m','bribe',0,0,0,0,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1'),current_setting('ragbot_test.inv1')),'22023',null,'unknown operation is rejected');
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('a',64),%L::uuid,%L::uuid,'gemini','m','chat',0,0,0,0,null)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1'),current_setting('ragbot_test.inv1')),'22023',null,'null final flag is rejected');

select throws_ok(format($q$select public.record_warm_usage(%L::uuid,2,repeat('a',64),%L::uuid,%L::uuid,'gemini','m','chat',1,0,0.01,5,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1'),current_setting('ragbot_test.inv1')),'RB003',null,'wrong generation breaks the binding');
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('b',64),%L::uuid,%L::uuid,'gemini','m','chat',1,0,0.01,5,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.r1'),current_setting('ragbot_test.inv1')),'RB003',null,'wrong question breaks the binding');
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('a',64),gen_random_uuid(),%L::uuid,'gemini','m','chat',1,0,0.01,5,true)$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.inv1')),'RB003',null,'unknown reservation breaks the binding');

select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,1,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,current_setting('ragbot_test.inv1')::uuid,
  'gemini','gemini-embedding-001','embedding_query',0,0,0,0,false);
select is((select state from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid
  and warm_invocation_id = current_setting('ragbot_test.inv1')::uuid),
  'pending','pending charge precedes the provider call');

select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,1,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,current_setting('ragbot_test.inv1')::uuid,
  'gemini','gemini-embedding-001','embedding_query',10,5,0.5,7,true);
select is((select count(*)::int from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid
  and warm_invocation_id = current_setting('ragbot_test.inv1')::uuid),
  1,'final report upserts the pending row instead of duplicating it');
select is((select (input_tokens, output_tokens, estimated_cost, state)::text from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid
  and warm_invocation_id = current_setting('ragbot_test.inv1')::uuid),
  '(10,5,0.500000,final)','final report carries the real cost');

select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,1,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,current_setting('ragbot_test.inv1')::uuid,
  'gemini','gemini-embedding-001','embedding_query',3,2,0.1,2,true);
select is((select (input_tokens, output_tokens, estimated_cost)::text from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid
  and warm_invocation_id = current_setting('ragbot_test.inv1')::uuid),
  '(10,5,0.500000)','a retried final report cannot shrink finalized spend');

update public.budget_reservations set expires_at = now() - interval '1 second'
  where id = current_setting('ragbot_test.r1')::uuid;
select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,1,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,current_setting('ragbot_test.inv2')::uuid,
  'gemini','gemini-2.5-flash-lite','chat',20,10,1.0,30,true);
select is((select count(*)::int from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid),2::int,
  'late accounting after expiry still lands on its reservation');

do $$ begin
  perform public.complete_job(current_setting('ragbot_test.j1')::uuid,'w-use');
end $$;
select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,1,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,current_setting('ragbot_test.inv3')::uuid,
  'openai','omni-moderation-latest','moderation',1,0,0.01,3,true);
select is((select count(*)::int from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid),3::int,
  'orphan spend on a finished job retains its estimate');

select public.record_warm_usage(current_setting('ragbot_test.j1')::uuid,1,repeat('a',64),
  current_setting('ragbot_test.r1')::uuid,current_setting('ragbot_test.inv4')::uuid,
  'openai','omni-moderation-latest','moderation',0,0,0,0,true);
select is((select (estimated_cost, state)::text from public.usage_events
  where warm_reservation_id = current_setting('ragbot_test.r1')::uuid
  and warm_invocation_id = current_setting('ragbot_test.inv4')::uuid),
  '(0.000000,final)','a zero-cost call is still recorded final');

do $$ begin
  delete from public.client_settings where bot_id = current_setting('ragbot_test.b2')::uuid;
end $$;
select throws_ok(format($q$select public.record_warm_usage(%L::uuid,1,repeat('c',64),%L::uuid,%L::uuid,'gemini','m','chat',1,0,0.01,1,true)$q$,
  current_setting('ragbot_test.j2'),current_setting('ragbot_test.r2'),current_setting('ragbot_test.inv5')),'RB002',null,'missing policy fails closed');

select * from finish();
rollback;
