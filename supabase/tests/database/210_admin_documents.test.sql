-- P3.5 admin document RPCs (migration 009): roles and MFA for every function, input validation, audit,
-- quotas, fail-closed policy, upload completion, retry, reindex, deletion, version order, job-based budget
-- reservations and the Storage object policies. All fixtures are synthetic. Sequential only: the real
-- two-connection races are in scripts/race-db.sh.
--
-- Ids end in 000000000210: bots bN, users aN, documents dN, versions eN, jobs cN.
begin;
select plan(364);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000210', 'authenticated', 'authenticated', 'p35-owner@example.test'),
  ('a2000000-0000-4000-8000-000000000210', 'authenticated', 'authenticated', 'p35-admin@example.test'),
  ('a3000000-0000-4000-8000-000000000210', 'authenticated', 'authenticated', 'p35-analyst@example.test'),
  ('a4000000-0000-4000-8000-000000000210', 'authenticated', 'authenticated', 'p35-nonmember@example.test'),
  ('a5000000-0000-4000-8000-000000000210', 'authenticated', 'authenticated', 'p35-revoked@example.test'),
  ('a6000000-0000-4000-8000-000000000210', 'authenticated', 'authenticated', 'p35-admin2@example.test');
insert into public.admin_memberships (user_id, role, active) values
  ('a1000000-0000-4000-8000-000000000210', 'owner', true), ('a2000000-0000-4000-8000-000000000210', 'admin', true), ('a3000000-0000-4000-8000-000000000210', 'analyst', true),
  ('a5000000-0000-4000-8000-000000000210', 'admin', false), ('a6000000-0000-4000-8000-000000000210', 'admin', true);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-000000000210', 'p35-main', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-000000000210', 'p35-no-attempts', 'x', array['en'], 'm', 1536),
  ('b3000000-0000-4000-8000-000000000210', 'p35-small-quotas', 'x', array['en'], 'm', 1536),
  ('b4000000-0000-4000-8000-000000000210', 'p35-no-quotas', 'x', array['en'], 'm', 1536),
  ('b5000000-0000-4000-8000-000000000210', 'p35-empty-policy', 'x', array['en'], 'm', 1536),
  ('b6000000-0000-4000-8000-000000000210', 'p35-budget', 'x', array['en'], 'm', 1536),
  ('b7000000-0000-4000-8000-000000000210', 'p35-no-settings', 'x', array['en'], 'm', 1536),
  ('b8000000-0000-4000-8000-000000000210', 'p35-no-cap', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1048576, "index_max_attempts": 3, "cleanup_max_attempts": 4, "quotas": {"register": {"limit": 100, "window_seconds": 3600}, "upload": {"limit": 100, "window_seconds": 3600}, "reindex": {"limit": 100, "window_seconds": 3600}, "write": {"limit": 100, "window_seconds": 3600}}}', '{}', '{}'),
  ('b2000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1048576, "quotas": {"register": {"limit": 100, "window_seconds": 3600}, "upload": {"limit": 100, "window_seconds": 3600}, "reindex": {"limit": 100, "window_seconds": 3600}, "write": {"limit": 100, "window_seconds": 3600}}}', '{}', '{}'),
  ('b3000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1048576, "index_max_attempts": 3, "cleanup_max_attempts": 3, "quotas": {"register": {"limit": 2, "window_seconds": 3600}, "upload": {"limit": 1, "window_seconds": 3600}, "reindex": {"limit": 1, "window_seconds": 3600}, "write": {"limit": 1, "window_seconds": 3600}}}', '{}', '{}'),
  ('b4000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1048576, "index_max_attempts": 3, "cleanup_max_attempts": 3}', '{}', '{}'),
  ('b5000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{}', '{}', '{}'),
  ('b6000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 2}', '{}', '{}', '{}', '{}'),
  ('b8000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{}', '{}', '{}', '{}', '{}');

-- Fixture documents (inserted by the migration owner): a live document with an active version and a chunk,
-- a pending version older than 24 hours, a deleted document that still has a pending version, and a live
-- document of the small-quota bot.
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('d6000000-0000-4000-8000-000000000210', 'b1000000-0000-4000-8000-000000000210', 'Live doc', 'ready', 'public_answer'),
  ('d7000000-0000-4000-8000-000000000210', 'b1000000-0000-4000-8000-000000000210', 'Expired pending doc', 'draft', 'excluded'),
  ('d9000000-0000-4000-8000-000000000210', 'b3000000-0000-4000-8000-000000000210', 'Quota doc', 'ready', 'public_answer');
insert into public.documents (id, bot_id, title, status, disclosure_policy, deleted_at) values
  ('d8000000-0000-4000-8000-000000000210', 'b1000000-0000-4000-8000-000000000210', 'Deleted doc', 'deleted', 'excluded', now());
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, embedding_model, created_at) values
  ('e6000000-0000-4000-8000-000000000210', 'd6000000-0000-4000-8000-000000000210', 1, 'b1000000-0000-4000-8000-000000000210/d6000000-0000-4000-8000-000000000210/e6000000-0000-4000-8000-000000000210/original.pdf', 'application/pdf', 100, 'ready', 'm', now()),
  ('e7000000-0000-4000-8000-000000000210', 'd7000000-0000-4000-8000-000000000210', 1, 'b1000000-0000-4000-8000-000000000210/d7000000-0000-4000-8000-000000000210/e7000000-0000-4000-8000-000000000210/original.txt', 'text/plain', 100, 'pending_upload', null, now() - interval '25 hours'),
  ('e8000000-0000-4000-8000-000000000210', 'd8000000-0000-4000-8000-000000000210', 1, 'b1000000-0000-4000-8000-000000000210/d8000000-0000-4000-8000-000000000210/e8000000-0000-4000-8000-000000000210/original.txt', 'text/plain', 100, 'pending_upload', null, now()),
  ('e9000000-0000-4000-8000-000000000210', 'd9000000-0000-4000-8000-000000000210', 1, 'b3000000-0000-4000-8000-000000000210/d9000000-0000-4000-8000-000000000210/e9000000-0000-4000-8000-000000000210/original.txt', 'text/plain', 100, 'ready', 'm', now());
update public.documents set active_version_id = 'e6000000-0000-4000-8000-000000000210' where id = 'd6000000-0000-4000-8000-000000000210';
update public.documents set active_version_id = 'e9000000-0000-4000-8000-000000000210' where id = 'd9000000-0000-4000-8000-000000000210';
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values
  ('e6000000-0000-4000-8000-000000000210', 0, 'live-chunk', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector),
  ('e9000000-0000-4000-8000-000000000210', 0, 'quota-chunk', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector);
insert into storage.buckets (id, name) values ('scratch', 'scratch');
select set_config('t.audit0', (select count(*)::text from public.audit_logs), true);


-- ===========================================================================
-- 1. Role and MFA matrix: every function, every actor (arguments are dummies; the guard comes first)
-- ===========================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, '42501', null, 'anon: register -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, '42501', null, 'anon: add_version -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, '42501', null, 'anon: complete -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, '42501', null, 'anon: retry -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, '42501', null, 'anon: reindex -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, '42501', null, 'anon: status -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, '42501', null, 'anon: download -> permission denied (role-level, no EXECUTE)');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, '42501', null, 'anon: delete -> permission denied (role-level, no EXECUTE)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB033', null, 'nonmember: register -> not a member');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, 'RB033', null, 'nonmember: add_version -> not a member');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, 'RB033', null, 'nonmember: complete -> not a member');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, 'RB033', null, 'nonmember: retry -> not a member');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, 'RB033', null, 'nonmember: reindex -> not a member');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, 'RB033', null, 'nonmember: status -> not a member');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, 'RB033', null, 'nonmember: download -> not a member');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, 'RB033', null, 'nonmember: delete -> not a member');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB033', null, 'revoked member: register -> not a member');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, 'RB033', null, 'revoked member: add_version -> not a member');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, 'RB033', null, 'revoked member: complete -> not a member');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, 'RB033', null, 'revoked member: retry -> not a member');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, 'RB033', null, 'revoked member: reindex -> not a member');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, 'RB033', null, 'revoked member: status -> not a member');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, 'RB033', null, 'revoked member: download -> not a member');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, 'RB033', null, 'revoked member: delete -> not a member');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB033', null, 'analyst: register -> analyst is not allowed');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, 'RB033', null, 'analyst: add_version -> analyst is not allowed');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, 'RB033', null, 'analyst: complete -> analyst is not allowed');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, 'RB033', null, 'analyst: retry -> analyst is not allowed');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, 'RB033', null, 'analyst: reindex -> analyst is not allowed');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, 'RB033', null, 'analyst: download -> analyst is not allowed');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, 'RB033', null, 'analyst: delete -> analyst is not allowed');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB032', null, 'owner at aal1: register -> MFA required');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, 'RB032', null, 'owner at aal1: add_version -> MFA required');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, 'RB032', null, 'owner at aal1: complete -> MFA required');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, 'RB032', null, 'owner at aal1: retry -> MFA required');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, 'RB032', null, 'owner at aal1: reindex -> MFA required');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, 'RB032', null, 'owner at aal1: status -> MFA required');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, 'RB032', null, 'owner at aal1: download -> MFA required');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, 'RB032', null, 'owner at aal1: delete -> MFA required');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB032', null, 'admin at aal1: register -> MFA required');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, 'RB032', null, 'admin at aal1: add_version -> MFA required');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, 'RB032', null, 'admin at aal1: complete -> MFA required');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, 'RB032', null, 'admin at aal1: retry -> MFA required');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, 'RB032', null, 'admin at aal1: reindex -> MFA required');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, 'RB032', null, 'admin at aal1: status -> MFA required');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, 'RB032', null, 'admin at aal1: download -> MFA required');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, 'RB032', null, 'admin at aal1: delete -> MFA required');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, 'RB032', null, 'analyst at aal1: status -> MFA required');
reset role;
select is((select count(*)::int from public.documents where bot_id = 'b1000000-0000-4000-8000-000000000210' and id not in ('d6000000-0000-4000-8000-000000000210', 'd7000000-0000-4000-8000-000000000210', 'd8000000-0000-4000-8000-000000000210')), 0, 'matrix: no denied call created a document');
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit0')::int, 0, 'matrix: no denied call wrote an audit row');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_register_document', 'admin_add_document_version', 'admin_complete_upload', 'admin_retry_version', 'admin_reindex_document', 'admin_document_status', 'admin_request_download', 'admin_delete_document') and pg_get_function_identity_arguments(p.oid) ~* '(path|role|actor|user|attempt)'), 0, 'signatures: no browser RPC takes a path, role, actor, user or attempt limit');
select ok((select count(*) = 8 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname in ('admin_register_document', 'admin_add_document_version', 'admin_complete_upload', 'admin_retry_version', 'admin_reindex_document', 'admin_document_status', 'admin_request_download', 'admin_delete_document')), 'signatures: all eight browser RPCs are SECURITY DEFINER');

