begin;
select plan(10);
select ok(has_function_privilege('service_role', signature, 'EXECUTE')
          and not has_function_privilege('anon', signature, 'EXECUTE')
          and not has_function_privilege('authenticated', signature, 'EXECUTE'),
          'analysis API is service-role only: ' || signature)
from (values
 ('public.analysis_job_fence(uuid,text,integer)'),
 ('public.get_analysis_job_context(uuid,text,integer)'),
 ('public.reserve_analysis_budget(uuid,text,integer,numeric,integer)'),
 ('public.record_analysis_usage(uuid,integer,uuid,text,text,integer,integer,numeric,integer)'),
 ('public.settle_analysis_budget(uuid,text,integer,uuid,numeric)'),
 ('public.save_analysis_job_result(uuid,text,integer,text,text,text,text)'),
 ('public.fail_analysis_job(uuid,text,integer)'),
 ('public.settle_orphaned_analysis_reservations(integer)')
) f(signature);
select ok((select bool_and(not p.prosecdef and 'lock_timeout=2s' = any(p.proconfig)
  and exists(select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path=')))
  from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('analysis_job_fence','get_analysis_job_context','reserve_analysis_budget','record_analysis_usage',
    'settle_analysis_budget','save_analysis_job_result','fail_analysis_job','settle_orphaned_analysis_reservations')),
  'analysis APIs are invoker functions with bounded locks and empty search paths');
select is(public.schema_version(), 27, 'schema version 27');
select * from finish();
rollback;
