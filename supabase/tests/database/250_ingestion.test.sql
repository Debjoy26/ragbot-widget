-- P6 (migration 012): the worker's ingestion data layer. Every function's success and refusal; the job fence for
-- every fenced function (wrong worker, expired lease, other job type, other version, terminal job, unknown job,
-- deleted document); progress validation; chunk writes (idempotent, bounded, shape-checked); activation through the
-- job; failing a version; retry with a delay and the dead-letter step; usage events; cleanup in batches; storage
-- targets; expiring abandoned uploads; grants; lock_timeout; schema_version. All fixtures are synthetic.
-- Sequential only: the real two-connection races are in scripts/race-db.sh.
--
-- Ids end in 000000000250: bots bN, documents dN, versions eN/cN, jobs fN/aN. Worker ids are 'w1' (the holder) and 'w2'.
begin;
select plan(227);

-- A valid embedding (1536 numbers) and a short one (1535), kept as transaction-local settings so every role can use them.
select set_config('p6.emb', (select jsonb_agg(0.01)::text from generate_series(1, 1536)), true);
select set_config('p6.short', (select jsonb_agg(0.01)::text from generate_series(1, 1535)), true);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-000000000250', 'p6-main',  'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-000000000250', 'p6-nopol', 'x', array['en'], 'm', 1536),
  ('b3000000-0000-4000-8000-000000000250', 'p6-other', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-000000000250', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1000, "max_pages": 50}', '{}', '{}'),
  ('b2000000-0000-4000-8000-000000000250', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1000}', '{}', '{}'),
  ('b3000000-0000-4000-8000-000000000250', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1000, "max_pages": 50}', '{}', '{}');

-- P6-D1 fixtures for the reindex check: an admin, a bot with the quotas and attempts policy, and a live document
-- (df) whose active version has an upload_etag and a checksum. Ids: bot b4, user a9, document df, version c9.
insert into auth.users (id, aud, role, email) values
  ('a9000000-0000-4000-8000-000000000250', 'authenticated', 'authenticated', 'p6-owner@example.test');