-- ===========================================================================
-- 2. Register and add version: allowed roles, generated path, stored values, audit
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.storage_path = 'b1000000-0000-4000-8000-000000000210/' || r.document_id || '/' || r.version_id || '/original.pdf' from public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Owner doc', 'application/pdf', 1000, 'public_answer') r), 'owner: register returns a path generated from bot, document and version ids (pdf)');
reset role;
select set_config('t.d1', (select id from public.documents where title = 'Owner doc')::text, true);
select set_config('t.v1', (select id from public.document_versions where document_id = current_setting('t.d1')::uuid and version_number = 1)::text, true);
select is((select row(d.bot_id, d.title, d.status, d.disclosure_policy, d.created_by, d.active_version_id, d.deleted_at) from public.documents d where d.id = current_setting('t.d1')::uuid), row('b1000000-0000-4000-8000-000000000210'::uuid, 'Owner doc'::text, 'draft'::text, 'public_answer'::text, 'a1000000-0000-4000-8000-000000000210'::uuid, null::uuid, null::timestamptz), 'register: document row has the bot, title, draft status, policy and creator');
select is((select row(v.version_number, v.status, v.media_type, v.byte_size, v.checksum, v.failure_code) from public.document_versions v where v.id = current_setting('t.v1')::uuid), row(1, 'pending_upload'::text, 'application/pdf'::text, 1000::bigint, null::text, null::text), 'register: version 1 is pending_upload with the declared type and size');
select is((select count(*)::int from public.audit_logs where action = 'document.register' and actor_user_id = 'a1000000-0000-4000-8000-000000000210' and resource_type = 'document' and resource_id = current_setting('t.d1')), 1, 'register: one audit row with the owner as actor');
select ok((select not (safe_metadata ? 'title') and safe_metadata ?& array['bot_id', 'document_id', 'version_id', 'media_type', 'byte_size'] from public.audit_logs where action = 'document.register' and resource_id = current_setting('t.d1')), 'register: audit metadata has ids and size but no title');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.storage_path = 'b1000000-0000-4000-8000-000000000210/' || r.document_id || '/' || r.version_id || '/original.md' from public.admin_register_document('b1000000-0000-4000-8000-000000000210', '  Admin doc  ', 'text/markdown', 500, 'excluded') r), 'admin: register generates an .md path for markdown');
select ok((select r.storage_path like '%/original.txt' from public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Plain doc', 'text/plain', 300, 'excluded') r), 'admin: register generates a .txt path for plain text');
select lives_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Limit doc', 'text/plain', 1048576, 'excluded')$q$, 'admin: a file of exactly max_bytes is accepted');
reset role;
select set_config('t.d2', (select id from public.documents where bot_id = 'b1000000-0000-4000-8000-000000000210' and title = 'Admin doc')::text, true);
select is((select count(*)::int from public.documents where title = 'Admin doc'), 1, 'register: the title is stored trimmed');
select set_config('t.d3', (select id from public.documents where title = 'Plain doc')::text, true);
select set_config('t.d4', (select id from public.documents where title = 'Limit doc')::text, true);
select set_config('t.v2d', (select id from public.document_versions where document_id = current_setting('t.d2')::uuid)::text, true);
select set_config('t.v3d', (select id from public.document_versions where document_id = current_setting('t.d3')::uuid)::text, true);
select set_config('t.v4d', (select id from public.document_versions where document_id = current_setting('t.d4')::uuid)::text, true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_number = 2 and r.storage_path = 'b1000000-0000-4000-8000-000000000210/' || current_setting('t.d1') || '/' || r.version_id || '/original.txt' from public.admin_add_document_version(current_setting('t.d1')::uuid, 'text/plain', 200) r), 'admin: add version returns number 2 and a generated .txt path');
reset role;
select set_config('t.v2', (select id from public.document_versions where document_id = current_setting('t.d1')::uuid and version_number = 2)::text, true);
select is((select row(v.status, v.byte_size, v.media_type) from public.document_versions v where v.id = current_setting('t.v2')::uuid), row('pending_upload'::text, 200::bigint, 'text/plain'::text), 'add version: new version is pending_upload with the declared size');
select is((select count(*)::int from public.audit_logs where action = 'document.add_version' and actor_user_id = 'a2000000-0000-4000-8000-000000000210' and resource_id = current_setting('t.v2')), 1, 'add version: one audit row');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_number = 2 from public.admin_add_document_version(current_setting('t.d3')::uuid, 'application/pdf', 900) r), 'owner: add version numbers per document (second version of another document is 2)');
reset role;
select set_config('t.v3b', (select id from public.document_versions where document_id = current_setting('t.d3')::uuid and version_number = 2)::text, true);
select set_config('t.p1', (select storage_path from public.document_versions where id = current_setting('t.v1')::uuid)::text, true);
select set_config('t.p2', (select storage_path from public.document_versions where id = current_setting('t.v2')::uuid)::text, true);

-- ===========================================================================
-- 3. Input validation: nothing is created, counted or audited when a call is refused
-- ===========================================================================
select set_config('t.docs1', (select count(*)::text from public.documents), true);
select set_config('t.vers1', (select count(*)::text from public.document_versions), true);
select set_config('t.audit1', (select count(*)::text from public.audit_logs), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document(null, 'T', 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: null bot');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', null, 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: null title');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', null, 10, 'excluded')$q$, '22023', null, 'register: null media type');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', null, 'excluded')$q$, '22023', null, 'register: null size');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, null)$q$, '22023', null, 'register: null disclosure policy (no default)');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', '', 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: empty title');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', '    ', 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: whitespace-only title');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', repeat('x', 201), 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: title over 200 characters');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', E'a\tb', 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: title with a tab');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', E'a\nb', 'text/plain', 10, 'excluded')$q$, '22023', null, 'register: title with a newline');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'image/png', 10, 'excluded')$q$, '22023', null, 'register: unsupported media type');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 0, 'excluded')$q$, '22023', null, 'register: size 0');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', -5, 'excluded')$q$, '22023', null, 'register: negative size');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'secret')$q$, '22023', null, 'register: unknown disclosure policy');
select throws_ok($q$select public.admin_register_document(gen_random_uuid(), 'T', 'text/plain', 10, 'excluded')$q$, 'RB037', null, 'register: unknown bot');
select throws_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'T', 'text/plain', 1048577, 'excluded')$q$, 'RB031', null, 'register: one byte over max_bytes -> file too large');
select throws_ok($q$select public.admin_register_document('b5000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'register: missing max_bytes fails closed');
select throws_ok($q$select public.admin_register_document('b7000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'register: bot with no client_settings fails closed');
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'register: missing quota fails closed');
select throws_ok($q$select public.admin_add_document_version(null, 'text/plain', 10)$q$, '22023', null, 'add version: null document');
select throws_ok($q$select public.admin_add_document_version(current_setting('t.d1')::uuid, null, 10)$q$, '22023', null, 'add version: null media type');
select throws_ok($q$select public.admin_add_document_version(current_setting('t.d1')::uuid, 'text/plain', null)$q$, '22023', null, 'add version: null size');
select throws_ok($q$select public.admin_add_document_version(gen_random_uuid(), 'text/plain', 10)$q$, 'RB037', null, 'add version: unknown document');
select throws_ok($q$select public.admin_add_document_version(current_setting('t.d1')::uuid, 'image/png', 10)$q$, '22023', null, 'add version: unsupported media type');
select throws_ok($q$select public.admin_add_document_version(current_setting('t.d1')::uuid, 'text/plain', 0)$q$, '22023', null, 'add version: size 0');
select throws_ok($q$select public.admin_add_document_version(current_setting('t.d1')::uuid, 'text/plain', 1048577)$q$, 'RB031', null, 'add version: over max_bytes -> file too large');
select throws_ok($q$select public.admin_complete_upload(null)$q$, '22023', null, 'complete: null id');
select throws_ok($q$select public.admin_complete_upload(gen_random_uuid())$q$, 'RB037', null, 'complete: unknown id');
select throws_ok($q$select public.admin_retry_version(null)$q$, '22023', null, 'retry: null id');
select throws_ok($q$select public.admin_retry_version(gen_random_uuid())$q$, 'RB037', null, 'retry: unknown id');
select throws_ok($q$select public.admin_reindex_document(null)$q$, '22023', null, 'reindex: null id');
select throws_ok($q$select public.admin_reindex_document(gen_random_uuid())$q$, 'RB037', null, 'reindex: unknown id');
select throws_ok($q$select public.admin_request_download(null)$q$, '22023', null, 'download: null id');
select throws_ok($q$select public.admin_request_download(gen_random_uuid())$q$, 'RB037', null, 'download: unknown id');
select throws_ok($q$select public.admin_delete_document(null)$q$, '22023', null, 'delete: null id');
select throws_ok($q$select public.admin_delete_document(gen_random_uuid())$q$, 'RB037', null, 'delete: unknown id');
select throws_ok($q$select * from public.admin_document_status(null, 100, 0)$q$, '22023', null, 'status: null bot');
select throws_ok($q$select * from public.admin_document_status(gen_random_uuid(), 100, 0)$q$, 'RB037', null, 'status: unknown bot');
reset role;
select is((select count(*)::int from public.documents) - current_setting('t.docs1')::int, 0, 'validation: refused calls created no document');
select is((select count(*)::int from public.document_versions) - current_setting('t.vers1')::int, 0, 'validation: refused calls created no version');
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit1')::int, 0, 'validation: refused calls wrote no audit row');

-- ===========================================================================
-- 4. Storage object policies (knowledge bucket): upload only to the pending path, owner and admin at aal2
-- ===========================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: anon cannot upload to the pending path');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: nonmember cannot upload to the pending path');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: revoked member cannot upload to the pending path');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: analyst cannot upload to the pending path');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: owner at aal1 cannot upload to the pending path');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: admin at aal1 cannot upload to the pending path');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1') || '.bak', '{"size": 1000}')$q$, '42501', null, 'storage: owner cannot upload to a path no version owns');
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', 'b1000000-0000-4000-8000-000000000210/d6000000-0000-4000-8000-000000000210/e6000000-0000-4000-8000-000000000210/original.pdf', '{"size": 1000}')$q$, '42501', null, 'storage: owner cannot upload to the path of an active (ready) version');
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', 'b1000000-0000-4000-8000-000000000210/d7000000-0000-4000-8000-000000000210/e7000000-0000-4000-8000-000000000210/original.txt', '{"size": 1000}')$q$, '42501', null, 'storage: owner cannot upload to a pending path older than 24 hours');
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', 'b1000000-0000-4000-8000-000000000210/d8000000-0000-4000-8000-000000000210/e8000000-0000-4000-8000-000000000210/original.txt', '{"size": 1000}')$q$, '42501', null, 'storage: owner cannot upload to the pending path of a deleted document');
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('scratch', current_setting('t.p1'), '{"size": 1000}')$q$, '42501', null, 'storage: owner cannot upload the pending path into another bucket');
select lives_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000, "mimetype": "application/pdf", "eTag": "etag-v1"}')$q$, 'storage: owner at aal2 can upload to the pending path of version 1');
select throws_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p1'), '{"size": 1000}')$q$, '23505', null, 'storage: a second upload to the same path is refused (no overwrite)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$insert into storage.objects (bucket_id, name, metadata) values ('knowledge', current_setting('t.p2'), '{"size": 200, "mimetype": "Text/Plain; charset=UTF-8", "eTag": "etag-v2"}')$q$, 'storage: admin at aal2 can upload to the pending path of version 2');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 2, 'storage: owner sees 2 object(s) in knowledge');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 2, 'storage: admin sees 2 object(s) in knowledge');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'storage: analyst sees 0 object(s) in knowledge');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'storage: nonmember sees 0 object(s) in knowledge');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'storage: revoked member sees 0 object(s) in knowledge');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal1","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'storage: owner at aal1 sees 0 object(s) in knowledge');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge'), 0, 'storage: anon sees 0 object(s) in knowledge');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select lives_ok($q$update storage.objects set name = name || '.moved' where bucket_id = 'knowledge'$q$, 'storage: anon update runs but changes no row (no UPDATE policy)');
set local storage.allow_delete_query = 'true';
select lives_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, 'storage: anon delete (storage guard lifted) removes no row (no DELETE policy)');
set local storage.allow_delete_query = 'false';
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$update storage.objects set name = name || '.moved' where bucket_id = 'knowledge'$q$, 'storage: nonmember update runs but changes no row (no UPDATE policy)');
set local storage.allow_delete_query = 'true';
select lives_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, 'storage: nonmember delete (storage guard lifted) removes no row (no DELETE policy)');
set local storage.allow_delete_query = 'false';
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$update storage.objects set name = name || '.moved' where bucket_id = 'knowledge'$q$, 'storage: analyst update runs but changes no row (no UPDATE policy)');
set local storage.allow_delete_query = 'true';
select lives_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, 'storage: analyst delete (storage guard lifted) removes no row (no DELETE policy)');
set local storage.allow_delete_query = 'false';
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$update storage.objects set name = name || '.moved' where bucket_id = 'knowledge'$q$, 'storage: owner update runs but changes no row (no UPDATE policy)');
set local storage.allow_delete_query = 'true';
select lives_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, 'storage: owner delete (storage guard lifted) removes no row (no DELETE policy)');
set local storage.allow_delete_query = 'false';
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$update storage.objects set name = name || '.moved' where bucket_id = 'knowledge'$q$, 'storage: admin update runs but changes no row (no UPDATE policy)');
set local storage.allow_delete_query = 'true';
select lives_ok($q$delete from storage.objects where bucket_id = 'knowledge'$q$, 'storage: admin delete (storage guard lifted) removes no row (no DELETE policy)');
set local storage.allow_delete_query = 'false';
reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'knowledge' and name in (current_setting('t.p1'), current_setting('t.p2'))), 2, 'storage: both originals are intact after every update and delete attempt');

