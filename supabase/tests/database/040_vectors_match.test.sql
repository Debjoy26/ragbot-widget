-- Vector dimension enforcement and match_document_chunks filtering/bounds.
begin;
select plan(33);

-- Test-only helper (rolled back). Unit vector with 1.0 at position i.
create schema tests;
grant usage on schema tests to public;
create function tests.unit_vec(i integer) returns extensions.vector
language sql immutable as $$
  select (array_agg(case when g = i then 1.0 else 0.0 end order by g))::real[]::extensions.vector
  from generate_series(1, 1536) g
$$;
-- Functions created by the migration owner are no longer executable by PUBLIC (P3-D1 L4): grant the test helper.
grant execute on function tests.unit_vec(integer) to public;

-- Two bots. Documents:
--   A  bot1 public_answer, active ready version  -> eligible ('A-active')
--   A  bot1 same document, OLD superseded version -> excluded ('A-old-version')
--   X  bot1 disclosure excluded                   -> excluded ('X-excluded')
--   Dl bot1 deleted                               -> excluded ('D-deleted')
--   P  bot1 version not active (pointer unset)    -> excluded ('P-inactive')
--   Q  bot1 active pointer but version not ready  -> excluded ('Q-notready')
--   B  bot2 public_answer active                  -> eligible for bot2 only
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000a1', 'v-bot1', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000a2', 'v-bot2', 'x', array['en'], 'm', 1536);

insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('d1000000-0000-4000-8000-0000000000a1', 'b1000000-0000-4000-8000-0000000000a1', 'Doc A', 'ready', 'public_answer'),
  ('d2000000-0000-4000-8000-0000000000a2', 'b1000000-0000-4000-8000-0000000000a1', 'Doc X', 'ready', 'excluded'),
  ('d3000000-0000-4000-8000-0000000000a3', 'b1000000-0000-4000-8000-0000000000a1', 'Doc D', 'ready', 'public_answer'),
  ('d4000000-0000-4000-8000-0000000000a4', 'b1000000-0000-4000-8000-0000000000a1', 'Doc P', 'indexing', 'public_answer'),
  ('d5000000-0000-4000-8000-0000000000a5', 'b1000000-0000-4000-8000-0000000000a1', 'Doc Q', 'ready', 'public_answer'),
  ('d6000000-0000-4000-8000-0000000000a6', 'b2000000-0000-4000-8000-0000000000a2', 'Doc B', 'ready', 'public_answer');

insert into public.document_versions (id, document_id, version_number, storage_path, media_type, status) values
  ('e1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', 1, 'v/a1', 'text/plain', 'superseded'),
  ('e1000000-0000-4000-8000-0000000000a2', 'd1000000-0000-4000-8000-0000000000a1', 2, 'v/a2', 'text/plain', 'ready'),
  ('e2000000-0000-4000-8000-0000000000a3', 'd2000000-0000-4000-8000-0000000000a2', 1, 'v/x1', 'text/plain', 'ready'),
  ('e3000000-0000-4000-8000-0000000000a4', 'd3000000-0000-4000-8000-0000000000a3', 1, 'v/d1', 'text/plain', 'ready'),
  ('e4000000-0000-4000-8000-0000000000a5', 'd4000000-0000-4000-8000-0000000000a4', 1, 'v/p1', 'text/plain', 'embedding'),
  ('e5000000-0000-4000-8000-0000000000a6', 'd5000000-0000-4000-8000-0000000000a5', 1, 'v/q1', 'text/plain', 'embedding'),
  ('e6000000-0000-4000-8000-0000000000a7', 'd6000000-0000-4000-8000-0000000000a6', 1, 'v/b1', 'text/plain', 'ready');

-- Versions were embedded with the bot's model 'm' (activation/match require model equality, P3-D1 M2).
update public.document_versions set embedding_model = 'm';
-- M2 fixtures: documents whose active ready version was embedded with ANOTHER model / no model recorded.
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('d7000000-0000-4000-8000-0000000000a7', 'b1000000-0000-4000-8000-0000000000a1', 'Doc M', 'ready', 'public_answer'),
  ('d8000000-0000-4000-8000-0000000000a8', 'b1000000-0000-4000-8000-0000000000a1', 'Doc N', 'ready', 'public_answer');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, status, embedding_model) values
  ('e7000000-0000-4000-8000-0000000000a8', 'd7000000-0000-4000-8000-0000000000a7', 1, 'v/m1', 'text/plain', 'ready', 'other-model'),
  ('e8000000-0000-4000-8000-0000000000a9', 'd8000000-0000-4000-8000-0000000000a8', 1, 'v/n1', 'text/plain', 'ready', null);
