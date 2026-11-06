-- P3-D5 fixes: migration 008 (G-1 cleanup payload, G-2 settings_version, G-3 live-job dedupe,
-- G-4 message_sources ownership, G-5 system messages, G-6 document_versions columns, G-7 job purge,
-- G-8 storage_path pattern) plus the G-9 test gaps (query_embedding_cache purge, argument bounds,
-- source-deletion snapshot, data_entries conversation FK). All fixtures are synthetic.
-- Sequential only: the real two-connection races are in scripts/race-db.sh.
--
-- Ids: bots bN, users aN, conversations cN, messages 8N, documents dN, versions eN, chunks fN,
-- all '...-0000-4000-8000-0000000000d5'.
begin;
select plan(149);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-0000000000d5', 'authenticated', 'authenticated', 'd5-analyst@example.test'),
  ('a2000000-0000-4000-8000-0000000000d5', 'authenticated', 'authenticated', 'd5-admin@example.test'),
  ('a3000000-0000-4000-8000-0000000000d5', 'authenticated', 'authenticated', 'd5-owner@example.test');
insert into public.admin_memberships (user_id, role) values
  ('a1000000-0000-4000-8000-0000000000d5', 'analyst'),
  ('a2000000-0000-4000-8000-0000000000d5', 'admin'),
  ('a3000000-0000-4000-8000-0000000000d5', 'owner');

insert into public.bot_profiles (id, slug, identity_prompt, tone, scope, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000d5', 'd5-one', 'x', 't', 's', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000d5', 'd5-two', 'x', 't', 's', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000d5', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}'),
  ('b2000000-0000-4000-8000-0000000000d5', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}');
insert into public.public_bot_config (bot_id, bot_slug, display_name, supported_languages) values
  ('b1000000-0000-4000-8000-0000000000d5', 'd5-one', 'One', array['en']);

insert into public.conversations (id, bot_id) values
  ('c1000000-0000-4000-8000-0000000000d5', 'b1000000-0000-4000-8000-0000000000d5'),
  ('c2000000-0000-4000-8000-0000000000d5', 'b2000000-0000-4000-8000-0000000000d5');
insert into public.messages (id, conversation_id, role, content) values
  ('81000000-0000-4000-8000-0000000000d5', 'c1000000-0000-4000-8000-0000000000d5', 'user', 'q'),
  ('82000000-0000-4000-8000-0000000000d5', 'c1000000-0000-4000-8000-0000000000d5', 'assistant', 'a'),
  ('83000000-0000-4000-8000-0000000000d5', 'c1000000-0000-4000-8000-0000000000d5', 'system', 'hidden'),
  ('84000000-0000-4000-8000-0000000000d5', 'c2000000-0000-4000-8000-0000000000d5', 'assistant', 'other bot');

