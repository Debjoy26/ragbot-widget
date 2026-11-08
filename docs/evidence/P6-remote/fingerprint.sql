-- Catalog fingerprint (read-only): grants, column privileges, policies, functions, triggers, constraints, indexes, columns.
with t as (select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role','PUBLIC') group by 1,2),
c as (select grantee, table_name, column_name, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.column_privileges where table_schema='public' and grantee in ('anon','authenticated') group by 1,2,3),
pol as (select tablename, policyname, cmd, roles::text r, coalesce(qual,'') q, coalesce(with_check,'') w, permissive from pg_policies where schemaname in ('public','storage')),
f as (select p.oid::regprocedure::text sig, p.prosecdef::text prosecdef, p.provolatile::text provolatile, coalesce(array_to_string(p.proconfig,','),'') cfg, md5(p.prosrc) src, has_function_privilege('anon',p.oid,'execute')::text a, has_function_privilege('authenticated',p.oid,'execute')::text au, has_function_privilege('service_role',p.oid,'execute')::text sr from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')),
tr as (select c.relname, g.tgname, pg_get_triggerdef(g.oid) d, g.tgenabled::text tgenabled from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not g.tgisinternal),
co as (select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace='public'::regnamespace),
ix as (select tablename, indexname, indexdef from pg_indexes where schemaname='public'),
cl as (select table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default,'') dflt from information_schema.columns where table_schema='public')
select json_build_object(
 'table_grants',(select md5(string_agg(grantee||table_name||p,'|' order by grantee,table_name)) from t),
 'col_grants',(select md5(coalesce(string_agg(grantee||table_name||column_name||p,'|' order by grantee,table_name,column_name),'')) from c),
 'policies',(select md5(string_agg(tablename||policyname||cmd||r||q||w||permissive,'|' order by tablename,policyname)) from pol),
 'functions',(select md5(string_agg(sig||prosecdef||provolatile||cfg||src||a||au||sr,'|' order by sig)) from f),
 'triggers',(select md5(string_agg(relname||tgname||d||tgenabled,'|' order by relname,tgname)) from tr),
 'constraints',(select md5(string_agg(t||conname||d,'|' order by t,conname)) from co),
 'indexes',(select md5(string_agg(indexname||indexdef,'|' order by indexname)) from ix),
 'columns',(select md5(string_agg(table_name||column_name||data_type||udt_name||is_nullable||dflt,'|' order by table_name,column_name)) from cl),
 'n',json_build_object('t',(select count(*) from t),'c',(select count(*) from c),'pol',(select count(*) from pol),'f',(select count(*) from f),'tr',(select count(*) from tr),'co',(select count(*) from co),'ix',(select count(*) from ix),'cl',(select count(*) from cl))) as fp;