update public.documents set active_version_id = 'e7000000-0000-4000-8000-0000000000a8' where id = 'd7000000-0000-4000-8000-0000000000a7';
update public.documents set active_version_id = 'e8000000-0000-4000-8000-0000000000a9' where id = 'd8000000-0000-4000-8000-0000000000a8';
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('e7000000-0000-4000-8000-0000000000a8', 0, 'M-othermodel', tests.unit_vec(1)),
  ('e8000000-0000-4000-8000-0000000000a9', 0, 'N-nomodel', tests.unit_vec(1));
-- A bot with no chunks (its embedding model may still be changed).
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b3000000-0000-4000-8000-0000000000a3', 'v-bot3', 'x', array['en'], 'm', 1536);

update public.documents set active_version_id = 'e1000000-0000-4000-8000-0000000000a2' where id = 'd1000000-0000-4000-8000-0000000000a1';
update public.documents set active_version_id = 'e2000000-0000-4000-8000-0000000000a3' where id = 'd2000000-0000-4000-8000-0000000000a2';
update public.documents set active_version_id = 'e3000000-0000-4000-8000-0000000000a4' where id = 'd3000000-0000-4000-8000-0000000000a3';
update public.documents set active_version_id = 'e5000000-0000-4000-8000-0000000000a6' where id = 'd5000000-0000-4000-8000-0000000000a5';
update public.documents set active_version_id = 'e6000000-0000-4000-8000-0000000000a7' where id = 'd6000000-0000-4000-8000-0000000000a6';
-- Document D is soft-deleted AFTER being active (as mark_document_deleted would leave it).
update public.documents set status = 'deleted', deleted_at = now() where id = 'd3000000-0000-4000-8000-0000000000a3';

-- All chunks sit exactly on the query direction, so ANY filter failure would surface them.
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('e1000000-0000-4000-8000-0000000000a1', 0, 'A-old-version', tests.unit_vec(1)),
  ('e1000000-0000-4000-8000-0000000000a2', 0, 'A-active', tests.unit_vec(1)),
  ('e2000000-0000-4000-8000-0000000000a3', 0, 'X-excluded', tests.unit_vec(1)),
  ('e3000000-0000-4000-8000-0000000000a4', 0, 'D-deleted', tests.unit_vec(1)),
  ('e4000000-0000-4000-8000-0000000000a5', 0, 'P-inactive', tests.unit_vec(1)),
  ('e5000000-0000-4000-8000-0000000000a6', 0, 'Q-notready', tests.unit_vec(1)),
  ('e6000000-0000-4000-8000-0000000000a7', 0, 'B-bot2', tests.unit_vec(1));
-- A second, less similar eligible chunk for ordering / threshold tests.
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('e1000000-0000-4000-8000-0000000000a2', 1, 'A-active-far', tests.unit_vec(2));

-- ---- Dimension enforcement (ADR 0002 / 0014) ----
select throws_ok(
  $q$insert into public.document_chunks (document_version_id, chunk_index, content, embedding)
     values ('e1000000-0000-4000-8000-0000000000a2', 9, 'bad', (select array_agg(0.1::real) from generate_series(1, 768))::extensions.vector)$q$,
  '22000', 'expected 1536 dimensions, not 768', 'document_chunks: 768-dim embedding is rejected');
select throws_ok(
  $q$insert into public.document_chunks (document_version_id, chunk_index, content, embedding)
     values ('e1000000-0000-4000-8000-0000000000a2', 9, 'bad', (select array_agg(0.1::real) from generate_series(1, 3072))::extensions.vector)$q$,
  '22000', 'expected 1536 dimensions, not 3072', 'document_chunks: 3072-dim embedding is rejected');
select throws_ok(
  $q$insert into public.query_embedding_cache (key_hash, embedding_model, embedding, expires_at)
     values (repeat('9', 64), 'm', (select array_agg(0.1::real) from generate_series(1, 768))::extensions.vector, now() + interval '1 hour')$q$,
  '22000', 'expected 1536 dimensions, not 768', 'query_embedding_cache: 768-dim embedding is rejected');
select throws_ok(
  $q$insert into public.bot_profiles (slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions)
     values ('v-bad-dim', 'x', array['en'], 'm', 768)$q$,
  '23514', null, 'bot_profiles: embedding_dimensions <> 1536 is rejected');
select throws_ok(
  $q$insert into public.document_chunks (document_version_id, chunk_index, content) values ('e1000000-0000-4000-8000-0000000000a2', 8, 'no-embedding')$q$,
  '23502', null, 'document_chunks: embedding is NOT NULL');
select ok(
  (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
    where a.attrelid = 'public.document_chunks'::regclass and a.attname = 'embedding') like '%vector(1536)',
  'document_chunks.embedding is vector(1536)');
select is(
  (select o.opcname::text from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_am am on am.oid = c.relam
     join pg_opclass o on o.oid = i.indclass[0]
    where c.relname = 'document_chunks_embedding_hnsw_idx' and am.amname = 'hnsw'),
  'vector_cosine_ops', 'HNSW index with vector_cosine_ops exists on document_chunks.embedding');

