-- Retention helpers (ADR 0006): fail closed on missing config; purge by configured age; expiry helpers.
begin;
select plan(22);

-- The seed bot already has full retention config; give the fixture bot its own.
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000aa', 'r-bot', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000aa', array['https://e.test'], '{}', '{}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}');

insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-0000000000aa', 'b1000000-0000-4000-8000-0000000000aa', now() - interval '1 minute'),
  ('a2000000-0000-4000-8000-0000000000ab', 'b1000000-0000-4000-8000-0000000000aa', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id, created_at, last_message_at) values
  ('c1000000-0000-4000-8000-0000000000aa', 'b1000000-0000-4000-8000-0000000000aa', 'a1000000-0000-4000-8000-0000000000aa', now() - interval '120 days', now() - interval '100 days'),
  ('c2000000-0000-4000-8000-0000000000ab', 'b1000000-0000-4000-8000-0000000000aa', 'a2000000-0000-4000-8000-0000000000ab', now() - interval '120 days', now() - interval '10 days');
insert into public.messages (conversation_id, role, content) values
  ('c1000000-0000-4000-8000-0000000000aa', 'user', 'old question'),
  ('c2000000-0000-4000-8000-0000000000ab', 'user', 'recent question');
insert into public.data_entries (id, bot_id, conversation_id, schema_key, payload) values
  ('de000000-0000-4000-8000-0000000000aa', 'b1000000-0000-4000-8000-0000000000aa', 'c1000000-0000-4000-8000-0000000000aa', 'k', '{}');
insert into public.usage_events (bot_id, operation, created_at) values
  ('b1000000-0000-4000-8000-0000000000aa', 'chat', now() - interval '14 months'),
  ('b1000000-0000-4000-8000-0000000000aa', 'chat', now() - interval '12 months'),
  ('b1000000-0000-4000-8000-0000000000aa', 'chat', now());
insert into public.rate_limit_buckets (key_hash, window_start, window_seconds, request_count, expires_at) values
  (repeat('a', 64), now() - interval '2 hours', 60, 1, now() - interval '1 hour'),
  (repeat('b', 64), now(), 60, 1, now() + interval '1 hour');
insert into public.moderation_cache (key_hash, policy_version, verdict, expires_at) values
  (repeat('a', 64), 'v1', 'allow', now() - interval '1 minute'), (repeat('b', 64), 'v1', 'allow', now() + interval '1 hour');
insert into public.answer_cache (bot_id, cache_key_hash, language, answer_text, corpus_version, settings_version, prompt_template_version, chat_model, expires_at) values
  ('b1000000-0000-4000-8000-0000000000aa', repeat('a', 64), 'en', 'x', 0, 1, 'p', 'm', now() - interval '1 minute'),
  ('b1000000-0000-4000-8000-0000000000aa', repeat('b', 64), 'en', 'x', 0, 1, 'p', 'm', now() + interval '1 hour');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fail closed: a bot with no / invalid retention config blocks the purge entirely.
reset role;
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b2000000-0000-4000-8000-0000000000ab', 'r-bot-noconfig', 'x', array['en'], 'm', 1536);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok('select public.purge_expired_conversations(100)', 'RB020', null, 'retention: bot without client_settings -> purge_expired_conversations fails closed');
select throws_ok('select public.purge_expired_usage_records(100)', 'RB020', null, 'retention: bot without client_settings -> purge_expired_usage_records fails closed');
reset role;
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b2000000-0000-4000-8000-0000000000ab', array['https://e.test'], '{}', '{}', '{"conversation_days": "ninety"}', '{}', '{}', '{}');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok('select public.purge_expired_conversations(100)', 'RB020', null, 'retention: non-numeric conversation_days fails closed');
select throws_ok('select public.purge_expired_usage_records(100)', 'RB020', null, 'retention: missing usage_months fails closed');
select is((select count(*)::int from public.conversations where id in ('c1000000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000ab')), 2, 'retention: failed-closed purges deleted nothing');
reset role;
update public.client_settings set retention_policy = '{"conversation_days": 0, "usage_months": 0}' where bot_id = 'b2000000-0000-4000-8000-0000000000ab';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok('select public.purge_expired_conversations(100)', 'RB020', null, 'retention: zero conversation_days rejected (no "delete everything" by misconfig)');
reset role;
update public.client_settings set retention_policy = '{"conversation_days": 90, "usage_months": 13}' where bot_id = 'b2000000-0000-4000-8000-0000000000ab';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Argument bounds.
select throws_ok('select public.purge_expired_conversations(0)', '22023', null, 'retention: batch 0 rejected');
select throws_ok('select public.expire_visitor_sessions(null)', '22023', null, 'retention: null batch rejected');

-- Purge by configured age.
select is(public.purge_expired_conversations(100), 1, 'retention: exactly the conversation older than 90 days is purged');
select is((select count(*)::int from public.conversations where id = 'c1000000-0000-4000-8000-0000000000aa'), 0, 'retention: old conversation deleted');
select is((select count(*)::int from public.conversations where id = 'c2000000-0000-4000-8000-0000000000ab'), 1, 'retention: recent conversation kept');
select is((select count(*)::int from public.messages where content = 'old question'), 0, 'retention: messages cascade with the conversation');
select is((select count(*)::int from public.messages where content = 'recent question'), 1, 'retention: recent messages kept');
select is((select conversation_id from public.data_entries where id = 'de000000-0000-4000-8000-0000000000aa'), null, 'retention: data_entries are detached, not deleted (retention for entries is an open item)');

select is((public.purge_expired_usage_records(100) ->> 'usage_events')::int, 1, 'retention: only the usage event older than 13 months is purged');
select is((select count(*)::int from public.usage_events where bot_id = 'b1000000-0000-4000-8000-0000000000aa'), 2, 'retention: newer usage events kept');

select is(public.expire_visitor_sessions(100), 1, 'retention: expired visitor session deleted');
select is((select count(*)::int from public.visitor_sessions where id = 'a2000000-0000-4000-8000-0000000000ab'), 1, 'retention: live session kept');
select is(public.purge_expired_rate_limit_buckets(100), 1, 'retention: expired rate-limit bucket deleted');
select is((select count(*)::int from public.rate_limit_buckets where key_hash = repeat('b', 64)), 1, 'retention: live bucket kept');
select is(public.purge_expired_caches(100), '{"answer_cache": 1, "moderation_cache": 1, "query_embedding_cache": 0}'::jsonb, 'retention: only expired cache rows are purged');
select is((select count(*)::int from public.answer_cache where cache_key_hash = repeat('b', 64)), 1, 'retention: live cache row kept');

reset role;
select * from finish();
rollback;
