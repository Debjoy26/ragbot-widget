-- Private storage bucket `knowledge`: exists, not public, no browser-role object access.
begin;
select plan(15);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'st-owner@example.test'),
  ('a1000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'st-nonmember@example.test');
insert into public.admin_memberships (user_id, role) values ('a1000000-0000-4000-8000-0000000000b1', 'owner');

select is((select count(*)::int from storage.buckets where id = 'knowledge'), 1, 'storage: bucket knowledge exists');
select is((select public from storage.buckets where id = 'knowledge'), false, 'storage: bucket knowledge is NOT public');
select isnt((select file_size_limit from storage.buckets where id = 'knowledge'), null, 'storage: bucket knowledge has a size cap');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ilike '%knowledge%' or coalesce(with_check, '') ilike '%knowledge%')),
  0, 'storage: no object policy grants any role access to the knowledge bucket (API signs URLs)');

-- An object that exists (inserted by the migration owner as a stand-in for an uploaded original).
insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/original.txt');
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 1, 'storage: fixture object present');

-- anon
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'anon: cannot see objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'anon: cannot upload to knowledge');
select is((select count(*)::int from storage.buckets where id = 'knowledge'), 0, 'anon: cannot see the knowledge bucket row');
reset role;

-- authenticated nonmember
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'nonmember: cannot see objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'nonmember: cannot upload to knowledge');
reset role;

-- owner (browser role, even a privileged admin, has no direct object access)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'owner: browser session cannot list objects in knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/evil.txt')$q$, '42501', null, 'owner: browser session cannot upload to knowledge');
select throws_ok($q$insert into storage.objects (bucket_id, name) values ('knowledge', 'b/d/v/original.txt')$q$, '42501', null, 'owner: browser session cannot overwrite an existing original');
select throws_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, null::char(5), null::text, 'owner: browser session cannot delete originals (storage delete protection / no policy)');
update storage.objects set name = 'b/d/v/renamed.txt' where bucket_id = 'knowledge';
reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge' and name = 'b/d/v/original.txt'), 1,
  'owner: delete/update from a browser session left the original intact');

select * from finish();
rollback;