-- ---- match_document_chunks as service_role ----
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select results_eq(
  $q$select content from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 50) order by similarity desc, content$q$,
  $q$values ('A-active'::text), ('A-active-far'::text)$q$,
  'match: bot1 returns ONLY eligible chunks (excludes old version, excluded, deleted, inactive, not-ready, other bot)');
select is(
  (select count(*)::int from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 50) where content in ('A-old-version', 'X-excluded', 'D-deleted', 'P-inactive', 'Q-notready', 'B-bot2')),
  0, 'match: no excluded chunk leaks (disclosure=excluded, deleted, superseded, inactive, not ready, cross-bot)');
select results_eq(
  $q$select content from public.match_document_chunks('b2000000-0000-4000-8000-0000000000a2', tests.unit_vec(1), 10)$q$,
  $q$values ('B-bot2'::text)$q$,
  'match: bot2 only sees bot2 chunks');
select is(
  (select count(*)::int from public.match_document_chunks('00000000-0000-4000-8000-00000000dead', tests.unit_vec(1), 10)),
  0, 'match: unknown bot returns nothing');
select results_eq(
  $q$select content from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 1)$q$,
  $q$values ('A-active'::text)$q$,
  'match: k=1 returns the single nearest eligible chunk');
select results_eq(
  $q$select content from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 10, 0.5)$q$,
  $q$values ('A-active'::text)$q$,
  'match: min similarity 0.5 drops the orthogonal chunk');
select cmp_ok(
  (select similarity from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 1)),
  '>=', 0.999::double precision, 'match: identical vector has cosine similarity ~1');

-- Bounded k: REJECTED (not clamped).
select lives_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 50)$q$, 'match: k = 50 (max) accepted');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 51)$q$, '22023', null, 'match: k = 51 rejected (not clamped)');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 1000000)$q$, '22023', null, 'match: k = 1000000 rejected');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 0)$q$, '22023', null, 'match: k = 0 rejected');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), -5)$q$, '22023', null, 'match: negative k rejected');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), null)$q$, '22023', null, 'match: null k rejected');
select throws_ok($q$select * from public.match_document_chunks(null, tests.unit_vec(1), 5)$q$, '22023', null, 'match: null bot rejected');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', null::extensions.vector, 5)$q$, '22023', null, 'match: null embedding rejected');
select throws_ok($q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 5, 2)$q$, '22023', null, 'match: out-of-range min similarity rejected');
select throws_ok(
  $q$select * from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', (select array_agg(0.1::real) from generate_series(1, 768))::extensions.vector, 5)$q$,
  '22000', null, 'match: 768-dim query vector rejected');

-- M2: chunks of a version embedded with a different (or unrecorded) model are never matched.
select is(
  (select count(*)::int from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 50) where content in ('M-othermodel', 'N-nomodel')),
  0, 'match (M2): chunks whose version embedding_model differs from / is null versus bot embedding_model are excluded');
reset role;
update public.bot_profiles set embedding_model = 'other-model' where id = 'b3000000-0000-4000-8000-0000000000a3';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select embedding_model from public.bot_profiles where id = 'b3000000-0000-4000-8000-0000000000a3'), 'other-model',
  'M2 guard: embedding_model of a bot WITHOUT chunks can be changed');
select throws_ok(
  $q$update public.bot_profiles set embedding_model = 'other-model' where id = 'b1000000-0000-4000-8000-0000000000a1'$q$,
  'RB012', null, 'M2 guard: embedding_model change is rejected while the bot has chunks (RB012)');
select throws_ok(
  $q$update public.bot_profiles set embedding_dimensions = 768 where id = 'b1000000-0000-4000-8000-0000000000a1'$q$,
  'RB012', null, 'M2 guard: embedding_dimensions change is rejected while the bot has chunks (RB012)');
select lives_ok(
  $q$update public.bot_profiles set embedding_model = embedding_model, embedding_dimensions = 1536, enabled = true where id = 'b1000000-0000-4000-8000-0000000000a1'$q$,
  'M2 guard: updates that keep model/dimension (and other columns) still work');
select is((select embedding_model from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000a1'), 'm',
  'M2 guard: the rejected change left embedding_model untouched');
select is(
  (select count(*)::int from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 50)
     where content = 'A-active'),
  1, 'match (M2): same-model chunks are still returned');

-- mark_document_deleted excludes the document from retrieval at once and bumps corpus_version.
select is(
  public.mark_document_deleted('d1000000-0000-4000-8000-0000000000a1', 3),
  1::bigint, 'mark_document_deleted bumps corpus_version 0 -> 1');
select is(
  (select count(*)::int from public.match_document_chunks('b1000000-0000-4000-8000-0000000000a1', tests.unit_vec(1), 50)),
  0, 'match: after mark_document_deleted the document is immediately unretrievable');

reset role;
select * from finish();
rollback;
