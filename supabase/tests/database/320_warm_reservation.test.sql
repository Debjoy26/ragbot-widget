-- T07: warm reservation schema and reserve RPC. Real grants andTransitions; no
-- providers. Synthetic rows and role changes are contained in this transaction
-- and rolled back.
begin;
set local lock_timeout = '2s';
lock table public.jobs in share row exclusive mode;
select plan(30);

select has_column('public','budget_reservations','warm_generation','warm reservations bind their claim generation');
select has_column('public','budget_reservations','question_hash','warm reservations bind their question');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches warm reserve contract: ' || f.signature)
from (values
  ('public.reserve_warm_budget(uuid,text,integer,text,numeric,integer)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'warm reserve function is invoker with fixed empty search path')
from (values
  ('public.reserve_warm_budget(uuid,text,integer,text,numeric,integer)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'warm reserve RPC has bounded lock waits')
from (values
  ('public.reserve_warm_budget(uuid,text,integer,text,numeric,integer)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok(exists(select 1 from pg_indexes where schemaname = 'public'
  and indexname = 'budget_reservations_warm_key' and indexdef ilike '%UNIQUE%'),
  'warm per-(job, generation, question) key exists');
select ok((select indexdef ilike '%warm_generation%' from pg_indexes
  where schemaname = 'public' and indexname = 'budget_reservations_job_id_key'),
  'one-active-reservation-per-job index excludes warm rows');

do $$ begin
  perform set_config('ragbot_test.b1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b2',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b3',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b4',gen_random_uuid()::text,true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values
  (current_setting('ragbot_test.b1')::uuid,'warm-rsv-' || current_setting('ragbot_test.b1'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b2')::uuid,'warm-rsv-' || current_setting('ragbot_test.b2'),false,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b3')::uuid,'warm-rsv-' || current_setting('ragbot_test.b3'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b4')::uuid,'warm-rsv-' || current_setting('ragbot_test.b4'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
  retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
values
  (current_setting('ragbot_test.b1')::uuid,array[]::text[],'{}','{"daily_cap_usd":1}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b2')::uuid,array[]::text[],'{}','{"daily_cap_usd":1}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b3')::uuid,array[]::text[],'{}','{"daily_cap_usd":1}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b4')::uuid,array[]::text[],'{}','{"daily_cap_usd":1}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":false,"warm_max_attempts":3}','{}');
insert into public.jobs(type,payload,state,attempts,max_attempts,locked_by,locked_until,warm_generation)
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-live',now() + interval '60 seconds',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b1')::uuid
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',99,'settings_version',b.settings_version),
  'running',1,3,'w-live',now() - interval '1 second',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b1')::uuid
union all
select 'index_document','{"bot_id":"00000000-0000-0000-0000-000000000000"}',
  'running',1,3,'w-live',now() + interval '60 seconds',0
union all
select 'warm_answer_cache','{}','running',1,3,'w-live',now() + interval '60 seconds',1
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',98,'settings_version',b.settings_version),
  'running',1,3,'w-live',now() + interval '60 seconds',2
from public.bot_profiles b where b.id = current_setting('ragbot_test.b1')::uuid
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-dis',now() + interval '60 seconds',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b2')::uuid
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-sup',now() + interval '60 seconds',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b3')::uuid
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-off',now() + interval '60 seconds',1
from public.bot_profiles b where b.id = current_setting('ragbot_test.b4')::uuid
union all
select 'warm_answer_cache',
  jsonb_build_object('bot_id',gen_random_uuid(),'corpus_version',0,'settings_version',1),
  'running',1,3,'w-noset',now() + interval '60 seconds',1;

do $$ begin
  perform set_config('ragbot_test.j1',(select id::text from public.jobs
    where payload->>'bot_id' = current_setting('ragbot_test.b1') and locked_by = 'w-live' and type = 'warm_answer_cache'
    and locked_until > now() and warm_generation = 1),true);
end $$;

set local role anon;
select throws_ok($q$select public.reserve_warm_budget(null::uuid,'w',1,repeat('a',64),0.01,300)$q$,
  '42501',null,'anon warm reserve is actually denied');
reset role;
set local role authenticated;
select throws_ok($q$select public.reserve_warm_budget(null::uuid,'w',1,repeat('a',64),0.01,300)$q$,
  '42501',null,'authenticated warm reserve is actually denied');
reset role;

select throws_ok($q$select public.reserve_warm_budget(null::uuid,'w',1,repeat('a',64),0.01,300)$q$,
  '22023',null,'null job is rejected');
select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w',1,'not-hex',0.01,300)$q$,
  current_setting('ragbot_test.j1')),'22023',null,'non-hex question hash is rejected');