-- ===========================================================================
-- 5. Complete upload: object must exist and match; one job; idempotent
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_complete_upload(current_setting('t.v3d')::uuid)$q$, 'RB038', null, 'complete: no object in Storage -> upload missing');
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.v2d')::uuid), '{"size": 499}');
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.v3b')::uuid), '{"size": 2000000}');
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.v4d')::uuid), '{}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_complete_upload(current_setting('t.v2d')::uuid)$q$, 'RB030', null, 'complete: object size differs from the registered size -> conflict');
select throws_ok($q$select public.admin_complete_upload(current_setting('t.v3b')::uuid)$q$, 'RB031', null, 'complete: object larger than max_bytes -> file too large');
select throws_ok($q$select public.admin_complete_upload(current_setting('t.v4d')::uuid)$q$, 'RB038', null, 'complete: object without a readable size -> upload missing');
reset role;
select is((select count(*)::int from public.document_versions where id in (current_setting('t.v2d')::uuid, current_setting('t.v3d')::uuid, current_setting('t.v3b')::uuid, current_setting('t.v4d')::uuid) and status = 'pending_upload'), 4, 'complete: refused versions stay pending_upload');
select is((select count(*)::int from public.jobs where type = 'index_document'), 0, 'complete: refused calls queued no job');
select is((select count(*)::int from public.audit_logs where action = 'document.complete_upload' and resource_id in (current_setting('t.v2d'), current_setting('t.v3d'), current_setting('t.v3b'), current_setting('t.v4d'))), 0, 'complete: refused calls wrote no audit row');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.status = 'uploaded' and r.job_queued from public.admin_complete_upload(current_setting('t.v1')::uuid) r), 'complete: first call marks uploaded and queues a job');
reset role;
select is((select row(v.status, d.status) from public.document_versions v join public.documents d on d.id = v.document_id where v.id = current_setting('t.v1')::uuid), row('uploaded'::text, 'indexing'::text), 'complete: version uploaded and a draft document moves to indexing');
select is((select upload_etag from public.document_versions where id = current_setting('t.v1')::uuid), 'etag-v1', 'complete: the eTag Storage reported is stored in upload_etag (P6 compares it)');
select is((select count(*)::int from public.jobs where dedupe_key = 'index:version:' || current_setting('t.v1')::uuid::text), 1, 'complete: exactly one job');
select is((select row(j.type, j.state, j.max_attempts, j.payload) from public.jobs j where j.dedupe_key = 'index:version:' || current_setting('t.v1')::uuid::text), row('index_document'::text, 'queued'::text, 3, jsonb_build_object('bot_id'::text, 'b1000000-0000-4000-8000-000000000210'::uuid, 'document_id'::text, current_setting('t.d1'::text)::uuid, 'version_id'::text, current_setting('t.v1'::text)::uuid)), 'complete: job payload is bot, document and version; attempts come from index_max_attempts');
select is((select count(*)::int from public.audit_logs where action = 'document.complete_upload' and actor_user_id = 'a1000000-0000-4000-8000-000000000210' and resource_id = current_setting('t.v1')), 1, 'complete: one audit row');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.status = 'uploaded' and not r.job_queued from public.admin_complete_upload(current_setting('t.v1')::uuid) r), 'complete: a duplicate call returns idempotently and queues nothing');
select ok((select r.job_queued from public.admin_complete_upload(current_setting('t.v2')::uuid) r), 'complete: admin completes version 2 (own upload) and queues its job');
reset role;
select is((select count(*)::int from public.jobs where dedupe_key = 'index:version:' || current_setting('t.v1')::uuid::text), 1, 'complete: duplicate complete still leaves one job');
select is((select count(*)::int from public.audit_logs where action = 'document.complete_upload' and resource_id = current_setting('t.v1')), 1, 'complete: the idempotent repeat wrote no second audit row');
select is((select status from public.documents where id = current_setting('t.d1')::uuid), 'indexing', 'complete: a second version leaves the document indexing');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_number = 2 from public.admin_add_document_version('d6000000-0000-4000-8000-000000000210', 'text/plain', 100) r), 'ready doc: add version 2 to the live document');
reset role;
select set_config('t.v6b', (select id from public.document_versions where document_id = 'd6000000-0000-4000-8000-000000000210' and version_number = 2)::text, true);
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.v6b')::uuid), '{"size": 100, "mimetype": "text/plain"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.job_queued from public.admin_complete_upload(current_setting('t.v6b')::uuid) r), 'ready doc: complete queues the job');
reset role;
select is((select row(d.status, d.active_version_id) from public.documents d where d.id = 'd6000000-0000-4000-8000-000000000210'), row('ready'::text, 'e6000000-0000-4000-8000-000000000210'::uuid), 'ready doc: stays ready with the same live version after complete');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_id is not null from public.admin_register_document('b2000000-0000-4000-8000-000000000210', 'No attempts doc', 'text/plain', 100, 'excluded') r), 'B2: register works (the attempts setting is absent, not the quotas)');
reset role;
select set_config('t.d9', (select id from public.documents where bot_id = 'b2000000-0000-4000-8000-000000000210' and title = 'No attempts doc')::text, true);
select set_config('t.v9', (select id from public.document_versions where document_id = current_setting('t.d9')::uuid)::text, true);
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.v9')::uuid), '{"size": 100}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_complete_upload(current_setting('t.v9')::uuid)$q$, 'RB036', null, 'complete: missing index_max_attempts fails closed');
select throws_ok($q$select public.admin_complete_upload('e8000000-0000-4000-8000-000000000210')$q$, 'RB037', null, 'complete: a version of a deleted document is not found');
reset role;
select is((select status from public.document_versions where id = current_setting('t.v9')::uuid), 'pending_upload', 'complete: the fail-closed call changed nothing');
select is((select count(*)::int from public.jobs where payload ->> 'bot_id' = 'b2000000-0000-4000-8000-000000000210'), 0, 'complete: and queued no job');

