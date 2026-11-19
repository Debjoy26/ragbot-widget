-- Real grants and claim_jobs transitions; no providers. Synthetic rows and
-- role changes are contained in this transaction and rolled back.
begin;
set local lock_timeout = '2s';
-- Exclude concurrent queue writers before inspecting/claiming fixture work.
lock table public.jobs in share row exclusive mode;
select plan(69);

select has_column('public','jobs','warm_generation','warming claims have a generation column');
select has_trigger('public','jobs','jobs_warm_generation','warming claims advance generation');
select has_trigger('public','bot_profiles','bot_profiles_warm_version','final bot versions schedule warming');
select cmp_ok(public.schema_version(),'>=',20,'warming migration is present');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute privilege matches warming contract: ' || f.signature)
from (values
  ('public.bump_warm_generation()'),
  ('public.warm_policy_enabled(jsonb)'),
  ('public.queue_warm_job(uuid)'),
  ('public.enqueue_warm_after_version_change()'),
  ('public.warm_job_fence(uuid,text,integer)'),
  ('public.get_warm_job_context(uuid,text,integer)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'warming function is invoker with fixed empty search path: ' || f.signature)
from (values
  ('public.bump_warm_generation()'),
  ('public.warm_policy_enabled(jsonb)'),
  ('public.queue_warm_job(uuid)'),
  ('public.enqueue_warm_after_version_change()'),
  ('public.warm_job_fence(uuid,text,integer)'),
  ('public.get_warm_job_context(uuid,text,integer)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select ok('lock_timeout=2s'=any(p.proconfig),
  'warming RPC has bounded lock waits: ' || f.signature)
from (values
  ('public.queue_warm_job(uuid)'),
  ('public.warm_job_fence(uuid,text,integer)'),
  ('public.get_warm_job_context(uuid,text,integer)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

set local role anon;
select throws_ok($q$select public.queue_warm_job(null::uuid)$q$,'42501',null,
  'anon queue invocation is actually denied');
select throws_ok($q$select public.get_warm_job_context(null::uuid,'fake-worker',1)$q$,'42501',null,
  'anon context invocation is actually denied');
reset role;
set local role authenticated;
select throws_ok($q$select public.queue_warm_job(null::uuid)$q$,'42501',null,
  'authenticated queue invocation is actually denied');
select throws_ok($q$select public.get_warm_job_context(null::uuid,'fake-worker',1)$q$,'42501',null,
  'authenticated context invocation is actually denied');
reset role;

do $$ begin
  perform set_config('ragbot_test.bot_id',gen_random_uuid()::text,true);
end $$;
insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
  allowed_languages,embedding_model,embedding_dimensions)
values(current_setting('ragbot_test.bot_id')::uuid,
  'warm-claim-' || current_setting('ragbot_test.bot_id'),false,
  'FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
  retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
values(current_setting('ragbot_test.bot_id')::uuid,array[]::text[],'{}',
  '{"daily_cap_usd":1}','{"conversation_days":90,"usage_months":13}','{}','{}',
  '{"warm_enabled":true,"warm_max_attempts":3,"c7":true}','{}');
insert into public.public_bot_config(bot_id,bot_slug,display_name,greeting,
  suggested_questions,primary_color,position,supported_languages,
  escalation_label,escalation_messages,contact_email)
values(current_setting('ragbot_test.bot_id')::uuid,
  'warm-claim-' || current_setting('ragbot_test.bot_id'),'FAKE bot','FAKE greeting',
  '["FAKE question"]','#3155D9','bottom-right',array['en'],'Contact',
  '{"en":"FAKE help"}','help@example.com');

set local role service_role;
-- Platform defaults grant service EXECUTE, but trigger functions cannot be
-- invoked directly. Browser roles remain denied above.
select throws_ok($q$select public.bump_warm_generation()$q$,'0A000',null,
  'service role cannot directly invoke the generation trigger');
select throws_ok($q$select public.enqueue_warm_after_version_change()$q$,'0A000',null,
  'service role cannot directly invoke the version trigger');
update public.bot_profiles set enabled=true
  where id=current_setting('ragbot_test.bot_id')::uuid;
do $$ begin
  perform set_config('ragbot_test.job_id',
    public.queue_warm_job(current_setting('ragbot_test.bot_id')::uuid)::text,true);
end $$;
select ok(current_setting('ragbot_test.job_id') is not null,'service role enqueues a real job');
select is((select max_attempts from public.jobs where id=current_setting('ragbot_test.job_id')::uuid),
  3,'queued job uses the explicit retry limit');

select is((select count(*) from public.jobs where type='warm_answer_cache'
  and state in ('queued','running') and id<>current_setting('ragbot_test.job_id')::uuid),
  0::bigint,'claim fixture has no unrelated active warming work');
-- Refuse to claim or modify unrelated local work if the stack is not clean.
do $$ begin
  if exists(select 1 from public.jobs where type='warm_answer_cache'
    and state in ('queued','running') and id<>current_setting('ragbot_test.job_id')::uuid) then
    raise exception 'warming claim fixture requires a clean local warming queue';
  end if;
end $$;

do $$ declare j public.jobs; n integer:=0; begin
  perform set_config('ragbot_test.claim','{}',true);
  for j in select * from public.claim_jobs('fake-warm-first',1,600,array['warm_answer_cache']) loop
    n:=n+1;
    perform set_config('ragbot_test.claim',to_jsonb(j)::text,true);
  end loop;
  perform set_config('ragbot_test.claim_count',n::text,true);
end $$;
select is(current_setting('ragbot_test.claim_count')::integer,1,'claim RPC acquires exactly one warming job');
select is(current_setting('ragbot_test.claim')::jsonb->>'id',current_setting('ragbot_test.job_id'),
  'claim RPC returns the fixture job');
select is(current_setting('ragbot_test.claim')::jsonb->>'type','warm_answer_cache',
  'claim RPC respects warming type selection');
select is(current_setting('ragbot_test.claim')::jsonb->>'locked_by','fake-warm-first',
  'claim RPC assigns the real lease owner');
select ok((current_setting('ragbot_test.claim')::jsonb->>'locked_until')::timestamptz>now(),
  'claim RPC grants a live lease');
select is((current_setting('ragbot_test.claim')::jsonb->>'attempts')::integer,1,
  'first claim counts one attempt');
select is((current_setting('ragbot_test.claim')::jsonb->>'warm_generation')::integer,1,
  'claim return row includes first warm generation');
select is(public.get_warm_job_context(current_setting('ragbot_test.job_id')::uuid,
  'fake-warm-first',1)->>'state','ready','first real claim can read context');
select throws_ok($q$select public.warm_job_fence(current_setting('ragbot_test.job_id')::uuid,
  'wrong-worker',1)$q$,'RB013',null,'wrong owner cannot use the acquired lease');
select throws_ok($q$select public.warm_job_fence(current_setting('ragbot_test.job_id')::uuid,
  'fake-warm-first',0)$q$,'RB013',null,'zero generation fails closed');

update public.jobs set locked_until=now()-interval '1 second'
  where id=current_setting('ragbot_test.job_id')::uuid;
do $$ declare j public.jobs; begin
  perform set_config('ragbot_test.claim','{}',true);
  for j in select * from public.claim_jobs('fake-warm-second',1,600,array['warm_answer_cache']) loop
    perform set_config('ragbot_test.claim',to_jsonb(j)::text,true);
  end loop;
end $$;
select is(current_setting('ragbot_test.claim')::jsonb->>'id',current_setting('ragbot_test.job_id'),
  'claim RPC recovers the expired fixture lease');
select is((current_setting('ragbot_test.claim')::jsonb->>'attempts')::integer,2,
  'reclaim counts the second attempt');
select is((current_setting('ragbot_test.claim')::jsonb->>'warm_generation')::integer,2,
  'reclaim advances warm generation');
select is(current_setting('ragbot_test.claim')::jsonb->>'locked_by','fake-warm-second',
  'reclaim changes the lease owner');
select throws_ok($q$select public.get_warm_job_context(current_setting('ragbot_test.job_id')::uuid,
  'fake-warm-first',1)$q$,'RB013',null,'old worker/generation is fenced after real reclaim');
select is(public.release_job_lease(current_setting('ragbot_test.job_id')::uuid,'wrong-worker'),
  false,'wrong worker cannot refund the claim');
select is(public.release_job_lease(current_setting('ragbot_test.job_id')::uuid,'fake-warm-second'),
  true,'owner can refund and release its real claim');
select is((select attempts from public.jobs where id=current_setting('ragbot_test.job_id')::uuid),
  1,'lease refund restores retry allowance');
select is((select warm_generation from public.jobs where id=current_setting('ragbot_test.job_id')::uuid),
  2,'lease refund never rewinds generation');

do $$ declare j public.jobs; begin
  perform set_config('ragbot_test.claim','{}',true);
  for j in select * from public.claim_jobs('fake-warm-third',1,600,array['warm_answer_cache']) loop
    perform set_config('ragbot_test.claim',to_jsonb(j)::text,true);
  end loop;
end $$;
select is((current_setting('ragbot_test.claim')::jsonb->>'attempts')::integer,2,
  'post-refund claim reuses the retry number');
select is((current_setting('ragbot_test.claim')::jsonb->>'warm_generation')::integer,3,
  'post-refund claim still gets a new generation');
select is(current_setting('ragbot_test.claim')::jsonb->>'id',current_setting('ragbot_test.job_id'),
  'post-refund acquisition returns the same job');
select is(current_setting('ragbot_test.claim')::jsonb->>'locked_by','fake-warm-third',
  'post-refund claim assigns its owner');
select throws_ok($q$select public.warm_job_fence(current_setting('ragbot_test.job_id')::uuid,
  'fake-warm-second',2)$q$,'RB013',null,'refunded worker/generation remains fenced');
select is(public.get_warm_job_context(current_setting('ragbot_test.job_id')::uuid,
  'fake-warm-third',3)->>'state','ready','current acquired generation can read context');

do $$ begin
  perform public.complete_job(current_setting('ragbot_test.job_id')::uuid,'fake-warm-third');
end $$;
select is(public.queue_warm_job(current_setting('ragbot_test.bot_id')::uuid)::text,
  current_setting('ragbot_test.job_id'),'terminal version replay reuses its job identity');
select is((select count(*) from public.jobs where type='warm_answer_cache'
  and payload->>'bot_id'=current_setting('ragbot_test.bot_id')),1::bigint,
  'terminal version replay creates no second job');
select is((select state from public.jobs where id=current_setting('ragbot_test.job_id')::uuid),
  'succeeded','completed warming job stays terminal');
reset role;
select ok(not has_column_privilege('anon','public.jobs','warm_generation','SELECT'),
  'anonymous users cannot read warming generation data');

select * from finish();
rollback;
