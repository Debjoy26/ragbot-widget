-- Retention helpers (ADR 0006): fail closed on missing config; purge by configured age; expiry helpers.
begin;
select plan(45);

-- The seed bot already has full retention config; give the fixture bot its own.
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000aa', 'r-bot', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000aa', array['https://e.test'], '{}', '{}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}');

insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-0000000000aa', 'b1000000-0000-4000-8000-0000000000aa', now() - interval '1 minute'),
  ('a2000000-0000-4000-8000-0000000000ab', 'b1000000-0000-4000-8000-0000000000aa', now() + interval '1 hour'),
  ('a3000000-0000-4000-8000-0000000000ac', 'b1000000-0000-4000-8000-0000000000aa', now() - interval '10 seconds');
insert into public.conversations (id, bot_id, visitor_session_id, created_at, last_message_at) values
  ('c1000000-0000-4000-8000-0000000000aa', 'b1000000-0000-4000-8000-0000000000aa', 'a1000000-0000-4000-8000-0000000000aa', now() - interval '120 days', now() - interval '100 days'),
  ('c2000000-0000-4000-8000-0000000000ab', 'b1000000-0000-4000-8000-0000000000aa', 'a2000000-0000-4000-8000-0000000000ab', now() - interval '120 days', now() - interval '10 days');
insert into public.messages (conversation_id, role, content) values
  ('c1000000-0000-4000-8000-0000000000aa', 'user', 'old question'),
  ('c2000000-0000-4000-8000-0000000000ab', 'user', 'recent question');
insert into public.data_entries (id, bot_id, conversation_id, schema_key, payload) values
  ('de000000-0000-4000-8000-0000000000aa', 'b1000000-0000-4000-8000-0000000000aa', 'c1000000-0000-4000-8000-0000000000aa', 'k', '{}');
-- ADR 0016: entries with no conversation age out after conversation_days (created_at clock).
insert into public.data_entries (id, bot_id, conversation_id, schema_key, payload, created_at) values
  ('de000000-0000-4000-8000-0000000000ab', 'b1000000-0000-4000-8000-0000000000aa', null, 'k', '{}', now() - interval '100 days'),
  ('de000000-0000-4000-8000-0000000000ac', 'b1000000-0000-4000-8000-0000000000aa', null, 'k', '{}', now() - interval '10 days'),
  ('de000000-0000-4000-8000-0000000000ad', 'b1000000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000ab', 'k', '{}', now() - interval '200 days');
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
select throws_ok('select public.purge_expired_data_entries(100)', 'RB020', null, 'retention (M3): bot without client_settings -> purge_expired_data_entries fails closed');
reset role;
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b2000000-0000-4000-8000-0000000000ab', array['https://e.test'], '{}', '{}', '{"conversation_days": "ninety"}', '{}', '{}', '{}');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok('select public.purge_expired_conversations(100)', 'RB020', null, 'retention: non-numeric conversation_days fails closed');
select throws_ok('select public.purge_expired_usage_records(100)', 'RB020', null, 'retention: missing usage_months fails closed');
select throws_ok('select public.purge_expired_data_entries(100)', 'RB020', null, 'retention (M3): non-numeric conversation_days -> purge_expired_data_entries fails closed');
select is((select count(*)::int from public.data_entries where id in ('de000000-0000-4000-8000-0000000000ab', 'de000000-0000-4000-8000-0000000000ac')), 2, 'retention (M3): failed-closed data-entry purge deleted nothing');
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
select throws_ok('select public.expire_visitor_sessions(null, 30)', '22023', null, 'retention: null batch rejected');
select throws_ok('select public.expire_visitor_sessions(10, null)', '22023', null, 'retention (L9): null grace rejected (no default)');
select throws_ok('select public.expire_visitor_sessions(10, 0)', '22023', null, 'retention (L9): grace 0 rejected');
select throws_ok('select public.expire_visitor_sessions(10, 86401)', '22023', null, 'retention (L9): grace > 86400 rejected');
select throws_ok('select public.purge_expired_data_entries(0)', '22023', null, 'retention (M3): data-entry batch 0 rejected');

-- Purge by configured age.
select is(public.purge_expired_conversations(100), 1, 'retention: exactly the conversation older than 90 days is purged');
select is((select count(*)::int from public.conversations where id = 'c1000000-0000-4000-8000-0000000000aa'), 0, 'retention: old conversation deleted');
select is((select count(*)::int from public.conversations where id = 'c2000000-0000-4000-8000-0000000000ab'), 1, 'retention: recent conversation kept');
select is((select count(*)::int from public.messages where content = 'old question'), 0, 'retention: messages cascade with the conversation');
select is((select count(*)::int from public.messages where content = 'recent question'), 1, 'retention: recent messages kept');
select is((select count(*)::int from public.data_entries where id = 'de000000-0000-4000-8000-0000000000aa'), 0, 'retention (M3, ADR 0016): data_entries are deleted with their conversation (cascade)');
select is((select count(*)::int from public.data_entries where id in ('de000000-0000-4000-8000-0000000000ab', 'de000000-0000-4000-8000-0000000000ac', 'de000000-0000-4000-8000-0000000000ad')), 3, 'retention (M3): conversation purge leaves unrelated entries alone');
select is(public.purge_expired_data_entries(100), 1, 'retention (M3): exactly the conversation-less entry older than 90 days is purged');
select is((select count(*)::int from public.data_entries where id = 'de000000-0000-4000-8000-0000000000ab'), 0, 'retention (M3): old orphan entry deleted');
select is((select count(*)::int from public.data_entries where id = 'de000000-0000-4000-8000-0000000000ac'), 1, 'retention (M3): recent orphan entry kept');
select is((select count(*)::int from public.data_entries where id = 'de000000-0000-4000-8000-0000000000ad'), 1, 'retention (M3): old entry of a LIVE conversation is not touched by the orphan purge');