-- ===========================================================================
-- 6. Status (owner, admin, analyst): progress and safe failure code, no error text, deleted excluded
-- ===========================================================================
update public.document_versions set status = 'failed', failure_code = 'INDEXING_FAILED', batches_done = 2, batches_total = 5 where id = current_setting('t.v2')::uuid;
update public.jobs set last_error = 'internal detail' where dedupe_key = 'index:version:' || current_setting('t.v2')::uuid::text;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select row(s.status, s.active_version_id, s.latest_version_number, s.latest_version_status, s.batches_done, s.batches_total, s.failure_code) from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0) s where s.document_id = current_setting('t.d1')::uuid), row('indexing'::text, null::uuid, 2, 'failed'::text, 2, 5, 'INDEXING_FAILED'::text), 'status: analyst sees state, progress and the failure code');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select row(s.status, s.active_version_id, s.latest_version_number, s.latest_version_status, s.batches_done, s.batches_total, s.failure_code) from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0) s where s.document_id = current_setting('t.d1')::uuid), row('indexing'::text, null::uuid, 2, 'failed'::text, 2, 5, 'INDEXING_FAILED'::text), 'status: owner sees state, progress and the failure code');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select row(s.status, s.active_version_id, s.latest_version_number, s.latest_version_status, s.batches_done, s.batches_total, s.failure_code) from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0) s where s.document_id = current_setting('t.d1')::uuid), row('indexing'::text, null::uuid, 2, 'failed'::text, 2, 5, 'INDEXING_FAILED'::text), 'status: admin sees state, progress and the failure code');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select row(s.status, s.active_version_id, s.latest_version_number, s.latest_version_status, s.batches_done, s.batches_total, s.failure_code) from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0) s where s.document_id = 'd6000000-0000-4000-8000-000000000210'), row('ready'::text, 'e6000000-0000-4000-8000-000000000210'::uuid, 2, 'uploaded'::text, null::integer, null::integer, null::text), 'status: a ready document shows its live version and the newer uploaded one');
select ok(not exists (select 1 from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0) s where s.document_id = 'd8000000-0000-4000-8000-000000000210'), 'status: a deleted document is not listed');
select ok((select count(*) from public.admin_document_status('b3000000-0000-4000-8000-000000000210', 100, 0) s) = 1, 'status: only the requested bot documents are listed (B3 has one)');
reset role;
select ok(not exists (select 1 from pg_proc p, unnest(p.proargnames) a where p.proname = 'admin_document_status' and (a ilike '%error%' or a ilike '%path%')), 'status: the result has no error text or path column');
-- Paging (migration 010): limit 1..500 and offset >= 0 are both required.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', null, 0)$q$, '22023', null, 'status: null limit (no default)');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 10, null)$q$, '22023', null, 'status: null offset (no default)');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 0, 0)$q$, '22023', null, 'status: limit 0');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 501, 0)$q$, '22023', null, 'status: limit 501');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 10, -1)$q$, '22023', null, 'status: negative offset');
select lives_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 500, 0)$q$, 'status: limit 500 is the largest page');
select is((select count(*)::int from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 1, 0)), 1, 'status: limit 1 returns one document');
select isnt((select s.document_id from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 1, 0) s), (select s.document_id from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 1, 1) s), 'status: the next page starts at a different document');
select is((select count(*)::int from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 10, 1000)), 0, 'status: an offset past the end returns nothing');
reset role;

-- ===========================================================================
-- 7. Retry: only a failed version, one live job per version
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_retry_version(current_setting('t.v1')::uuid)$q$, 'RB030', null, 'retry: an uploaded version cannot be retried');
select throws_ok($q$select public.admin_retry_version(current_setting('t.v3d')::uuid)$q$, 'RB030', null, 'retry: a pending_upload version cannot be retried');
select throws_ok($q$select public.admin_retry_version(current_setting('t.v2')::uuid)$q$, 'RB030', null, 'retry: refused while the version still has a live job');
reset role;
select is((select row(status, failure_code, batches_done) from public.document_versions where id = current_setting('t.v2')::uuid), row('failed'::text, 'INDEXING_FAILED'::text, 2), 'retry: the refused call changed nothing');
update public.jobs set state = 'failed', completed_at = now() where dedupe_key = 'index:version:' || current_setting('t.v2')::uuid::text;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.status = 'uploaded' from public.admin_retry_version(current_setting('t.v2')::uuid) r), 'retry: a failed version with a finished job goes back to uploaded');
reset role;
select is((select row(status, failure_code, batches_done, batches_total, completed_at) from public.document_versions where id = current_setting('t.v2')::uuid), row('uploaded'::text, null::text, null::integer, null::integer, null::timestamptz), 'retry: failure code, progress and completion are cleared');
select is((select count(*)::int from public.jobs where dedupe_key = 'index:version:' || current_setting('t.v2')::uuid::text), 2, 'retry: a new job exists next to the finished one');
select is((select count(*)::int from public.jobs where dedupe_key = 'index:version:' || current_setting('t.v2')::uuid::text and state = 'queued'), 1, 'retry: exactly one live job');
select is((select count(*)::int from public.audit_logs where action = 'document.retry_version' and actor_user_id = 'a2000000-0000-4000-8000-000000000210' and resource_id = current_setting('t.v2')), 1, 'retry: one audit row');

-- A version older than the live one cannot be retried (migration 010): activation would refuse it anyway.
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('da000000-0000-4000-8000-000000000210', 'b1000000-0000-4000-8000-000000000210', 'Order doc', 'ready', 'excluded');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, failure_code, embedding_model) values
  ('ea000000-0000-4000-8000-000000000210', 'da000000-0000-4000-8000-000000000210', 1, 'b1000000-0000-4000-8000-000000000210/da000000-0000-4000-8000-000000000210/ea000000-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'failed', 'INDEXING_FAILED', 'm'),
  ('eb000000-0000-4000-8000-000000000210', 'da000000-0000-4000-8000-000000000210', 2, 'b1000000-0000-4000-8000-000000000210/da000000-0000-4000-8000-000000000210/eb000000-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'ready', null, 'm'),
  ('ec000000-0000-4000-8000-000000000210', 'da000000-0000-4000-8000-000000000210', 3, 'b1000000-0000-4000-8000-000000000210/da000000-0000-4000-8000-000000000210/ec000000-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'failed', 'INDEXING_FAILED', 'm');
update public.documents set active_version_id = 'eb000000-0000-4000-8000-000000000210' where id = 'da000000-0000-4000-8000-000000000210';
select set_config('t.jobsA', (select count(*)::text from public.jobs), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_retry_version('ea000000-0000-4000-8000-000000000210')$q$, 'RB030', null, 'retry: a failed version older than the live one is refused');
reset role;
select is((select row(status, failure_code) from public.document_versions where id = 'ea000000-0000-4000-8000-000000000210'), row('failed'::text, 'INDEXING_FAILED'::text), 'retry: the refused older version is unchanged');
select is((select count(*)::int from public.jobs) - current_setting('t.jobsA')::int, 0, 'retry: the refused older version queued no job');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.status = 'uploaded' from public.admin_retry_version('ec000000-0000-4000-8000-000000000210') r), 'retry: a failed version newer than the live one can be retried');
reset role;

-- ===========================================================================
-- 8. Reindex: new version over the same original; the live version keeps serving until activation
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_reindex_document(current_setting('t.d1')::uuid)$q$, 'RB030', null, 'reindex: a document with no active version -> conflict');
select ok((select r.version_number = 3 from public.admin_reindex_document('d6000000-0000-4000-8000-000000000210') r), 'reindex: owner creates version 3 of the live document');
reset role;
select set_config('t.v6c', (select id from public.document_versions where document_id = 'd6000000-0000-4000-8000-000000000210' and version_number = 3)::text, true);
select is((select row(v.storage_path, v.media_type, v.byte_size, v.status) from public.document_versions v where v.id = current_setting('t.v6c')::uuid), row('b1000000-0000-4000-8000-000000000210/d6000000-0000-4000-8000-000000000210/e6000000-0000-4000-8000-000000000210/original.pdf'::text, 'application/pdf'::text, 100::bigint, 'uploaded'::text), 'reindex: the new version reuses the live original and starts uploaded');
select is((select row(d.status, d.active_version_id) from public.documents d where d.id = 'd6000000-0000-4000-8000-000000000210'), row('ready'::text, 'e6000000-0000-4000-8000-000000000210'::uuid), 'reindex: the document stays ready on the same live version');
select is((select row(v.status, (select count(*)::int from public.document_chunks c where c.document_version_id = v.id)) from public.document_versions v where v.id = 'e6000000-0000-4000-8000-000000000210'), row('ready'::text, 1), 'reindex: the live version and its chunks are untouched');
select is((select j.payload from public.jobs j where j.dedupe_key = 'index:version:' || current_setting('t.v6c')::uuid::text), jsonb_build_object('bot_id', 'b1000000-0000-4000-8000-000000000210'::uuid, 'document_id', 'd6000000-0000-4000-8000-000000000210'::uuid, 'version_id', current_setting('t.v6c')::uuid), 'reindex: an index job is queued for the new version');
select is((select count(*)::int from public.audit_logs where action = 'document.reindex' and actor_user_id = 'a1000000-0000-4000-8000-000000000210'), 1, 'reindex: one audit row');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select array_agg(m.content) from public.match_document_chunks('b1000000-0000-4000-8000-000000000210', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector, 10) m where m.document_id = 'd6000000-0000-4000-8000-000000000210'), array['live-chunk'], 'reindex: the live version is still retrievable before activation');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_number = 4 from public.admin_reindex_document('d6000000-0000-4000-8000-000000000210') r), 'reindex: admin creates version 4');
select throws_ok($q$select public.admin_reindex_document('d8000000-0000-4000-8000-000000000210')$q$, 'RB037', null, 'reindex: a deleted document is not found');
reset role;
select set_config('t.v6d', (select id from public.document_versions where document_id = 'd6000000-0000-4000-8000-000000000210' and version_number = 4)::text, true);
update public.document_versions set status = 'embedding', embedding_model = 'm' where id in (current_setting('t.v6c')::uuid, current_setting('t.v6d')::uuid);
insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values (current_setting('t.v6c')::uuid, 0, 'v3-chunk', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector), (current_setting('t.v6d')::uuid, 0, 'v4-chunk', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(public.activate_document_version('d6000000-0000-4000-8000-000000000210', current_setting('t.v6d')::uuid, 1) is not null, 'activation: the newest version (4) activates');
select throws_ok($q$select public.activate_document_version('d6000000-0000-4000-8000-000000000210', current_setting('t.v6c')::uuid, 1)$q$, 'RB011', null, 'activation: an older version (3) cannot replace the newer active version (4)');
select is((select array_agg(m.content) from public.match_document_chunks('b1000000-0000-4000-8000-000000000210', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector, 10) m where m.document_id = 'd6000000-0000-4000-8000-000000000210'), array['v4-chunk'], 'activation: the newer version serves after activation');
reset role;
select is((select row(d.active_version_id, (select v.status from public.document_versions v where v.id = 'e6000000-0000-4000-8000-000000000210')) from public.documents d where d.id = 'd6000000-0000-4000-8000-000000000210'), row(current_setting('t.v6d'::text)::uuid, 'superseded'::text), 'activation: the refused older version left the pointer on version 4; the first version is superseded');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.activate_document_version('d6000000-0000-4000-8000-000000000210', 'e6000000-0000-4000-8000-000000000210', 1)$q$, 'RB011', null, 'activation: the superseded first version cannot come back');
reset role;

