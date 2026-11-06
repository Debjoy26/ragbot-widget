-- CHECK constraints for enum-like fields (canonical values) and format checks. Run as the migration owner
-- so only the constraint (not privileges) can reject the row.
begin;
select plan(46);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000e1', 'c-bot', 'x', array['en'], 'm', 1536);
insert into public.visitor_sessions (id, bot_id, expires_at) values ('a1000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-0000000000e1', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id) values ('c1000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-0000000000e1');
insert into public.documents (id, bot_id, title) values ('d1000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-0000000000e1', 'Doc');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type) values ('e1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000e1', 1, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v1.txt', 'text/plain');

-- messages
select throws_ok($q$insert into public.messages (conversation_id, role, content) values ('c1000000-0000-4000-8000-0000000000e1', 'bot', 'x')$q$, '23514', null, 'messages.role: invalid value rejected');
select throws_ok($q$insert into public.messages (conversation_id, role, content, status) values ('c1000000-0000-4000-8000-0000000000e1', 'user', 'x', 'done')$q$, '23514', null, 'messages.status: invalid value rejected');
select throws_ok($q$insert into public.messages (conversation_id, role, content, handoff_reason) values ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'x', 'because')$q$, '23514', null, 'messages.handoff_reason: invalid value rejected');
select throws_ok($q$insert into public.messages (conversation_id, role, content, handoff_reason) values ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'x', '')$q$, '23514', null, 'messages.handoff_reason: empty string rejected (null is the only "none")');
select lives_ok($q$insert into public.messages (conversation_id, role, content, handoff_reason) values
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', 'no_knowledge'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', 'out_of_scope'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', 'human_requested'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', 'blocked'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', 'unavailable'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', 'repeated_no_knowledge'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 'a', null)$q$, 'messages.handoff_reason: all six canonical values and null accepted');
select lives_ok($q$insert into public.messages (conversation_id, role, content, status) values
  ('c1000000-0000-4000-8000-0000000000e1', 'system', 's', 'complete'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 's', 'partial'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 's', 'failed'),
  ('c1000000-0000-4000-8000-0000000000e1', 'assistant', 's', 'blocked')$q$, 'messages: canonical roles/statuses accepted');