insert into public.documents (id, bot_id, title) values
  ('d1000000-0000-4000-8000-0000000000d5', 'b1000000-0000-4000-8000-0000000000d5', 'Doc 1'),
  ('d2000000-0000-4000-8000-0000000000d5', 'b2000000-0000-4000-8000-0000000000d5', 'Doc 2'),
  ('d3000000-0000-4000-8000-0000000000d5', 'b1000000-0000-4000-8000-0000000000d5', 'Doc 3');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type) values
  ('e1000000-0000-4000-8000-0000000000d5', 'd1000000-0000-4000-8000-0000000000d5', 1, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-0000000000d5/f.txt', 'text/plain'),
  ('e2000000-0000-4000-8000-0000000000d5', 'd1000000-0000-4000-8000-0000000000d5', 2, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e2000000-0000-4000-8000-0000000000d5/f.txt', 'text/plain'),
  ('e3000000-0000-4000-8000-0000000000d5', 'd2000000-0000-4000-8000-0000000000d5', 1, 'b2000000-0000-4000-8000-0000000000d5/d2000000-0000-4000-8000-0000000000d5/e3000000-0000-4000-8000-0000000000d5/f.txt', 'text/plain'),
  ('e4000000-0000-4000-8000-0000000000d5', 'd3000000-0000-4000-8000-0000000000d5', 1, 'b1000000-0000-4000-8000-0000000000d5/d3000000-0000-4000-8000-0000000000d5/e4000000-0000-4000-8000-0000000000d5/f.txt', 'text/plain');
insert into public.document_chunks (id, document_version_id, chunk_index, content, embedding)
select c.id::uuid, c.ver::uuid, 0, 'chunk', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector
  from (values
    ('f1000000-0000-4000-8000-0000000000d5', 'e1000000-0000-4000-8000-0000000000d5'),
    ('f2000000-0000-4000-8000-0000000000d5', 'e2000000-0000-4000-8000-0000000000d5'),
    ('f3000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-0000000000d5'),
    ('f4000000-0000-4000-8000-0000000000d5', 'e4000000-0000-4000-8000-0000000000d5')) as c (id, ver);

-- ===========================================================================
-- G-1: the cleanup job payload has exactly the shape shared/src/schemas.ts accepts
-- ===========================================================================
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.mark_document_deleted('d3000000-0000-4000-8000-0000000000d5', 4), 1::bigint,
  'G-1: mark_document_deleted still returns the new corpus_version');
select is((select array_agg(k order by k) from public.jobs j, jsonb_object_keys(j.payload) k where j.dedupe_key = 'cleanup:document:d3000000-0000-4000-8000-0000000000d5'),
  array['bot_id', 'resource_id', 'scope'], 'G-1: the cleanup payload has exactly bot_id, scope and resource_id');
select is((select payload from public.jobs where dedupe_key = 'cleanup:document:d3000000-0000-4000-8000-0000000000d5'),
  '{"bot_id": "b1000000-0000-4000-8000-0000000000d5", "scope": "document", "resource_id": "d3000000-0000-4000-8000-0000000000d5"}'::jsonb,
  'G-1: payload values are the bot id, scope document and the document id');
select ok(not (select payload ? 'document_id' from public.jobs where dedupe_key = 'cleanup:document:d3000000-0000-4000-8000-0000000000d5'),
  'G-1: the old document_id key is gone');

-- ===========================================================================
-- G-3: dedupe_key is unique among live jobs only
-- ===========================================================================
reset role;
select is((select count(*)::int from pg_constraint where conname = 'jobs_dedupe_key_key'), 0, 'G-3: the unconditional unique constraint is gone');
select is((select indexdef like '%WHERE%queued%running%' from pg_indexes where indexname = 'jobs_dedupe_key_live_key'), true,
  'G-3: the live-job partial unique index exists');
insert into public.jobs (id, type, dedupe_key, max_attempts, state) values
  ('a0000001-0000-4000-8000-0000000000d5', 'cleanup', 'd5-queued', 3, 'queued'),
  ('a0000002-0000-4000-8000-0000000000d5', 'cleanup', 'd5-running', 3, 'running');
select throws_ok($q$insert into public.jobs (type, dedupe_key, max_attempts) values ('cleanup', 'd5-queued', 3)$q$, '23505', null,
  'G-3: a duplicate of a queued job is rejected');
select throws_ok($q$insert into public.jobs (type, dedupe_key, max_attempts, state) values ('cleanup', 'd5-running', 3, 'running')$q$, '23505', null,
  'G-3: a duplicate of a running job is rejected');
select lives_ok($q$insert into public.jobs (type, dedupe_key, max_attempts) values ('cleanup', 'd5-queued', 3)
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing$q$,
  'G-3: ON CONFLICT on the live-job index accepts a live duplicate silently');
select is((select count(*)::int from public.jobs where dedupe_key = 'd5-queued'), 1, 'G-3: the live duplicate was dropped, not inserted');
update public.jobs set state = 'succeeded', completed_at = now() where id = 'a0000001-0000-4000-8000-0000000000d5';
update public.jobs set state = 'failed', completed_at = now() where id = 'a0000002-0000-4000-8000-0000000000d5';
select lives_ok($q$insert into public.jobs (type, dedupe_key, max_attempts) values ('cleanup', 'd5-queued', 3), ('cleanup', 'd5-running', 3)$q$,
  'G-3: the key of a succeeded or failed job can be queued again');
select is((select count(*)::int from public.jobs where dedupe_key = 'd5-queued'), 2, 'G-3: the finished job is kept next to the new one');
select throws_ok($q$insert into public.jobs (type, dedupe_key, max_attempts) values ('cleanup', 'd5-queued', 3)$q$, '23505', null,
  'G-3: the new live job blocks a third');
-- Through the RPC: finish the cleanup job, delete again, and a second job is queued.
update public.jobs set state = 'succeeded', completed_at = now() where dedupe_key = 'cleanup:document:d3000000-0000-4000-8000-0000000000d5';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.mark_document_deleted('d3000000-0000-4000-8000-0000000000d5', 4);
select is((select count(*)::int || ':' || count(*) filter (where state = 'queued')::int from public.jobs where dedupe_key = 'cleanup:document:d3000000-0000-4000-8000-0000000000d5'),
  '2:1', 'G-3: mark_document_deleted queues a new cleanup job once the first one has finished');
select public.mark_document_deleted('d3000000-0000-4000-8000-0000000000d5', 4);
select is((select count(*)::int from public.jobs where dedupe_key = 'cleanup:document:d3000000-0000-4000-8000-0000000000d5'),
  2, 'G-3: a second delete while the new job is live adds nothing');
reset role;

-- ===========================================================================
-- G-2: settings_version moves with settings, not with corpus or timestamps
-- ===========================================================================
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 1, 'G-2: a new bot starts at settings_version 1');
update public.bot_profiles set identity_prompt = 'y' where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 2, 'G-2: identity_prompt change bumps by one');
update public.bot_profiles set tone = 'u' where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 3, 'G-2: tone change bumps by one');
update public.bot_profiles set scope = 'v' where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 4, 'G-2: scope change bumps by one');
update public.bot_profiles set allowed_languages = array['en', 'de'] where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 5, 'G-2: allowed_languages change bumps by one');
update public.bot_profiles set enabled = true where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 6,
  'G-2: enabling bumps by exactly one (the is_published sync does not count again)');
