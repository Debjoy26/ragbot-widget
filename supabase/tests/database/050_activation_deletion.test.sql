-- activate_document_version atomicity + corpus_version, mark_document_deleted.
begin;
select plan(36);

create schema tests;
grant usage on schema tests to public;
create function tests.unit_vec(i integer) returns extensions.vector
language sql immutable as $$
  select (array_agg(case when g = i then 1.0 else 0.0 end order by g))::real[]::extensions.vector
  from generate_series(1, 1536) g
$$;

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000c1', 'a-bot1', 'x', array['en'], 'm', 1536);
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('d1000000-0000-4000-8000-0000000000c1', 'b1000000-0000-4000-8000-0000000000c1', 'Doc', 'ready', 'public_answer'),
  ('d2000000-0000-4000-8000-0000000000c2', 'b1000000-0000-4000-8000-0000000000c1', 'Other doc', 'indexing', 'public_answer');

-- v1: currently active (ready, 2 chunks). v2: candidate (embedding, 2 chunks).
-- v3: candidate with only 1 of 2 expected chunks. v4: candidate with a gap in chunk indexes.
-- v5: still 'uploaded'. vo: version of ANOTHER document.
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, status) values
  ('e1000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-0000000000c1', 1, 'a/v1', 'text/plain', 'ready'),
  ('e2000000-0000-4000-8000-0000000000c2', 'd1000000-0000-4000-8000-0000000000c1', 2, 'a/v2', 'text/plain', 'embedding'),
  ('e3000000-0000-4000-8000-0000000000c3', 'd1000000-0000-4000-8000-0000000000c1', 3, 'a/v3', 'text/plain', 'embedding'),
  ('e4000000-0000-4000-8000-0000000000c4', 'd1000000-0000-4000-8000-0000000000c1', 4, 'a/v4', 'text/plain', 'embedding'),
  ('e5000000-0000-4000-8000-0000000000c5', 'd1000000-0000-4000-8000-0000000000c1', 5, 'a/v5', 'text/plain', 'uploaded'),
  ('e6000000-0000-4000-8000-0000000000c6', 'd2000000-0000-4000-8000-0000000000c2', 1, 'a/vo', 'text/plain', 'embedding');
update public.documents set active_version_id = 'e1000000-0000-4000-8000-0000000000c1' where id = 'd1000000-0000-4000-8000-0000000000c1';

insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('e1000000-0000-4000-8000-0000000000c1', 0, 'v1-c0', tests.unit_vec(1)),
  ('e1000000-0000-4000-8000-0000000000c1', 1, 'v1-c1', tests.unit_vec(1)),
  ('e2000000-0000-4000-8000-0000000000c2', 0, 'v2-c0', tests.unit_vec(1)),
  ('e2000000-0000-4000-8000-0000000000c2', 1, 'v2-c1', tests.unit_vec(1)),
  ('e3000000-0000-4000-8000-0000000000c3', 0, 'v3-c0', tests.unit_vec(1)),
  ('e4000000-0000-4000-8000-0000000000c4', 0, 'v4-c0', tests.unit_vec(1)),
  ('e4000000-0000-4000-8000-0000000000c4', 2, 'v4-c2', tests.unit_vec(1)),
  ('e6000000-0000-4000-8000-0000000000c6', 0, 'vo-c0', tests.unit_vec(1));

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---- Failures leave the previous version active and corpus_version untouched ----
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e3000000-0000-4000-8000-0000000000c3', 2)$q$,
  'RB011', null, 'activate: chunk count mismatch (1 of 2) is rejected');
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e4000000-0000-4000-8000-0000000000c4', 2)$q$,
  'RB011', null, 'activate: non-contiguous chunk indexes are rejected');
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e5000000-0000-4000-8000-0000000000c5', 1)$q$,
  'RB011', null, 'activate: a version that is not in status embedding is rejected');
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e6000000-0000-4000-8000-0000000000c6', 1)$q$,
  'RB010', null, 'activate: a version of a different document is rejected');
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-0000000000c2', 3)$q$,
  'RB011', null, 'activate: expected count larger than actual is rejected');
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-0000000000c2', 0)$q$,
  '22023', null, 'activate: expected count 0 rejected');
select throws_ok(
  $q$select public.activate_document_version('00000000-0000-4000-8000-00000000dead', 'e2000000-0000-4000-8000-0000000000c2', 2)$q$,
  'RB010', null, 'activate: unknown document is rejected');

select is(
  (select active_version_id from public.documents where id = 'd1000000-0000-4000-8000-0000000000c1'),
  'e1000000-0000-4000-8000-0000000000c1'::uuid, 'after failed activations the previous version is still active');
select is(
  (select status from public.document_versions where id = 'e1000000-0000-4000-8000-0000000000c1'),
  'ready', 'after failed activations the previous version is still ready (not superseded)');
select is(
  (select status from public.document_versions where id = 'e2000000-0000-4000-8000-0000000000c2'),
  'embedding', 'after failed activations the candidate version is unchanged');