insert into public.admin_memberships (user_id, role, active) values
  ('a9000000-0000-4000-8000-000000000250', 'owner', true);
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions, enabled) values
  ('b4000000-0000-4000-8000-000000000250', 'p6-reindex', 'x', array['en'], 'm', 1536, true);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b4000000-0000-4000-8000-000000000250', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1000, "max_pages": 50, "index_max_attempts": 3, "cleanup_max_attempts": 3, "quotas": {"reindex": {"limit": 10, "window_seconds": 3600}}}', '{}', '{}');
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('df000000-0000-4000-8000-000000000250', 'b4000000-0000-4000-8000-000000000250', 'df', 'ready', 'public_answer');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, upload_etag, checksum, embedding_model, created_at) values
  ('c9000000-0000-4000-8000-000000000250', 'df000000-0000-4000-8000-000000000250', 1, 'b4000000-0000-4000-8000-000000000250/df000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'ready', 'etag-src', 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'm', now());
update public.documents set active_version_id = 'c9000000-0000-4000-8000-000000000250' where id = 'df000000-0000-4000-8000-000000000250';

-- Documents. d1 context/progress; d2 live with a reindex version; d3 deleted (fence, cleanup, storage targets);
-- d4 bot without max_pages; d5 chunk writes; d6 older version versus a newer active one; d7 first version that fails;
-- d8 live document whose new version fails; d9 retry; da the fence matrix; db/dc abandoned uploads;
-- dd/de activation checks.
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('d1000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd1', 'indexing', 'public_answer'),
  ('d2000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd2', 'ready', 'public_answer'),
  ('d4000000-0000-4000-8000-000000000250', 'b2000000-0000-4000-8000-000000000250', 'd4', 'indexing', 'public_answer'),
  ('d5000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd5', 'indexing', 'public_answer'),
  ('d6000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd6', 'ready', 'public_answer'),
  ('d7000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd7', 'indexing', 'public_answer'),
  ('d8000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd8', 'ready', 'public_answer'),
  ('d9000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd9', 'indexing', 'public_answer'),
  ('da000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'da', 'indexing', 'public_answer'),
  ('db000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'db', 'draft', 'public_answer'),
  ('dc000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'dc', 'ready', 'public_answer'),
  ('dd000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'dd', 'indexing', 'public_answer'),
  ('de000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'de', 'indexing', 'public_answer');
insert into public.documents (id, bot_id, title, status, disclosure_policy, deleted_at) values
  ('d3000000-0000-4000-8000-000000000250', 'b1000000-0000-4000-8000-000000000250', 'd3', 'deleted', 'excluded', now());

insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, upload_etag, embedding_model, created_at) values
  ('e1000000-0000-4000-8000-000000000250', 'd1000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d1000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.pdf', 'application/pdf', 100, 'uploaded', 'etag-1', null, now()),
  ('e2000000-0000-4000-8000-000000000250', 'd2000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d2000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'ready', null, 'm', now()),
  ('e3000000-0000-4000-8000-000000000250', 'd2000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/d2000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'uploaded', null, null, now()),
  ('e4000000-0000-4000-8000-000000000250', 'd4000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d4000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'uploaded', null, null, now()),
  ('e5000000-0000-4000-8000-000000000250', 'd5000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d5000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'embedding', null, 'm', now()),
  ('c8000000-0000-4000-8000-000000000250', 'd5000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/d5000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/v2.txt', 'text/plain', 100, 'embedding', null, 'm', now()),
  ('e6000000-0000-4000-8000-000000000250', 'd6000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/d6000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/v2.txt', 'text/plain', 100, 'ready', null, 'm', now()),
  ('e7000000-0000-4000-8000-000000000250', 'd6000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d6000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/v1.txt', 'text/plain', 100, 'embedding', null, 'm', now()),
  ('e8000000-0000-4000-8000-000000000250', 'd7000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d7000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.pdf', 'application/pdf', 100, 'uploaded', null, null, now()),
  ('e9000000-0000-4000-8000-000000000250', 'd8000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d8000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'ready', null, 'm', now()),
  ('ea000000-0000-4000-8000-000000000250', 'd8000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/d8000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'embedding', null, 'm', now()),
  ('eb000000-0000-4000-8000-000000000250', 'd9000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d9000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'extracting', null, null, now()),
  ('ec000000-0000-4000-8000-000000000250', 'da000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/da000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'embedding', null, 'm', now()),
  ('ed000000-0000-4000-8000-000000000250', 'da000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/da000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/v2.txt', 'text/plain', 100, 'uploaded', null, null, now()),
  ('ee000000-0000-4000-8000-000000000250', 'd3000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/d3000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/only-deleted.txt', 'text/plain', 100, 'ready', null, 'm', now()),
  ('ef000000-0000-4000-8000-000000000250', 'd3000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/d2000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'ready', null, 'm', now()),
  ('e0000000-0000-4000-8000-000000000250', 'd3000000-0000-4000-8000-000000000250', 3, 'b1000000-0000-4000-8000-000000000250/d3000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/only-deleted.txt', 'text/plain', 100, 'failed', null, null, now()),
  ('c1000000-0000-4000-8000-000000000250', 'dd000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/dd000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'embedding', null, 'm', now()),
  ('c2000000-0000-4000-8000-000000000250', 'de000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/de000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt', 'text/plain', 100, 'embedding', null, 'other-model', now()),
  ('c3000000-0000-4000-8000-000000000250', 'db000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/db000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c3.txt', 'text/plain', 100, 'pending_upload', null, null, now() - interval '5 hours'),
  ('c4000000-0000-4000-8000-000000000250', 'db000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/db000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c4.txt', 'text/plain', 100, 'pending_upload', null, null, now() - interval '10 minutes'),
  ('c5000000-0000-4000-8000-000000000250', 'db000000-0000-4000-8000-000000000250', 3, 'b1000000-0000-4000-8000-000000000250/db000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c4.txt', 'text/plain', 100, 'pending_upload', null, null, now() - interval '4 hours'),
  ('c6000000-0000-4000-8000-000000000250', 'dc000000-0000-4000-8000-000000000250', 1, 'b1000000-0000-4000-8000-000000000250/dc000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c6.txt', 'text/plain', 100, 'ready', null, 'm', now()),
  ('c7000000-0000-4000-8000-000000000250', 'dc000000-0000-4000-8000-000000000250', 2, 'b1000000-0000-4000-8000-000000000250/dc000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c7.txt', 'text/plain', 100, 'pending_upload', null, null, now() - interval '3 hours');
update public.documents set active_version_id = 'e2000000-0000-4000-8000-000000000250' where id = 'd2000000-0000-4000-8000-000000000250';
update public.documents set active_version_id = 'e6000000-0000-4000-8000-000000000250' where id = 'd6000000-0000-4000-8000-000000000250';
update public.documents set active_version_id = 'e9000000-0000-4000-8000-000000000250' where id = 'd8000000-0000-4000-8000-000000000250';
update public.documents set active_version_id = 'c6000000-0000-4000-8000-000000000250' where id = 'dc000000-0000-4000-8000-000000000250';

-- Five chunks on the deleted document (cleanup_document), one on the live document d2 (must never be touched).
insert into public.document_chunks (document_version_id, chunk_index, content, embedding)
  select 'ee000000-0000-4000-8000-000000000250', g, 'dead-' || g, (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector from generate_series(0, 2) g;
insert into public.document_chunks (document_version_id, chunk_index, content, embedding)
  select 'ef000000-0000-4000-8000-000000000250', g, 'dead2-' || g, (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector from generate_series(0, 1) g;
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('e2000000-0000-4000-8000-000000000250', 0, 'live-chunk', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector);

-- Chunks for the activation checks: dd has one chunk; de has one chunk (model mismatch); e7 (older version) has one.
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('c1000000-0000-4000-8000-000000000250', 0, 'x', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector),
  ('c2000000-0000-4000-8000-000000000250', 0, 'x', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector),
  ('e7000000-0000-4000-8000-000000000250', 0, 'x', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector);

-- Jobs. All index_document jobs are running for 'w1' with a lease an hour out unless stated.
insert into public.jobs (id, type, payload, state, attempts, max_attempts, locked_by, locked_until) values
  ('f1000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d1000000-0000-4000-8000-000000000250","version_id":"e1000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f2000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d2000000-0000-4000-8000-000000000250","version_id":"e3000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f4000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b2000000-0000-4000-8000-000000000250","document_id":"d4000000-0000-4000-8000-000000000250","version_id":"e4000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f5000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d5000000-0000-4000-8000-000000000250","version_id":"e5000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('a1000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d5000000-0000-4000-8000-000000000250","version_id":"c8000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f6000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d6000000-0000-4000-8000-000000000250","version_id":"e7000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f7000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d7000000-0000-4000-8000-000000000250","version_id":"e8000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f8000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d8000000-0000-4000-8000-000000000250","version_id":"ea000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f9000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d9000000-0000-4000-8000-000000000250","version_id":"eb000000-0000-4000-8000-000000000250"}', 'running', 1, 2, 'w1', now() + interval '1 hour'),
  ('fa000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"da000000-0000-4000-8000-000000000250","version_id":"ec000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('fb000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"da000000-0000-4000-8000-000000000250","version_id":"ec000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() - interval '1 second'),
  ('fc000000-0000-4000-8000-000000000250', 'cleanup',        '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"da000000-0000-4000-8000-000000000250","version_id":"ec000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('fe000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d3000000-0000-4000-8000-000000000250","version_id":"ee000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f3000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"dd000000-0000-4000-8000-000000000250","version_id":"c1000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('f0000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"de000000-0000-4000-8000-000000000250","version_id":"c2000000-0000-4000-8000-000000000250"}', 'running', 1, 3, 'w1', now() + interval '1 hour'),
  ('ff000000-0000-4000-8000-000000000250', 'cleanup',        '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"d3000000-0000-4000-8000-000000000250"}', 'running', 3, 3, 'w1', now() + interval '1 hour'),
  ('a2000000-0000-4000-8000-000000000250', 'cleanup',        '{"bot_id":"b1000000-0000-4000-8000-000000000250"}', 'queued', 0, 3, null, null),
  ('a3000000-0000-4000-8000-000000000250', 'cleanup',        '{"bot_id":"b3000000-0000-4000-8000-000000000250"}', 'queued', 0, 3, null, null);
insert into public.jobs (id, type, payload, state, attempts, max_attempts, completed_at) values
  ('fd000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"da000000-0000-4000-8000-000000000250","version_id":"ec000000-0000-4000-8000-000000000250"}', 'succeeded', 1, 3, now());

select is((select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000250'), 0::bigint, 'fixture: the main bot starts at corpus_version 0');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ===== the fence: every fenced function x every way to not hold the job =====
-- RB013 for wrong worker, expired lease, other job type, other version, terminal job and unknown job; RB010 for a
-- deleted document (its job still running). The version of the matrix (ec) belongs to document da.
select ok((select count(*) = 1 from public.get_index_job_context('fa000000-0000-4000-8000-000000000250', 'w1', 'ec000000-0000-4000-8000-000000000250')), 'fence: the matched job passes (control)');
select throws_ok(format(f.call, c.job, c.worker, c.ver), c.code::char(5), null::text, f.name || ': ' || c.label)
  from (values
    ('get_index_job_context',    $f$select * from public.get_index_job_context(%L, %L, %L)$f$),
    ('update_version_progress',  $f$select public.update_version_progress(%L, %L, %L, '{"batches_done": 1}')$f$),
    ('write_document_chunks',    $f$select public.write_document_chunks(%L, %L, %L, jsonb_build_array(jsonb_build_object('chunk_index', 0, 'content', 'c', 'embedding', current_setting('p6.emb')::jsonb)))$f$),
    ('activate_version_for_job', $f$select public.activate_version_for_job(%L, %L, %L, 1)$f$),
    ('fail_document_version',    $f$select public.fail_document_version(%L, %L, %L, 'INDEXING_FAILED')$f$)
  ) f(name, call)
  cross join (values
    ('wrong worker',     'fa000000-0000-4000-8000-000000000250', 'w2', 'ec000000-0000-4000-8000-000000000250', 'RB013'),
    ('expired lease',    'fb000000-0000-4000-8000-000000000250', 'w1', 'ec000000-0000-4000-8000-000000000250', 'RB013'),
    ('other job type',   'fc000000-0000-4000-8000-000000000250', 'w1', 'ec000000-0000-4000-8000-000000000250', 'RB013'),
    ('other version',    'fa000000-0000-4000-8000-000000000250', 'w1', 'ed000000-0000-4000-8000-000000000250', 'RB013'),
    ('terminal job',     'fd000000-0000-4000-8000-000000000250', 'w1', 'ec000000-0000-4000-8000-000000000250', 'RB013'),
    ('unknown job',      'f1111111-0000-4000-8000-000000000250', 'w1', 'ec000000-0000-4000-8000-000000000250', 'RB013'),
    ('deleted document', 'fe000000-0000-4000-8000-000000000250', 'w1', 'ee000000-0000-4000-8000-000000000250', 'RB010')
  ) c(label, job, worker, ver, code);
select throws_ok($q$select * from public.get_index_job_context(null, 'w1', 'ec000000-0000-4000-8000-000000000250')$q$, '22023', null, 'fence: null job -> 22023');
select throws_ok($q$select * from public.get_index_job_context('fa000000-0000-4000-8000-000000000250', '', 'ec000000-0000-4000-8000-000000000250')$q$, '22023', null, 'fence: empty worker -> 22023');
select throws_ok($q$select * from public.get_index_job_context('fa000000-0000-4000-8000-000000000250', 'w1', null)$q$, '22023', null, 'fence: null version -> 22023');
select throws_ok($q$select * from public.get_index_job_context('fa000000-0000-4000-8000-000000000250', 'w1', 'f1111111-0000-4000-8000-000000000250')$q$, 'RB013', null, 'fence: unknown version -> RB013');
-- A job whose payload names another document than the version's is refused.
reset role;
update public.jobs set payload = jsonb_set(payload, '{document_id}', '"d1000000-0000-4000-8000-000000000250"') where id = 'fa000000-0000-4000-8000-000000000250';
set local role service_role;
select throws_ok($q$select * from public.get_index_job_context('fa000000-0000-4000-8000-000000000250', 'w1', 'ec000000-0000-4000-8000-000000000250')$q$, 'RB013', null, 'fence: payload names another document than the version belongs to -> RB013');
reset role;
update public.jobs set payload = jsonb_set(payload, '{document_id}', '"da000000-0000-4000-8000-000000000250"') where id = 'fa000000-0000-4000-8000-000000000250';
set local role service_role;
select is((select count(*)::int from public.document_versions where id = 'ec000000-0000-4000-8000-000000000250' and status = 'embedding' and failure_code is null), 1, 'fence: no refused call changed the matrix version');
select is((select count(*)::int from public.document_chunks where document_version_id = 'ec000000-0000-4000-8000-000000000250'), 0, 'fence: no refused call wrote a chunk');

-- ===== get_index_job_context =====
select results_eq(
  $q$select bot_id, document_id, version_id, version_number, status, storage_path, media_type, byte_size, upload_etag, embedding_model, max_bytes, max_pages, active_version_id, active_version_number
       from public.get_index_job_context('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250')$q$,
  $q$values ('b1000000-0000-4000-8000-000000000250'::uuid, 'd1000000-0000-4000-8000-000000000250'::uuid, 'e1000000-0000-4000-8000-000000000250'::uuid, 1, 'uploaded', 'b1000000-0000-4000-8000-000000000250/d1000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.pdf', 'application/pdf', 100::bigint, 'etag-1', 'm', 1000::bigint, 50::bigint, null::uuid, null::integer)$q$,
  'context: a first version returns its row, the bot model, the limits and no active version');
select results_eq(
  $q$select version_number, active_version_id, active_version_number from public.get_index_job_context('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250')$q$,
  $q$values (2, 'e2000000-0000-4000-8000-000000000250'::uuid, 1)$q$,
  'context: a reindex version reports the active version and its number');
select results_eq(
  $q$select batches_done, written_chunks from public.get_index_job_context('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250')$q$,
  $q$values (null::integer, 0)$q$, 'context: before any progress or write, batches_done is null and written_chunks is 0');
select results_eq(
  $q$select batches_done, written_chunks from public.get_index_job_context('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250')$q$,
  $q$values (null::integer, 0)$q$, 'context: a version in the embedding state with no chunks yet reports written_chunks 0');
select results_eq(
  $q$select batches_done, written_chunks from public.get_index_job_context('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250')$q$,
  $q$values (null::integer, 0)$q$, 'context: written_chunks counts this version only (the live version of the same document has a chunk, the new one has none)');
select throws_ok($q$select * from public.get_index_job_context('f4000000-0000-4000-8000-000000000250', 'w1', 'e4000000-0000-4000-8000-000000000250')$q$, 'RB036', null, 'context: upload_policy without max_pages fails closed (RB036)');

-- ===== update_version_progress =====
select lives_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "extracting", "extraction_method": "pdf_text", "extraction_version": "pdf-1", "batches_total": 4}')$q$, 'progress: uploaded -> extracting with method, version and total');
select results_eq(
  $q$select status, extraction_method, extraction_version, batches_total, batches_done from public.document_versions where id = 'e1000000-0000-4000-8000-000000000250'$q$,
  $q$values ('extracting', 'pdf_text', 'pdf-1', 4, null::integer)$q$, 'progress: the patch was applied and nothing else changed');
select lives_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "extracting"}')$q$, 'progress: the same status is a no-op, not an error');
select lives_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "embedding", "batches_done": 2, "checksum": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "chunking_version": "chunk-1", "embedding_model": "m"}')$q$, 'progress: extracting -> embedding with done, checksum, chunking version and model');
select results_eq(
  $q$select status, batches_done, batches_total, checksum, chunking_version, embedding_model, extraction_version from public.document_versions where id = 'e1000000-0000-4000-8000-000000000250'$q$,
  $q$values ('embedding', 2, 4, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'chunk-1', 'm', 'pdf-1')$q$, 'progress: earlier values were kept, new ones set');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "extracting"}')$q$, '22023', null, 'progress: embedding -> extracting is backward -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "ready"}')$q$, '22023', null, 'progress: status ready is not allowed (only activation makes a version ready)');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "failed"}')$q$, '22023', null, 'progress: status failed is not allowed here');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": "bogus"}')$q$, '22023', null, 'progress: unknown status -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"status": 3}')$q$, '22023', null, 'progress: non-string status -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"failure_code": "INDEXING_FAILED"}')$q$, '22023', null, 'progress: failure_code is not a patch key -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"batches_done": 1, "storage_path": "x"}')$q$, '22023', null, 'progress: one unknown key among valid ones -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{}')$q$, '22023', null, 'progress: empty patch -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '[1]')$q$, '22023', null, 'progress: non-object patch -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', null)$q$, '22023', null, 'progress: null patch -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"checksum": "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"}')$q$, '22023', null, 'progress: uppercase checksum -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"checksum": "abc"}')$q$, '22023', null, 'progress: short checksum -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"extraction_method": "ocr"}')$q$, '22023', null, 'progress: unknown extraction_method -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"batches_done": -1}')$q$, '22023', null, 'progress: negative batches_done -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"batches_done": "2"}')$q$, '22023', null, 'progress: string batches_done -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"batches_done": 1.5}')$q$, '22023', null, 'progress: fractional batches_done -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"batches_done": 5}')$q$, '22023', null, 'progress: batches_done above the stored batches_total -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"batches_total": 1}')$q$, '22023', null, 'progress: batches_total below the stored batches_done -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"extraction_version": ""}')$q$, '22023', null, 'progress: empty extraction_version -> 22023');
select throws_ok(format($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"chunking_version": "%s"}')$q$, repeat('x', 65)), '22023', null, 'progress: chunking_version over 64 characters -> 22023');
select throws_ok($q$select public.update_version_progress('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250', '{"embedding_model": null}')$q$, '22023', null, 'progress: null embedding_model -> 22023');
select results_eq(
  $q$select status, batches_done, batches_total from public.document_versions where id = 'e1000000-0000-4000-8000-000000000250'$q$,
  $q$values ('embedding', 2, 4)$q$, 'progress: refused patches changed nothing');
select results_eq(
  $q$select batches_done, written_chunks from public.get_index_job_context('f1000000-0000-4000-8000-000000000250', 'w1', 'e1000000-0000-4000-8000-000000000250')$q$,
  $q$values (2, 0)$q$, 'context: batches_done reflects the progress patch while written_chunks stays 0');

-- ===== write_document_chunks =====
select is(public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'content', 'first', 'token_count', 5, 'page_number', 1, 'section', 'Intro', 'metadata', '{"k": 1}'::jsonb, 'embedding', current_setting('p6.emb')::jsonb),
    jsonb_build_object('chunk_index', 1, 'content', 'second', 'embedding', current_setting('p6.emb')::jsonb))),
  2, 'chunks: two chunks written, returns 2');
select results_eq(
  $q$select chunk_index, content, token_count, page_number, section, metadata, vector_dims(embedding) from public.document_chunks where document_version_id = 'e5000000-0000-4000-8000-000000000250' order by chunk_index$q$,
  $q$values (0, 'first', 5, 1, 'Intro', '{"k": 1}'::jsonb, 1536), (1, 'second', null::integer, null::integer, null::text, '{}'::jsonb, 1536)$q$,
  'chunks: fields stored, optional fields null, metadata defaults to {}, embedding has 1536 dimensions');
select is(public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'content', 'first changed', 'token_count', 6, 'page_number', 2, 'section', 'Intro', 'embedding', current_setting('p6.emb')::jsonb),
    jsonb_build_object('chunk_index', 1, 'content', 'second', 'embedding', current_setting('p6.emb')::jsonb))),
  2, 'chunks: the same batch again is accepted (idempotent upsert), returns 2');
select results_eq(
  $q$select count(*)::int, min(content) filter (where chunk_index = 0), max(page_number) from public.document_chunks where document_version_id = 'e5000000-0000-4000-8000-000000000250'$q$,
  $q$values (2, 'first changed', 2)$q$, 'chunks: a repeat updates in place, no duplicate rows');
select is(public.write_document_chunks('a1000000-0000-4000-8000-000000000250', 'w1', 'c8000000-0000-4000-8000-000000000250',
  (select jsonb_agg(jsonb_build_object('chunk_index', g, 'content', 'c' || g, 'embedding', current_setting('p6.emb')::jsonb)) from generate_series(0, 199) g)),
  200, 'chunks: exactly 200 chunks in one call is accepted');
select is((select count(*)::int from public.document_chunks where document_version_id = 'c8000000-0000-4000-8000-000000000250'), 200, 'chunks: 200 rows stored');
select results_eq(
  $q$select written_chunks from public.get_index_job_context('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250')$q$,
  $q$values (2)$q$, 'context: after a partial write written_chunks is the number of rows written (2)');
select results_eq(
  $q$select written_chunks from public.get_index_job_context('a1000000-0000-4000-8000-000000000250', 'w1', 'c8000000-0000-4000-8000-000000000250')$q$,
  $q$values (200)$q$, 'context: a sibling version of the same document reports its own count (200), not the other version''s');
select throws_ok($q$select public.write_document_chunks('a1000000-0000-4000-8000-000000000250', 'w1', 'c8000000-0000-4000-8000-000000000250',
  (select jsonb_agg(jsonb_build_object('chunk_index', g, 'content', 'c', 'embedding', current_setting('p6.emb')::jsonb)) from generate_series(200, 400) g))$q$,
  '22023', null, 'chunks: 201 chunks in one call -> 22023');
select is((select count(*)::int from public.document_chunks where document_version_id = 'c8000000-0000-4000-8000-000000000250'), 200, 'chunks: the refused 201-chunk call wrote nothing');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250', '[]')$q$, '22023', null, 'chunks: an empty array -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250', '{"chunk_index": 2}')$q$, '22023', null, 'chunks: an object instead of an array -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250', null)$q$, '22023', null, 'chunks: null -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'short', 'embedding', current_setting('p6.short')::jsonb)))$q$, '22023', null, 'chunks: an embedding of 1535 numbers -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'noemb')))$q$, '22023', null, 'chunks: a missing embedding -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'strs', 'embedding', (select jsonb_agg('0.5'::text) from generate_series(1, 1536)))))$q$, '22023', null, 'chunks: an embedding of strings -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', '', 'embedding', current_setting('p6.emb')::jsonb)))$q$, '22023', null, 'chunks: empty content -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', -1, 'content', 'neg', 'embedding', current_setting('p6.emb')::jsonb)))$q$, '22023', null, 'chunks: negative chunk_index -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'pg0', 'page_number', 0, 'embedding', current_setting('p6.emb')::jsonb)))$q$, '22023', null, 'chunks: page_number 0 -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'tok', 'token_count', -3, 'embedding', current_setting('p6.emb')::jsonb)))$q$, '22023', null, 'chunks: negative token_count -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'meta', 'metadata', '[1]'::jsonb, 'embedding', current_setting('p6.emb')::jsonb)))$q$, '22023', null, 'chunks: metadata that is not an object -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'a', 'embedding', current_setting('p6.emb')::jsonb), jsonb_build_object('chunk_index', 2, 'content', 'b', 'embedding', current_setting('p6.emb')::jsonb)))$q$, '22023', null, 'chunks: the same chunk_index twice in one call -> 22023');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250', '[7]')$q$, '22023', null, 'chunks: an element that is not an object -> 22023');
select is((select count(*)::int from public.document_chunks where document_version_id = 'e5000000-0000-4000-8000-000000000250'), 2, 'chunks: every refused call wrote nothing (still two rows)');
-- Version status other than embedding: uploaded (d1/e1 is embedding now, use d4's version, job f4) and failed/ready.
select throws_ok($q$select public.write_document_chunks('f4000000-0000-4000-8000-000000000250', 'w1', 'e4000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 0, 'content', 'c', 'embedding', current_setting('p6.emb')::jsonb)))$q$, 'RB030', null, 'chunks: a version still uploaded -> RB030');
select is((select count(*)::int from public.document_chunks where document_version_id = 'e4000000-0000-4000-8000-000000000250'), 0, 'chunks: nothing written for the uploaded version');

-- ===== activation through the job =====
-- d2: a reindex version (e3) over the live version e2.
select lives_ok($q$select public.update_version_progress('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', '{"status": "embedding", "embedding_model": "m"}')$q$, 'activate: e3 moves to embedding with the bot model');
select is(public.write_document_chunks('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250',
  jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'content', 'n0', 'embedding', current_setting('p6.emb')::jsonb),
    jsonb_build_object('chunk_index', 1, 'content', 'n1', 'embedding', current_setting('p6.emb')::jsonb))), 2, 'activate: two chunks written for the new version');
select throws_ok($q$select public.activate_version_for_job('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', 3)$q$, 'RB011', null, 'activate: a wrong expected chunk count -> RB011');
select throws_ok($q$select public.activate_version_for_job('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', 0)$q$, '22023', null, 'activate: expected chunks 0 -> 22023');
select throws_ok($q$select public.activate_version_for_job('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', null)$q$, '22023', null, 'activate: expected chunks null -> 22023');
select is((select active_version_id from public.documents where id = 'd2000000-0000-4000-8000-000000000250'), 'e2000000-0000-4000-8000-000000000250'::uuid, 'activate: the refused calls left the old version active');
select is(public.activate_version_for_job('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', 2), 1::bigint, 'activate: returns the new corpus_version (1)');
select results_eq(
  $q$select (select status from public.document_versions where id = 'e3000000-0000-4000-8000-000000000250'),
            (select status from public.document_versions where id = 'e2000000-0000-4000-8000-000000000250'),
            (select active_version_id from public.documents where id = 'd2000000-0000-4000-8000-000000000250'),
            (select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000250')$q$,
  $q$values ('ready', 'superseded', 'e3000000-0000-4000-8000-000000000250'::uuid, 1::bigint)$q$, 'activate: new version ready, old superseded, pointer switched, corpus_version bumped');
select is(public.activate_version_for_job('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', 2), 1::bigint, 'activate: activating the already active version again is idempotent (no second bump)');
select throws_ok($q$select public.write_document_chunks('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'late', 'embedding', current_setting('p6.emb')::jsonb)))$q$, 'RB030', null, 'chunks: a ready version takes no more chunks -> RB030');
select throws_ok($q$select public.fail_document_version('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', 'INDEXING_FAILED')$q$, 'RB030', null, 'fail version: a ready version cannot be failed -> RB030');
select throws_ok($q$select public.update_version_progress('f2000000-0000-4000-8000-000000000250', 'w1', 'e3000000-0000-4000-8000-000000000250', '{"batches_done": 1}')$q$, 'RB030', null, 'progress: a ready version takes no progress -> RB030');
-- RB011: an older version cannot replace the newer active one (d6: active e6 is version 2, e7 is version 1).
select throws_ok($q$select public.activate_version_for_job('f6000000-0000-4000-8000-000000000250', 'w1', 'e7000000-0000-4000-8000-000000000250', 1)$q$, 'RB011', null, 'activate: an older version cannot replace a newer active version -> RB011');
select is((select active_version_id from public.documents where id = 'd6000000-0000-4000-8000-000000000250'), 'e6000000-0000-4000-8000-000000000250'::uuid, 'activate: the newer version is still active after the refusal');
-- Chunk-count and model checks of activate_document_version are reached through the job too.
select throws_ok($q$select public.activate_version_for_job('f3000000-0000-4000-8000-000000000250', 'w1', 'c1000000-0000-4000-8000-000000000250', 2)$q$, 'RB011', null, 'activate: chunk count mismatch -> RB011');
select throws_ok($q$select public.activate_version_for_job('f0000000-0000-4000-8000-000000000250', 'w1', 'c2000000-0000-4000-8000-000000000250', 1)$q$, 'RB011', null, 'activate: a version embedded with another model -> RB011');
select is((select count(*)::int from public.documents where id in ('dd000000-0000-4000-8000-000000000250', 'de000000-0000-4000-8000-000000000250') and active_version_id is not null), 0, 'activate: neither refused version became active');
select is((select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000250'), 1::bigint, 'activate: refused activations did not bump corpus_version');

-- ===== fail_document_version =====
select lives_ok($q$select public.fail_document_version('f7000000-0000-4000-8000-000000000250', 'w1', 'e8000000-0000-4000-8000-000000000250', 'OCR_REQUIRED')$q$, 'fail version: a first version fails with OCR_REQUIRED');
select results_eq(
  $q$select v.status, v.failure_code, v.completed_at is not null, d.status from public.document_versions v join public.documents d on d.id = v.document_id where v.id = 'e8000000-0000-4000-8000-000000000250'$q$,
  $q$values ('failed', 'OCR_REQUIRED', true, 'failed')$q$, 'fail version: version failed with the code, document failed (no active version)');
select lives_ok($q$select public.fail_document_version('f7000000-0000-4000-8000-000000000250', 'w1', 'e8000000-0000-4000-8000-000000000250', 'INDEXING_FAILED')$q$, 'fail version: failing again is idempotent');
select is((select failure_code from public.document_versions where id = 'e8000000-0000-4000-8000-000000000250'), 'OCR_REQUIRED', 'fail version: the repeat kept the first failure code');
select lives_ok($q$select public.fail_document_version('f8000000-0000-4000-8000-000000000250', 'w1', 'ea000000-0000-4000-8000-000000000250', 'BUDGET_EXCEEDED')$q$, 'fail version: a new version of a live document fails');
select results_eq(
  $q$select v.status, v.failure_code, d.status, d.active_version_id from public.document_versions v join public.documents d on d.id = v.document_id where v.id = 'ea000000-0000-4000-8000-000000000250'$q$,
  $q$values ('failed', 'BUDGET_EXCEEDED', 'ready', 'e9000000-0000-4000-8000-000000000250'::uuid)$q$, 'fail version: the live document stays ready with its active version');
select is((select status from public.document_versions where id = 'e9000000-0000-4000-8000-000000000250'), 'ready', 'fail version: the live version is untouched');
select throws_ok($q$select public.fail_document_version('f9000000-0000-4000-8000-000000000250', 'w1', 'eb000000-0000-4000-8000-000000000250', 'DISK_FULL')$q$, '22023', null, 'fail version: an unknown failure code -> 22023');
select throws_ok($q$select public.fail_document_version('f9000000-0000-4000-8000-000000000250', 'w1', 'eb000000-0000-4000-8000-000000000250', null)$q$, '22023', null, 'fail version: a null failure code -> 22023');
select is((select status from public.document_versions where id = 'eb000000-0000-4000-8000-000000000250'), 'extracting', 'fail version: refused calls left the version alone');
-- Chunks are kept when a version fails: fail the version that has chunks (e5 has 2) and count again.
select lives_ok($q$select public.fail_document_version('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250', 'SUPERSEDED')$q$, 'fail version: SUPERSEDED is a valid code');
select is((select count(*)::int from public.document_chunks where document_version_id = 'e5000000-0000-4000-8000-000000000250'), 2, 'fail version: chunks are not cleared');
select throws_ok($q$select public.write_document_chunks('f5000000-0000-4000-8000-000000000250', 'w1', 'e5000000-0000-4000-8000-000000000250',
  jsonb_build_array(jsonb_build_object('chunk_index', 2, 'content', 'late', 'embedding', current_setting('p6.emb')::jsonb)))$q$, 'RB030', null, 'chunks: a failed version takes no more chunks -> RB030');

-- ===== retry_job_later =====
select is(public.retry_job_later('f9000000-0000-4000-8000-000000000250', 'w1', 'provider_429', 30), 'queued', 'retry: with attempts left the job is queued again');
select results_eq(
  $q$select state, attempts, last_error, locked_by is null, locked_until is null, completed_at is null, available_at > now() + interval '25 seconds' and available_at <= now() + interval '35 seconds'
       from public.jobs where id = 'f9000000-0000-4000-8000-000000000250'$q$,
  $q$values ('queued', 1, 'provider_429', true, true, true, true)$q$, 'retry: lease cleared, attempts kept, error code stored, available about 30 s later');
select results_eq(
  $q$select v.status, v.failure_code, d.status from public.document_versions v join public.documents d on d.id = v.document_id where v.id = 'eb000000-0000-4000-8000-000000000250'$q$,
  $q$values ('extracting', null::text, 'indexing')$q$, 'retry: a requeue leaves the version and document alone');
select is((select count(*)::int from public.claim_jobs('w9', 1, 60, array['index_document']) where id = 'f9000000-0000-4000-8000-000000000250'), 0, 'retry: the delayed job is not claimable before its time');
reset role;
update public.jobs set state = 'running', attempts = 2, locked_by = 'w1', locked_until = now() + interval '1 hour', available_at = now() where id = 'f9000000-0000-4000-8000-000000000250';
set local role service_role;
select is(public.retry_job_later('f9000000-0000-4000-8000-000000000250', 'w1', 'provider_5xx', 30), 'failed', 'retry: on the last attempt the job dead-letters');
select results_eq(
  $q$select j.state, j.completed_at is not null, j.last_error, v.status, v.failure_code, d.status
       from public.jobs j, public.document_versions v, public.documents d
      where j.id = 'f9000000-0000-4000-8000-000000000250' and v.id = 'eb000000-0000-4000-8000-000000000250' and d.id = 'd9000000-0000-4000-8000-000000000250'$q$,
  $q$values ('failed', true, 'provider_5xx', 'failed', 'INDEXING_FAILED', 'failed')$q$, 'retry: dead-letter fails the version with INDEXING_FAILED and the document (no active version)');
select is(public.retry_job_later('ff000000-0000-4000-8000-000000000250', 'w1', 'cleanup_failed', 60), 'failed', 'retry: a cleanup job on its last attempt dead-letters');
select is((select status from public.document_versions where id = 'ee000000-0000-4000-8000-000000000250'), 'ready', 'retry: dead-lettering a cleanup job touches no version');
-- A dead-lettered index job of a live document: its version fails, the document stays ready.
reset role;
insert into public.jobs (id, type, payload, state, attempts, max_attempts, locked_by, locked_until) values
  ('a4000000-0000-4000-8000-000000000250', 'index_document', '{"bot_id":"b1000000-0000-4000-8000-000000000250","document_id":"dc000000-0000-4000-8000-000000000250","version_id":"c7000000-0000-4000-8000-000000000250"}', 'running', 3, 3, 'w1', now() + interval '1 hour');
update public.document_versions set status = 'embedding' where id = 'c7000000-0000-4000-8000-000000000250';
set local role service_role;
select is(public.retry_job_later('a4000000-0000-4000-8000-000000000250', 'w1', 'timeout', 5), 'failed', 'retry: last attempt of a live document''s new version dead-letters');
select results_eq(
  $q$select v.status, v.failure_code, d.status from public.document_versions v join public.documents d on d.id = v.document_id where v.id = 'c7000000-0000-4000-8000-000000000250'$q$,
  $q$values ('failed', 'INDEXING_FAILED', 'ready')$q$, 'retry: that version failed, the live document stays ready');
reset role;
update public.document_versions set status = 'pending_upload' where id = 'c7000000-0000-4000-8000-000000000250';
update public.document_versions set failure_code = null where id = 'c7000000-0000-4000-8000-000000000250';
set local role service_role;
select throws_ok($q$select public.retry_job_later('f9000000-0000-4000-8000-000000000250', 'w1', 'provider_429', 30)$q$, 'RB013', null, 'retry: a job that is no longer running -> RB013');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w2', 'provider_429', 30)$q$, 'RB013', null, 'retry: a worker that does not hold the job -> RB013');
select throws_ok($q$select public.retry_job_later('f1111111-0000-4000-8000-000000000250', 'w1', 'provider_429', 30)$q$, 'RB013', null, 'retry: unknown job -> RB013');
select throws_ok($q$select public.retry_job_later('fd000000-0000-4000-8000-000000000250', 'w1', 'provider_429', 30)$q$, 'RB013', null, 'retry: a succeeded job -> RB013');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', 'provider_429', 0)$q$, '22023', null, 'retry: delay 0 -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', 'provider_429', 3601)$q$, '22023', null, 'retry: delay 3601 -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', 'provider_429', null)$q$, '22023', null, 'retry: null delay -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', 'Provider 429', 30)$q$, '22023', null, 'retry: an error code with a capital and a space -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', '', 30)$q$, '22023', null, 'retry: an empty error code -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', null, 30)$q$, '22023', null, 'retry: a null error code -> 22023');
select throws_ok(format($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', '%s', 30)$q$, repeat('a', 65)), '22023', null, 'retry: an error code over 64 characters -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', 'free text with secrets', 30)$q$, '22023', null, 'retry: free text is not an error code -> 22023');
select throws_ok($q$select public.retry_job_later('f1000000-0000-4000-8000-000000000250', '', 'provider_429', 30)$q$, '22023', null, 'retry: an empty worker -> 22023');
select is((select state from public.jobs where id = 'f1000000-0000-4000-8000-000000000250'), 'running', 'retry: every refused call left the job running');
select is(public.retry_job_later('f1000000-0000-4000-8000-000000000250', 'w1', repeat('a', 64), 3600), 'queued', 'retry: a 64-character code and the 3600 s delay are accepted');

-- ===== record_usage_event =====
select lives_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', 'a2000000-0000-4000-8000-000000000250', 'openai', 'emb-model', 'embedding_index', 1200, 0.000024, 350)$q$, 'usage: an embedding_index event is recorded');
select results_eq(
  $q$select bot_id, job_id, provider, model, operation, input_tokens, output_tokens, estimated_cost, latency_ms from public.usage_events where job_id = 'a2000000-0000-4000-8000-000000000250'$q$,
  $q$values ('b1000000-0000-4000-8000-000000000250'::uuid, 'a2000000-0000-4000-8000-000000000250'::uuid, 'openai', 'emb-model', 'embedding_index', 1200, 0, 0.000024::numeric, 350)$q$, 'usage: the row has the given values');
select isnt(public.record_usage_event('b1000000-0000-4000-8000-000000000250', null, null, null, 'moderation', 0, 0, null), null, 'usage: no job, provider, model or latency is allowed; returns the id');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', null, 'p', 'm', 'telepathy', 1, 0, 1)$q$, '22023', null, 'usage: an unknown operation -> 22023');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', null, 'p', 'm', null, 1, 0, 1)$q$, '22023', null, 'usage: a null operation -> 22023');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', null, 'p', 'm', 'chat', -1, 0, 1)$q$, '22023', null, 'usage: negative input tokens -> 22023');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', null, 'p', 'm', 'chat', 1, -0.5, 1)$q$, '22023', null, 'usage: negative cost -> 22023');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', null, 'p', 'm', 'chat', 1, 0, -1)$q$, '22023', null, 'usage: negative latency -> 22023');
select throws_ok($q$select public.record_usage_event(null, null, 'p', 'm', 'chat', 1, 0, 1)$q$, '22023', null, 'usage: a null bot -> 22023');
select throws_ok($q$select public.record_usage_event('b9000000-0000-4000-8000-000000000250', null, 'p', 'm', 'chat', 1, 0, 1)$q$, '22023', null, 'usage: an unknown bot -> 22023');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', 'f1111111-0000-4000-8000-000000000250', 'p', 'm', 'chat', 1, 0, 1)$q$, '22023', null, 'usage: an unknown job -> 22023');
select throws_ok($q$select public.record_usage_event('b1000000-0000-4000-8000-000000000250', 'a3000000-0000-4000-8000-000000000250', 'p', 'm', 'chat', 1, 0, 1)$q$, '22023', null, 'usage: a job of another bot -> 22023');
select is((select count(*)::int from public.usage_events where bot_id = 'b1000000-0000-4000-8000-000000000250'), 2, 'usage: refused calls inserted nothing (two rows)');

-- ===== cleanup_document =====
select results_eq($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', 2)$q$, $q$values (2, false)$q$, 'cleanup: batch of 2 deletes 2 of 5 chunks, not done');
select results_eq($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', 2)$q$, $q$values (2, false)$q$, 'cleanup: the second batch deletes 2 more, not done');
select results_eq($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', 2)$q$, $q$values (1, true)$q$, 'cleanup: the third batch deletes the last chunk and is done');
select results_eq($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', 2)$q$, $q$values (0, true)$q$, 'cleanup: a repeat deletes nothing and is done');
select is((select count(*)::int from public.document_chunks where document_version_id in ('ee000000-0000-4000-8000-000000000250', 'ef000000-0000-4000-8000-000000000250')), 0, 'cleanup: all chunks of the deleted document are gone');
select is((select count(*)::int from public.document_chunks where document_version_id = 'e2000000-0000-4000-8000-000000000250'), 1, 'cleanup: a live document''s chunk is untouched');
select is((select count(*)::int from public.document_versions where document_id = 'd3000000-0000-4000-8000-000000000250'), 3, 'cleanup: version rows stay (their paths are read by cleanup_storage_targets)');
select throws_ok($q$select * from public.cleanup_document('d2000000-0000-4000-8000-000000000250', 10)$q$, 'RB030', null, 'cleanup: a live document -> RB030');
select throws_ok($q$select * from public.cleanup_document('d9999999-0000-4000-8000-000000000250', 10)$q$, 'RB010', null, 'cleanup: an unknown document -> RB010');
select throws_ok($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', 0)$q$, '22023', null, 'cleanup: batch 0 -> 22023');
select throws_ok($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', 1001)$q$, '22023', null, 'cleanup: batch 1001 -> 22023');
select throws_ok($q$select * from public.cleanup_document(null, 10)$q$, '22023', null, 'cleanup: null document -> 22023');
select throws_ok($q$select * from public.cleanup_document('d3000000-0000-4000-8000-000000000250', null)$q$, '22023', null, 'cleanup: null batch -> 22023');

-- ===== cleanup_storage_targets =====
-- d3 (deleted) has ee (path only-deleted), ef (path shared with live d2's versions e2 and e3 after a reindex), e0 (same path as ee).
select results_eq($q$select storage_path from public.cleanup_storage_targets('d3000000-0000-4000-8000-000000000250')$q$, $q$values ('b1000000-0000-4000-8000-000000000250/d3000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/only-deleted.txt')$q$,
  'storage targets: only the path no live document references, once; the path a live document''s versions still use is excluded');
select throws_ok($q$select * from public.cleanup_storage_targets('d2000000-0000-4000-8000-000000000250')$q$, 'RB030', null, 'storage targets: a live document -> RB030');
select throws_ok($q$select * from public.cleanup_storage_targets('d9999999-0000-4000-8000-000000000250')$q$, 'RB010', null, 'storage targets: an unknown document -> RB010');
select throws_ok($q$select * from public.cleanup_storage_targets(null)$q$, '22023', null, 'storage targets: null document -> 22023');
-- Even a failed version of a live document keeps its path: d2's reindex version e3 shares e2's path; delete d2 and the path is free.
reset role;
update public.documents set deleted_at = now(), status = 'deleted' where id = 'd2000000-0000-4000-8000-000000000250';
set local role service_role;
select results_eq($q$select storage_path from public.cleanup_storage_targets('d3000000-0000-4000-8000-000000000250') order by 1$q$, $q$values ('b1000000-0000-4000-8000-000000000250/d2000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt'), ('b1000000-0000-4000-8000-000000000250/d3000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/only-deleted.txt')$q$,
  'storage targets: once the last live document using a shared path is deleted, the path is returned');
select results_eq($q$select storage_path from public.cleanup_storage_targets('d2000000-0000-4000-8000-000000000250') order by 1$q$, $q$values ('b1000000-0000-4000-8000-000000000250/d2000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt')$q$,
  'storage targets: the reindexed document returns its shared path once (not once per version)');

-- ===== expire_abandoned_uploads =====
select throws_ok($q$select * from public.expire_abandoned_uploads(0, 10)$q$, '22023', null, 'expire: 0 hours -> 22023');
select throws_ok($q$select * from public.expire_abandoned_uploads(8761, 10)$q$, '22023', null, 'expire: 8761 hours -> 22023');
select throws_ok($q$select * from public.expire_abandoned_uploads(1, 0)$q$, '22023', null, 'expire: batch 0 -> 22023');
select throws_ok($q$select * from public.expire_abandoned_uploads(1, 1001)$q$, '22023', null, 'expire: batch 1001 -> 22023');
select throws_ok($q$select * from public.expire_abandoned_uploads(null, 10)$q$, '22023', null, 'expire: null hours -> 22023');
select throws_ok($q$select * from public.expire_abandoned_uploads(1, null)$q$, '22023', null, 'expire: null batch -> 22023');
select results_eq($q$select * from public.expire_abandoned_uploads(1, 1)$q$, $q$values ('c3000000-0000-4000-8000-000000000250'::uuid, 'b1000000-0000-4000-8000-000000000250/db000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c3.txt')$q$, 'expire: batch 1 takes the oldest pending upload only and returns its path');
select results_eq($q$select v.status, v.failure_code, v.completed_at is not null, d.status from public.document_versions v join public.documents d on d.id = v.document_id where v.id = 'c3000000-0000-4000-8000-000000000250'$q$,
  $q$values ('failed', 'INDEXING_FAILED', true, 'failed')$q$, 'expire: the version failed with INDEXING_FAILED and its draft document failed');
select is((select status from public.document_versions where id = 'c5000000-0000-4000-8000-000000000250'), 'pending_upload', 'expire: the second old one waited for the next batch');
-- c7 was set back to pending_upload (3 hours old) above; its document dc is live (ready).
select results_eq($q$select version_id, storage_path from public.expire_abandoned_uploads(1, 10)$q$, $q$values ('c7000000-0000-4000-8000-000000000250'::uuid, 'b1000000-0000-4000-8000-000000000250/dc000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/c7.txt')$q$,
  'expire: the next call fails c5 and c7 but returns only c7, because c5''s path is still referenced by another version');
select results_eq($q$select (select status from public.document_versions where id = 'c5000000-0000-4000-8000-000000000250'),
                          (select status from public.document_versions where id = 'c7000000-0000-4000-8000-000000000250'),
                          (select status from public.document_versions where id = 'c4000000-0000-4000-8000-000000000250'),
                          (select status from public.documents where id = 'dc000000-0000-4000-8000-000000000250')$q$,
  $q$values ('failed', 'failed', 'pending_upload', 'ready')$q$, 'expire: a recent pending upload is kept; a live document stays ready');
select is((select count(*)::int from public.expire_abandoned_uploads(1, 10)), 0, 'expire: nothing is left to expire, a repeat returns no rows');
select is((select status from public.document_versions where id = 'e1000000-0000-4000-8000-000000000250'), 'embedding', 'expire: versions in other states are never touched');

-- ===== grants, lock_timeout, search_path =====
reset role;
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.index_job_fence(uuid,text,uuid)'::regprocedure, 'public.get_index_job_context(uuid,text,uuid)'::regprocedure,
                    'public.update_version_progress(uuid,text,uuid,jsonb)'::regprocedure, 'public.write_document_chunks(uuid,text,uuid,jsonb)'::regprocedure,
                    'public.activate_version_for_job(uuid,text,uuid,integer)'::regprocedure, 'public.fail_document_version(uuid,text,uuid,text)'::regprocedure,
                    'public.retry_job_later(uuid,text,text,integer)'::regprocedure, 'public.record_usage_event(uuid,uuid,text,text,text,integer,numeric,integer)'::regprocedure,
                    'public.cleanup_document(uuid,integer)'::regprocedure, 'public.cleanup_storage_targets(uuid)'::regprocedure,
                    'public.expire_abandoned_uploads(integer,integer)'::regprocedure, 'public.schema_version()'::regprocedure)
      and 'lock_timeout=2s' = any (p.proconfig) and 'search_path=""' = any (p.proconfig) and not p.prosecdef),
  12, 'proconfig: all twelve functions of migration 012 set lock_timeout = 2s and an empty search_path, and are SECURITY INVOKER');
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.index_job_fence(uuid,text,uuid)'::regprocedure, 'public.get_index_job_context(uuid,text,uuid)'::regprocedure,
                    'public.update_version_progress(uuid,text,uuid,jsonb)'::regprocedure, 'public.write_document_chunks(uuid,text,uuid,jsonb)'::regprocedure,
                    'public.activate_version_for_job(uuid,text,uuid,integer)'::regprocedure, 'public.fail_document_version(uuid,text,uuid,text)'::regprocedure,
                    'public.retry_job_later(uuid,text,text,integer)'::regprocedure, 'public.record_usage_event(uuid,uuid,text,text,text,integer,numeric,integer)'::regprocedure,
                    'public.cleanup_document(uuid,integer)'::regprocedure, 'public.cleanup_storage_targets(uuid)'::regprocedure,
                    'public.expire_abandoned_uploads(integer,integer)'::regprocedure)
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)),
  11, 'grants: the eleven new functions are executable by service_role only (not anon, authenticated or PUBLIC)');
select is(public.schema_version(), 12, 'schema_version: 12');
select is(public.schema_version(), (select count(*)::int from supabase_migrations.schema_migrations), 'schema_version: equals the number of migrations in the history');
select ok(has_function_privilege('authenticated', 'public.schema_version()', 'EXECUTE') and not has_function_privilege('anon', 'public.schema_version()', 'EXECUTE'), 'schema_version: the grants of 010 are kept (authenticated yes, anon no)');
select is((select count(*)::int from pg_indexes where schemaname = 'public' and indexname = 'document_versions_pending_upload_idx'), 1, 'index: the pending-upload age index exists');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.cleanup_document(gen_random_uuid(), 1)$q$, '42501', null, 'anon: cleanup_document -> permission denied');
select throws_ok($q$select * from public.get_index_job_context(gen_random_uuid(), 'w', gen_random_uuid())$q$, '42501', null, 'anon: get_index_job_context -> permission denied');
select throws_ok($q$select * from public.index_job_fence(gen_random_uuid(), 'w', gen_random_uuid())$q$, '42501', null, 'anon: index_job_fence -> permission denied');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($q$select public.retry_job_later(gen_random_uuid(), 'w', 'x', 1)$q$, '42501', null, 'authenticated: retry_job_later -> permission denied');
select throws_ok($q$select public.write_document_chunks(gen_random_uuid(), 'w', gen_random_uuid(), '[]')$q$, '42501', null, 'authenticated: write_document_chunks -> permission denied');
select throws_ok($q$select * from public.expire_abandoned_uploads(1, 1)$q$, '42501', null, 'authenticated: expire_abandoned_uploads -> permission denied');
select throws_ok($q$select public.record_usage_event(gen_random_uuid(), null, 'p', 'm', 'chat', 1, 0, 1)$q$, '42501', null, 'authenticated: record_usage_event -> permission denied');
reset role;

-- ===== reindex carries the source version's etag and checksum (P6-D1) =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-000000000250","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_number = 2 from public.admin_reindex_document('df000000-0000-4000-8000-000000000250') r), 'reindex: the owner creates version 2 of the live document');
reset role;
select is(
  (select row(v.upload_etag, v.checksum, v.status, v.storage_path, v.media_type, v.byte_size) from public.document_versions v where v.document_id = 'df000000-0000-4000-8000-000000000250' and v.version_number = 2),
  row('etag-src'::text, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'::text, 'uploaded'::text, 'b4000000-0000-4000-8000-000000000250/df000000-0000-4000-8000-000000000250/a0000000-0000-4000-8000-000000000250/original.txt'::text, 'text/plain'::text, 100::bigint),
  'reindex: the new version has the source upload_etag and checksum, and still reuses the original and starts uploaded');
select is(
  (select row(v.upload_etag, v.checksum) from public.document_versions v where v.id = 'c9000000-0000-4000-8000-000000000250'),
  row('etag-src'::text, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'::text),
  'reindex: the source version is unchanged');
select is((select count(*)::int from public.jobs j where j.type = 'index_document' and j.payload ->> 'document_id' = 'df000000-0000-4000-8000-000000000250' and j.state = 'queued' and j.max_attempts = 3), 1, 'reindex: one queued index job with the policy attempts');
select is((select count(*)::int from public.audit_logs where action = 'document.reindex' and actor_user_id = 'a9000000-0000-4000-8000-000000000250'), 1, 'reindex: one audit row');
select is((select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.admin_reindex_document(uuid)'::regprocedure), (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.admin_document_status(uuid, integer, integer)'::regprocedure), 'reindex: the replaced function has the same owner as its siblings');
select ok((select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = 'public.admin_reindex_document(uuid)'::regprocedure), 'reindex: still SECURITY DEFINER with an empty search_path');
select ok(has_function_privilege('authenticated', 'public.admin_reindex_document(uuid)', 'execute') and not has_function_privilege('anon', 'public.admin_reindex_document(uuid)', 'execute') and not has_function_privilege('service_role', 'public.admin_reindex_document(uuid)', 'execute'), 'reindex: EXECUTE is still authenticated only');
select ok((select p.proretset and pg_get_function_result(p.oid) = 'TABLE(version_id uuid, version_number integer)' from pg_proc p where p.oid = 'public.admin_reindex_document(uuid)'::regprocedure), 'reindex: the return type is unchanged');

select * from finish();
rollback;
