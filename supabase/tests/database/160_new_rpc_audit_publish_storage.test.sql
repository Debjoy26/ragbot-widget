-- P3-D1: service-only denial for the new RPCs per actor + audit_logs append-only (L1) + published public
-- config (L5) + storage MIME allow-list (L13) + default function privileges (L4). Partly GENERATED.
begin;
select plan(63);

insert into auth.users (id, aud, role, email) values
  ('f1000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'x-owner@example.test'),
  ('f1000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'x-admin@example.test'),
  ('f1000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'x-analyst@example.test'),
  ('f1000000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'x-nonmember@example.test'),
  ('f1000000-0000-4000-8000-0000000000a5', 'authenticated', 'authenticated', 'x-actor@example.test');
insert into public.admin_memberships (user_id, role) values
  ('f1000000-0000-4000-8000-0000000000a1', 'owner'),
  ('f1000000-0000-4000-8000-0000000000a2', 'admin'),
  ('f1000000-0000-4000-8000-0000000000a3', 'analyst');


-- ===== anon: new service-only RPCs must be permission denied =====
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.begin_request_run(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '42501', null, 'anon: begin_request_run -> permission denied (service role only)');
select throws_ok($q$select public.complete_job(gen_random_uuid(), 'w')$q$, '42501', null, 'anon: complete_job -> permission denied (service role only)');
select throws_ok($q$select public.fail_job(gen_random_uuid(), 'w', 'e')$q$, '42501', null, 'anon: fail_job -> permission denied (service role only)');
select throws_ok($q$select public.heartbeat_job(gen_random_uuid(), 'w', 60)$q$, '42501', null, 'anon: heartbeat_job -> permission denied (service role only)');
select throws_ok($q$select public.purge_expired_data_entries(10)$q$, '42501', null, 'anon: purge_expired_data_entries -> permission denied (service role only)');
reset role;

-- ===== nonmember: new service-only RPCs must be permission denied =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-0000000000a4","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.begin_request_run(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '42501', null, 'nonmember: begin_request_run -> permission denied (service role only)');
select throws_ok($q$select public.complete_job(gen_random_uuid(), 'w')$q$, '42501', null, 'nonmember: complete_job -> permission denied (service role only)');
select throws_ok($q$select public.fail_job(gen_random_uuid(), 'w', 'e')$q$, '42501', null, 'nonmember: fail_job -> permission denied (service role only)');
select throws_ok($q$select public.heartbeat_job(gen_random_uuid(), 'w', 60)$q$, '42501', null, 'nonmember: heartbeat_job -> permission denied (service role only)');
select throws_ok($q$select public.purge_expired_data_entries(10)$q$, '42501', null, 'nonmember: purge_expired_data_entries -> permission denied (service role only)');
reset role;

-- ===== analyst: new service-only RPCs must be permission denied =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-0000000000a3","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.begin_request_run(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '42501', null, 'analyst: begin_request_run -> permission denied (service role only)');
select throws_ok($q$select public.complete_job(gen_random_uuid(), 'w')$q$, '42501', null, 'analyst: complete_job -> permission denied (service role only)');
select throws_ok($q$select public.fail_job(gen_random_uuid(), 'w', 'e')$q$, '42501', null, 'analyst: fail_job -> permission denied (service role only)');
select throws_ok($q$select public.heartbeat_job(gen_random_uuid(), 'w', 60)$q$, '42501', null, 'analyst: heartbeat_job -> permission denied (service role only)');
select throws_ok($q$select public.purge_expired_data_entries(10)$q$, '42501', null, 'analyst: purge_expired_data_entries -> permission denied (service role only)');
reset role;

-- ===== admin: new service-only RPCs must be permission denied =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-0000000000a2","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.begin_request_run(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '42501', null, 'admin: begin_request_run -> permission denied (service role only)');
select throws_ok($q$select public.complete_job(gen_random_uuid(), 'w')$q$, '42501', null, 'admin: complete_job -> permission denied (service role only)');
select throws_ok($q$select public.fail_job(gen_random_uuid(), 'w', 'e')$q$, '42501', null, 'admin: fail_job -> permission denied (service role only)');
select throws_ok($q$select public.heartbeat_job(gen_random_uuid(), 'w', 60)$q$, '42501', null, 'admin: heartbeat_job -> permission denied (service role only)');
select throws_ok($q$select public.purge_expired_data_entries(10)$q$, '42501', null, 'admin: purge_expired_data_entries -> permission denied (service role only)');
reset role;

-- ===== owner: new service-only RPCs must be permission denied =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-0000000000a1","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.begin_request_run(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000001', repeat('a', 64))$q$, '42501', null, 'owner: begin_request_run -> permission denied (service role only)');
select throws_ok($q$select public.complete_job(gen_random_uuid(), 'w')$q$, '42501', null, 'owner: complete_job -> permission denied (service role only)');
select throws_ok($q$select public.fail_job(gen_random_uuid(), 'w', 'e')$q$, '42501', null, 'owner: fail_job -> permission denied (service role only)');
select throws_ok($q$select public.heartbeat_job(gen_random_uuid(), 'w', 60)$q$, '42501', null, 'owner: heartbeat_job -> permission denied (service role only)');
select throws_ok($q$select public.purge_expired_data_entries(10)$q$, '42501', null, 'owner: purge_expired_data_entries -> permission denied (service role only)');
reset role;

-- ===== catalog: EXECUTE for service_role only =====
select ok(has_function_privilege('service_role', 'public.begin_request_run(uuid, uuid, text, text)', 'EXECUTE'), 'service_role: EXECUTE on begin_request_run');
select ok(not has_function_privilege('anon', 'public.begin_request_run(uuid, uuid, text, text)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.begin_request_run(uuid, uuid, text, text)', 'EXECUTE') and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.begin_request_run(uuid, uuid, text, text)'::regprocedure and a.grantee = 0), 'catalog: anon/authenticated/PUBLIC cannot EXECUTE begin_request_run');
select ok(has_function_privilege('service_role', 'public.complete_job(uuid, text)', 'EXECUTE'), 'service_role: EXECUTE on complete_job');
select ok(not has_function_privilege('anon', 'public.complete_job(uuid, text)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.complete_job(uuid, text)', 'EXECUTE') and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.complete_job(uuid, text)'::regprocedure and a.grantee = 0), 'catalog: anon/authenticated/PUBLIC cannot EXECUTE complete_job');
select ok(has_function_privilege('service_role', 'public.fail_job(uuid, text, text)', 'EXECUTE'), 'service_role: EXECUTE on fail_job');
select ok(not has_function_privilege('anon', 'public.fail_job(uuid, text, text)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.fail_job(uuid, text, text)', 'EXECUTE') and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.fail_job(uuid, text, text)'::regprocedure and a.grantee = 0), 'catalog: anon/authenticated/PUBLIC cannot EXECUTE fail_job');
select ok(has_function_privilege('service_role', 'public.heartbeat_job(uuid, text, integer)', 'EXECUTE'), 'service_role: EXECUTE on heartbeat_job');
select ok(not has_function_privilege('anon', 'public.heartbeat_job(uuid, text, integer)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.heartbeat_job(uuid, text, integer)', 'EXECUTE') and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.heartbeat_job(uuid, text, integer)'::regprocedure and a.grantee = 0), 'catalog: anon/authenticated/PUBLIC cannot EXECUTE heartbeat_job');
select ok(has_function_privilege('service_role', 'public.purge_expired_data_entries(integer)', 'EXECUTE'), 'service_role: EXECUTE on purge_expired_data_entries');
select ok(not has_function_privilege('anon', 'public.purge_expired_data_entries(integer)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.purge_expired_data_entries(integer)', 'EXECUTE') and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.purge_expired_data_entries(integer)'::regprocedure and a.grantee = 0), 'catalog: anon/authenticated/PUBLIC cannot EXECUTE purge_expired_data_entries');

-- ===== L1: audit_logs is append-only =====
insert into public.audit_logs (id, actor_user_id, action, resource_type, safe_metadata) values
  ('a0d17000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a5', 'fixture', 'test', '{}'::jsonb);
-- Even the table owner (postgres, BYPASSRLS) is stopped by the trigger.

select throws_ok($q$update public.audit_logs set action = 'tampered' where id = 'a0d17000-0000-4000-8000-000000000001'$q$, '42501', null, 'audit_logs (L1): owner UPDATE blocked by trigger');
select throws_ok($q$delete from public.audit_logs where id = 'a0d17000-0000-4000-8000-000000000001'$q$, '42501', null, 'audit_logs (L1): owner DELETE blocked by trigger');
select throws_ok($q$update public.audit_logs set actor_user_id = 'f1000000-0000-4000-8000-0000000000a1' where id = 'a0d17000-0000-4000-8000-000000000001'$q$, '42501', null, 'audit_logs (L1): re-attributing the actor is blocked');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($q$insert into public.audit_logs (action, resource_type) values ('append', 'test')$q$, 'audit_logs (L1): service_role can INSERT');
select cmp_ok((select count(*) from public.audit_logs)::int, '>=', 2, 'audit_logs (L1): service_role can SELECT');
select throws_ok($q$update public.audit_logs set action = 'tampered'$q$, '42501', null, 'audit_logs (L1): service_role UPDATE -> permission denied');
select throws_ok($q$delete from public.audit_logs$q$, '42501', null, 'audit_logs (L1): service_role DELETE -> permission denied');
select throws_ok($q$truncate public.audit_logs$q$, '42501', null, 'audit_logs (L1): service_role TRUNCATE -> permission denied');
reset role;
select lives_ok($q$delete from auth.users where id = 'f1000000-0000-4000-8000-0000000000a5'$q$, 'audit_logs (L1): deleting an auth user still works (FK set-null is the one permitted change)');
select is((select actor_user_id from public.audit_logs where id = 'a0d17000-0000-4000-8000-000000000001'), null, 'audit_logs (L1): the actor reference was nulled, the row kept');
select is((select action from public.audit_logs where id = 'a0d17000-0000-4000-8000-000000000001'), 'fixture', 'audit_logs (L1): nothing else in the row changed');

-- ===== L5: public_bot_config exposes only enabled bots =====
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions, enabled) values
  ('b1000000-0000-4000-8000-0000000000a1', 'p-on', 'x', array['en'], 'm', 1536, true),
  ('b2000000-0000-4000-8000-0000000000a2', 'p-off', 'x', array['en'], 'm', 1536, false);
insert into public.public_bot_config (bot_id, bot_slug, display_name, supported_languages) values
  ('b1000000-0000-4000-8000-0000000000a1', 'p-on', 'On', array['en']),
  ('b2000000-0000-4000-8000-0000000000a2', 'p-off', 'Off', array['en']);

select is((select is_published from public.public_bot_config where bot_slug = 'p-on'), true, 'published (L5): config of an enabled bot is published');
select is((select is_published from public.public_bot_config where bot_slug = 'p-off'), false, 'published (L5): config of a disabled bot is not published');
select is((select is_published from public.public_bot_config where bot_slug = 'dev-bot'), true, 'published (L5): the seeded dev bot config is published');
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'public_bot_config' and column_name = 'is_published'), 'false', 'published (L5): is_published defaults to false');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.public_bot_config where bot_slug = 'p-on'), 1, 'published (L5): anon sees the enabled bot config');
select is((select count(*)::int from public.public_bot_config where bot_slug = 'p-off'), 0, 'published (L5): anon does NOT see the disabled bot config');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-0000000000a4","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.public_bot_config where bot_slug = 'p-off'), 0, 'published (L5): an authenticated nonmember does not see the disabled bot config either');
reset role;
update public.public_bot_config set is_published = true where bot_slug = 'p-off';
select is((select is_published from public.public_bot_config where bot_slug = 'p-off'), false, 'published (L5): is_published cannot be forced on for a disabled bot (UPDATE)');
update public.bot_profiles set enabled = true where slug = 'p-off';
select is((select is_published from public.public_bot_config where bot_slug = 'p-off'), true, 'published (L5): enabling the bot publishes its config in the same transaction');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.public_bot_config where bot_slug = 'p-off'), 1, 'published (L5): anon now sees it');
reset role;
update public.bot_profiles set enabled = false where slug = 'p-on';
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.public_bot_config where bot_slug = 'p-on'), 0, 'published (L5): disabling a bot hides its config at once');
reset role;
select throws_ok($q$insert into public.public_bot_config (bot_id, bot_slug, display_name, supported_languages) values ('00000000-0000-4000-8000-00000000dead', 'ghost', 'G', array['en'])$q$, '23503', null, 'published (L5): config for an unknown bot is still rejected (FK)');