select is((select is_published from public.public_bot_config where bot_id = 'b1000000-0000-4000-8000-0000000000d5'), true, 'G-2: enabling still publishes the public config');
update public.bot_profiles set enabled = false where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 7, 'G-2: disabling bumps by exactly one');
select is((select is_published from public.public_bot_config where bot_id = 'b1000000-0000-4000-8000-0000000000d5'), false, 'G-2: disabling still unpublishes the public config');
update public.bot_profiles set identity_prompt = 'w', tone = 'k' where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 8, 'G-2: several columns in one UPDATE bump once');
update public.bot_profiles set identity_prompt = identity_prompt, tone = tone, scope = scope,
  allowed_languages = allowed_languages, enabled = enabled where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 8, 'G-2: a no-op UPDATE of the watched columns does not bump');
update public.bot_profiles set corpus_version = corpus_version + 1 where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 8, 'G-2: a corpus_version change does not bump');
update public.bot_profiles set updated_at = now() + interval '1 second' where id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 8, 'G-2: an updated_at-only change does not bump');

update public.client_settings set rate_policy = '{"concurrent_requests_per_session": 2}' where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 9, 'G-2: client_settings rate_policy change bumps by one');
update public.client_settings set rate_policy = rate_policy where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 9, 'G-2: a no-op client_settings UPDATE does not bump');
update public.client_settings set updated_at = now() + interval '1 second' where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 9, 'G-2: a client_settings updated_at-only change does not bump');
update public.client_settings set allowed_origins = array['https://e.test', 'https://f.test'] where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 10, 'G-2: client_settings allowed_origins change bumps by one');
update public.client_settings set feature_flags = '{"x": true}' where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 11, 'G-2: client_settings feature_flags change bumps by one');

