-- T15: bot filter on the chunk rehydration lookup. Service_role only;
-- same-bot chunks are returned, cross-bot chunks are hidden, and the legacy
-- single-argument call still works through the default.
begin;
set local lock_timeout = '2s';
select plan(6);

select has_function('public','get_chunks_by_ids',array['uuid[]','uuid'],
  'tenant-filtered chunk lookup exists');

select ok(has_function_privilege('service_role','public.get_chunks_by_ids(uuid[],uuid)','EXECUTE')
  and not has_function_privilege('anon','public.get_chunks_by_ids(uuid[],uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.get_chunks_by_ids(uuid[],uuid)','EXECUTE'),
  'chunk lookup is service_role only');

do $$ begin
  perform set_config('ragbot_test.b1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.b2',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.d1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.v1',gen_random_uuid()::text,true);
  perform set_config('ragbot_test.k1',gen_random_uuid()::text,true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values
  (current_setting('ragbot_test.b1')::uuid,'warm-tenant-' || current_setting('ragbot_test.b1'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536),
  (current_setting('ragbot_test.b2')::uuid,'warm-tenant-' || current_setting('ragbot_test.b2'),true,
    'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.documents(id,bot_id,title,status,disclosure_policy) values
  (current_setting('ragbot_test.d1')::uuid,current_setting('ragbot_test.b1')::uuid,'tenant doc','ready','public_answer');
insert into public.document_versions(id,document_id,version_number,storage_path,media_type,byte_size,status) values
  (current_setting('ragbot_test.v1')::uuid,current_setting('ragbot_test.d1')::uuid,1,current_setting('ragbot_test.b1') || '/' || current_setting('ragbot_test.d1') || '/' || current_setting('ragbot_test.v1') || '/v1.txt','text/plain',10,'ready');
insert into public.document_chunks(id,document_version_id,chunk_index,content,embedding) values
  (current_setting('ragbot_test.k1')::uuid,current_setting('ragbot_test.v1')::uuid,0,'tenant chunk',
    (select array_agg(0.1::real) from generate_series(1,1536))::extensions.vector);

set local role anon;
select throws_ok($q$select public.get_chunks_by_ids(array['00000000-0000-4000-8000-000000000000'::uuid])$q$,
  '42501',null,'anon chunk lookup is actually denied');
reset role;

select is((select count(*)::int from public.get_chunks_by_ids(
  array[current_setting('ragbot_test.k1')::uuid],current_setting('ragbot_test.b1')::uuid)),1,
  'same-bot chunk is returned');
select is((select count(*)::int from public.get_chunks_by_ids(
  array[current_setting('ragbot_test.k1')::uuid],current_setting('ragbot_test.b2')::uuid)),0,
  'cross-bot chunk is hidden');
select is((select count(*)::int from public.get_chunks_by_ids(
  array[current_setting('ragbot_test.k1')::uuid])),1,
  'unfiltered lookup still works');

select * from finish();
rollback;
