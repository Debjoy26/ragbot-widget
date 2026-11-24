-- ADR 0022: widget keys + subscription gate. Real grants/transitions, no providers.
-- Synthetic rows contained in transaction and rolled back.
begin;
set local lock_timeout = '2s';
select plan(18);

select has_table('public','widget_keys','widget keys table exists');
select has_table('public','subscription_state','subscription cache table exists');
select has_column('public','widget_keys','key_fingerprint','fingerprint column, never raw key');
select has_column('public','subscription_state','status','subscription status column');

select is(has_function_privilege(r.role_name,f.signature,'EXECUTE'),
  r.role_name='service_role',
  r.role_name || ' execute matches auto-provision contract: ' || f.signature)
from (values
  ('public.resolve_widget_key(text,text)'),
  ('public.require_active_subscription(uuid)'),
  ('public.sync_subscription_status(uuid,text,bigint)')
) f(signature)
cross join (values('anon'),('authenticated'),('service_role')) r(role_name);

select ok(not p.prosecdef and exists(select 1 from unnest(p.proconfig) c
  where c in ('search_path=""','search_path=')),
  'provisioning functions are invoker with fixed empty search path')
from (values
  ('public.resolve_widget_key(text,text)'),
  ('public.require_active_subscription(uuid)'),
  ('public.sync_subscription_status(uuid,text,bigint)')
) f(signature) join pg_proc p on p.oid=to_regprocedure(f.signature);

select * from finish();
rollback;