update public.public_bot_config set display_name = 'Two' where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 12, 'G-2: public_bot_config display_name change bumps by one');
update public.public_bot_config set display_name = display_name where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 12, 'G-2: a no-op public_bot_config UPDATE does not bump');
update public.public_bot_config set updated_at = now() + interval '1 second' where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 12, 'G-2: a public_bot_config updated_at-only change does not bump');
update public.public_bot_config set is_published = true where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 12, 'G-2: a caller-supplied is_published (overwritten by the sync trigger) does not bump');
update public.public_bot_config set greeting = 'hello' where bot_id = 'b1000000-0000-4000-8000-0000000000d5';
select is((select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-0000000000d5'), 13, 'G-2: public_bot_config greeting change bumps by one');
select is((select settings_version from public.bot_profiles where id = 'b2000000-0000-4000-8000-0000000000d5'), 1, 'G-2: another bot''s settings_version is untouched');
select lives_ok($q$update public.bot_profiles set slug = 'd5-one-renamed' where id = 'b1000000-0000-4000-8000-0000000000d5'$q$,
  'G-2: a slug rename (cascades to public_bot_config) runs without trigger recursion errors');

-- ===========================================================================
-- G-4: message_sources ownership; G-9: source-deletion snapshot
-- ===========================================================================
select lives_ok($q$insert into public.message_sources (id, message_id, chunk_id, document_version_id, source_label, excerpt) values
  ('51000000-0000-4000-8000-0000000000d5', '82000000-0000-4000-8000-0000000000d5', 'f1000000-0000-4000-8000-0000000000d5', 'e1000000-0000-4000-8000-0000000000d5', 'S1', 'x1'),
  ('52000000-0000-4000-8000-0000000000d5', '82000000-0000-4000-8000-0000000000d5', 'f2000000-0000-4000-8000-0000000000d5', 'e2000000-0000-4000-8000-0000000000d5', 'S2', 'x2'),
  ('53000000-0000-4000-8000-0000000000d5', '82000000-0000-4000-8000-0000000000d5', 'f4000000-0000-4000-8000-0000000000d5', 'e4000000-0000-4000-8000-0000000000d5', 'S3', 'x3')$q$,
  'G-4: sources whose chunk and version belong to the message bot (and to each other) are accepted');
select lives_ok($q$insert into public.message_sources (message_id, chunk_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'f1000000-0000-4000-8000-0000000000d5', 'chunk only')$q$,
  'G-4: a chunk link without a version link is accepted when the chunk is the bot''s');
select lives_ok($q$insert into public.message_sources (message_id, document_version_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'e1000000-0000-4000-8000-0000000000d5', 'version only')$q$,
  'G-4: a version link without a chunk link is accepted when the version is the bot''s');
select lives_ok($q$insert into public.message_sources (message_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'no links')$q$,
  'G-4: a source with both links null is accepted');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'f3000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: another bot''s chunk is rejected');
select throws_ok($q$insert into public.message_sources (message_id, document_version_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: another bot''s document version is rejected');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, document_version_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'f3000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: another bot''s chunk and version together are rejected');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, document_version_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'f2000000-0000-4000-8000-0000000000d5', 'e1000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: a chunk of a different version of the same bot is rejected');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, document_version_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', 'f1000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: the bot''s chunk with another bot''s version is rejected');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, source_label) values ('84000000-0000-4000-8000-0000000000d5', 'f1000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: the same rule holds from the other side (bot 2''s message cannot cite bot 1''s chunk)');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, source_label) values ('82000000-0000-4000-8000-0000000000d5', gen_random_uuid(), 'x')$q$,
  '23514', null, 'G-4: an unknown chunk is rejected');
select throws_ok($q$insert into public.message_sources (message_id, chunk_id, source_label) values (gen_random_uuid(), 'f1000000-0000-4000-8000-0000000000d5', 'x')$q$,
  '23514', null, 'G-4: a link on an unknown message is rejected');
select throws_ok($q$update public.message_sources set chunk_id = 'f3000000-0000-4000-8000-0000000000d5' where id = '51000000-0000-4000-8000-0000000000d5'$q$,
  '23514', null, 'G-4: re-pointing a source at another bot''s chunk is rejected');
select throws_ok($q$update public.message_sources set document_version_id = 'e3000000-0000-4000-8000-0000000000d5' where id = '51000000-0000-4000-8000-0000000000d5'$q$,
  '23514', null, 'G-4: re-pointing a source at another bot''s version is rejected');
select throws_ok($q$update public.message_sources set message_id = '84000000-0000-4000-8000-0000000000d5' where id = '51000000-0000-4000-8000-0000000000d5'$q$,
  '23514', null, 'G-4: moving a source to another bot''s message is rejected');
select lives_ok($q$update public.message_sources set source_label = 'S1 renamed' where id = '51000000-0000-4000-8000-0000000000d5'$q$,
  'G-4: a label-only update is accepted');
select lives_ok($q$update public.message_sources set chunk_id = null, document_version_id = null where source_label = 'no links'$q$,
  'G-4: setting links to null is accepted');