select is(
  (select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000c1'),
  0::bigint, 'after failed activations corpus_version is unchanged');

-- ---- Atomicity under a mid-flight failure: a trigger aborts the pointer update AFTER the
--      function has already superseded the old version / readied the new one in the same txn. ----
reset role;
create function tests.poison() returns trigger language plpgsql as $$
begin
  if new.active_version_id = 'e2000000-0000-4000-8000-0000000000c2' then
    raise exception 'poisoned pointer update' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger poison before update on public.documents for each row execute function tests.poison();
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-0000000000c2', 2)$q$,
  'P0001', 'poisoned pointer update', 'activate: failure in the middle of the switch raises');
select is(
  (select active_version_id from public.documents where id = 'd1000000-0000-4000-8000-0000000000c1'),
  'e1000000-0000-4000-8000-0000000000c1'::uuid, 'atomic: mid-flight failure leaves the previous version active');
select is(
  (select status from public.document_versions where id = 'e1000000-0000-4000-8000-0000000000c1'),
  'ready', 'atomic: mid-flight failure did not leave the previous version superseded');
select is(
  (select status from public.document_versions where id = 'e2000000-0000-4000-8000-0000000000c2'),
  'embedding', 'atomic: mid-flight failure did not leave the candidate half-activated');
select is(
  (select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000c1'),
  0::bigint, 'atomic: mid-flight failure did not bump corpus_version');

reset role;
drop trigger poison on public.documents;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---- Success path ----
select is(
  public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-0000000000c2', 2),
  1::bigint, 'activate: success returns incremented corpus_version (1)');
select is(
  (select active_version_id from public.documents where id = 'd1000000-0000-4000-8000-0000000000c1'),
  'e2000000-0000-4000-8000-0000000000c2'::uuid, 'activate: pointer switched to the new version');
select is(
  (select status from public.document_versions where id = 'e1000000-0000-4000-8000-0000000000c1'),
  'superseded', 'activate: previous version is superseded');
select is(
  (select status from public.document_versions where id = 'e2000000-0000-4000-8000-0000000000c2'),
  'ready', 'activate: new version is ready');
select isnt(
  (select completed_at from public.document_versions where id = 'e2000000-0000-4000-8000-0000000000c2'),
  null, 'activate: new version has completed_at');
select is(
  (select status from public.documents where id = 'd1000000-0000-4000-8000-0000000000c1'),
  'ready', 'activate: document status ready');
select is(
  (select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000c1'),
  1::bigint, 'activate: bot_profiles.corpus_version incremented exactly once');
select results_eq(
  $q$select content from public.match_document_chunks('b1000000-0000-4000-8000-0000000000c1', tests.unit_vec(1), 10) order by content$q$,
  $q$values ('v2-c0'::text), ('v2-c1'::text)$q$,
  'activate: retrieval now serves only the new version (old chunks excluded)');
select is(
  public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-0000000000c2', 2),
  1::bigint, 'activate: re-activating the active version is idempotent (no second bump)');
select is(
  (select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000c1'),
  1::bigint, 'activate: idempotent retry did not bump corpus_version');

-- First activation of a brand-new document (no previous active version).
select is(
  public.activate_document_version('d2000000-0000-4000-8000-0000000000c2', 'e6000000-0000-4000-8000-0000000000c6', 1),
  2::bigint, 'activate: first version of a new document activates and bumps corpus_version (2)');

-- ---- mark_document_deleted ----
select is(
  public.mark_document_deleted('d1000000-0000-4000-8000-0000000000c1', 4),
  3::bigint, 'mark_document_deleted: bumps corpus_version (3)');
select is(
  (select status || ':' || (deleted_at is not null)::text from public.documents where id = 'd1000000-0000-4000-8000-0000000000c1'),
  'deleted:true', 'mark_document_deleted: status deleted and deleted_at set');
select is(
  (select count(*)::int from public.match_document_chunks('b1000000-0000-4000-8000-0000000000c1', tests.unit_vec(1), 10) where content like 'v1%' or content like 'v2%'),
  0, 'mark_document_deleted: deleted document no longer retrievable');
select is(
  (select count(*)::int from public.jobs where type = 'cleanup' and dedupe_key = 'cleanup:document:d1000000-0000-4000-8000-0000000000c1' and max_attempts = 4 and state = 'queued'),
  1, 'mark_document_deleted: one queued cleanup job enqueued');
select is(
  public.mark_document_deleted('d1000000-0000-4000-8000-0000000000c1', 4),
  3::bigint, 'mark_document_deleted: second call is idempotent (no extra bump)');
select is(
  (select count(*)::int from public.jobs where dedupe_key = 'cleanup:document:d1000000-0000-4000-8000-0000000000c1'),
  1, 'mark_document_deleted: cleanup job is deduplicated');
select throws_ok(
  $q$select public.activate_document_version('d1000000-0000-4000-8000-0000000000c1', 'e3000000-0000-4000-8000-0000000000c3', 1)$q$,
  'RB010', null, 'activate: a deleted document cannot be activated');
select throws_ok(
  $q$select public.mark_document_deleted('00000000-0000-4000-8000-00000000dead', 4)$q$,
  'RB010', null, 'mark_document_deleted: unknown document is rejected');
select throws_ok(
  $q$select public.mark_document_deleted('d2000000-0000-4000-8000-0000000000c2', 0)$q$,
  '22023', null, 'mark_document_deleted: max attempts must be positive (no default)');

reset role;
select * from finish();
rollback;
