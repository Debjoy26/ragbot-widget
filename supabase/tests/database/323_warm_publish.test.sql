-- T10: fenced C4-C6 publication. Real grants andTransitions; no providers.
-- Synthetic rows and role changes are contained in this transaction and rolled back.
begin;
set local lock_timeout = '2s';
lock table public.jobs in share row exclusive mode;
select plan(40);

select has_function('public','publish_warm_embedding',
  array['uuid','text','integer','text','text','integer','text','timestamptz'],
  'warm C4 publish RPC exists');
select has_function('public','publish_warm_moderation',
  array['uuid','text','integer','text','text','text','text','timestamptz'],
  'warm C6 publish RPC exists');
select has_function('public','publish_warm_retrieval',
  array['uuid','text','integer','text','uuid','bigint','text','integer','double precision','text','jsonb','timestamptz'],
  'warm C5 publish RPC exists');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches C4 publish contract: ' || f.signature)
from (values
  ('public.publish_warm_embedding(uuid,text,integer,text,text,integer,text,timestamptz)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches C6 publish contract: ' || f.signature)
from (values
  ('public.publish_warm_moderation(uuid,text,integer,text,text,text,text,timestamptz)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches C5 publish contract: ' || f.signature)
from (values
  ('public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'C4 publish is invoker with fixed empty search path')
from (values
  ('public.publish_warm_embedding(uuid,text,integer,text,text,integer,text,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'C6 publish is invoker with fixed empty search path')
from (values
  ('public.publish_warm_moderation(uuid,text,integer,text,text,text,text,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'C5 publish is invoker with fixed empty search path')
from (values
  ('public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'C4 publish has bounded lock waits')
from (values
  ('public.publish_warm_embedding(uuid,text,integer,text,text,integer,text,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'C6 publish has bounded lock waits')
from (values
  ('public.publish_warm_moderation(uuid,text,integer,text,text,text,text,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'C5 publish has bounded lock waits')
from (values
  ('public.publish_warm_retrieval(uuid,text,integer,text,uuid,bigint,text,integer,double precision,text,jsonb,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

do $$ begin
  perform set_config('ragbot_test.b1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b2',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b3',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b4',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b5',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b6',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.d6',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.v6',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.k6',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.vec',
    (select '[' || string_agg('0.1', ',' order by g) || ']' from generate_series(1,1536) g),true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values
  (current_setting('ragbot_test.b1')::uuid,'warm-pub-' || current_setting('ragbot_test.b1'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b2')::uuid,'warm-pub-' || current_setting('ragbot_test.b2'),false,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b3')::uuid,'warm-pub-' || current_setting('ragbot_test.b3'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b4')::uuid,'warm-pub-' || current_setting('ragbot_test.b4'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b5')::uuid,'warm-pub-' || current_setting('ragbot_test.b5'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b6')::uuid,'warm-pub-' || current_setting('ragbot_test.b6'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake6',1536);
insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
  retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
values
  (current_setting('ragbot_test.b1')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b2')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b3')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b4')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":false,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b5')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3,"c4":false}','{}'),
  (current_setting('ragbot_test.b6')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}');
insert into public.jobs(type,payload,state,attempts,max_attempts,locked_by,locked_until,warm_generation)
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-pub',now() + interval '60 seconds',1
from public.bot_profiles b where b.id in
  (current_setting('ragbot_test.b1')::uuid,current_setting('ragbot_test.b2')::uuid,
   current_setting('ragbot_test.b3')::uuid,current_setting('ragbot_test.b4')::uuid,
   current_setting('ragbot_test.b5')::uuid,current_setting('ragbot_test.b6')::uuid);

do $$ begin
  perform set_config('ragbot_test.j1',(select id::text from public.jobs
    where payload->>'bot_id' = current_setting('ragbot_test.b1') and locked_by = 'w-pub'),true);
  perform set_config('ragbot_test.g1',(select warm_generation::text from public.jobs
    where id = current_setting('ragbot_test.j1')::uuid),true);
  perform set_config('ragbot_test.ref6',jsonb_build_array(jsonb_build_object(
    'chunk_id',current_setting('ragbot_test.k6'),
    'document_version_id',current_setting('ragbot_test.v6'),
    'similarity',0.9))::text,true);
end $$;

-- Tenant fixture: b6 owns a live public chunk no other bot may warm from.
insert into public.documents(id,bot_id,title,status,disclosure_policy) values
  (current_setting('ragbot_test.d6')::uuid,current_setting('ragbot_test.b6')::uuid,'b6 doc','ready','public_answer');
insert into public.document_versions(id,document_id,version_number,storage_path,media_type,byte_size,status) values
  (current_setting('ragbot_test.v6')::uuid,current_setting('ragbot_test.d6')::uuid,1,current_setting('ragbot_test.b6') || '/' || current_setting('ragbot_test.d6') || '/' || current_setting('ragbot_test.v6') || '/v1.txt','text/plain',10,'ready');
insert into public.document_chunks(id,document_version_id,chunk_index,content,embedding) values
  (current_setting('ragbot_test.k6')::uuid,current_setting('ragbot_test.v6')::uuid,0,'b6 chunk',
    (select array_agg(0.1::real) from generate_series(1,1536))::extensions.vector);

set local role anon;
select throws_ok($q$select public.publish_warm_embedding(null::uuid,'w',1,repeat('a',64),'m',1536,'[0]',now() + interval '1 day')$q$,
  '42501',null,'anon publish is actually denied');
reset role;

select is(public.publish_warm_embedding(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('a',64),'fake',1536,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),true,'live claim publishes C4');
select is((select (embedding_model, embedding_dimensions)::text from public.query_embedding_cache
  where key_hash = repeat('a',64)),'(fake,1536)','C4 record carries the current model');

update public.bot_profiles set corpus_version = corpus_version + 1
  where id = current_setting('ragbot_test.b3')::uuid;
select is(public.publish_warm_embedding(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b3') and (payload->>'corpus_version')::bigint = 0),
  'w-pub',1,repeat('b',64),'fake',1536,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),false,'superseded versions publish nothing');

select is(public.publish_warm_embedding(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b2')),
  'w-pub',1,repeat('b',64),'fake',1536,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),false,'disabled bots publish nothing');

select is(public.publish_warm_embedding(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b4')),
  'w-pub',1,repeat('b',64),'fake',1536,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),false,'switched-off policy publishes nothing');

select is(public.publish_warm_embedding(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b5')),
  'w-pub',1,repeat('b',64),'fake',1536,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),false,'disabled layer publishes nothing');

select is(public.publish_warm_embedding(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('b',64),'other-model',1536,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),false,'stale model publishes nothing');

select is(public.publish_warm_embedding(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('b',64),'fake',768,
  current_setting('ragbot_test.vec'),now() + interval '7 days'),false,'stale dimensions publish nothing');

select throws_ok(format($q$select public.publish_warm_embedding(%L::uuid,'w-pub',%L::text::integer,'not-hex','fake',1536,%L,now() + interval '7 days')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.vec')),'22023',null,'malformed key is rejected');
select throws_ok(format($q$select public.publish_warm_embedding(%L::uuid,'w-pub',%L::text::integer,repeat('b',64),'fake',0,%L,now() + interval '7 days')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.vec')),'22023',null,'absurd dimensions are rejected');
select throws_ok(format($q$select public.publish_warm_embedding(%L::uuid,'nope',%L::text::integer,repeat('b',64),'fake',1536,%L,now() + interval '7 days')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.vec')),'RB013',null,'foreign worker publishes nothing');

select is(public.publish_warm_retrieval(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('d',64),current_setting('ragbot_test.b1')::uuid,0,
  repeat('a',64),5,0.3,'en','[]'::jsonb,now() + interval '10 minutes'),true,'live claim publishes C5');
select is((select (bot_id, corpus_version)::text from public.retrieval_cache
  where key_hash = repeat('d',64)),'(' || current_setting('ragbot_test.b1') || ',0)','C5 record carries bot and corpus');

select throws_ok(format($q$select public.publish_warm_retrieval(%L::uuid,'w-pub',1,repeat('e',64),%L::uuid,0,repeat('a',64),5,0.3,'en','[]'::jsonb,now() + interval '10 minutes')$q$,
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b6')),current_setting('ragbot_test.b6')),'RB003',null,'model without live embedding cannot anchor retrieval');

select throws_ok(format($q$select public.publish_warm_retrieval(%L::uuid,'w-pub',%L::text::integer,repeat('e',64),%L::uuid,0,repeat('a',64),5,0.3,'en','[]'::jsonb,now() + interval '10 minutes')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b2')),'RB004',null,'cross-bot retrieval is refused');

select is(public.publish_warm_retrieval(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('e',64),current_setting('ragbot_test.b1')::uuid,999,
  repeat('a',64),5,0.3,'en','[]'::jsonb,now() + interval '10 minutes'),false,'stale corpus publishes nothing');

select is(public.publish_warm_retrieval(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('2',64),current_setting('ragbot_test.b1')::uuid,0,
  repeat('a',64),5,0.3,'en',current_setting('ragbot_test.ref6')::jsonb,now() + interval '10 minutes'),false,'foreign chunk publishes nothing');
select is((select count(*)::int from public.retrieval_cache where key_hash = repeat('2',64)),0,
  'foreign chunk writes nothing');

select is(public.publish_warm_moderation(current_setting('ragbot_test.j1')::uuid,'w-pub',
  current_setting('ragbot_test.g1')::integer,repeat('1',64),'v1','allow','test-moderation-model',
  now() + interval '1 day'),true,'live claim publishes C6');
select is((select verdict from public.moderation_cache where key_hash = repeat('1',64)),
  'allow','C6 record carries the verdict');

select throws_ok(format($q$select public.publish_warm_moderation(%L::uuid,'w-pub',%L::text::integer,repeat('2',64),'v1','maybe','m',now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1')),'22023',null,'bad verdict is rejected');

select * from finish();
rollback;