-- G-9: deleting a chunk, a version and a document keeps the snapshot with null links.
delete from public.document_chunks where id = 'f1000000-0000-4000-8000-0000000000d5';
select is((select chunk_id is null and document_version_id = 'e1000000-0000-4000-8000-0000000000d5' and source_label = 'S1 renamed' and excerpt = 'x1'
             from public.message_sources where id = '51000000-0000-4000-8000-0000000000d5'),
  true, 'G-9: deleting a chunk nulls chunk_id and keeps the version link, label and excerpt');
delete from public.document_versions where id = 'e2000000-0000-4000-8000-0000000000d5';
select is((select chunk_id is null and document_version_id is null and source_label = 'S2' and excerpt = 'x2'
             from public.message_sources where id = '52000000-0000-4000-8000-0000000000d5'),
  true, 'G-9: deleting a version nulls both links and keeps label and excerpt');
delete from public.documents where id = 'd3000000-0000-4000-8000-0000000000d5';
select is((select chunk_id is null and document_version_id is null and source_label = 'S3' and excerpt = 'x3'
             from public.message_sources where id = '53000000-0000-4000-8000-0000000000d5'),
  true, 'G-9: deleting a document nulls both links and keeps label and excerpt');
select is((select count(*)::int from public.messages where id = '82000000-0000-4000-8000-0000000000d5'), 1, 'G-9: the cited message survives the source deletions');

-- ===========================================================================
-- G-5: members never read system messages
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-0000000000d5","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.messages where role = 'system'), 0, 'G-5: analyst (aal2) cannot see system messages');
select is((select count(*)::int from public.messages where conversation_id = 'c1000000-0000-4000-8000-0000000000d5'), 2, 'G-5: analyst (aal2) still sees user and assistant messages');
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-0000000000d5","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.messages where role = 'system'), 0, 'G-5: admin (aal2) cannot see system messages');
select is((select count(*)::int from public.messages where conversation_id = 'c1000000-0000-4000-8000-0000000000d5'), 2, 'G-5: admin (aal2) still sees user and assistant messages');
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-0000000000d5","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.messages where role = 'system'), 0, 'G-5: owner (aal2) cannot see system messages');
select is((select count(*)::int from public.messages where conversation_id = 'c1000000-0000-4000-8000-0000000000d5'), 2, 'G-5: owner (aal2) still sees user and assistant messages');
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-0000000000d5","aal":"aal1","role":"authenticated"}', true);
select is((select count(*)::int from public.messages), 0, 'G-5: owner at aal1 sees no messages at all');
reset role;
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'messages_select_members' and qual like '%system%'),
  1, 'G-5: the messages policy keeps its name and excludes system in its qualifier');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*)::int from public.messages where role = 'system'), 1, 'G-5: service_role still reads system messages');
reset role;

-- ===========================================================================
-- G-6: document_versions columns and CHECKs
-- ===========================================================================
select is((select failure_code is null and batches_done is null and batches_total is null and chunking_version is null and extraction_version is null
             from public.document_versions where id = 'e1000000-0000-4000-8000-0000000000d5'),
  true, 'G-6: the new columns default to null');