-- ===========================================================================
-- 9. Download request, delete, deleted documents refuse everything
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select public.admin_request_download(current_setting('t.v1')::uuid)), current_setting('t.p1'), 'download: owner gets the storage path of the version');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select is((select public.admin_request_download(current_setting('t.v2')::uuid)), current_setting('t.p2'), 'download: admin gets the storage path of the version');
select throws_ok($q$select public.admin_request_download('e8000000-0000-4000-8000-000000000210')$q$, 'RB037', null, 'download: a version of a deleted document is not found');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'document.download'), 2, 'download: one audit row per successful request, none for the refused one');
select is((select count(*)::int from public.audit_logs where action = 'document.download' and actor_user_id = 'a1000000-0000-4000-8000-000000000210' and resource_id = current_setting('t.v1')), 1, 'download: audit names the owner and the version');
select set_config('t.corpus0', (select corpus_version::text from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000210'), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_delete_document(current_setting('t.d4')::uuid)$q$, 'delete: admin deletes a document');
reset role;
select is((select row(status, deleted_at is not null) from public.documents where id = current_setting('t.d4')::uuid), row('deleted'::text, true), 'delete: document marked deleted');
select is(((select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000210') - current_setting('t.corpus0')::bigint)::int, 1, 'delete: corpus_version moves once');
select is((select row(j.state, j.max_attempts, j.payload) from public.jobs j where j.dedupe_key = 'cleanup:document:' || current_setting('t.d4')::uuid::text), row('queued'::text, 4, jsonb_build_object('bot_id'::text, 'b1000000-0000-4000-8000-000000000210'::uuid, 'scope'::text, 'document'::text, 'resource_id'::text, current_setting('t.d4'::text)::uuid)), 'delete: one cleanup job with cleanup_max_attempts and the contract payload');
select is((select count(*)::int from public.audit_logs where action = 'document.delete' and actor_user_id = 'a2000000-0000-4000-8000-000000000210' and resource_id = current_setting('t.d4')), 1, 'delete: one audit row');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
reset role;
select set_config('t.auditdel', (select count(*)::text from public.audit_logs), true);
select set_config('t.jobsdel', (select count(*)::text from public.jobs), true);
select set_config('t.writectr', (select coalesce(sum(request_count), 0)::text from public.rate_limit_buckets where key_hash = encode(sha256(convert_to('admin_quota:b1000000-0000-4000-8000-000000000210:write', 'utf8')), 'hex')), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_delete_document(current_setting('t.d4')::uuid)$q$, 'delete: a second delete is idempotent');
reset role;
select is((select count(*)::int from public.audit_logs) - current_setting('t.auditdel')::int, 0, 'delete: the repeat on an already deleted document wrote no audit row');
select is((select count(*)::int from public.jobs) - current_setting('t.jobsdel')::int, 0, 'delete: the repeat queued no job');
select is((select coalesce(sum(request_count), 0)::int from public.rate_limit_buckets where key_hash = encode(sha256(convert_to('admin_quota:b1000000-0000-4000-8000-000000000210:write', 'utf8')), 'hex')), current_setting('t.writectr')::int, 'delete: the repeat did not count against the write quota');
select is(((select corpus_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000210') - current_setting('t.corpus0')::bigint)::int, 1, 'delete: the repeat does not move corpus_version again');
select is((select count(*)::int from public.jobs where dedupe_key = 'cleanup:document:' || current_setting('t.d4')::uuid::text and state = 'queued'), 1, 'delete: the repeat leaves one live cleanup job');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_add_document_version(current_setting('t.d4')::uuid, 'text/plain', 10)$q$, 'RB037', null, 'deleted document: add version refused');
select throws_ok($q$select public.admin_complete_upload(current_setting('t.v4d')::uuid)$q$, 'RB037', null, 'deleted document: complete refused');
select throws_ok($q$select public.admin_retry_version(current_setting('t.v4d')::uuid)$q$, 'RB037', null, 'deleted document: retry refused');
select throws_ok($q$select public.admin_reindex_document(current_setting('t.d4')::uuid)$q$, 'RB037', null, 'deleted document: reindex refused');
select throws_ok($q$select public.admin_request_download(current_setting('t.v4d')::uuid)$q$, 'RB037', null, 'deleted document: download refused');
select ok(not exists (select 1 from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0) s where s.document_id = current_setting('t.d4')::uuid), 'deleted document: not listed in status');
select throws_ok($q$select public.admin_delete_document(current_setting('t.d9')::uuid)$q$, 'RB036', null, 'delete: missing cleanup_max_attempts fails closed');
reset role;
select is((select row(status, deleted_at is null) from public.documents where id = current_setting('t.d9')::uuid), row('draft'::text, true), 'delete: the fail-closed call deleted nothing');
select is((select count(*)::int from public.jobs where type = 'cleanup' and payload ->> 'resource_id' = current_setting('t.d9')), 0, 'delete: and queued no cleanup job');
select is((select count(*)::int from public.audit_logs where action = 'document.delete'), 1, 'delete: one audit row in all (the repeat on a deleted document and the fail-closed call wrote none)');

-- ===========================================================================
-- 10. Quotas (per bot, shared by related calls) and invalid quota settings
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_register_document('b3000000-0000-4000-8000-000000000210', 'Q1', 'text/plain', 10, 'excluded')$q$, 'quota: register 1 of 2 is allowed');
select lives_ok($q$select public.admin_register_document('b3000000-0000-4000-8000-000000000210', 'Q2', 'text/plain', 10, 'excluded')$q$, 'quota: register 2 of 2 is allowed');
select throws_ok($q$select public.admin_register_document('b3000000-0000-4000-8000-000000000210', 'Q3', 'text/plain', 10, 'excluded')$q$, 'RB034', null, 'quota: register 3 is refused');
reset role;
select set_config('t.dq1', (select id from public.documents where bot_id = 'b3000000-0000-4000-8000-000000000210' and title = 'Q1')::text, true);
select set_config('t.dq2', (select id from public.documents where bot_id = 'b3000000-0000-4000-8000-000000000210' and title = 'Q2')::text, true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_add_document_version(current_setting('t.dq1')::uuid, 'text/plain', 10)$q$, 'RB034', null, 'quota: add version shares the register quota');
reset role;
select is((select count(*)::int from public.documents where bot_id = 'b3000000-0000-4000-8000-000000000210' and title = 'Q3'), 0, 'quota: the refused register created nothing');
select is((select coalesce(sum(request_count), 0)::int from public.rate_limit_buckets where key_hash = encode(sha256(convert_to('admin_quota:b3000000-0000-4000-8000-000000000210:register', 'utf8')), 'hex')), 2, 'quota: refused calls are not counted (counter stays at the limit)');
select set_config('t.vq1', (select id from public.document_versions where document_id = current_setting('t.dq1')::uuid)::text, true);
select set_config('t.vq2', (select id from public.document_versions where document_id = current_setting('t.dq2')::uuid)::text, true);
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.vq1')::uuid), '{"size": 10, "mimetype": "text/plain"}');
insert into storage.objects (bucket_id, name, metadata) values ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.vq2')::uuid), '{"size": 10, "mimetype": "text/plain"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_complete_upload(current_setting('t.vq1')::uuid)$q$, 'quota: upload 1 of 1 is allowed');
select throws_ok($q$select public.admin_complete_upload(current_setting('t.vq2')::uuid)$q$, 'RB034', null, 'quota: upload 2 is refused');
reset role;
select is((select row(status, (select count(*)::int from public.jobs j where j.dedupe_key = 'index:version:' || v.id::text)) from public.document_versions v where v.id = current_setting('t.vq2')::uuid), row('pending_upload'::text, 0), 'quota: the refused upload stays pending with no job');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select r.version_number = 2 from public.admin_reindex_document('d9000000-0000-4000-8000-000000000210') r), 'quota: reindex 1 of 1 is allowed');
select throws_ok($q$select public.admin_reindex_document('d9000000-0000-4000-8000-000000000210')$q$, 'RB034', null, 'quota: reindex 2 is refused');
reset role;
select set_config('t.vb3b', (select id from public.document_versions where document_id = 'd9000000-0000-4000-8000-000000000210' and version_number = 2)::text, true);
update public.document_versions set status = 'failed', failure_code = 'INDEXING_FAILED' where id = current_setting('t.vb3b')::uuid;
update public.jobs set state = 'failed', completed_at = now() where dedupe_key = 'index:version:' || current_setting('t.vb3b')::uuid::text;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_retry_version(current_setting('t.vb3b')::uuid)$q$, 'RB034', null, 'quota: retry shares the reindex quota');
reset role;
select is((select status from public.document_versions where id = current_setting('t.vb3b')::uuid), 'failed', 'quota: the refused retry left the version failed');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select count(*) = 1 from public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Other bot is unaffected', 'text/plain', 10, 'excluded')), 'quota: another bot is not limited by this bot quota');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": {"limit": 0, "window_seconds": 60}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (limit 0) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": {"limit": "5", "window_seconds": 60}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (limit as a string) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": {"limit": 1.5, "window_seconds": 60}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (fractional limit) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": {"limit": 5, "window_seconds": 86401}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (window over a day) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": {"limit": 5}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (window missing) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": 5}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (quota not an object) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"upload": {"limit": 5, "window_seconds": 60}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'T', 'text/plain', 10, 'excluded')$q$, 'RB036', null, 'quota: invalid setting (only another kind configured) fails closed');
reset role;
update public.client_settings set upload_policy = '{"max_bytes": 1048576, "quotas": {"register": {"limit": 1, "window_seconds": 60}}}'::jsonb where bot_id = 'b4000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'Fits', 'text/plain', 10, 'excluded')$q$, 'quota: a valid setting (1 per 60 seconds) allows one call');
select throws_ok($q$select public.admin_register_document('b4000000-0000-4000-8000-000000000210', 'Over', 'text/plain', 10, 'excluded')$q$, 'RB034', null, 'quota: and refuses the next');
reset role;

-- ===========================================================================
-- 11. Revocation takes effect on the next call
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select ok((select count(*) >= 0 from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)), 'revocation: an active admin can call');
reset role;
update public.admin_memberships set active = false where user_id = 'a6000000-0000-4000-8000-000000000210';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000210', 100, 0)$q$, 'RB033', null, 'revocation: the same session is refused once the membership is revoked');
reset role;

-- ===========================================================================
-- 12. Audit helper: allowlisted keys, short scalars, an actor
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_audit('document.test', 'document', gen_random_uuid(), '{"bot_id": "x", "version_number": 3, "kind": "register"}')$q$, 'admin_audit: allowlisted keys are written');
select is((select actor_user_id from public.audit_logs where action = 'document.test'), 'a1000000-0000-4000-8000-000000000210'::uuid, 'admin_audit: the actor is auth.uid(), never an argument');
select throws_ok($q$select public.admin_audit('document.test', 'document', null, '{"title": "secret title"}')$q$, '22023', null, 'admin_audit: a title key is refused');
select throws_ok($q$select public.admin_audit('document.test', 'document', null, '{"file_name": "a.pdf"}')$q$, '22023', null, 'admin_audit: an unknown key is refused');
select throws_ok($q$select public.admin_audit('document.test', 'document', null, '{"bot_id": {"nested": 1}}')$q$, '22023', null, 'admin_audit: a nested object value is refused');
select throws_ok($q$select public.admin_audit('document.test', 'document', null, '{"bot_id": [1]}')$q$, '22023', null, 'admin_audit: an array value is refused');
select throws_ok($q$select public.admin_audit('document.test', 'document', null, jsonb_build_object('bot_id', repeat('x', 201)))$q$, '22023', null, 'admin_audit: a long string value is refused');
select throws_ok($q$select public.admin_audit('document.test', 'document', null, '[]')$q$, '22023', null, 'admin_audit: metadata that is not an object is refused');
select throws_ok($q$select public.admin_audit('Bad Action', 'document', null, '{}')$q$, '22023', null, 'admin_audit: a malformed action is refused');
select set_config('request.jwt.claims', '{}', true);
select throws_ok($q$select public.admin_audit('document.test', 'document', null, '{}')$q$, 'RB033', null, 'admin_audit: without a signed-in user nothing is written');
select is((select count(*)::int from public.audit_logs where action = 'document.test'), 1, 'admin_audit: refused calls wrote nothing');
select set_config('request.jwt.claims', '', true);
select ok(not exists (select 1 from public.audit_logs a cross join lateral jsonb_object_keys(a.safe_metadata) k where a.action like 'document.%' and k <> all (array['bot_id', 'document_id', 'version_id', 'version_number', 'media_type', 'byte_size', 'kind'])), 'audit: every document audit row uses only allowlisted metadata keys');
select ok(not exists (select 1 from public.audit_logs a where a.action like 'document.%' and a.safe_metadata::text ~* 'Owner doc|Admin doc|Plain doc|Limit doc|secret title'), 'audit: no document title appears in any audit row');

