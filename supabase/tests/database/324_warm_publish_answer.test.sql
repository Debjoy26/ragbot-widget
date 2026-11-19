-- T11: fenced C7 publication. Real grants andTransitions; no providers.
-- Synthetic rows and role changes are contained in this transaction and rolled back.
begin;
set local lock_timeout = '2s';
lock table public.jobs in share row exclusive mode;
select plan(40);

select has_function('public','publish_warm_answer',
  array['uuid','text','integer','text','uuid','text','text','text','jsonb','text','text','boolean','boolean','text','text','bigint','integer','timestamptz'],
  'warm C7 publish RPC exists');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches C7 publish contract: ' || f.signature)
from (values
  ('public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'C7 publish is invoker with fixed empty search path')
from (values
  ('public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'C7 publish has bounded lock waits')
from (values
  ('public.publish_warm_answer(uuid,text,integer,text,uuid,text,text,text,jsonb,text,text,boolean,boolean,text,text,bigint,integer,timestamptz)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

do $$ begin
  perform set_config('ragbot_test.b1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b2',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b3',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b4',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b5',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b6',gen_random_uuid()::text,true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values
  (current_setting('ragbot_test.b1')::uuid,'warm-c7-' || current_setting('ragbot_test.b1'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b2')::uuid,'warm-c7-' || current_setting('ragbot_test.b2'),false,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b3')::uuid,'warm-c7-' || current_setting('ragbot_test.b3'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b4')::uuid,'warm-c7-' || current_setting('ragbot_test.b4'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b5')::uuid,'warm-c7-' || current_setting('ragbot_test.b5'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b6')::uuid,'warm-c7-' || current_setting('ragbot_test.b6'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
  retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
values
  (current_setting('ragbot_test.b1')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3,"c7":true}','{}'),
  (current_setting('ragbot_test.b2')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3,"c7":true}','{}'),
  (current_setting('ragbot_test.b3')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3,"c7":true}','{}'),
  (current_setting('ragbot_test.b4')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":false,"warm_max_attempts":3,"c7":true}','{}'),
  (current_setting('ragbot_test.b5')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3}','{}'),
  (current_setting('ragbot_test.b6')::uuid,array[]::text[],'{}','{"daily_cap_usd":100}',
    '{"conversation_days":90,"usage_months":13}','{}','{}','{"warm_enabled":true,"warm_max_attempts":3,"c7":true}','{}');
insert into public.jobs(type,payload,state,attempts,max_attempts,locked_by,locked_until,warm_generation)
select 'warm_answer_cache',
  jsonb_build_object('bot_id',b.id,'corpus_version',b.corpus_version,'settings_version',b.settings_version),
  'running',1,3,'w-c7',now() + interval '60 seconds',1
from public.bot_profiles b where b.id in
  (current_setting('ragbot_test.b1')::uuid,current_setting('ragbot_test.b2')::uuid,
   current_setting('ragbot_test.b3')::uuid,current_setting('ragbot_test.b4')::uuid,
   current_setting('ragbot_test.b5')::uuid,current_setting('ragbot_test.b6')::uuid);

-- Active corpus for b1: one public ready document, one ready version, one chunk.
do $$ begin
  perform set_config('ragbot_test.d1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.v1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.k1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.dx',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.vx',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.kx',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.d6',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.v6',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.k6',gen_random_uuid()::text,true);
end $$;
insert into public.documents(id,bot_id,title,status,disclosure_policy) values
  (current_setting('ragbot_test.d1')::uuid,current_setting('ragbot_test.b1')::uuid,'c7 doc','ready','public_answer'),
  (current_setting('ragbot_test.dx')::uuid,current_setting('ragbot_test.b1')::uuid,'c7 excluded','ready','excluded'),
  (current_setting('ragbot_test.d6')::uuid,current_setting('ragbot_test.b6')::uuid,'c7 foreign','ready','public_answer');
insert into public.document_versions(id,document_id,version_number,storage_path,media_type,byte_size,status) values
  (current_setting('ragbot_test.v1')::uuid,current_setting('ragbot_test.d1')::uuid,1,current_setting('ragbot_test.b1') || '/' || current_setting('ragbot_test.d1') || '/' || current_setting('ragbot_test.v1') || '/v1.txt','text/plain',10,'ready'),
  (current_setting('ragbot_test.vx')::uuid,current_setting('ragbot_test.dx')::uuid,1,current_setting('ragbot_test.b1') || '/' || current_setting('ragbot_test.dx') || '/' || current_setting('ragbot_test.vx') || '/v1.txt','text/plain',10,'ready'),
  (current_setting('ragbot_test.v6')::uuid,current_setting('ragbot_test.d6')::uuid,1,current_setting('ragbot_test.b6') || '/' || current_setting('ragbot_test.d6') || '/' || current_setting('ragbot_test.v6') || '/v1.txt','text/plain',10,'ready');
insert into public.document_chunks(id,document_version_id,chunk_index,content,embedding) values
  (current_setting('ragbot_test.k1')::uuid,current_setting('ragbot_test.v1')::uuid,0,'c7 chunk one',
    (select array_agg(0.1::real) from generate_series(1,1536))::extensions.vector),
  (current_setting('ragbot_test.kx')::uuid,current_setting('ragbot_test.vx')::uuid,0,'c7 excluded chunk',
    (select array_agg(0.1::real) from generate_series(1,1536))::extensions.vector),
  (current_setting('ragbot_test.k6')::uuid,current_setting('ragbot_test.v6')::uuid,0,'c7 foreign chunk',
    (select array_agg(0.1::real) from generate_series(1,1536))::extensions.vector);

do $$ begin
  perform set_config('ragbot_test.j1',(select id::text from public.jobs
    where payload->>'bot_id' = current_setting('ragbot_test.b1') and locked_by = 'w-c7'),true);
  perform set_config('ragbot_test.g1',(select warm_generation::text from public.jobs
    where id = current_setting('ragbot_test.j1')::uuid),true);
  perform set_config('ragbot_test.refs1',jsonb_build_array(jsonb_build_object(
    'chunk_id',current_setting('ragbot_test.k1'),
    'document_version_id',current_setting('ragbot_test.v1')))::text,true);
  perform set_config('ragbot_test.refx',jsonb_build_array(jsonb_build_object(
    'chunk_id',current_setting('ragbot_test.kx'),
    'document_version_id',current_setting('ragbot_test.vx')))::text,true);
  perform set_config('ragbot_test.refbad',jsonb_build_array(jsonb_build_object(
    'chunk_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'document_version_id','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'))::text,true);
  perform set_config('ragbot_test.ref6',jsonb_build_array(jsonb_build_object(
    'chunk_id',current_setting('ragbot_test.k6'),
    'document_version_id',current_setting('ragbot_test.v6')))::text,true);
end $$;

set local role anon;
select throws_ok($q$select public.publish_warm_answer(null::uuid,'w',1,repeat('a',64),null::uuid,'en','q','a','[]'::jsonb,null,'complete',true,false,'rag-v2','m',0,0,now() + interval '1 day')$q$,
  '42501',null,'anon publish is actually denied');
reset role;

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('a',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),true,'live claim publishes C7');
select is((select answer_text from public.answer_cache where cache_key_hash = repeat('a',64)),
  'the refund policy allows returns','C7 record carries the answer text');
select is((select (corpus_version, settings_version, prompt_template_version, chat_model)::text from public.answer_cache where cache_key_hash = repeat('a',64)),
  '(0,1,rag-v2,test-chat-model)','C7 record carries current versions and model');

update public.bot_profiles set corpus_version = corpus_version + 1
  where id = current_setting('ragbot_test.b3')::uuid;
select is(public.publish_warm_answer(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b3') and (payload->>'corpus_version')::bigint = 0),
  'w-c7',1,repeat('b',64),current_setting('ragbot_test.b3')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'superseded versions publish nothing');

select is(public.publish_warm_answer(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b2')),
  'w-c7',1,repeat('b',64),current_setting('ragbot_test.b2')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'disabled bots publish nothing');

select is(public.publish_warm_answer(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b4')),
  'w-c7',1,repeat('b',64),current_setting('ragbot_test.b4')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'switched-off policy publishes nothing');

select is(public.publish_warm_answer(
  (select id from public.jobs where payload->>'bot_id' = current_setting('ragbot_test.b5')),
  'w-c7',1,repeat('b',64),current_setting('ragbot_test.b5')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'missing C7 opt-in publishes nothing');

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('c',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'old-template','test-chat-model',
  0,1,now() + interval '1 day'),false,'stale prompt template publishes nothing');

select throws_ok(format($q$select public.publish_warm_answer(%L::uuid,'w-c7',%L::text::integer,repeat('c',64),%L::uuid,'en','q','a','[]'::jsonb,null,'complete',true,false,'rag-v2','m',0,1,now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b2')),'RB004',null,'cross-bot answer is refused');
select throws_ok(format($q$select public.publish_warm_answer(%L::uuid,'nope',%L::text::integer,repeat('c',64),%L::uuid,'en','q','a','[]'::jsonb,null,'complete',true,false,'rag-v2','m',0,1,now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b1')),'RB013',null,'foreign worker publishes nothing');
select throws_ok(format($q$select public.publish_warm_answer(%L::uuid,'w-c7',%L::text::integer,'not-hex',%L::uuid,'en','q','a','[]'::jsonb,null,'complete',true,false,'rag-v2','m',0,1,now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b1')),'22023',null,'malformed key is rejected');
select throws_ok(format($q$select public.publish_warm_answer(%L::uuid,'w-c7',%L::text::integer,repeat('c',64),%L::uuid,'en','q','a',%L::jsonb,null,'complete',true,false,'rag-v2','m',0,1,now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b1'),'[{"chunk_id":"not-a-uuid"}]'),'22023',null,'malformed citation is rejected');

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('d',64),current_setting('ragbot_test.b1')::uuid,'en',
  'my email is test@example.com','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'PII question publishes nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('d',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','call 415-555-2671 for help',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'PII answer publishes nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('d',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','reach us via mailto:help desk',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'contact details publish nothing');

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('e',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the policy is blocked',
  current_setting('ragbot_test.refs1')::jsonb,null,'blocked',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'blocked status publishes nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('e',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','a partial answer',
  current_setting('ragbot_test.refs1')::jsonb,null,'partial',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'partial answers publish nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('e',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','an unmoderated answer',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',false,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'unmoderated answers publish nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('e',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','a cut answer',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,true,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'truncated answers publish nothing');

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('f',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','an answer without citations',
  '[]'::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'uncited answers publish nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('f',64),current_setting('ragbot_test.b1')::uuid,'en',
  'where is support','we do not know yet',
  '[]'::jsonb,'no_knowledge','complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),true,'deliberate handoff publishes without citations');
select is((select handoff_reason from public.answer_cache where cache_key_hash = repeat('f',64)),
  'no_knowledge','handoff record carries its reason');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('f',64),current_setting('ragbot_test.b1')::uuid,'en',
  'where is support','blocked message',
  '[]'::jsonb,'blocked','complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'blocked handoff publishes nothing');

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('1',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refbad')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'deleted citations publish nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('1',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refx')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'excluded disclosure publishes nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('4',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.ref6')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),false,'foreign bot chunk publishes nothing');
select is((select count(*)::int from public.answer_cache where cache_key_hash = repeat('4',64)),0,
  'foreign chunk writes nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('2',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  999,1,now() + interval '1 day'),false,'stale corpus publishes nothing');
select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('3',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy allows returns',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,999,now() + interval '1 day'),false,'stale settings publish nothing');

select throws_ok(format($q$select public.publish_warm_answer(%L::uuid,'w-c7',%L::text::integer,repeat('2',64),%L::uuid,'en','q','a','[]'::jsonb,null,'weird',true,false,'rag-v2','m',0,1,now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b1')),'22023',null,'unknown status is rejected');
select throws_ok(format($q$select public.publish_warm_answer(%L::uuid,'w-c7',%L::text::integer,repeat('2',64),%L::uuid,'en','q','a','[]'::jsonb,'bogus','complete',true,false,'rag-v2','m',0,1,now() + interval '1 day')$q$,
  current_setting('ragbot_test.j1'),current_setting('ragbot_test.g1'),current_setting('ragbot_test.b1')),'22023',null,'unknown handoff reason is rejected');

select is(public.publish_warm_answer(current_setting('ragbot_test.j1')::uuid,'w-c7',
  current_setting('ragbot_test.g1')::integer,repeat('a',64),current_setting('ragbot_test.b1')::uuid,'en',
  'what is the refund policy','the refund policy was updated',
  current_setting('ragbot_test.refs1')::jsonb,null,'complete',true,false,'rag-v2','test-chat-model',
  0,1,now() + interval '1 day'),true,'republish overwrites the same key');
select is((select answer_text from public.answer_cache where cache_key_hash = repeat('a',64)),
  'the refund policy was updated','republished record carries the new answer');

select * from finish();
rollback;
