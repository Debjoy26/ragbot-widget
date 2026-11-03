-- Membership semantics: authenticated != admin (handover §4.4); revocation is immediate (no caching).
begin;
select plan(31);

-- Fixtures (as the migration owner).
insert into auth.users (id, aud, role, email) values
  ('a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'm-analyst@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'm-admin@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'm-owner@example.test'),
  ('a0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'm-inactive@example.test'),
  ('a0000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'm-unknownrole@example.test'),
  ('a0000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'm-nonmember@example.test');
insert into public.admin_memberships (user_id, role, active) values
  ('a0000000-0000-4000-8000-000000000001', 'analyst', true),
  ('a0000000-0000-4000-8000-000000000002', 'admin', true),
  ('a0000000-0000-4000-8000-000000000003', 'owner', true),
  ('a0000000-0000-4000-8000-000000000004', 'admin', false);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions)
values ('b0000000-0000-4000-8000-000000000001', 'm-bot', 'x', array['en'], 'm', 1536);
insert into public.documents (id, bot_id, title) values ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Doc');

-- Constraint: unknown role cannot even be stored.
select throws_ok(
  $q$insert into public.admin_memberships (user_id, role) values ('a0000000-0000-4000-8000-000000000005', 'superuser')$q$,
  '23514', null, 'admin_memberships.role CHECK rejects an unknown role');

-- Simulate a corrupted row with an unknown role by dropping the CHECK inside this (rolled back) transaction.
alter table public.admin_memberships drop constraint admin_memberships_role_check;
insert into public.admin_memberships (user_id, role, active) values ('a0000000-0000-4000-8000-000000000005', 'superuser', true);

-- ---- helper-function behaviour as each user ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.is_active_member(array['analyst']), true, 'analyst: is_active_member([analyst]) = true');
select is(public.is_active_member(array['owner', 'admin']), false, 'analyst: is_active_member([owner,admin]) = false');
select cmp_ok((select count(*) from public.documents)::int, '>=', 1, 'analyst can read documents');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.is_active_member(array['owner', 'admin']), true, 'admin: is_active_member([owner,admin]) = true');
select is(public.is_active_member(array['owner']), false, 'admin: is_active_member([owner]) = false');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.is_active_member(array['owner']), true, 'owner: is_active_member([owner]) = true');
select is(public.is_active_member(array[]::text[]), false, 'owner: empty role list = false');
select is(public.is_active_member(null), false, 'owner: null role list = false (fail closed)');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select is(public.is_active_member(array['owner', 'admin', 'analyst']), false, 'authenticated nonmember: is_active_member = false');
select is((select count(*) from public.documents)::int, 0, 'authenticated nonmember sees no documents');

-- No JWT subject at all.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is(public.is_active_member(array['owner', 'admin', 'analyst']), false, 'authenticated without sub: is_active_member = false');
select is((select count(*) from public.documents)::int, 0, 'authenticated without sub sees no documents');

-- Inactive member.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is(public.is_active_member(array['owner', 'admin', 'analyst']), false, 'inactive member: is_active_member = false');
select is((select count(*) from public.documents)::int, 0, 'inactive member sees no documents');
select throws_ok('select * from public.job_status_summary()', '42501', null, 'inactive member: job_status_summary denied');
select throws_ok('select * from public.knowledge_gaps(current_date - 1, current_date, 10)', '42501', null, 'inactive member: knowledge_gaps denied');
select throws_ok('select * from public.usage_daily_summary(current_date - 1, current_date)', '42501', null, 'inactive member: usage_daily_summary denied');

-- Unknown-role member (row corrupted above): not in any allowed role list.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select is(public.is_active_member(array['owner', 'admin', 'analyst']), false, 'unknown-role member: is_active_member = false');
select is((select count(*) from public.documents)::int, 0, 'unknown-role member sees no documents');
select throws_ok('select * from public.job_status_summary()', '42501', null, 'unknown-role member: job_status_summary denied');

-- anon cannot even call the helper.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok('select public.is_active_member(array[''owner''])', '42501', null, 'anon: is_active_member EXECUTE denied');

-- ---- Revocation takes effect immediately (same transaction, same role, same JWT claims) ----
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select cmp_ok((select count(*) from public.documents)::int, '>=', 1, 'revocation: active admin reads documents');
select is((select count(*) from public.job_status_summary())::int, 0, 'revocation: active admin can call job_status_summary (no jobs yet)');

reset role;
update public.admin_memberships set active = false where user_id = 'a0000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.documents)::int, 0, 'revocation: same session, active=false -> documents hidden immediately');
select throws_ok('select * from public.job_status_summary()', '42501', null, 'revocation: same session, active=false -> RPC denied immediately');

reset role;
update public.admin_memberships set active = true where user_id = 'a0000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select cmp_ok((select count(*) from public.documents)::int, '>=', 1, 'revocation: re-activation is also immediate');

-- Deleting the membership row is equally immediate.
reset role;
delete from public.admin_memberships where user_id = 'a0000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.documents)::int, 0, 'revocation: deleted membership row -> documents hidden immediately');

-- Downgrade analyst -> demoted role takes effect immediately for admin-only data.
reset role;
insert into public.audit_logs (action, resource_type) values ('fixture', 'test');
insert into public.data_entries (bot_id, schema_key, payload) values ('b0000000-0000-4000-8000-000000000001', 'k', '{}'::jsonb);
update public.admin_memberships set role = 'admin' where user_id = 'a0000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select cmp_ok((select count(*) from public.data_entries)::int, '>=', 1, 'role change: analyst promoted to admin reads data_entries at once');
reset role;
update public.admin_memberships set role = 'analyst' where user_id = 'a0000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.data_entries)::int, 0, 'role change: admin demoted to analyst loses data_entries at once');
select is((select count(*) from public.audit_logs)::int, 0, 'role change: analyst cannot read audit_logs');

reset role;
select * from finish();
rollback;