-- ===========================================================================
-- 13. Job-based budget reservations (service_role): same cap, never exceeded, idempotent, bound to a running job of the bot
-- ===========================================================================
insert into public.jobs (id, type, payload, state, max_attempts) values
  ('c1000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "b6000000-0000-4000-8000-000000000210"}', 'running', 3),
  ('c2000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "b6000000-0000-4000-8000-000000000210"}', 'running', 3),
  ('c3000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "b6000000-0000-4000-8000-000000000210"}', 'running', 3),
  ('c4000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "b6000000-0000-4000-8000-000000000210"}', 'queued', 3),
  ('c5000000-0000-4000-8000-000000000210', 'cleanup', '{"bot_id": "b6000000-0000-4000-8000-000000000210"}', 'running', 3),
  ('c6000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "b1000000-0000-4000-8000-000000000210"}', 'running', 3),
  ('c7000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "b6000000-0000-4000-8000-000000000210"}', 'succeeded', 3);
insert into public.visitor_sessions (id, bot_id, expires_at) values ('f1000000-0000-4000-8000-000000000210', 'b6000000-0000-4000-8000-000000000210', now() + interval '1 hour');
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state) values ('f2000000-0000-4000-8000-000000000210', 'b6000000-0000-4000-8000-000000000210', 'f1000000-0000-4000-8000-000000000210', '00000000-0000-4000-8000-000000000210', repeat('a', 64), 'running');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c1000000-0000-4000-8000-000000000210', 1.0, 3600) is not null, 'job budget: a running index_document job of the bot reserves 1.0 of the 2.0 cap');
reset role;
select set_config('t.r1', (select id from public.budget_reservations where job_id = 'c1000000-0000-4000-8000-000000000210')::text, true);
select is((select row(bot_id, request_id, job_id, amount, state) from public.budget_reservations where id = current_setting('t.r1')::uuid), row('b6000000-0000-4000-8000-000000000210'::uuid, null::uuid, 'c1000000-0000-4000-8000-000000000210'::uuid, 1.000000::numeric, 'reserved'::text), 'job budget: the reservation belongs to the job, not to a request');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c1000000-0000-4000-8000-000000000210', 1.0, 3600), current_setting('t.r1')::uuid, 'job budget: a retry returns the same reservation');
select ok(public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c2000000-0000-4000-8000-000000000210', 1.0, 3600) is not null, 'job budget: a second job reserves up to the cap exactly (2.0 of 2.0)');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0.01, 3600)$q$, 'RB001', null, 'job budget: one cent over the cap is refused');
select throws_ok($q$select public.reserve_request_budget('b6000000-0000-4000-8000-000000000210', 'f2000000-0000-4000-8000-000000000210', 0.5, 3600)$q$, 'RB001', null, 'job budget: job reservations count toward the request cap too (same sum)');
reset role;
select is((select coalesce(sum(amount), 0) from public.budget_reservations where bot_id = 'b6000000-0000-4000-8000-000000000210' and state = 'reserved'), 2.000000::numeric, 'job budget: reserved total never exceeds the cap');
select is((select count(*)::int from public.budget_reservations where job_id = 'c1000000-0000-4000-8000-000000000210'), 1, 'job budget: the retry did not add spend or a second row');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c4000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB004', null, 'job budget: a queued job is refused (not running)');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c7000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB004', null, 'job budget: a finished job is refused');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c5000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB004', null, 'job budget: a job of another type is refused');
select throws_ok($q$select public.reserve_job_budget('b1000000-0000-4000-8000-000000000210', 'c1000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB004', null, 'job budget: a job of another bot is refused');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c6000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB004', null, 'job budget: a job whose payload names another bot is refused');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', gen_random_uuid(), 0.1, 3600)$q$, 'RB004', null, 'job budget: an unknown job is refused');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0, 3600)$q$, '22023', null, 'job budget: amount 0 is refused');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0.1, 0)$q$, '22023', null, 'job budget: ttl 0 is refused');
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', null, 0.1, 3600)$q$, '22023', null, 'job budget: a null job is refused');
select throws_ok($q$select public.reserve_job_budget('b7000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB002', null, 'job budget: a bot with no settings fails closed');
select throws_ok($q$select public.reserve_job_budget('b8000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, 'RB002', null, 'job budget: a bot with no daily cap fails closed');
select lives_ok($q$select public.settle_budget_reservation('b6000000-0000-4000-8000-000000000210', current_setting('t.r1')::uuid, 0.75)$q$, 'job budget: settle works unchanged on a job reservation');
select lives_ok($q$select public.release_budget_reservation('b6000000-0000-4000-8000-000000000210', (select id from public.budget_reservations where job_id = 'c2000000-0000-4000-8000-000000000210'))$q$, 'job budget: release works unchanged on a job reservation');
select ok(public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 1.25, 3600) is not null, 'job budget: settled 0.75 plus new 1.25 fits the cap (released spend is free again)');
reset role;
update public.jobs set state = 'succeeded' where id = 'c1000000-0000-4000-8000-000000000210';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c1000000-0000-4000-8000-000000000210', 1.0, 3600)$q$, 'RB004', null, 'job budget: after settling, a call for a job that is no longer running is refused (a new attempt needs a running job)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, '42501', null, 'job budget: owner (authenticated) cannot execute reserve_job_budget');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select public.reserve_job_budget('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0.1, 3600)$q$, '42501', null, 'job budget: anon cannot execute reserve_job_budget');
reset role;
select throws_ok($q$insert into public.budget_reservations (bot_id, request_id, job_id, amount, expires_at) values ('b6000000-0000-4000-8000-000000000210', 'f2000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 1, now() + interval '1 hour')$q$, '23514', null, 'job budget: a reservation cannot belong to both a request and a job');
select throws_ok($q$insert into public.budget_reservations (bot_id, job_id, amount, expires_at) values ('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 1, now() + interval '1 hour')$q$, '23505', null, 'job budget: one ACTIVE (reserved) reservation per job (unique)');
select lives_ok($q$insert into public.budget_reservations (bot_id, job_id, amount, state, expires_at) values ('b6000000-0000-4000-8000-000000000210', 'c3000000-0000-4000-8000-000000000210', 0, 'released', now() + interval '1 hour')$q$, 'job budget: finished reservations of one job may pile up as history');
delete from public.jobs where id = 'c2000000-0000-4000-8000-000000000210';
select is((select count(*)::int from public.budget_reservations where bot_id = 'b6000000-0000-4000-8000-000000000210' and job_id is null and request_id is null and state = 'released'), 1, 'job budget: deleting a job keeps its reservation, detached');

-- ===========================================================================
-- 15. Debug cycle P35-D1: content type and eTag at complete, retry of a stuck version, delete cancels queued
--     index jobs, write quota, job budget across attempts
-- ===========================================================================
-- 15a. Complete checks the object's content type (parameters ignored, case ignored) and stores its eTag.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Mime wrong', 'text/plain', 10, 'excluded')$q$, 'mime: register the wrong-type fixture');
select lives_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Mime missing', 'text/plain', 10, 'excluded')$q$, 'mime: register the no-type fixture');
select lives_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Mime param', 'text/markdown', 10, 'excluded')$q$, 'mime: register the parameter fixture');
select lives_ok($q$select public.admin_register_document('b1000000-0000-4000-8000-000000000210', 'Mime noetag', 'text/plain', 10, 'excluded')$q$, 'mime: register the no-eTag fixture');
reset role;
select set_config('t.mw', (select v.id from public.document_versions v join public.documents d on d.id = v.document_id where d.title = 'Mime wrong')::text, true);
select set_config('t.mm', (select v.id from public.document_versions v join public.documents d on d.id = v.document_id where d.title = 'Mime missing')::text, true);
select set_config('t.mp', (select v.id from public.document_versions v join public.documents d on d.id = v.document_id where d.title = 'Mime param')::text, true);
select set_config('t.mn', (select v.id from public.document_versions v join public.documents d on d.id = v.document_id where d.title = 'Mime noetag')::text, true);
insert into storage.objects (bucket_id, name, metadata) values
  ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.mw')::uuid), '{"size": 10, "mimetype": "application/pdf", "eTag": "etag-mw"}'),
  ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.mm')::uuid), '{"size": 10, "eTag": "etag-mm"}'),
  ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.mp')::uuid), '{"size": 10, "mimetype": "TEXT/Markdown ; charset=utf-8", "eTag": "etag-mp"}'),
  ('knowledge', (select storage_path from public.document_versions where id = current_setting('t.mn')::uuid), '{"size": 10, "mimetype": "text/plain"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_complete_upload(current_setting('t.mw')::uuid)$q$, 'RB030', null, 'mime: a content type that differs from the registered media type -> conflict');
select throws_ok($q$select public.admin_complete_upload(current_setting('t.mm')::uuid)$q$, 'RB030', null, 'mime: an object with no content type -> conflict (fail closed)');
select ok((select r.job_queued from public.admin_complete_upload(current_setting('t.mp')::uuid) r), 'mime: "TEXT/Markdown ; charset=utf-8" matches text/markdown (parameters and case ignored)');
select ok((select r.job_queued from public.admin_complete_upload(current_setting('t.mn')::uuid) r), 'mime: an object without an eTag still completes');
reset role;
select is((select array_agg(v.status order by v.id) from public.document_versions v where v.id in (current_setting('t.mw')::uuid, current_setting('t.mm')::uuid)), array['pending_upload', 'pending_upload'], 'mime: the refused versions stay pending_upload');
select is((select count(*)::int from public.jobs where dedupe_key in ('index:version:' || current_setting('t.mw'), 'index:version:' || current_setting('t.mm'))), 0, 'mime: the refused versions queued no job');
select is((select upload_etag from public.document_versions where id = current_setting('t.mp')::uuid), 'etag-mp', 'mime: the eTag is stored at complete');
select is((select upload_etag from public.document_versions where id = current_setting('t.mn')::uuid), null::text, 'mime: no eTag in the object metadata leaves upload_etag null');
select is((select upload_etag from public.document_versions where id = current_setting('t.mw')::uuid), null::text, 'mime: a refused complete stored no eTag');

-- 15b. Retry also recovers a version stuck in uploaded, extracting or embedding with no live job.
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('dd000001-0000-4000-8000-000000000210', 'b1000000-0000-4000-8000-000000000210', 'Stuck doc', 'indexing', 'excluded');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, embedding_model, failure_code) values
  ('ee000001-0000-4000-8000-000000000210', 'dd000001-0000-4000-8000-000000000210', 1, 'b1000000-0000-4000-8000-000000000210/dd000001-0000-4000-8000-000000000210/ee000001-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'embedding', 'm', null),
  ('ee000002-0000-4000-8000-000000000210', 'dd000001-0000-4000-8000-000000000210', 2, 'b1000000-0000-4000-8000-000000000210/dd000001-0000-4000-8000-000000000210/ee000002-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'extracting', null, null),
  ('ee000003-0000-4000-8000-000000000210', 'dd000001-0000-4000-8000-000000000210', 3, 'b1000000-0000-4000-8000-000000000210/dd000001-0000-4000-8000-000000000210/ee000003-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'uploaded', null, null),
  ('ee000004-0000-4000-8000-000000000210', 'dd000001-0000-4000-8000-000000000210', 4, 'b1000000-0000-4000-8000-000000000210/dd000001-0000-4000-8000-000000000210/ee000004-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'ready', 'm', null),
  ('ee000005-0000-4000-8000-000000000210', 'dd000001-0000-4000-8000-000000000210', 5, 'b1000000-0000-4000-8000-000000000210/dd000001-0000-4000-8000-000000000210/ee000005-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'pending_upload', null, null),
  ('ee000006-0000-4000-8000-000000000210', 'dd000001-0000-4000-8000-000000000210', 6, 'b1000000-0000-4000-8000-000000000210/dd000001-0000-4000-8000-000000000210/ee000006-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'superseded', 'm', null);
-- v2 (extracting) has a live job; v3 (uploaded) only a dead-lettered one; v1 (embedding) has none.
insert into public.jobs (type, dedupe_key, payload, state, max_attempts, completed_at) values
  ('index_document', 'index:version:ee000002-0000-4000-8000-000000000210', '{"bot_id": "b1000000-0000-4000-8000-000000000210", "document_id": "dd000001-0000-4000-8000-000000000210", "version_id": "ee000002-0000-4000-8000-000000000210"}', 'running', 3, null),
  ('index_document', 'index:version:ee000003-0000-4000-8000-000000000210', '{"bot_id": "b1000000-0000-4000-8000-000000000210", "document_id": "dd000001-0000-4000-8000-000000000210", "version_id": "ee000003-0000-4000-8000-000000000210"}', 'failed', 3, now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_retry_version('ee000002-0000-4000-8000-000000000210')$q$, 'RB030', null, 'retry: an extracting version with a live job is refused');
select throws_ok($q$select public.admin_retry_version('ee000004-0000-4000-8000-000000000210')$q$, 'RB030', null, 'retry: a ready version is refused');
select throws_ok($q$select public.admin_retry_version('ee000005-0000-4000-8000-000000000210')$q$, 'RB030', null, 'retry: a pending_upload version is refused');
select throws_ok($q$select public.admin_retry_version('ee000006-0000-4000-8000-000000000210')$q$, 'RB030', null, 'retry: a superseded version is refused');
select ok((select r.status = 'uploaded' from public.admin_retry_version('ee000001-0000-4000-8000-000000000210') r), 'retry: an embedding version with no live job is recovered');
select ok((select r.status = 'uploaded' from public.admin_retry_version('ee000003-0000-4000-8000-000000000210') r), 'retry: an uploaded version whose only job was dead-lettered is recovered');
select throws_ok($q$select public.admin_retry_version('ee000001-0000-4000-8000-000000000210')$q$, 'RB030', null, 'retry: right after, the recovered version has a live job and is refused again');
reset role;
select is((select count(*)::int from public.jobs where dedupe_key in ('index:version:ee000001-0000-4000-8000-000000000210', 'index:version:ee000003-0000-4000-8000-000000000210') and state = 'queued'), 2, 'retry: each recovered version has exactly one queued job');
select is((select count(*)::int from public.jobs where dedupe_key in ('index:version:ee000002-0000-4000-8000-000000000210', 'index:version:ee000004-0000-4000-8000-000000000210', 'index:version:ee000005-0000-4000-8000-000000000210', 'index:version:ee000006-0000-4000-8000-000000000210') and state = 'queued'), 0, 'retry: the refused versions got no queued job');
select is((select status from public.document_versions where id = 'ee000002-0000-4000-8000-000000000210'), 'extracting', 'retry: the refused extracting version is unchanged');

-- 15c. A first delete cancels the document's queued index jobs (not a running one); the repeat does nothing.
insert into public.documents (id, bot_id, title, status, disclosure_policy) values
  ('dd000002-0000-4000-8000-000000000210', 'b1000000-0000-4000-8000-000000000210', 'Cancel doc', 'indexing', 'excluded');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status) values
  ('ee000011-0000-4000-8000-000000000210', 'dd000002-0000-4000-8000-000000000210', 1, 'b1000000-0000-4000-8000-000000000210/dd000002-0000-4000-8000-000000000210/ee000011-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'uploaded'),
  ('ee000012-0000-4000-8000-000000000210', 'dd000002-0000-4000-8000-000000000210', 2, 'b1000000-0000-4000-8000-000000000210/dd000002-0000-4000-8000-000000000210/ee000012-0000-4000-8000-000000000210/original.txt', 'text/plain', 10, 'embedding');
insert into public.jobs (type, dedupe_key, payload, state, max_attempts) values
  ('index_document', 'index:version:ee000011-0000-4000-8000-000000000210', '{"bot_id": "b1000000-0000-4000-8000-000000000210", "document_id": "dd000002-0000-4000-8000-000000000210", "version_id": "ee000011-0000-4000-8000-000000000210"}', 'queued', 3),
  ('index_document', 'index:version:ee000012-0000-4000-8000-000000000210', '{"bot_id": "b1000000-0000-4000-8000-000000000210", "document_id": "dd000002-0000-4000-8000-000000000210", "version_id": "ee000012-0000-4000-8000-000000000210"}', 'running', 3);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_delete_document('dd000002-0000-4000-8000-000000000210')$q$, 'delete: a document with a queued and a running index job');
reset role;
select is((select j.state from public.jobs j where j.dedupe_key = 'index:version:ee000011-0000-4000-8000-000000000210'), 'cancelled', 'delete: the queued index job is cancelled');
select ok((select j.completed_at is not null from public.jobs j where j.dedupe_key = 'index:version:ee000011-0000-4000-8000-000000000210'), 'delete: the cancelled job has a completion time (purge clock)');
select is((select j.state from public.jobs j where j.dedupe_key = 'index:version:ee000012-0000-4000-8000-000000000210'), 'running', 'delete: a running index job is left alone');
select is((select j.state from public.jobs j where j.dedupe_key = 'cleanup:document:dd000002-0000-4000-8000-000000000210'), 'queued', 'delete: the cleanup job is queued');
select ok((select count(*) >= 1 from public.jobs j where j.type = 'index_document' and j.state = 'queued' and j.payload ->> 'document_id' = current_setting('t.d1')), 'delete: a queued index job of another document is untouched');
select set_config('t.auditdel2', (select count(*)::text from public.audit_logs), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_delete_document('dd000002-0000-4000-8000-000000000210')$q$, 'delete: the repeat returns');
reset role;
select is((select count(*)::int from public.audit_logs) - current_setting('t.auditdel2')::int, 0, 'delete: the repeat wrote no audit row');
select is((select count(*)::int from public.jobs where payload ->> 'document_id' = 'dd000002-0000-4000-8000-000000000210' or payload ->> 'resource_id' = 'dd000002-0000-4000-8000-000000000210'), 3, 'delete: the repeat queued nothing (two index jobs and one cleanup job)');

-- 15d. Write quota (download request and delete share it); a bot without a write quota fails closed.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_request_download('e9000000-0000-4000-8000-000000000210')$q$, 'write quota: download 1 of 1 is allowed');
select throws_ok($q$select public.admin_request_download('e9000000-0000-4000-8000-000000000210')$q$, 'RB034', null, 'write quota: download 2 is refused');
select throws_ok($q$select public.admin_delete_document('d9000000-0000-4000-8000-000000000210')$q$, 'RB034', null, 'write quota: delete shares the write quota and is refused');
reset role;
select is((select status from public.documents where id = 'd9000000-0000-4000-8000-000000000210'), 'ready', 'write quota: the refused delete changed nothing');
select is((select count(*)::int from public.jobs where payload ->> 'resource_id' = 'd9000000-0000-4000-8000-000000000210'), 0, 'write quota: and queued no cleanup job');
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b9000000-0000-4000-8000-000000000210', 'p35-no-write', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b9000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1048576, "index_max_attempts": 3, "cleanup_max_attempts": 3, "quotas": {"register": {"limit": 100, "window_seconds": 3600}, "upload": {"limit": 100, "window_seconds": 3600}, "reindex": {"limit": 100, "window_seconds": 3600}}}', '{}', '{}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_register_document('b9000000-0000-4000-8000-000000000210', 'No write quota doc', 'text/plain', 10, 'excluded')$q$, 'write quota: register still works without a write quota');
reset role;
select set_config('t.dnw', (select id from public.documents where bot_id = 'b9000000-0000-4000-8000-000000000210')::text, true);
select set_config('t.vnw', (select id from public.document_versions where document_id = current_setting('t.dnw')::uuid)::text, true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000210","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_request_download(current_setting('t.vnw')::uuid)$q$, 'RB036', null, 'write quota: download without a write quota fails closed');
select throws_ok($q$select public.admin_delete_document(current_setting('t.dnw')::uuid)$q$, 'RB036', null, 'write quota: delete without a write quota fails closed');
reset role;
select is((select deleted_at is null from public.documents where id = current_setting('t.dnw')::uuid), true, 'write quota: the fail-closed delete deleted nothing');
select is((select count(*)::int from public.audit_logs where action in ('document.download', 'document.delete') and safe_metadata ->> 'bot_id' = 'b9000000-0000-4000-8000-000000000210'), 0, 'write quota: and the refused calls wrote no audit row');

-- 15e. Job budget across attempts: reserve, release, requeue, reserve; settled and expired reservations are history.
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('ba000000-0000-4000-8000-000000000210', 'p35-attempts', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('ba000000-0000-4000-8000-000000000210', array['https://e.test'], '{}', '{"daily_cap_usd": 2}', '{}', '{}', '{}', '{}');
insert into public.jobs (id, type, payload, state, max_attempts) values
  ('c8000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "ba000000-0000-4000-8000-000000000210"}', 'running', 3),
  ('c9000000-0000-4000-8000-000000000210', 'index_document', '{"bot_id": "ba000000-0000-4000-8000-000000000210"}', 'running', 3);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('t.ra1', public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 1.0, 3600)::text, true);
select lives_ok($q$select public.release_budget_reservation('ba000000-0000-4000-8000-000000000210', current_setting('t.ra1')::uuid)$q$, 'attempts: attempt 1 releases its reservation');
reset role;
update public.jobs set state = 'queued', locked_by = null, locked_until = null where id = 'c8000000-0000-4000-8000-000000000210';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 1.0, 3600)$q$, 'RB004', null, 'attempts: a requeued (not running) job cannot reserve');
reset role;
update public.jobs set state = 'running' where id = 'c8000000-0000-4000-8000-000000000210';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('t.ra2', public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 1.0, 3600)::text, true);
select isnt(current_setting('t.ra2')::uuid, current_setting('t.ra1')::uuid, 'attempts: reserve, release, requeue, reserve gives a NEW reservation');
select is(public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 1.0, 3600), current_setting('t.ra2')::uuid, 'attempts: a repeat during attempt 2 returns the same active reservation (idempotent)');
reset role;
select is((select array_agg(state order by created_at, state) from public.budget_reservations where job_id = 'c8000000-0000-4000-8000-000000000210'), array['released', 'reserved'], 'attempts: the released row is kept as history next to the active one');
select is((select coalesce(sum(amount), 0) from public.budget_reservations where bot_id = 'ba000000-0000-4000-8000-000000000210' and state = 'reserved'), 1.000000::numeric, 'attempts: only attempt 2 holds budget');
-- settle attempt 2, requeue, attempt 3: the settled spend counts and the new spend is checked against the cap (2.0)
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($q$select public.settle_budget_reservation('ba000000-0000-4000-8000-000000000210', current_setting('t.ra2')::uuid, 1.5)$q$, 'attempts: attempt 2 settles 1.5');
select throws_ok($q$select public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 0.6, 3600)$q$, 'RB001', null, 'attempts: settled 1.5 plus a new 0.6 exceeds the 2.0 cap, so attempt 3 is refused');
select ok(public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 0.5, 3600) is not null, 'attempts: settled 1.5 plus a new 0.5 fits the cap exactly, so attempt 3 reserves');
reset role;
select is((select array_agg(state order by state) from public.budget_reservations where job_id = 'c8000000-0000-4000-8000-000000000210'), array['released', 'reserved', 'settled'], 'attempts: three attempts, three rows (released, settled, reserved)');
select is((select coalesce(sum(amount), 0) from public.budget_reservations where bot_id = 'ba000000-0000-4000-8000-000000000210' and state in ('settled', 'reserved')), 2.000000::numeric, 'attempts: the counted spend is exactly the cap');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c9000000-0000-4000-8000-000000000210', 0.01, 3600)$q$, 'RB001', null, 'attempts: another job of the bot is refused at the cap (one cent over)');
reset role;
-- an expired but still 'reserved' row keeps counting, because a stale worker can still settle it (R3-3)
update public.budget_reservations set expires_at = now() - interval '1 minute' where job_id = 'c8000000-0000-4000-8000-000000000210' and state = 'reserved';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 0.4, 3600)$q$, 'RB001', null, 'attempts: an expired reservation still counts, so the next attempt is refused at the cap');
select public.settle_budget_reservation('ba000000-0000-4000-8000-000000000210', (select id from public.budget_reservations where job_id = 'c8000000-0000-4000-8000-000000000210' and state = 'reserved'), 0.1);
select set_config('t.ra4', public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 0.4, 3600)::text, true);
reset role;
select is((select array_agg(state order by state) from public.budget_reservations where job_id = 'c8000000-0000-4000-8000-000000000210'), array['released', 'reserved', 'settled', 'settled'], 'attempts: settling the stale row frees the difference for the next attempt');
select is((select coalesce(sum(amount), 0) from public.budget_reservations where bot_id = 'ba000000-0000-4000-8000-000000000210' and state in ('settled', 'reserved') and (state = 'settled' or expires_at > now())), 2.000000::numeric, 'attempts: the expired row is not counted, so the replacement fits the cap');
-- an expired row cannot be reserved over the cap
update public.budget_reservations set expires_at = now() - interval '1 minute' where id = current_setting('t.ra4')::uuid;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 0.6, 3600)$q$, 'RB001', null, 'attempts: after expiry the new attempt still respects the cap (settled 1.5 plus 0.6)');
reset role;
select is((select state from public.budget_reservations where id = current_setting('t.ra4')::uuid), 'reserved', 'attempts: the cap refusal rolled back, so the old row is unchanged');
-- the active-reservation rule also covers a finished job: a reserved, unexpired row is returned even then
update public.budget_reservations set expires_at = now() + interval '1 hour' where id = current_setting('t.ra4')::uuid;
update public.jobs set state = 'succeeded' where id = 'c8000000-0000-4000-8000-000000000210';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.reserve_job_budget('ba000000-0000-4000-8000-000000000210', 'c8000000-0000-4000-8000-000000000210', 0.5, 3600), current_setting('t.ra4')::uuid, 'attempts: an active unexpired reservation is returned idempotently even after the job finished');
reset role;

-- ===========================================================================
-- 14. Catalog
-- ===========================================================================
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'document_versions_storage_path_idx') and not exists (select 1 from pg_constraint where conname = 'document_versions_storage_path_key'), 'catalog: storage_path is indexed, no longer unique (reindex reuses the original)');
select ok((select indexdef like '%UNIQUE%job_id%WHERE%reserved%' from pg_indexes where schemaname = 'public' and indexname = 'budget_reservations_job_id_key'), 'catalog: one ACTIVE reservation per job is a unique partial index over state = reserved');
select lives_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values ('d7000000-0000-4000-8000-000000000210', 2, 'b1000000-0000-4000-8000-000000000210/d7000000-0000-4000-8000-000000000210/e7000000-0000-4000-8000-000000000210/original.txt', 'text/plain')$q$, 'catalog: two versions may share one storage_path');
select * from finish();
rollback;