select lives_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type, failure_code) values
  ('d1000000-0000-4000-8000-0000000000d5', 11, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d511/f.txt', 'text/plain', 'FILE_UNSUPPORTED'),
  ('d1000000-0000-4000-8000-0000000000d5', 12, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d512/f.txt', 'text/plain', 'OCR_REQUIRED'),
  ('d1000000-0000-4000-8000-0000000000d5', 13, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d513/f.txt', 'text/plain', 'INDEXING_FAILED'),
  ('d1000000-0000-4000-8000-0000000000d5', 14, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d514/f.txt', 'text/plain', 'BUDGET_EXCEEDED'),
  ('d1000000-0000-4000-8000-0000000000d5', 15, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d515/f.txt', 'text/plain', 'SUPERSEDED')$q$,
  'G-6: all five contract failure codes are accepted');
select throws_ok($q$update public.document_versions set failure_code = 'OTHER' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: an unknown failure_code is rejected');
select throws_ok($q$update public.document_versions set failure_code = 'file_unsupported' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: a lowercase failure_code is rejected');
select throws_ok($q$update public.document_versions set failure_code = '' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: an empty failure_code is rejected');
select lives_ok($q$update public.document_versions set batches_done = 3, batches_total = 5 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: batches_done below batches_total is accepted');
select lives_ok($q$update public.document_versions set batches_done = 5, batches_total = 5 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: batches_done equal to batches_total is accepted');
select lives_ok($q$update public.document_versions set batches_done = 0, batches_total = 0 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: zero of zero batches is accepted');
select lives_ok($q$update public.document_versions set batches_done = null, batches_total = 5 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: a total without a done count is accepted');
select lives_ok($q$update public.document_versions set batches_done = 3, batches_total = null where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: a done count without a total is accepted');
select throws_ok($q$update public.document_versions set batches_done = 6, batches_total = 5 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: batches_done above batches_total is rejected');
select throws_ok($q$update public.document_versions set batches_done = -1, batches_total = 5 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: negative batches_done is rejected');
select throws_ok($q$update public.document_versions set batches_done = null, batches_total = -1 where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: negative batches_total is rejected');
select lives_ok($q$update public.document_versions set chunking_version = 'chunk-v1', extraction_version = 'extract-v1' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: chunking_version and extraction_version accept a short label');
select lives_ok($q$update public.document_versions set chunking_version = null, extraction_version = null where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, 'G-6: chunking_version and extraction_version accept null');
select throws_ok($q$update public.document_versions set chunking_version = '' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: an empty chunking_version is rejected');
select throws_ok($q$update public.document_versions set extraction_version = '' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: an empty extraction_version is rejected');
select throws_ok($q$update public.document_versions set chunking_version = repeat('a', 65) where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: a 65 character chunking_version is rejected');
select throws_ok($q$update public.document_versions set extraction_version = repeat('a', 65) where id = 'e1000000-0000-4000-8000-0000000000d5'$q$, '23514', null, 'G-6: a 65 character extraction_version is rejected');

-- ===========================================================================
-- G-8: storage_path pattern {uuid}/{uuid}/{uuid}/{filename}
-- ===========================================================================
select lives_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 21, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d521/manual (v2).pdf', 'application/pdf')$q$,
  'G-8: a canonical path with spaces and punctuation in the filename is accepted');
select lives_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 22, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d522/résumé.pdf', 'application/pdf')$q$,
  'G-8: a non-ASCII filename is accepted');
select lives_ok(format($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 23, %L, 'text/plain')$q$,
  'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d523/' || repeat('a', 255)),
  'G-8: a 255 character filename is accepted');
select throws_ok(format($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 30, %L, 'text/plain')$q$,
  'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d530/' || repeat('a', 256)),
  '23514', null, 'G-8: a 256 character filename is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 31, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d531/..', 'text/plain')$q$,
  '23514', null, 'G-8: a filename of ".." is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 32, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d532/a..b.txt', 'text/plain')$q$,
  '23514', null, 'G-8: ".." inside the filename is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 33, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d533/../x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a traversal segment before the filename is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 34, '../d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d534/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: ".." in place of the bot segment is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 35, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d535/.', 'text/plain')$q$,
  '23514', null, 'G-8: a filename of "." is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 36, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d536/sub/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a nested path after the version segment is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 37, 'd1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d537/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a path with too few segments is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 38, 'not-a-uuid/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d538/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a non-uuid bot segment is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 39, 'b1000000-0000-4000-8000-0000000000d5/doc/e1000000-0000-4000-8000-00000000d539/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a non-uuid document segment is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 40, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/v1/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a non-uuid version segment is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 41, 'B1000000-0000-4000-8000-0000000000D5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d541/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: an uppercase uuid is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 42, '/b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d542/x.txt', 'text/plain')$q$,
  '23514', null, 'G-8: a leading slash is rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 43, 'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d543/', 'text/plain')$q$,
  '23514', null, 'G-8: an empty filename is rejected');
select throws_ok(format($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 44, %L, 'text/plain')$q$,
  'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d544/a' || chr(10) || 'b.txt'),
  '23514', null, 'G-8: a newline in the filename is rejected');
select throws_ok(format($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 45, %L, 'text/plain')$q$,
  'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d545/a.txt' || chr(10)),
  '23514', null, 'G-8: a trailing newline is rejected');
select throws_ok(format($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 46, %L, 'text/plain')$q$,
  'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d546/a' || chr(9) || 'b.txt'),
  '23514', null, 'G-8: a tab in the filename is rejected');
select throws_ok(format($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values
  ('d1000000-0000-4000-8000-0000000000d5', 47, %L, 'text/plain')$q$,
  'b1000000-0000-4000-8000-0000000000d5/d1000000-0000-4000-8000-0000000000d5/e1000000-0000-4000-8000-00000000d547/a' || chr(127) || 'b.txt'),
  '23514', null, 'G-8: a DEL character in the filename is rejected');
select throws_ok($q$update public.document_versions set storage_path = 'path/ver1' where id = 'e1000000-0000-4000-8000-0000000000d5'$q$,
  '23514', null, 'G-8: an old-style path is rejected on UPDATE too');

-- ===========================================================================
-- G-7: purge_terminal_jobs
-- ===========================================================================
insert into public.jobs (id, type, dedupe_key, max_attempts, state, created_at, completed_at) values
  ('a1000001-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t1', 3, 'succeeded', now() - interval '41 days', now() - interval '40 days'),
  ('a1000002-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t2', 3, 'failed', now() - interval '41 days', now() - interval '40 days'),
  ('a1000003-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t3', 3, 'cancelled', now() - interval '40 days', null),
  ('a1000004-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t4', 3, 'succeeded', now() - interval '6 days', now() - interval '5 days'),
  ('a1000005-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t5', 3, 'queued', now() - interval '40 days', null),
  ('a1000006-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t6', 3, 'running', now() - interval '40 days', null),
  ('a1000007-0000-4000-8000-0000000000d5', 'cleanup', 'd5-t7', 3, 'cancelled', now() - interval '3 days', null);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.purge_terminal_jobs(30, 2), 2, 'G-7: the batch limit bounds the number of deleted jobs');
select is(public.purge_terminal_jobs(30, 100), 1, 'G-7: the remaining old terminal job is deleted next');
select is((select array_agg(dedupe_key order by dedupe_key) from public.jobs where dedupe_key like 'd5-t%'),
  array['d5-t4', 'd5-t5', 'd5-t6', 'd5-t7'],
  'G-7: young terminal jobs and queued or running jobs of any age are kept');
select is(public.purge_terminal_jobs(30, 100), 0, 'G-7: a second run deletes nothing');
select is(public.purge_terminal_jobs(2, 100), 2, 'G-7: a cancelled job without completed_at ages by created_at; terminal jobs past 2 days go');
select throws_ok($q$select public.purge_terminal_jobs(0, 10)$q$, '22023', null, 'G-7: days 0 rejected');
select throws_ok($q$select public.purge_terminal_jobs(3651, 10)$q$, '22023', null, 'G-7: days 3651 rejected');
select throws_ok($q$select public.purge_terminal_jobs(null, 10)$q$, '22023', null, 'G-7: null days rejected');
select throws_ok($q$select public.purge_terminal_jobs(30, 0)$q$, '22023', null, 'G-7: batch 0 rejected');
select throws_ok($q$select public.purge_terminal_jobs(30, 10001)$q$, '22023', null, 'G-7: batch 10001 rejected');
select throws_ok($q$select public.purge_terminal_jobs(30, null)$q$, '22023', null, 'G-7: null batch rejected');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select public.purge_terminal_jobs(30, 10)$q$, '42501', null, 'G-7: anon cannot execute purge_terminal_jobs');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-0000000000d5","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.purge_terminal_jobs(30, 10)$q$, '42501', null, 'G-7: an owner at aal2 cannot execute purge_terminal_jobs');
reset role;

-- ===========================================================================
-- G-9: query_embedding_cache purge, argument bounds, data_entries conversation FK
-- ===========================================================================
insert into public.query_embedding_cache (key_hash, embedding_model, expires_at, embedding)
select repeat(k, 64), 'm', now() + make_interval(mins => m), (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector
  from (values ('1', -10), ('2', -10), ('3', -10), ('4', 60)) as t (k, m);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((public.purge_expired_caches(2) ->> 'query_embedding_cache')::int, 2, 'G-9: purge_expired_caches deletes expired query_embedding_cache rows up to the batch');
select is((public.purge_expired_caches(100) ->> 'query_embedding_cache')::int, 1, 'G-9: the next run deletes the rest of the expired rows');
select is((select array_agg(key_hash) from public.query_embedding_cache), array[repeat('4', 64)], 'G-9: the unexpired query_embedding_cache row is kept');

select throws_ok($q$select public.purge_expired_rate_limit_buckets(0)$q$, '22023', null, 'G-9: purge_expired_rate_limit_buckets batch 0 rejected');
select throws_ok($q$select public.purge_expired_rate_limit_buckets(100001)$q$, '22023', null, 'G-9: purge_expired_rate_limit_buckets batch 100001 rejected');
select throws_ok($q$select public.purge_expired_rate_limit_buckets(null)$q$, '22023', null, 'G-9: purge_expired_rate_limit_buckets null batch rejected');
select throws_ok($q$select public.purge_expired_caches(0)$q$, '22023', null, 'G-9: purge_expired_caches batch 0 rejected');
select throws_ok($q$select public.purge_expired_caches(100001)$q$, '22023', null, 'G-9: purge_expired_caches batch 100001 rejected');
select throws_ok($q$select public.purge_expired_caches(null)$q$, '22023', null, 'G-9: purge_expired_caches null batch rejected');
select throws_ok($q$select public.expire_stale_budget_reservations(0)$q$, '22023', null, 'G-9: expire_stale_budget_reservations batch 0 rejected');
select throws_ok($q$select public.expire_stale_budget_reservations(10001)$q$, '22023', null, 'G-9: expire_stale_budget_reservations batch 10001 rejected');
select throws_ok($q$select public.expire_stale_budget_reservations(null)$q$, '22023', null, 'G-9: expire_stale_budget_reservations null batch rejected');
select throws_ok($q$select public.purge_expired_usage_records(0)$q$, '22023', null, 'G-9: purge_expired_usage_records batch 0 rejected');
select throws_ok($q$select public.purge_expired_usage_records(100001)$q$, '22023', null, 'G-9: purge_expired_usage_records batch 100001 rejected');
select throws_ok($q$select public.purge_expired_usage_records(null)$q$, '22023', null, 'G-9: purge_expired_usage_records null batch rejected');
select throws_ok($q$select public.expire_visitor_sessions(10001, 60)$q$, '22023', null, 'G-9: expire_visitor_sessions batch 10001 rejected');
select throws_ok($q$select public.expire_visitor_sessions(0, 60)$q$, '22023', null, 'G-9: expire_visitor_sessions batch 0 rejected');
select throws_ok($q$select public.expire_visitor_sessions(null, 60)$q$, '22023', null, 'G-9: expire_visitor_sessions null batch rejected');
select throws_ok($q$select public.expire_visitor_sessions(10, 0)$q$, '22023', null, 'G-9: expire_visitor_sessions grace 0 rejected');
select throws_ok($q$select public.expire_visitor_sessions(10, 86401)$q$, '22023', null, 'G-9: expire_visitor_sessions grace 86401 rejected');
select throws_ok($q$select public.expire_visitor_sessions(10, null)$q$, '22023', null, 'G-9: expire_visitor_sessions null grace rejected');
select lives_ok($q$select public.expire_visitor_sessions(10000, 60)$q$, 'G-9: expire_visitor_sessions accepts the upper bound 10000');
reset role;

select lives_ok($q$insert into public.data_entries (bot_id, conversation_id, schema_key, payload) values ('b1000000-0000-4000-8000-0000000000d5', 'c1000000-0000-4000-8000-0000000000d5', 'k', '{}')$q$,
  'G-9: a data entry for the bot''s own conversation is accepted');
select throws_ok($q$insert into public.data_entries (bot_id, conversation_id, schema_key, payload) values ('b1000000-0000-4000-8000-0000000000d5', 'c2000000-0000-4000-8000-0000000000d5', 'k', '{}')$q$,
  '23503', null, 'G-9: data_entries_conversation_fk rejects another bot''s conversation');
select lives_ok($q$insert into public.data_entries (bot_id, conversation_id, schema_key, payload) values ('b1000000-0000-4000-8000-0000000000d5', null, 'k', '{}')$q$,
  'G-9: a data entry without a conversation is still accepted');

select * from finish();
rollback;
