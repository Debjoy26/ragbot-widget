-- A09 scheduling: actual job transitions and role denials, synthetic fixtures.
begin;
select plan(18);
select has_column('public','jobs','analysis_requested_revision','enqueue revision exists');
select has_column('public','jobs','analysis_context_generation','context is generation-bound');
select has_trigger('public','jobs','jobs_analysis_successor','terminal transition schedules uncovered work');
select ok(has_function_privilege('service_role','public.queue_analysis_job(uuid,uuid,integer)','EXECUTE'),'service can enqueue');
select ok(not has_function_privilege('anon','public.queue_analysis_job(uuid,uuid,integer)','EXECUTE'),'anon cannot enqueue');
select ok(not has_function_privilege('authenticated','public.get_analysis_job_context(uuid,text,integer)','EXECUTE'),'authenticated cannot read context');
select ok(not has_function_privilege('anon','public.schedule_analysis_successor()','EXECUTE'),'anon cannot call trigger function');
select ok(not has_function_privilege('authenticated','public.schedule_analysis_successor()','EXECUTE'),'authenticated cannot call trigger function');

insert into public.bot_profiles(id,slug,identity_prompt,tone,scope,allowed_languages,embedding_model,embedding_dimensions)
values('b1000000-0000-4000-8000-000000000300','schedule-test-300','FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.conversations(id,bot_id)
values('c1000000-0000-4000-8000-000000000300','b1000000-0000-4000-8000-000000000300');
insert into public.messages(conversation_id,role,status,content)
values('c1000000-0000-4000-8000-000000000300','user','complete','FAKE first turn');
create temp table scheduled as select public.queue_analysis_job('b1000000-0000-4000-8000-000000000300','c1000000-0000-4000-8000-000000000300',0) as id;
select is((select analysis_requested_revision from public.jobs where id=(select id from scheduled)),1::bigint,'first enqueue has revision one');
update public.jobs set state='running',attempts=1,locked_by='fake-worker',locked_until=now()+interval '10 minutes' where id=(select id from scheduled);
select is(jsonb_array_length(public.get_analysis_job_context((select id from scheduled),'fake-worker',1)->'messages'),1,'first context covers one turn');
insert into public.messages(conversation_id,role,status,content)
values('c1000000-0000-4000-8000-000000000300','user','complete','FAKE later turn');
do $$ begin perform public.queue_analysis_job('b1000000-0000-4000-8000-000000000300','c1000000-0000-4000-8000-000000000300',0); end $$;
select is((select analysis_requested_revision from public.jobs where id=(select id from scheduled)),2::bigint,'running enqueue advances requested revision');
do $$ begin perform public.complete_job((select id from scheduled),'fake-worker'); end $$;
select is((select state from public.jobs where id=(select id from scheduled)),'queued','uncovered work remains queued after completion');
select is((select attempts from public.jobs where id=(select id from scheduled)),0,'successor receives a fresh retry budget');
update public.jobs set state='running',attempts=1,locked_by='fake-worker',locked_until=now()+interval '10 minutes' where id=(select id from scheduled);
select is((select analysis_generation from public.jobs where id=(select id from scheduled)),2,'successor advances generation even though attempts restarted');
select is(jsonb_array_length(public.get_analysis_job_context((select id from scheduled),'fake-worker',2)->'messages'),2,'successor context includes the new turn');
do $$ begin perform public.complete_job((select id from scheduled),'fake-worker'); end $$;
select is((select state from public.jobs where id=(select id from scheduled)),'succeeded','covered revision stays terminal without a loop');

set local role anon;
select throws_ok($q$select public.queue_analysis_job('b1000000-0000-4000-8000-000000000300','c1000000-0000-4000-8000-000000000300',0)$q$,'42501',null,'anon enqueue is actually refused');
reset role;
set local role authenticated;
select throws_ok($q$select public.get_analysis_job_context('c1000000-0000-4000-8000-000000000300','fake-worker',1)$q$,'42501',null,'authenticated context is actually refused');
reset role;
select * from finish();
rollback;
