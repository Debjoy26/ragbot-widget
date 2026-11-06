-- Private storage bucket `knowledge`: exists, not public. Object policies (migration 009) are a census
-- (authenticated only, knowledge only, MFA membership checked) plus negatives with real aal2 claims.
-- The positive upload and download cases, with versions as fixtures, are in 210_admin_documents.
begin;
select plan(27);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'st-owner@example.test'),
  ('a1000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'st-nonmember@example.test'),
  ('a1000000-0000-4000-8000-0000000000b3', 'authenticated', 'authenticated', 'st-analyst@example.test'),
  ('a1000000-0000-4000-8000-0000000000b4', 'authenticated', 'authenticated', 'st-admin@example.test');
insert into public.admin_memberships (user_id, role) values
  ('a1000000-0000-4000-8000-0000000000b1', 'owner'),
  ('a1000000-0000-4000-8000-0000000000b3', 'analyst'),
  ('a1000000-0000-4000-8000-0000000000b4', 'admin');

select is((select count(*)::int from storage.buckets where id = 'knowledge'), 1, 'storage: bucket knowledge exists');
select is((select public from storage.buckets where id = 'knowledge'), false, 'storage: bucket knowledge is NOT public');
select isnt((select file_size_limit from storage.buckets where id = 'knowledge'), null, 'storage: bucket knowledge has a size cap');

-- ---- G-13 census over every policy on storage.objects ----
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and roles <> array['authenticated']::name[]),
  0, 'storage census: every storage.objects policy is to authenticated only (never public, anon or service_role)');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) not ilike '%''knowledge''%'),
  0, 'storage census: every storage.objects policy names the knowledge bucket');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) not ilike '%is_active_member_mfa%'),
  0, 'storage census: every storage.objects policy calls is_active_member_mfa');
select set_eq(
  $q$select cmd::text from pg_policies where schemaname = 'storage' and tablename = 'objects'$q$,
  $q$values ('INSERT'), ('SELECT')$q$,
  'storage census: policies exist for INSERT and SELECT only (no UPDATE or DELETE policy, so no overwrite)');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and permissive <> 'PERMISSIVE'),
  0, 'storage census: no restrictive policy is hiding in the set');

-- An object that exists (inserted by the migration owner as a stand-in for an uploaded original), owned by a
-- version of a live document: members can list only objects that a version of a live document owns.
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000b1', 'st-bot', 'x', array['en'], 'm', 1536);
insert into public.documents (id, bot_id, title) values
  ('d1000000-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-0000000000b1', 'Stored doc');
insert into public.document_versions (document_id, version_number, storage_path, media_type, byte_size, status) values
  ('d1000000-0000-4000-8000-0000000000b1', 1, 'b1000000-0000-4000-8000-0000000000b1/d1000000-0000-4000-8000-0000000000b1/e1000000-0000-4000-8000-0000000000b1/original.txt', 'text/plain', 10, 'ready');
insert into storage.objects (bucket_id, name) values ('knowledge', 'b1000000-0000-4000-8000-0000000000b1/d1000000-0000-4000-8000-0000000000b1/e1000000-0000-4000-8000-0000000000b1/original.txt');
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 1, 'storage: fixture object present');
-- Two more objects that no live document owns: one with no version at all, one whose document is deleted.
insert into public.documents (id, bot_id, title, status, deleted_at) values
  ('d2000000-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-0000000000b1', 'Deleted stored doc', 'deleted', now());
insert into public.document_versions (document_id, version_number, storage_path, media_type, byte_size, status) values
  ('d2000000-0000-4000-8000-0000000000b1', 1, 'b1000000-0000-4000-8000-0000000000b1/d2000000-0000-4000-8000-0000000000b1/e2000000-0000-4000-8000-0000000000b1/original.txt', 'text/plain', 10, 'ready');
insert into storage.objects (bucket_id, name) values ('knowledge', 'b1000000-0000-4000-8000-0000000000b1/d3000000-0000-4000-8000-0000000000b1/e3000000-0000-4000-8000-0000000000b1/original.txt'), ('knowledge', 'b1000000-0000-4000-8000-0000000000b1/d2000000-0000-4000-8000-0000000000b1/e2000000-0000-4000-8000-0000000000b1/original.txt');
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 3, 'storage: three fixture objects (one live, one orphan, one of a deleted document)');

-- anon
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'anon: cannot see objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'anon: cannot upload to knowledge');
select is((select count(*)::int from storage.buckets where id = 'knowledge'), 0, 'anon: cannot see the knowledge bucket row');
reset role;

-- authenticated nonmember, even at aal2
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b2","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'nonmember (aal2): cannot see objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'nonmember (aal2): cannot upload to knowledge');
reset role;

-- analyst at aal2: reads metadata elsewhere, but has no Storage access
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b3","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'analyst (aal2): cannot see objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'analyst (aal2): cannot upload to knowledge');
reset role;

-- owner at aal1: a password-only session has no Storage access
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b1","aal":"aal1","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'owner (aal1): cannot see objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'owner (aal1): cannot upload to knowledge');
reset role;

-- owner at aal2: may read, but cannot write to an unregistered path, overwrite, update or delete
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b1","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 1, 'owner (aal2): lists only the object a live document owns (the orphan and the deleted document''s original are hidden)');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'owner (aal2): cannot upload to a path no pending version owns');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b1000000-0000-4000-8000-0000000000b1/d1000000-0000-4000-8000-0000000000b1/e1000000-0000-4000-8000-0000000000b1/original.txt')$q$, '42501', null, 'owner (aal2): cannot overwrite an existing original');
select throws_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, '42501', 'Direct deletion from storage tables is not allowed. Use the Storage API instead.', 'owner (aal2): cannot delete originals (the storage delete guard raises 42501 before any policy is consulted)');
select lives_ok($q$update storage.objects set name = 'b1000000-0000-4000-8000-0000000000b1/d1000000-0000-4000-8000-0000000000b1/e1000000-0000-4000-8000-0000000000b1/renamed.txt' where bucket_id = 'knowledge'$q$,
  'owner (aal2): an update statement runs but matches no row (no UPDATE policy)');
reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge' and name = 'b1000000-0000-4000-8000-0000000000b1/d1000000-0000-4000-8000-0000000000b1/e1000000-0000-4000-8000-0000000000b1/original.txt'), 1,
  'owner (aal2): delete and update from a browser session left the original intact');
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge' and name in ('b1000000-0000-4000-8000-0000000000b1/d3000000-0000-4000-8000-0000000000b1/e3000000-0000-4000-8000-0000000000b1/original.txt', 'b1000000-0000-4000-8000-0000000000b1/d2000000-0000-4000-8000-0000000000b1/e2000000-0000-4000-8000-0000000000b1/original.txt')), 2,
  'the two objects no live document owns still exist (hidden from members, not removed)');

-- admin at aal2 reads too
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b4","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 1, 'admin (aal2): lists only the object a live document owns');
reset role;

select * from finish();
rollback;