-- conversations / documents / versions
select throws_ok($q$insert into public.conversations (bot_id, status) values ('b1000000-0000-4000-8000-0000000000e1', 'archived')$q$, '23514', null, 'conversations.status: invalid value rejected');
select throws_ok($q$insert into public.documents (bot_id, title, status) values ('b1000000-0000-4000-8000-0000000000e1', 't', 'published')$q$, '23514', null, 'documents.status: invalid value rejected');
select throws_ok($q$insert into public.documents (bot_id, title, disclosure_policy) values ('b1000000-0000-4000-8000-0000000000e1', 't', 'private')$q$, '23514', null, 'documents.disclosure_policy: invalid value rejected');
select throws_ok($q$insert into public.documents (bot_id, title, status) values ('b1000000-0000-4000-8000-0000000000e1', 't', 'deleted')$q$, '23514', null, 'documents: status=deleted requires deleted_at');
insert into public.documents (id, bot_id, title) values ('d2000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-0000000000e1', 'default policy');
select is((select disclosure_policy from public.documents where id = 'd2000000-0000-4000-8000-0000000000e1'), 'excluded', 'documents.disclosure_policy defaults to excluded (fail closed)');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type, status) values ('d1000000-0000-4000-8000-0000000000e1', 2, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v2.txt', 'text/plain', 'done')$q$, '23514', null, 'document_versions.status: invalid value rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values ('d1000000-0000-4000-8000-0000000000e1', 2, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v2.txt', 'image/png')$q$, '23514', null, 'document_versions.media_type: image/png rejected (no OCR, ADR 0005)');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type, extraction_method) values ('d1000000-0000-4000-8000-0000000000e1', 2, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v2.txt', 'text/plain', 'ocr')$q$, '23514', null, 'document_versions.extraction_method: ocr rejected (ADR 0005)');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values ('d1000000-0000-4000-8000-0000000000e1', 1, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v-dup.txt', 'text/plain')$q$, '23505', null, 'document_versions: duplicate (document, version_number) rejected');
select throws_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type) values ('d1000000-0000-4000-8000-0000000000e1', 0, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v0.txt', 'text/plain')$q$, '23514', null, 'document_versions: version_number 0 rejected');
select throws_ok($q$update public.documents set active_version_id = 'e1000000-0000-4000-8000-0000000000e1' where id = 'd2000000-0000-4000-8000-0000000000e1'$q$, '23503', null, 'documents: active pointer must reference a version of the same document');
select lives_ok($q$insert into public.document_versions (document_id, version_number, storage_path, media_type, extraction_method) values
  ('d1000000-0000-4000-8000-0000000000e1', 2, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v2.txt', 'application/pdf', 'pdf_text'),
  ('d1000000-0000-4000-8000-0000000000e1', 3, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v3.txt', 'text/markdown', 'markdown'),
  ('d1000000-0000-4000-8000-0000000000e1', 4, 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/ab000000-0000-4000-8000-000000000003/c-v4.txt', 'text/plain', 'plain_text')$q$, 'document_versions: canonical media types and extraction methods accepted');
select throws_ok($q$insert into public.document_chunks (document_version_id, chunk_index, content, embedding) values ('e1000000-0000-4000-8000-0000000000e1', 0, 'a', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector), ('e1000000-0000-4000-8000-0000000000e1', 0, 'b', (select array_agg(0.1::real) from generate_series(1, 1536))::extensions.vector)$q$, '23505', null, 'document_chunks: duplicate (version, chunk_index) rejected');

-- analysis / usage / caches / config
select throws_ok($q$insert into public.conversation_analysis (conversation_id, status) values ('c1000000-0000-4000-8000-0000000000e1', 'done')$q$, '23514', null, 'conversation_analysis.status: invalid value rejected');
select throws_ok($q$insert into public.conversation_analysis (conversation_id, sentiment) values ('c1000000-0000-4000-8000-0000000000e1', 'angry')$q$, '23514', null, 'conversation_analysis.sentiment: invalid value rejected');
select throws_ok($q$insert into public.usage_events (bot_id, operation) values ('b1000000-0000-4000-8000-0000000000e1', 'search')$q$, '23514', null, 'usage_events.operation: invalid value rejected');
select throws_ok($q$insert into public.usage_events (bot_id, operation, input_tokens) values ('b1000000-0000-4000-8000-0000000000e1', 'chat', -1)$q$, '23514', null, 'usage_events: negative tokens rejected');
select lives_ok($q$insert into public.usage_events (bot_id, operation) values
  ('b1000000-0000-4000-8000-0000000000e1', 'chat'), ('b1000000-0000-4000-8000-0000000000e1', 'embedding_query'),
  ('b1000000-0000-4000-8000-0000000000e1', 'embedding_index'), ('b1000000-0000-4000-8000-0000000000e1', 'moderation'),
  ('b1000000-0000-4000-8000-0000000000e1', 'analysis'), ('b1000000-0000-4000-8000-0000000000e1', 'answer_cache_hit')$q$, 'usage_events.operation: all six canonical values accepted');
select throws_ok($q$insert into public.moderation_cache (key_hash, policy_version, verdict, expires_at) values (repeat('a', 64), 'v1', 'maybe', now())$q$, '23514', null, 'moderation_cache.verdict: invalid value rejected');
select throws_ok($q$insert into public.moderation_cache (key_hash, policy_version, verdict, expires_at) values ('raw user text', 'v1', 'allow', now())$q$, '23514', null, 'moderation_cache: key must be a 64-hex digest (no raw text)');
select throws_ok($q$insert into public.answer_cache (bot_id, cache_key_hash, language, answer_text, handoff_reason, corpus_version, settings_version, prompt_template_version, chat_model, expires_at) values ('b1000000-0000-4000-8000-0000000000e1', repeat('a', 64), 'en', 'a', 'nope', 0, 1, 'p', 'm', now())$q$, '23514', null, 'answer_cache.handoff_reason: invalid value rejected');
select throws_ok($q$insert into public.rate_limit_buckets (key_hash, window_start, window_seconds, expires_at) values ('10.0.0.1', now(), 60, now())$q$, '23514', null, 'rate_limit_buckets: plain IP as key rejected');
select throws_ok($q$insert into public.bot_profiles (slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values ('c-bot', 'x', array['en'], 'm', 1536)$q$, '23505', null, 'bot_profiles: duplicate slug rejected');
select throws_ok($q$insert into public.bot_profiles (slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values ('Bad Slug!', 'x', array['en'], 'm', 1536)$q$, '23514', null, 'bot_profiles: malformed slug rejected');
select throws_ok($q$insert into public.admin_memberships (user_id, role) values (gen_random_uuid(), 'viewer')$q$, '23514', null, 'admin_memberships.role: viewer rejected');
select throws_ok($q$insert into public.budget_reservations (bot_id, amount, state, expires_at) values ('b1000000-0000-4000-8000-0000000000e1', 1, 'pending', now())$q$, '23514', null, 'budget_reservations.state: invalid value rejected');
select throws_ok($q$insert into public.budget_reservations (bot_id, amount, expires_at) values ('b1000000-0000-4000-8000-0000000000e1', -1, now())$q$, '23514', null, 'budget_reservations: negative amount rejected');
select throws_ok($q$insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy) values ('b1000000-0000-4000-8000-0000000000e1', array['https://e.test'], '{}', '{}', '{}', '{}', '{}')$q$, '23502', null, 'client_settings: cache_policy has no default (fail closed)');
select throws_ok($q$insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values ('b1000000-0000-4000-8000-0000000000e1', array['https://e.test'], '[]', '{}', '{}', '{}', '{}', '{}')$q$, '23514', null, 'client_settings: policy must be a JSON object');

-- public_bot_config
select lives_ok($q$insert into public.public_bot_config (bot_id, bot_slug, display_name, supported_languages) values ('b1000000-0000-4000-8000-0000000000e1', 'c-bot', 'Bot', array['en'])$q$, 'public_bot_config: minimal row accepted');
select throws_ok($q$update public.public_bot_config set bot_slug = 'other-slug' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23503', null, 'public_bot_config: slug must match the bot profile slug (composite FK)');
select throws_ok($q$update public.public_bot_config set position = 'top-left' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config.position: top-left rejected');
select throws_ok($q$update public.public_bot_config set contact_page_url = 'http://example.com/contact' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: http (non-https) contact page URL rejected');
select throws_ok($q$update public.public_bot_config set contact_whatsapp_url = 'javascript:alert(1)' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: javascript: WhatsApp URL rejected');
select throws_ok($q$update public.public_bot_config set privacy_url = 'http://example.com/privacy' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: http privacy URL rejected');
select throws_ok($q$update public.public_bot_config set contact_phone = '555-1234' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: non-E.164 phone rejected');
select throws_ok($q$update public.public_bot_config set primary_color = 'blue' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: non-hex colour rejected');
select throws_ok($q$update public.public_bot_config set contact_email = 'not-an-email' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: malformed email rejected');
select throws_ok($q$update public.public_bot_config set escalation_messages = '[]'::jsonb where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, '23514', null, 'public_bot_config: escalation_messages must be a JSON object');
select lives_ok($q$update public.public_bot_config set position = 'bottom-left', contact_phone = '+919876543210', contact_page_url = 'https://example.com/contact', contact_email = 'support@example.com', primary_color = '#112233' where bot_id = 'b1000000-0000-4000-8000-0000000000e1'$q$, 'public_bot_config: valid contact + position values accepted');

select * from finish();
rollback;