-- ===== L13: knowledge bucket MIME allow-list =====
select set_eq($q$select unnest(allowed_mime_types) from storage.buckets where id = 'knowledge'$q$, $q$values ('application/pdf'), ('text/markdown'), ('text/plain')$q$, 'storage (L13): bucket allows exactly pdf, markdown and plain text');
select is((select count(*)::int from storage.buckets where id = 'knowledge' and allowed_mime_types is null), 0, 'storage (L13): the allow-list is not null (null would allow every type)');

-- ===== L4: default function privileges =====
select is((select count(*)::int from pg_default_acl d, lateral aclexplode(d.defaclacl) a where d.defaclrole = (select oid from pg_roles where rolname = 'postgres') and d.defaclnamespace = 0 and d.defaclobjtype = 'f' and a.grantee = 0), 0, 'default privileges (L4): global default ACL for postgres-created functions does not grant PUBLIC');
create function public.tests_l4_probe() returns integer language sql as 'select 1';
select is((select count(*)::int from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname = 'tests_l4_probe' and a.grantee = 0), 0, 'default privileges (L4): a function created later is not executable by PUBLIC');
select ok(not has_function_privilege('anon', 'public.tests_l4_probe()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.tests_l4_probe()', 'EXECUTE'), 'default privileges (L4): a function created later is not executable by anon/authenticated');

select * from finish();
rollback;