select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w',1,repeat('a',64),0,300)$q$,
  current_setting('ragbot_test.j1')),'22023',null,'zero amount is rejected');
select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w',1,repeat('a',64),0.01,0)$q$,
  current_setting('ragbot_test.j1')),'22023',null,'zero ttl is rejected');
select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w',0,repeat('a',64),0.01,300)$q$,
  current_setting('ragbot_test.j1')),'22023',null,'zero generation is rejected');

select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'nope',1,repeat('a',64),0.01,300)$q$,
  current_setting('ragbot_test.j1')),'RB013',null,'foreign worker holds no lease');
select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w-live',2,repeat('a',64),0.01,300)$q$,
  current_setting('ragbot_test.j1')),'RB013',null,'stale generation holds no lease');
select throws_ok($q$select public.reserve_warm_budget(
  (select id from public.jobs where locked_by = 'w-live' and locked_until < now()),
  'w-live',1,repeat('a',64),0.01,300)$q$,'RB013',null,'lapsed lease holds nothing');
select throws_ok($q$select public.reserve_warm_budget(
  (select id from public.jobs where locked_by = 'w-live' and type = 'index_document'),
  'w-live',1,repeat('a',64),0.01,300)$q$,'RB004',null,'non-warm job cannot reserve warm budget');
select throws_ok($q$select public.reserve_warm_budget(
  (select id from public.jobs where payload = '{}'::jsonb),
  'w-live',1,repeat('a',64),0.01,300)$q$,'22023',null,'payload without a bot is rejected');
select throws_ok($q$select public.reserve_warm_budget(
  (select id from public.jobs where locked_by = 'w-noset'),
  'w-noset',1,repeat('2',64),0.01,300)$q$,'RB002',null,'settings-less bot cannot reserve');

select is(public.reserve_warm_budget(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b2') and locked_by = 'w-dis'),
  'w-dis',1,repeat('b',64),0.01,300), null, 'disabled bot reserves nothing');

update public.bot_profiles set corpus_version = corpus_version + 1
  where id = current_setting('ragbot_test.b3')::uuid;
select is(public.reserve_warm_budget(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b3') and locked_by = 'w-sup'),
  'w-sup',1,repeat('c',64),0.01,300), null, 'superseded versions reserve nothing');

select is(public.reserve_warm_budget(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b4') and locked_by = 'w-off'),
  'w-off',1,repeat('d',64),0.01,300), null, 'switched-off policy reserves nothing');

select ok(public.reserve_warm_budget(current_setting('ragbot_test.j1')::uuid,
  'w-live',1,repeat('a',64),0.01,300) is not null, 'live claim reserves');
select is(public.reserve_warm_budget(current_setting('ragbot_test.j1')::uuid,
  'w-live',1,repeat('a',64),0.01,300),
  public.reserve_warm_budget(current_setting('ragbot_test.j1')::uuid,
  'w-live',1,repeat('a',64),0.01,300), 'duplicate reserve returns the same identity');
select ok(public.reserve_warm_budget(current_setting('ragbot_test.j1')::uuid,
  'w-live',1,repeat('e',64),0.01,300)
  is distinct from public.reserve_warm_budget(current_setting('ragbot_test.j1')::uuid,
  'w-live',1,repeat('a',64),0.01,300), 'another question reserves separately');

do $$ begin
  perform public.settle_budget_reservation(current_setting('ragbot_test.b1')::uuid,
    public.reserve_warm_budget(current_setting('ragbot_test.j1')::uuid,
    'w-live',1,repeat('f',64),0.01,300), 0.005);
end $$;
select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w-live',1,repeat('f',64),0.01,300)$q$,
  current_setting('ragbot_test.j1')),'RB003',null,'accounted invocation cannot reserve again');

select throws_ok(format($q$select public.reserve_warm_budget(%L::uuid,'w-live',1,repeat('1',64),2,300)$q$,
  current_setting('ragbot_test.j1')),'RB001',null,'daily cap refuses warm overspend');

select * from finish();
rollback;