select is((public.purge_expired_usage_records(100) ->> 'usage_events')::int, 1, 'retention: only the usage event older than 13 months is purged');
select is((select count(*)::int from public.usage_events where bot_id = 'b1000000-0000-4000-8000-0000000000aa'), 2, 'retention: newer usage events kept');

select is(public.expire_visitor_sessions(100, 30), 1, 'retention: visitor session expired longer ago than the grace period deleted');
select is((select count(*)::int from public.visitor_sessions where id = 'a3000000-0000-4000-8000-0000000000ac'), 1, 'retention (L9): session that expired within the grace period is kept');
select is(public.expire_visitor_sessions(100, 5), 1, 'retention (L9): a shorter grace period deletes the recently expired session');
select is((select count(*)::int from public.visitor_sessions where id = 'a2000000-0000-4000-8000-0000000000ab'), 1, 'retention: live session kept');
select is(public.purge_expired_rate_limit_buckets(100), 1, 'retention: expired rate-limit bucket deleted');
select is((select count(*)::int from public.rate_limit_buckets where key_hash = repeat('b', 64)), 1, 'retention: live bucket kept');
select is(public.purge_expired_caches(100), '{"answer_cache": 1, "moderation_cache": 1, "query_embedding_cache": 0, "retrieval_cache": 0}'::jsonb, 'retention: only expired cache rows are purged');
select is((select count(*)::int from public.answer_cache where cache_key_hash = repeat('b', 64)), 1, 'retention: live cache row kept');

-- L7: answer_cache rows from an older corpus_version / settings_version are purged although unexpired.
reset role;
insert into public.answer_cache (bot_id, cache_key_hash, language, answer_text, corpus_version, settings_version, prompt_template_version, chat_model, expires_at) values
  ('b1000000-0000-4000-8000-0000000000aa', repeat('c', 64), 'en', 'x', 3, 0, 'p', 'm', now() + interval '1 hour'),
  ('b1000000-0000-4000-8000-0000000000aa', repeat('d', 64), 'en', 'x', 3, 1, 'p', 'm', now() + interval '1 hour');
update public.bot_profiles set corpus_version = 3 where id = 'b1000000-0000-4000-8000-0000000000aa';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((public.purge_expired_caches(100) ->> 'answer_cache')::int, 2, 'retention (L7): unexpired rows with a stale corpus_version (b: 0 < 3) or stale settings_version (c: 0 < 1) are purged');
select is((select array_agg(cache_key_hash order by cache_key_hash) from public.answer_cache where bot_id = 'b1000000-0000-4000-8000-0000000000aa'), array[repeat('d', 64)], 'retention (L7): the row matching current corpus and settings versions survives');


-- P6-D5: the batch limit holds when the planner re-runs the locked subquery per outer row (012 replaces the 005
-- body). Statistics taken while the table holds one row make the planner choose, by itself, a nested-loop semi join
-- with the locked subquery as its inner side and no Materialize. Rows are inserted oldest first, as real entries
-- arrive, so the outer scan meets them in the subquery's order: each rescan skips the rows this statement already
-- deleted and locks the next ones, and the 005 body deleted all 8 entries for a batch of 3.
delete from public.data_entries;
insert into public.data_entries (bot_id, conversation_id, schema_key, payload, created_at) values
  ('b1000000-0000-4000-8000-0000000000aa', null, 'batch', '{}', now() - interval '200 days');
analyze public.data_entries;
insert into public.data_entries (bot_id, conversation_id, schema_key, payload, created_at)
  select 'b1000000-0000-4000-8000-0000000000aa', null, 'batch', '{}', now() - interval '100 days' - make_interval(mins => 8 - g)
    from generate_series(1, 7) g;
insert into public.data_entries (id, bot_id, conversation_id, schema_key, payload, created_at) values
  ('de000000-0000-4000-8000-0000000000ae', 'b1000000-0000-4000-8000-0000000000aa', null, 'k', '{}', now() - interval '10 days');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok((select reltuples <= 1 from pg_class where oid = 'public.data_entries'::regclass), 'retention (P6-D5): statistics are stale (one row, the table holds nine), as on a quiet production table');
select is(public.purge_expired_data_entries(3), 3, 'retention (P6-D5): a batch of 3 deletes exactly 3 of 8 expired entries');
select is((select count(*)::int from public.data_entries where schema_key = 'batch'), 5, 'retention (P6-D5): and 5 remain');
select is(public.purge_expired_data_entries(3), 3, 'retention (P6-D5): the second call deletes exactly 3 more');
select is(public.purge_expired_data_entries(3), 2, 'retention (P6-D5): the third deletes the last 2');
select is(public.purge_expired_data_entries(3), 0, 'retention (P6-D5): a repeat deletes nothing');
select is((select count(*)::int from public.data_entries where id = 'de000000-0000-4000-8000-0000000000ae'), 1, 'retention (P6-D5): a recent entry is untouched');

reset role;
select * from finish();
