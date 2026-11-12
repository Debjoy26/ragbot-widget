-- P3.5 admin settings RPCs (migration 010): roles and MFA for every function, settings read and update,
-- merged validation, enable gate, conversation delete, member list, schema version, helper grants, audit
-- allowlist. The field-by-field rule check against the Zod schema is the parity test
-- (tests/integration/settings-parity.test.ts); here every field gets one accept and one reject.
-- All fixtures are synthetic.
--
-- Ids end in 000000000220: bots bN, users aN, conversations fN, messages eN.
begin;
select plan(320);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000220', 'authenticated', 'authenticated', 'p35s-owner@example.test'),
  ('a2000000-0000-4000-8000-000000000220', 'authenticated', 'authenticated', 'p35s-admin@example.test'),
  ('a3000000-0000-4000-8000-000000000220', 'authenticated', 'authenticated', 'p35s-analyst@example.test'),
  ('a4000000-0000-4000-8000-000000000220', 'authenticated', 'authenticated', 'p35s-nonmember@example.test'),
  ('a5000000-0000-4000-8000-000000000220', 'authenticated', 'authenticated', 'p35s-revoked@example.test'),
  ('a6000000-0000-4000-8000-000000000220', 'authenticated', 'authenticated', 'p35s-admin2@example.test');
insert into public.admin_memberships (user_id, role, active) values
  ('a1000000-0000-4000-8000-000000000220', 'owner', true), ('a2000000-0000-4000-8000-000000000220', 'admin', true),
  ('a3000000-0000-4000-8000-000000000220', 'analyst', true), ('a5000000-0000-4000-8000-000000000220', 'admin', false),
  ('a6000000-0000-4000-8000-000000000220', 'admin', true);

-- B1 main (no public config yet), B2 live (enabled, complete config), B3 no client_settings until section 3, B4 gate bot,
-- B5 disabled and complete, B6 no config. Every bot that is written to has a write quota (B7 and B8 are added in section 11).
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-000000000220', 'p35s-main', 'SECRET-PROMPT-220', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-000000000220', 'p35s-live', 'x', array['en', 'de'], 'm', 1536),
  ('b3000000-0000-4000-8000-000000000220', 'p35s-nosettings', 'x', array['en'], 'm', 1536),
  ('b4000000-0000-4000-8000-000000000220', 'p35s-gate', 'x', array['en', 'de'], 'm', 1536),
  ('b5000000-0000-4000-8000-000000000220', 'p35s-disabled', 'x', array['en', 'de'], 'm', 1536),
  ('b6000000-0000-4000-8000-000000000220', 'p35s-noconfig', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-000000000220', array['https://origin-220.test'], '{"marker": "RATE-MARKER-220"}', '{"daily_cap_usd": 5}', '{}', '{"max_bytes": 1048576, "max_pages": 50, "index_max_attempts": 3, "quotas": {"write": {"limit": 1000, "window_seconds": 3600}}}', '{"marker": "HANDOFF-MARKER-220"}', '{}'),
  ('b2000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"max_bytes": "not a number", "quotas": {"write": {"limit": 1000, "window_seconds": 3600}}}', '{}', '{}'),
  ('b4000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"quotas": {"write": {"limit": 1000, "window_seconds": 3600}}}', '{}', '{}'),
  ('b5000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"quotas": {"write": {"limit": 1000, "window_seconds": 3600}}}', '{}', '{}'),
  ('b6000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"quotas": {"write": {"limit": 1000, "window_seconds": 3600}}}', '{}', '{}');
insert into public.public_bot_config (bot_id, bot_slug, display_name, greeting, primary_color, supported_languages, escalation_label, escalation_messages, contact_email) values
  ('b2000000-0000-4000-8000-000000000220', 'p35s-live', 'Live Bot', 'Hello', '#112233', array['en', 'de'], 'Contact', '{"en": "Email us.", "de": "Schreiben Sie uns."}', 'live@example.test'),
  ('b4000000-0000-4000-8000-000000000220', 'p35s-gate', 'Gate Bot', 'Hello', '#112233', array['en', 'de'], 'Contact', '{"en": "Email us.", "de": "Schreiben Sie uns."}', 'gate@example.test'),
  ('b5000000-0000-4000-8000-000000000220', 'p35s-disabled', 'Disabled Bot', 'Hello', '#112233', array['en', 'de'], 'Contact', '{"en": "Email us.", "de": "Schreiben Sie uns."}', 'off@example.test');
update public.bot_profiles set enabled = true where id = 'b2000000-0000-4000-8000-000000000220';
update public.bot_profiles set enabled = true where id = 'b6000000-0000-4000-8000-000000000220';
-- B1 gets a partial config directly (an operator wrote it): no greeting, colour, label or channel.
insert into public.public_bot_config (bot_id, bot_slug, display_name, supported_languages) values
  ('b1000000-0000-4000-8000-000000000220', 'p35s-main', 'Placeholder', array['en']);

select set_config('t.audit0', (select count(*)::text from public.audit_logs), true);

-- ===========================================================================
-- 1. Role and MFA matrix: every function, every actor (arguments are dummies; the guard comes first)
-- ===========================================================================
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.admin_list_bots()$q$, '42501', null, 'anon: list_bots -> permission denied (no EXECUTE)');
select throws_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, '42501', null, 'anon: get_settings -> permission denied (no EXECUTE)');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, '42501', null, 'anon: update_settings -> permission denied (no EXECUTE)');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, '42501', null, 'anon: set_bot_enabled -> permission denied (no EXECUTE)');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, '42501', null, 'anon: delete_conversation -> permission denied (no EXECUTE)');
select throws_ok($q$select * from public.admin_list_members()$q$, '42501', null, 'anon: list_members -> permission denied (no EXECUTE)');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, '42501', null, 'anon: document_status -> permission denied (no EXECUTE)');
select throws_ok($q$select public.schema_version()$q$, '42501', null, 'anon: schema_version -> permission denied (no EXECUTE)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_list_bots()$q$, 'RB033', null, 'nonmember: list_bots -> not a member');
select throws_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'RB033', null, 'nonmember: get_settings -> not a member');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, 'RB033', null, 'nonmember: update_settings -> not a member');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, 'RB033', null, 'nonmember: set_bot_enabled -> not a member');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB033', null, 'nonmember: delete_conversation -> not a member');
select throws_ok($q$select * from public.admin_list_members()$q$, 'RB033', null, 'nonmember: list_members -> not a member');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'RB033', null, 'nonmember: document_status -> not a member');
select is(public.schema_version(), 15, 'nonmember: schema_version works (no membership needed)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_list_bots()$q$, 'RB033', null, 'revoked: list_bots -> not a member');
select throws_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'RB033', null, 'revoked: get_settings -> not a member');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, 'RB033', null, 'revoked: update_settings -> not a member');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, 'RB033', null, 'revoked: set_bot_enabled -> not a member');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB033', null, 'revoked: delete_conversation -> not a member');
select throws_ok($q$select * from public.admin_list_members()$q$, 'RB033', null, 'revoked: list_members -> not a member');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'RB033', null, 'revoked: document_status -> not a member');
select is(public.schema_version(), 15, 'revoked: schema_version works (no membership needed)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select * from public.admin_list_bots()$q$, 'analyst: list_bots allowed');
select lives_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'analyst: get_settings allowed');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, 'RB033', null, 'analyst: update_settings -> role not allowed');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, 'RB033', null, 'analyst: set_bot_enabled -> role not allowed');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB033', null, 'analyst: delete_conversation -> role not allowed');
select throws_ok($q$select * from public.admin_list_members()$q$, 'RB033', null, 'analyst: list_members -> role not allowed');
select lives_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'analyst: document_status allowed');
select is(public.schema_version(), 15, 'analyst: schema_version works');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_list_bots()$q$, 'RB032', null, 'owner at aal1: list_bots -> MFA required');
select throws_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'RB032', null, 'owner at aal1: get_settings -> MFA required');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, 'RB032', null, 'owner at aal1: update_settings -> MFA required');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, 'RB032', null, 'owner at aal1: set_bot_enabled -> MFA required');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB032', null, 'owner at aal1: delete_conversation -> MFA required');
select throws_ok($q$select * from public.admin_list_members()$q$, 'RB032', null, 'owner at aal1: list_members -> MFA required');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'RB032', null, 'owner at aal1: document_status -> MFA required');
select is(public.schema_version(), 15, 'owner at aal1: schema_version works (no MFA needed)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_list_bots()$q$, 'RB032', null, 'admin at aal1: list_bots -> MFA required');
select throws_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'RB032', null, 'admin at aal1: get_settings -> MFA required');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, 'RB032', null, 'admin at aal1: update_settings -> MFA required');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, 'RB032', null, 'admin at aal1: set_bot_enabled -> MFA required');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB032', null, 'admin at aal1: delete_conversation -> MFA required');
select throws_ok($q$select * from public.admin_list_members()$q$, 'RB032', null, 'admin at aal1: list_members -> MFA required');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'RB032', null, 'admin at aal1: document_status -> MFA required');
select is(public.schema_version(), 15, 'admin at aal1: schema_version works (no MFA needed)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000220","aal":"aal1","role":"authenticated"}', true);
select throws_ok($q$select * from public.admin_list_bots()$q$, 'RB032', null, 'analyst at aal1: list_bots -> MFA required');
select throws_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'RB032', null, 'analyst at aal1: get_settings -> MFA required');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"tone":"x"}')$q$, 'RB033', null, 'analyst at aal1: update_settings -> role not allowed (checked before MFA)');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', 1, false)$q$, 'RB033', null, 'analyst at aal1: set_bot_enabled -> role not allowed (checked before MFA)');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB033', null, 'analyst at aal1: delete_conversation -> role not allowed (checked before MFA)');
select throws_ok($q$select * from public.admin_list_members()$q$, 'RB033', null, 'analyst at aal1: list_members -> role not allowed (checked before MFA)');
select throws_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'RB032', null, 'analyst at aal1: document_status -> MFA required');
select is(public.schema_version(), 15, 'analyst at aal1: schema_version works (no MFA needed)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select * from public.admin_list_bots()$q$, 'owner: list_bots allowed');
select lives_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'owner: get_settings allowed');
select lives_ok($q$select * from public.admin_list_members()$q$, 'owner: list_members allowed');
select lives_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'owner: document_status allowed');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select * from public.admin_list_bots()$q$, 'admin: list_bots allowed');
select lives_ok($q$select * from public.admin_get_settings('b1000000-0000-4000-8000-000000000220')$q$, 'admin: get_settings allowed');
select lives_ok($q$select * from public.admin_list_members()$q$, 'admin: list_members allowed');
select lives_ok($q$select * from public.admin_document_status('b1000000-0000-4000-8000-000000000220', 10, 0)$q$, 'admin: document_status allowed');
reset role;

-- ===========================================================================
-- 2. Reads: bot list, settings read (before publishing, no private fields), members, schema version
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.admin_list_bots() l where l.id::text like '%220'), 6, 'list_bots: all six fixture bots are listed');
select is((select row(l.slug, l.display_name, l.enabled, l.settings_version) from public.admin_list_bots() l where l.id = 'b2000000-0000-4000-8000-000000000220'), row('p35s-live'::text, 'Live Bot'::text, true, 2), 'list_bots: a published bot shows its display name, enabled flag and version');
select is((select row(l.slug, l.display_name, l.enabled, l.settings_version) from public.admin_list_bots() l where l.id = 'b3000000-0000-4000-8000-000000000220'), row('p35s-nosettings'::text, null::text, false, 1), 'list_bots: a bot without public config has a null display name');
select is((select row(s.bot_id, s.slug, s.enabled, s.settings_version, s.tone, s.scope, s.max_bytes, s.max_pages, s.display_name, s.greeting, s.supported_languages, s.contact_email) from public.admin_get_settings('b3000000-0000-4000-8000-000000000220') s), row('b3000000-0000-4000-8000-000000000220'::uuid, 'p35s-nosettings'::text, false, 1, null::text, null::text, null::bigint, null::bigint, null::text, null::text, null::text[], null::text), 'get_settings: works before publishing, with no public config and no client settings (limits are null)');
select is((select row(s.max_bytes, s.max_pages, s.display_name, s.enabled) from public.admin_get_settings('b1000000-0000-4000-8000-000000000220') s), row(1048576::bigint, 50::bigint, 'Placeholder'::text, false), 'get_settings: returns the two upload limits and the public config of an unpublished bot');
select is((select s.max_bytes from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), null::bigint, 'get_settings: a limit that is not a number comes back null');
select is((select row(s.display_name, s.greeting, s.primary_color, s.position, s.supported_languages, s.escalation_label, s.escalation_messages, s.contact_email, s.suggested_questions) from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), row('Live Bot'::text, 'Hello'::text, '#112233'::text, 'bottom-right'::text, array['en', 'de'], 'Contact'::text, '{"en": "Email us.", "de": "Schreiben Sie uns."}'::jsonb, 'live@example.test'::text, '[]'::jsonb), 'get_settings: returns the whitelisted public fields');
select throws_ok($q$select * from public.admin_get_settings(null)$q$, '22023', null, 'get_settings: null bot');
select throws_ok($q$select * from public.admin_get_settings(gen_random_uuid())$q$, 'RB037', null, 'get_settings: unknown bot');
select ok(position('SECRET-PROMPT-220' in (select to_jsonb(s)::text from public.admin_get_settings('b1000000-0000-4000-8000-000000000220') s)) = 0, 'get_settings: the identity prompt is never returned');
select ok((select to_jsonb(s)::text not like '%origin-220%' and to_jsonb(s)::text not like '%RATE-MARKER%' and to_jsonb(s)::text not like '%HANDOFF-MARKER%' from public.admin_get_settings('b1000000-0000-4000-8000-000000000220') s), 'get_settings: allowed origins and the other policies are never returned');
reset role;
select is((select p.proargnames from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_get_settings'), array['p_bot_id', 'bot_id', 'slug', 'enabled', 'settings_version', 'tone', 'scope', 'max_bytes', 'max_pages', 'display_name', 'greeting', 'suggested_questions', 'primary_color', 'position', 'privacy_url', 'supported_languages', 'escalation_label', 'escalation_messages', 'contact_email', 'contact_phone', 'contact_whatsapp_url', 'contact_page_url', 'business_hours', 'timezone'], 'get_settings: the result has exactly the whitelisted columns (no identity prompt, policies or origins)');
select is((select p.proargnames from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_list_bots'), array['id', 'slug', 'display_name', 'enabled', 'settings_version'], 'list_bots: the result has exactly five columns');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.admin_list_members() m where m.user_id::text like '%220'), 5, 'list_members: admin sees all five fixture members');
select is((select row(m.role, m.active, m.label) from public.admin_list_members() m where m.user_id = 'a2000000-0000-4000-8000-000000000220'), row('admin'::text, true, 'p35s-admin@example.test'::text), 'list_members: the label is the sign-in email');
select is((select row(m.role, m.active, m.label) from public.admin_list_members() m where m.user_id = 'a5000000-0000-4000-8000-000000000220'), row('admin'::text, false, 'p35s-revoked@example.test'::text), 'list_members: a revoked member is listed as inactive');
select is((select m.label from public.admin_list_members() m where m.user_id = 'a3000000-0000-4000-8000-000000000220'), 'p35s-analyst@example.test', 'list_members: the analyst is listed with a label');
reset role;
select is((select p.proargnames from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_list_members'), array['user_id', 'role', 'active', 'label'], 'list_members: the result has exactly user_id, role, active and label');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is((select count(*)::int from public.admin_list_members() m where m.user_id::text like '%220'), 5, 'list_members: owner sees all five fixture members');
reset role;
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit0')::int, 0, 'reads: no read wrote an audit row');

-- schema_version equals the number of applied migrations
select is(public.schema_version(), (select count(*)::int from supabase_migrations.schema_migrations), 'schema_version: equals the number of migrations in the migration history');
select is(public.schema_version(), 15, 'schema_version: this database is at 15');

-- ===========================================================================
-- 3. Update settings: refusals change nothing
-- ===========================================================================
-- B3 gets its settings now (the reads above ran without any): only a write quota.
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy)
  values ('b3000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"quotas": {"write": {"limit": 1000, "window_seconds": 3600}}}', '{}', '{}');
select set_config('t.audit1', (select count(*)::text from public.audit_logs), true);
select set_config('t.cfg1', (select to_jsonb(c)::text from public.public_bot_config c where c.bot_id = 'b1000000-0000-4000-8000-000000000220'), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings(null, 1, '{"tone":"x"}')$q$, '22023', null, 'update: null bot');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', null, '{"tone":"x"}')$q$, '22023', null, 'update: null expected version (no default)');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, null)$q$, 'RB035', null, 'update: null patch');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{}')$q$, 'RB035', null, 'update: empty patch');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '[]')$q$, 'RB035', null, 'update: patch that is not an object');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"nope": 1}')$q$, 'RB035', null, 'update: unknown key');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"identity_prompt": "x"}')$q$, 'RB035', null, 'update: identity_prompt is not patchable');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"allowed_origins": ["https://x.test"]}')$q$, 'RB035', null, 'update: allowed_origins is not patchable');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"enabled": true}')$q$, 'RB035', null, 'update: enabled is not patchable through settings');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"upload_policy": {"max_bytes": 1}}')$q$, 'RB035', null, 'update: upload_policy is not patchable');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"display_name": "Ok", "primary_color": "red"}')$q$, 'RB035', null, 'update: one invalid value refuses the whole patch');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"display_name": "<b>x</b>"}')$q$, 'RB035', null, 'update: markup in a public text field');
select throws_ok($q$select public.admin_update_settings(gen_random_uuid(), 1, '{"tone": "x"}')$q$, 'RB037', null, 'update: unknown bot');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 99, '{"tone": "x"}')$q$, 'RB030', null, 'update: stale (wrong) version is a conflict');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 0, '{"tone": "x"}')$q$, 'RB030', null, 'update: version 0 is a conflict');
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 99, '{"nope": 1}')$q$, 'RB035', null, 'update: an invalid patch is reported before the version is compared');
select throws_ok($q$select public.admin_update_settings('b3000000-0000-4000-8000-000000000220', 1, '{"tone": "x"}')$q$, 'RB035', null, 'update: a bot with no public config needs display_name and supported_languages in its first patch');
select throws_ok($q$select public.admin_update_settings('b3000000-0000-4000-8000-000000000220', 1, '{"display_name": "Only name"}')$q$, 'RB035', null, 'update: display_name alone cannot create the config');
select throws_ok($q$select public.admin_update_settings('b3000000-0000-4000-8000-000000000220', 1, '{"supported_languages": ["en"]}')$q$, 'RB035', null, 'update: supported_languages alone cannot create the config');
reset role;
select is((select to_jsonb(c)::text from public.public_bot_config c where c.bot_id = 'b1000000-0000-4000-8000-000000000220'), current_setting('t.cfg1'), 'update: refused calls changed no config');
select is((select row(b.tone, b.scope, b.settings_version) from public.bot_profiles b where b.id = 'b1000000-0000-4000-8000-000000000220'), row(null::text, null::text, 1), 'update: refused calls changed no tone, scope or version');
select ok(not exists (select 1 from public.public_bot_config c where c.bot_id = 'b3000000-0000-4000-8000-000000000220'), 'update: refused calls created no config row');
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit1')::int, 0, 'update: refused calls wrote no audit row');

-- ===========================================================================
-- 4. Update settings: first update creates the config; later updates are partial
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is(public.admin_update_settings('b3000000-0000-4000-8000-000000000220', 1, '{"display_name": "  Spare Bot  ", "supported_languages": ["en", "pt-BR"]}'), 2, 'update: the first update creates the config and moves the version (1 -> 2)');
reset role;
select is((select row(c.bot_slug, c.display_name, c.supported_languages, c.is_published, c.position, c.escalation_messages, c.suggested_questions) from public.public_bot_config c where c.bot_id = 'b3000000-0000-4000-8000-000000000220'), row('p35s-nosettings'::text, 'Spare Bot'::text, array['en', 'pt-BR'], false, 'bottom-right'::text, '{}'::jsonb, '[]'::jsonb), 'update: the created row has the slug, the trimmed name, the languages, defaults and is not published');
select is((select row(a.actor_user_id, a.resource_type, a.resource_id, a.safe_metadata) from public.audit_logs a where a.action = 'settings.update' and a.resource_id = 'b3000000-0000-4000-8000-000000000220'), row('a1000000-0000-4000-8000-000000000220'::uuid, 'bot'::text, 'b3000000-0000-4000-8000-000000000220'::text, '{"bot_id": "b3000000-0000-4000-8000-000000000220", "changed_fields": "display_name,supported_languages", "expected_settings_version": 1, "settings_version": 2}'::jsonb), 'update: one audit row with the owner as actor, sorted field names and both versions');
select ok((select a.safe_metadata::text not like '%Spare%' and a.safe_metadata::text not like '%pt-BR%' from public.audit_logs a where a.action = 'settings.update' and a.resource_id = 'b3000000-0000-4000-8000-000000000220'), 'update: the audit row holds no submitted values');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is(public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"greeting": "  Hi there  ", "contact_email": "x@example.test", "suggested_questions": ["  Q1  ", "Q2"], "tone": "  Friendly\n", "scope": "Only the docs", "privacy_url": "HTTPS://Example.com/p"}'), 3, 'update: a partial patch by an admin moves the version once per touched table (public config +1, tone and scope +1)');
reset role;
select is((select row(c.display_name, c.greeting, c.contact_email, c.suggested_questions, c.privacy_url, c.supported_languages, c.primary_color) from public.public_bot_config c where c.bot_id = 'b1000000-0000-4000-8000-000000000220'), row('Placeholder'::text, 'Hi there'::text, 'x@example.test'::text, '["Q1", "Q2"]'::jsonb, 'https://Example.com/p'::text, array['en'], null::text), 'update: only the patched fields changed, text is trimmed and the URL scheme is lower-cased');
select is((select row(b.tone, b.scope, b.settings_version) from public.bot_profiles b where b.id = 'b1000000-0000-4000-8000-000000000220'), row('Friendly'::text, 'Only the docs'::text, 3), 'update: tone and scope are written to bot_profiles, trimmed');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 1, '{"greeting": "again"}')$q$, 'RB030', null, 'update: reusing the old version is a conflict (a lost update is refused)');
select is(public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 3, '{"contact_email": null, "business_hours": {"mon-fri": "09:00-18:00"}, "timezone": "Asia/Kolkata", "position": "bottom-left", "primary_color": "#ABCDEF"}'), 4, 'update: null clears a contact field; hours, timezone, position and colour are set');
reset role;
select is((select row(c.contact_email, c.business_hours, c.timezone, c.position, c.primary_color) from public.public_bot_config c where c.bot_id = 'b1000000-0000-4000-8000-000000000220'), row(null::text, '{"mon-fri": "09:00-18:00"}'::jsonb, 'Asia/Kolkata'::text, 'bottom-left'::text, '#ABCDEF'::text), 'update: the cleared and set fields are stored');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is(public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 4, '{"business_hours": null, "timezone": null}'), 5, 'update: hours and timezone can both be cleared');
select is(public.admin_update_settings('b1000000-0000-4000-8000-000000000220', 5, '{"tone": "Friendly"}'), 5, 'update: a patch that changes nothing leaves the version where it was');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'settings.update' and resource_id = 'b1000000-0000-4000-8000-000000000220'), 4, 'update: every successful call wrote one audit row');
select is((select safe_metadata ->> 'changed_fields' from public.audit_logs where action = 'settings.update' and resource_id = 'b1000000-0000-4000-8000-000000000220' and (safe_metadata ->> 'expected_settings_version')::int = 1), 'contact_email,greeting,privacy_url,scope,suggested_questions,tone', 'update: changed_fields is the sorted, comma-joined list of patched names');
select ok(not exists (select 1 from public.audit_logs a where a.safe_metadata::text ~ '(Hi there|Friendly|Only the docs|x@example.test|Example.com|Asia/Kolkata)'), 'update: no audit row anywhere holds a submitted value');

-- all seventeen fields in one call: the audit list is 234 characters long
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_update_settings('b3000000-0000-4000-8000-000000000220', 2, '{"display_name": "Spare", "greeting": "Hi!", "suggested_questions": ["What do you do?"], "primary_color": "#336699", "position": "bottom-left", "privacy_url": "https://spare.example/privacy", "supported_languages": ["en", "hi"], "escalation_label": "Talk to us", "escalation_messages": {"en": "Contact us.", "hi": "Sampark karein."}, "contact_email": "hello@spare.example", "contact_phone": "+911234567890", "contact_whatsapp_url": "https://wa.me/911234567890", "contact_page_url": "https://spare.example/contact", "business_hours": {"mon-fri": "09:00-18:00"}, "timezone": "Asia/Kolkata", "tone": "Friendly.", "scope": "Spare products."}')$q$, 'update: all seventeen whitelisted fields in one call');
reset role;
select is((select char_length(a.safe_metadata ->> 'changed_fields') from public.audit_logs a where a.action = 'settings.update' and a.resource_id = 'b3000000-0000-4000-8000-000000000220' and (a.safe_metadata ->> 'expected_settings_version')::int = 2), 234, 'update: the audit list of all seventeen names (234 characters) is accepted');
select is((select row(c.escalation_messages, c.supported_languages, c.contact_phone, c.timezone) from public.public_bot_config c where c.bot_id = 'b3000000-0000-4000-8000-000000000220'), row('{"en": "Contact us.", "hi": "Sampark karein."}'::jsonb, array['en', 'hi'], '+911234567890'::text, 'Asia/Kolkata'::text), 'update: the full patch is stored');

-- ===========================================================================
-- 5. Merged validation on an enabled bot (B2: English and German, email is the only channel)
-- ===========================================================================
select set_config('t.audit2', (select count(*)::text from public.audit_logs), true);
select set_config('t.cfg2', (select to_jsonb(c)::text from public.public_bot_config c where c.bot_id = 'b2000000-0000-4000-8000-000000000220'), true);
select set_config('t.ver2', (select settings_version::text from public.bot_profiles where id = 'b2000000-0000-4000-8000-000000000220'), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"contact_email": null}')$q$, 'RB035', null, 'merged: removing the last contact channel from an enabled bot is refused');
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"tone": "changed tone", "greeting": "changed", "contact_email": null}')$q$, 'RB035', null, 'merged: the same refusal when other fields are patched in the same call');
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"escalation_messages": {"en": "Only English."}}')$q$, 'RB035', null, 'merged: removing the escalation message of a supported language is refused');
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"supported_languages": ["en", "de", "fr"]}')$q$, 'RB035', null, 'merged: adding a supported language without a message is refused');
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"supported_languages": ["en"]}')$q$, 'RB035', null, 'merged: a message left for a language that is no longer supported is refused (the widget schema rejects it)');
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"business_hours": {"mon": "09:00-17:00"}}')$q$, 'RB035', null, 'merged: hours without a timezone are refused (the widget schema requires both)');
reset role;
select is((select to_jsonb(c)::text from public.public_bot_config c where c.bot_id = 'b2000000-0000-4000-8000-000000000220'), current_setting('t.cfg2'), 'merged: the refused calls changed no config (writes rolled back)');
select is((select row(b.tone, b.settings_version) from public.bot_profiles b where b.id = 'b2000000-0000-4000-8000-000000000220'), row(null::text, current_setting('t.ver2')::int), 'merged: a refused call also rolled back tone and left the version alone');
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit2')::int, 0, 'merged: the refused calls wrote no audit row (audit rolls back with the change)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"contact_phone": "+911234567890", "contact_email": null}')$q$, 'merged: swapping the contact channel is allowed');
select lives_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"supported_languages": ["en"], "escalation_messages": {"en": "Call us."}}')$q$, 'merged: dropping a language together with its message is allowed');
select lives_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"business_hours": {"mon": "09:00-17:00"}, "timezone": "Europe/London"}')$q$, 'merged: hours with a timezone are allowed');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'settings.update' and resource_id = 'b2000000-0000-4000-8000-000000000220'), 3, 'merged: the three allowed calls wrote three audit rows');

-- the same changes are allowed while the bot is disabled (B5: complete, disabled)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_update_settings('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), '{"contact_email": null}')$q$, 'disabled bot: removing the last contact channel is allowed');
select lives_ok($q$select public.admin_update_settings('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), '{"escalation_messages": {"en": "Only English."}}')$q$, 'disabled bot: removing the message of a supported language is allowed');
select lives_ok($q$select public.admin_update_settings('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), '{"supported_languages": ["en", "de", "fr"]}')$q$, 'disabled bot: adding a language without a message is allowed');
select throws_ok($q$select public.admin_set_bot_enabled('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'disabled bot: but it can no longer be enabled until the rules pass again');
reset role;

-- ===========================================================================
-- 6. Enable gate and disable
-- ===========================================================================
select set_config('t.audit3', (select count(*)::text from public.audit_logs), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled(null, 1, true)$q$, '22023', null, 'enable: null bot');
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', null, true)$q$, '22023', null, 'enable: null expected version');
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', 1, null)$q$, '22023', null, 'enable: null state');
select throws_ok($q$select public.admin_set_bot_enabled(gen_random_uuid(), 1, true)$q$, 'RB037', null, 'enable: unknown bot');
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', 99, true)$q$, 'RB030', null, 'enable: stale version is a conflict');
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', 99, false)$q$, 'RB030', null, 'disable: stale version is a conflict too');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b1000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'enable: a config with no colour, label or channel is refused');
reset role;
select is((select enabled from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000220'), false, 'enable: the refused call left the bot disabled');

-- B4 is complete; break one rule at a time (an operator writing the row directly) and expect a refusal.
update public.public_bot_config set greeting = null where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: no greeting');
reset role;
update public.public_bot_config set greeting = 'Hello', primary_color = null where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: no primary colour');
reset role;
update public.public_bot_config set primary_color = '#112233', escalation_label = null where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: no escalation label');
reset role;
update public.public_bot_config set escalation_label = 'Contact', contact_email = null where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: no contact channel');
reset role;
update public.public_bot_config set contact_email = 'gate@example.test', escalation_messages = '{"en": "Email us."}' where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: no escalation message for a supported language');
reset role;
update public.public_bot_config set escalation_messages = '{"en": "Email us.", "de": "Schreiben Sie uns.", "fr": "Ecrivez."}' where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: a message for an unsupported language');
reset role;
update public.public_bot_config set escalation_messages = '{"en": "Email us.", "de": "Schreiben Sie uns."}', business_hours = '{"mon": "09:00-17:00"}' where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: business hours without a timezone');
reset role;
update public.public_bot_config set business_hours = null, greeting = '<b>Hello</b>' where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: a stored value that breaks a field rule (markup in the greeting)');
reset role;
update public.public_bot_config set greeting = 'Hello', contact_email = 'a..b@example.test' where bot_id = 'b4000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: an email the table accepts but the widget schema rejects');
reset role;
update public.public_bot_config set contact_email = 'gate@example.test' where bot_id = 'b4000000-0000-4000-8000-000000000220';
select is((select enabled from public.bot_profiles where id = 'b4000000-0000-4000-8000-000000000220'), false, 'gate: every refused call left the bot disabled');
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit3')::int, 0, 'gate: refused calls wrote no audit row');

-- Now B4 is complete again: enabling works, publishes the config, moves the version and audits.
select set_config('t.ver4', (select settings_version::text from public.bot_profiles where id = 'b4000000-0000-4000-8000-000000000220'), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select is(public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', current_setting('t.ver4')::int, true), current_setting('t.ver4')::int + 1, 'enable: a complete config is enabled and the version moves by one');
reset role;
select is((select row(b.enabled, c.is_published) from public.bot_profiles b join public.public_bot_config c on c.bot_id = b.id where b.id = 'b4000000-0000-4000-8000-000000000220'), row(true, true), 'enable: the public config is published with the bot');
select is((select safe_metadata from public.audit_logs where action = 'bot.enable' and resource_id = 'b4000000-0000-4000-8000-000000000220'), jsonb_build_object('bot_id', 'b4000000-0000-4000-8000-000000000220', 'enabled', true, 'expected_settings_version', current_setting('t.ver4')::int, 'settings_version', current_setting('t.ver4')::int + 1), 'enable: one audit row with the flag and both versions');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.public_bot_config where bot_id = 'b4000000-0000-4000-8000-000000000220'), 1, 'enable: anon can now read the published config');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', current_setting('t.ver4')::int, false)$q$, 'RB030', null, 'disable: the version read before enabling is now stale');
select is(public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', current_setting('t.ver4')::int + 1, false), current_setting('t.ver4')::int + 2, 'disable: always allowed, and the version moves by one');
reset role;
select is((select row(b.enabled, c.is_published) from public.bot_profiles b join public.public_bot_config c on c.bot_id = b.id where b.id = 'b4000000-0000-4000-8000-000000000220'), row(false, false), 'disable: the public config is unpublished');
select is((select (safe_metadata ->> 'enabled')::boolean from public.audit_logs where action = 'bot.disable' and resource_id = 'b4000000-0000-4000-8000-000000000220'), false, 'disable: one audit row with enabled = false');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.public_bot_config where bot_id = 'b4000000-0000-4000-8000-000000000220'), 0, 'disable: anon can no longer read it');
reset role;

-- B6 is enabled but has no config (written by an operator): enabling is refused, disabling is not.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_set_bot_enabled('b6000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b6000000-0000-4000-8000-000000000220') s), false)$q$, 'disable: allowed even when the bot has no config');
select throws_ok($q$select public.admin_set_bot_enabled('b6000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b6000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'enable: a bot with no config row is refused');
-- B3 was filled in by the full patch above and passes the gate through the RPCs alone.
select lives_ok($q$select public.admin_set_bot_enabled('b3000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b3000000-0000-4000-8000-000000000220') s), true)$q$, 'enable: a config built entirely through admin_update_settings passes the gate');
reset role;
select is((select enabled from public.bot_profiles where id = 'b3000000-0000-4000-8000-000000000220'), true, 'enable: that bot is enabled');

-- ===========================================================================
-- 7. Delete a conversation: every dependent row goes with it, the others stay
-- ===========================================================================
insert into public.visitor_sessions (id, bot_id, expires_at) values ('a9000000-0000-4000-8000-000000000220', 'b1000000-0000-4000-8000-000000000220', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('f1000000-0000-4000-8000-000000000220', 'b1000000-0000-4000-8000-000000000220', 'a9000000-0000-4000-8000-000000000220'),
  ('f2000000-0000-4000-8000-000000000220', 'b1000000-0000-4000-8000-000000000220', 'a9000000-0000-4000-8000-000000000220'),
  ('f3000000-0000-4000-8000-000000000220', 'b1000000-0000-4000-8000-000000000220', 'a9000000-0000-4000-8000-000000000220');
insert into public.messages (id, conversation_id, role, content) values
  ('e1000000-0000-4000-8000-000000000220', 'f1000000-0000-4000-8000-000000000220', 'user', 'secret question text 220'),
  ('e3000000-0000-4000-8000-000000000220', 'f2000000-0000-4000-8000-000000000220', 'user', 'other question'),
  ('e4000000-0000-4000-8000-000000000220', 'f3000000-0000-4000-8000-000000000220', 'user', 'third question');
insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values
  ('e2000000-0000-4000-8000-000000000220', 'f1000000-0000-4000-8000-000000000220', 'e1000000-0000-4000-8000-000000000220', 'assistant', 'secret answer text 220');
insert into public.message_sources (message_id, source_label, excerpt) values
  ('e2000000-0000-4000-8000-000000000220', 'label', 'secret excerpt 220'), ('e3000000-0000-4000-8000-000000000220', 'other', 'other excerpt');
insert into public.conversation_analysis (conversation_id, summary) values
  ('f1000000-0000-4000-8000-000000000220', 'secret summary 220'), ('f2000000-0000-4000-8000-000000000220', 'other summary');
insert into public.data_entries (bot_id, conversation_id, schema_key, payload) values
  ('b1000000-0000-4000-8000-000000000220', 'f1000000-0000-4000-8000-000000000220', 'lead', '{"name": "secret entry 220"}'),
  ('b1000000-0000-4000-8000-000000000220', 'f1000000-0000-4000-8000-000000000220', 'lead', '{"name": "secret entry 2"}'),
  ('b1000000-0000-4000-8000-000000000220', 'f2000000-0000-4000-8000-000000000220', 'lead', '{"name": "other entry"}'),
  ('b1000000-0000-4000-8000-000000000220', null, 'lead', '{"name": "orphan entry"}');
select set_config('t.audit4', (select count(*)::text from public.audit_logs), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_delete_conversation(null)$q$, '22023', null, 'delete conversation: null id');
select throws_ok($q$select public.admin_delete_conversation(gen_random_uuid())$q$, 'RB037', null, 'delete conversation: unknown id');
reset role;
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit4')::int, 0, 'delete conversation: refused calls wrote no audit row');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_delete_conversation('f1000000-0000-4000-8000-000000000220')$q$, 'delete conversation: an admin deletes a conversation');
reset role;
select is((select count(*)::int from public.conversations where id = 'f1000000-0000-4000-8000-000000000220'), 0, 'delete conversation: the conversation is gone');
select is((select count(*)::int from public.messages where conversation_id = 'f1000000-0000-4000-8000-000000000220' or id in ('e1000000-0000-4000-8000-000000000220', 'e2000000-0000-4000-8000-000000000220')), 0, 'delete conversation: its messages are gone');
select is((select count(*)::int from public.message_sources where message_id in ('e1000000-0000-4000-8000-000000000220', 'e2000000-0000-4000-8000-000000000220') or excerpt = 'secret excerpt 220'), 0, 'delete conversation: the sources of its messages are gone');
select is((select count(*)::int from public.conversation_analysis where conversation_id = 'f1000000-0000-4000-8000-000000000220'), 0, 'delete conversation: its analysis is gone');
select is((select count(*)::int from public.data_entries where conversation_id = 'f1000000-0000-4000-8000-000000000220' or payload ->> 'name' like 'secret entry%'), 0, 'delete conversation: its data entries are gone (ADR 0016)');
select is((select count(*)::int from public.conversations where id in ('f2000000-0000-4000-8000-000000000220', 'f3000000-0000-4000-8000-000000000220')), 2, 'delete conversation: other conversations stay');
select is((select count(*)::int from public.messages where conversation_id = 'f2000000-0000-4000-8000-000000000220') + (select count(*)::int from public.message_sources where excerpt = 'other excerpt') + (select count(*)::int from public.conversation_analysis where conversation_id = 'f2000000-0000-4000-8000-000000000220') + (select count(*)::int from public.data_entries where payload ->> 'name' = 'other entry'), 4, 'delete conversation: the messages, sources, analysis and entries of another conversation stay');
select is((select count(*)::int from public.data_entries where payload ->> 'name' = 'orphan entry'), 1, 'delete conversation: an entry with no conversation is not touched');
select is((select row(a.actor_user_id, a.resource_type, a.resource_id, a.safe_metadata) from public.audit_logs a where a.action = 'conversation.delete'), row('a2000000-0000-4000-8000-000000000220'::uuid, 'conversation'::text, 'f1000000-0000-4000-8000-000000000220'::text, '{"bot_id": "b1000000-0000-4000-8000-000000000220", "conversation_id": "f1000000-0000-4000-8000-000000000220"}'::jsonb), 'delete conversation: one audit row with ids only');
select ok(not exists (select 1 from public.audit_logs a where a.safe_metadata::text like '%secret%' or coalesce(a.resource_id, '') like '%secret%'), 'delete conversation: no conversation content reached the audit log');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_delete_conversation('f1000000-0000-4000-8000-000000000220')$q$, 'RB037', null, 'delete conversation: deleting it again is not found');
select lives_ok($q$select public.admin_delete_conversation('f3000000-0000-4000-8000-000000000220')$q$, 'delete conversation: an owner can delete too');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'conversation.delete'), 2, 'delete conversation: two deletions, two audit rows');

-- ===========================================================================
-- 8. Field rules, one accept and one reject per field (the full set is the parity test)
-- ===========================================================================
select is(public.admin_validate_settings_patch('{"display_name": "Acme"}'), null, 'rule display_name: accept');
select is(public.admin_validate_settings_patch('{"display_name": "a<b"}'), 'display_name', 'rule display_name: reject angle bracket');
select is(public.admin_validate_settings_patch(jsonb_build_object('greeting', repeat('g', 500))), null, 'rule greeting: accept 500 characters');
select is(public.admin_validate_settings_patch(jsonb_build_object('greeting', repeat('g', 501))), 'greeting', 'rule greeting: reject 501 characters');
select is(public.admin_validate_settings_patch('{"suggested_questions": ["a", "b"]}'), null, 'rule suggested_questions: accept');
select is(public.admin_validate_settings_patch('{"suggested_questions": ["a", "b", "c", "d", "e", "f", "g"]}'), 'suggested_questions', 'rule suggested_questions: reject seven');
select is(public.admin_validate_settings_patch('{"primary_color": "#aBc123"}'), null, 'rule primary_color: accept');
select is(public.admin_validate_settings_patch('{"primary_color": "#abc"}'), 'primary_color', 'rule primary_color: reject short hex');
select is(public.admin_validate_settings_patch('{"position": "bottom-left"}'), null, 'rule position: accept');
select is(public.admin_validate_settings_patch('{"position": "top-left"}'), 'position', 'rule position: reject');
select is(public.admin_validate_settings_patch('{"privacy_url": "https://example.com/p"}'), null, 'rule privacy_url: accept');
select is(public.admin_validate_settings_patch('{"privacy_url": "http://example.com/p"}'), 'privacy_url', 'rule privacy_url: reject http');
select is(public.admin_validate_settings_patch('{"supported_languages": ["en", "pt-BR"]}'), null, 'rule supported_languages: accept');
select is(public.admin_validate_settings_patch('{"supported_languages": ["en", "en"]}'), 'supported_languages', 'rule supported_languages: reject a duplicate');
select is(public.admin_validate_settings_patch('{"escalation_label": "Talk to us"}'), null, 'rule escalation_label: accept');
select is(public.admin_validate_settings_patch(jsonb_build_object('escalation_label', repeat('l', 61))), 'escalation_label', 'rule escalation_label: reject 61 characters');
select is(public.admin_validate_settings_patch('{"escalation_messages": {"en": "Call us."}}'), null, 'rule escalation_messages: accept');
select is(public.admin_validate_settings_patch('{"escalation_messages": {"English": "Call us."}}'), 'escalation_messages', 'rule escalation_messages: reject a bad language key');
select is(public.admin_validate_settings_patch('{"contact_email": "a@example.com"}'), null, 'rule contact_email: accept');
select is(public.admin_validate_settings_patch('{"contact_email": "a@b"}'), 'contact_email', 'rule contact_email: reject');
select is(public.admin_validate_settings_patch('{"contact_phone": "+919876543210"}'), null, 'rule contact_phone: accept');
select is(public.admin_validate_settings_patch('{"contact_phone": "9876543210"}'), 'contact_phone', 'rule contact_phone: reject without plus');
select is(public.admin_validate_settings_patch('{"contact_whatsapp_url": "https://wa.me/1"}'), null, 'rule contact_whatsapp_url: accept');
select is(public.admin_validate_settings_patch('{"contact_whatsapp_url": "https://u:p@wa.me/1"}'), 'contact_whatsapp_url', 'rule contact_whatsapp_url: reject credentials');
select is(public.admin_validate_settings_patch('{"contact_page_url": "https://example.com/contact"}'), null, 'rule contact_page_url: accept');
select is(public.admin_validate_settings_patch('{"contact_page_url": "example.com/contact"}'), 'contact_page_url', 'rule contact_page_url: reject without scheme');
select is(public.admin_validate_settings_patch('{"business_hours": {"mon-fri": "09:00-18:00"}}'), null, 'rule business_hours: accept');
select is(public.admin_validate_settings_patch('{"business_hours": {"mon-fri": "18:00-09:00"}}'), 'business_hours', 'rule business_hours: reject end before start');
select is(public.admin_validate_settings_patch('{"timezone": "Europe/London"}'), null, 'rule timezone: accept');
select is(public.admin_validate_settings_patch('{"timezone": "Mars/Olympus"}'), 'timezone', 'rule timezone: reject unknown zone');
select is(public.admin_validate_settings_patch('{"tone": "Warm and brief"}'), null, 'rule tone: accept a single line');
select is(public.admin_validate_settings_patch('{"tone": "Warm\nand brief"}'), 'tone', 'rule tone: reject a newline (single line)');
select is(public.admin_validate_settings_patch(jsonb_build_object('tone', repeat('t', 501))), 'tone', 'rule tone: reject 501 characters');
select is(public.admin_validate_settings_patch('{"scope": "Only product questions"}'), null, 'rule scope: accept');
select is(public.admin_validate_settings_patch('{"scope": "Line one\nLine two"}'), null, 'rule scope: accept a newline (multi-line)');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', repeat('s', 2001))), 'scope', 'rule scope: reject 2001 characters');
select is(public.admin_validate_settings_patch('{"tone": null}'), 'tone', 'rule: null is refused for a field that cannot be cleared');
select is(public.admin_validate_settings_patch('{"zzz": 1, "display_name": "x"}'), '_unknown_key', 'rule: an unknown key is reported by a fixed token, never by its name');

-- ===========================================================================
-- 9. Document status paging (the signature changed in 010)
-- ===========================================================================
select ok(to_regprocedure('public.admin_document_status(uuid)') is null, 'status: the old one-argument signature is gone');
select ok(to_regprocedure('public.admin_document_status(uuid, integer, integer)') is not null, 'status: the paged signature exists');

-- ===========================================================================
-- 10. Catalog: grants, search_path, audit allowlist, signatures
-- ===========================================================================
select ok(
  (select bool_and(not has_function_privilege('anon', f.o, 'EXECUTE') and not has_function_privilege('authenticated', f.o, 'EXECUTE') and not has_function_privilege('service_role', f.o, 'EXECUTE')
          and not exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f.o and a.grantee = 0))
     from (values ('public.admin_js_trim(text)'::regprocedure), ('public.admin_utf16_length(text)'::regprocedure), ('public.admin_text_ok(jsonb, integer, boolean)'::regprocedure), ('public.admin_url_ok(jsonb)'::regprocedure),
                  ('public.admin_validate_settings_patch(jsonb)'::regprocedure), ('public.admin_settings_gate_error(uuid)'::regprocedure), ('public.admin_audit(text, text, uuid, jsonb)'::regprocedure)) f(o)),
  'catalog: the validation helpers, the gate and admin_audit are executable by no API role and not PUBLIC');
select ok(
  (select bool_and(has_function_privilege('authenticated', f.o, 'EXECUTE') and not has_function_privilege('anon', f.o, 'EXECUTE') and not has_function_privilege('service_role', f.o, 'EXECUTE')
          and not exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f.o and a.grantee = 0))
     from (values ('public.admin_list_bots()'::regprocedure), ('public.admin_get_settings(uuid)'::regprocedure), ('public.admin_update_settings(uuid, integer, jsonb)'::regprocedure),
                  ('public.admin_set_bot_enabled(uuid, integer, boolean)'::regprocedure), ('public.admin_delete_conversation(uuid)'::regprocedure), ('public.admin_list_members()'::regprocedure),
                  ('public.schema_version()'::regprocedure), ('public.admin_document_status(uuid, integer, integer)'::regprocedure)) f(o)),
  'catalog: the eight new or changed browser RPCs are executable by authenticated only (not anon, service_role or PUBLIC)');
select ok(
  (select count(*) = 7 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and p.proname in ('admin_list_bots', 'admin_get_settings', 'admin_update_settings', 'admin_set_bot_enabled', 'admin_delete_conversation', 'admin_list_members', 'admin_document_status')
     and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))),
  'catalog: the seven admin RPCs are SECURITY DEFINER with an empty search_path');
select ok(
  (select not p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path=')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'schema_version'),
  'catalog: schema_version is SECURITY INVOKER with an empty search_path (it reads no table)');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('admin_list_bots', 'admin_get_settings', 'admin_update_settings', 'admin_set_bot_enabled', 'admin_delete_conversation', 'admin_list_members', 'schema_version')
             and pg_get_function_identity_arguments(p.oid) ~* '(path|role|actor|user|attempt)'), 0, 'signatures: no settings RPC takes a path, role, actor, user or attempt limit');

-- admin_audit keeps its rules and has the wider allowlist (called as the owner role with a session set)
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_audit('settings.update', 'bot', gen_random_uuid(), '{"changed_fields": "tone", "expected_settings_version": 1, "settings_version": 2, "enabled": true, "conversation_id": "x", "bot_id": "y"}')$q$, 'audit: the settings, enable and conversation keys are allowed');
select throws_ok($q$select public.admin_audit('settings.update', 'bot', gen_random_uuid(), '{"title": "x"}')$q$, '22023', null, 'audit: a key outside the allowlist is still refused');
select throws_ok($q$select public.admin_audit('settings.update', 'bot', gen_random_uuid(), '{"changed_fields": {"a": 1}}')$q$, '22023', null, 'audit: a non-scalar value is still refused');
select throws_ok($q$select public.admin_audit('settings.update', 'bot', gen_random_uuid(), jsonb_build_object('bot_id', repeat('x', 201)))$q$, '22023', null, 'audit: any other key is still limited to 200 characters');
select lives_ok($q$select public.admin_audit('settings.update', 'bot', gen_random_uuid(), jsonb_build_object('changed_fields', repeat('x', 300)))$q$, 'audit: changed_fields may be 300 characters');
select throws_ok($q$select public.admin_audit('settings.update', 'bot', gen_random_uuid(), jsonb_build_object('changed_fields', repeat('x', 301)))$q$, '22023', null, 'audit: changed_fields is still capped (301 is refused)');

-- ===========================================================================
-- 11. Debug cycle P35-D1: write quota, language sync, format characters, single-line tone, URL controls,
--     stored-row re-validation, cancelled analysis jobs
-- ===========================================================================
-- B7 has no write quota at all; B8 allows three write calls. Both are complete and disabled.
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b7000000-0000-4000-8000-000000000220', 'p35s-nowrite', 'x', array['en'], 'm', 1536),
  ('b8000000-0000-4000-8000-000000000220', 'p35s-writeq', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b7000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"quotas": {"upload": {"limit": 5, "window_seconds": 3600}}}', '{}', '{}'),
  ('b8000000-0000-4000-8000-000000000220', array['https://e.test'], '{}', '{}', '{}', '{"quotas": {"write": {"limit": 3, "window_seconds": 3600}}}', '{}', '{}');
insert into public.public_bot_config (bot_id, bot_slug, display_name, greeting, primary_color, supported_languages, escalation_label, escalation_messages, contact_email) values
  ('b7000000-0000-4000-8000-000000000220', 'p35s-nowrite', 'No Write', 'Hello', '#112233', array['en'], 'Contact', '{"en": "Email us."}', 'nw@example.test'),
  ('b8000000-0000-4000-8000-000000000220', 'p35s-writeq', 'Write Q', 'Hello', '#112233', array['en'], 'Contact', '{"en": "Email us."}', 'wq@example.test');
insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a9000000-0000-4000-8000-0000000000b7', 'b7000000-0000-4000-8000-000000000220', now() + interval '1 hour'),
  ('a9000000-0000-4000-8000-0000000000b8', 'b8000000-0000-4000-8000-000000000220', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('f7000000-0000-4000-8000-000000000220', 'b7000000-0000-4000-8000-000000000220', 'a9000000-0000-4000-8000-0000000000b7'),
  ('f8000000-0000-4000-8000-000000000220', 'b8000000-0000-4000-8000-000000000220', 'a9000000-0000-4000-8000-0000000000b8');
select set_config('t.audit11', (select count(*)::text from public.audit_logs), true);
select set_config('t.cfg7', (select to_jsonb(c)::text from public.public_bot_config c where c.bot_id = 'b7000000-0000-4000-8000-000000000220'), true);

-- 11a. A bot without a write quota fails closed on all five write functions (and nothing changes).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings('b7000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b7000000-0000-4000-8000-000000000220') s), '{"greeting": "Changed"}')$q$, 'RB036', null, 'write quota: update_settings without a write quota fails closed');
select throws_ok($q$select public.admin_set_bot_enabled('b7000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b7000000-0000-4000-8000-000000000220') s), true)$q$, 'RB036', null, 'write quota: set_bot_enabled without a write quota fails closed');
select throws_ok($q$select public.admin_delete_conversation('f7000000-0000-4000-8000-000000000220')$q$, 'RB036', null, 'write quota: delete_conversation without a write quota fails closed');
reset role;
select is((select to_jsonb(c)::text from public.public_bot_config c where c.bot_id = 'b7000000-0000-4000-8000-000000000220'), current_setting('t.cfg7'), 'write quota: the fail-closed update changed no config');
select is((select enabled from public.bot_profiles where id = 'b7000000-0000-4000-8000-000000000220'), false, 'write quota: the fail-closed enable left the bot disabled');
select is((select count(*)::int from public.conversations where id = 'f7000000-0000-4000-8000-000000000220'), 1, 'write quota: the fail-closed delete kept the conversation');
select is((select count(*)::int from public.audit_logs) - current_setting('t.audit11')::int, 0, 'write quota: the fail-closed calls wrote no audit row');
-- RB036 for the missing kind, RB036 for an invalid one (limit 0), before anything is written
update public.client_settings set upload_policy = '{"quotas": {"write": {"limit": 0, "window_seconds": 3600}}}' where bot_id = 'b7000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_delete_conversation('f7000000-0000-4000-8000-000000000220')$q$, 'RB036', null, 'write quota: an invalid write quota (limit 0) also fails closed');
reset role;

-- 11b. The write quota is shared: three calls of any kind, then RB034 for each function.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_update_settings('b8000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b8000000-0000-4000-8000-000000000220') s), '{"greeting": "Hello again"}')$q$, 'write quota: call 1 of 3 (update_settings)');
select lives_ok($q$select public.admin_set_bot_enabled('b8000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b8000000-0000-4000-8000-000000000220') s), true)$q$, 'write quota: call 2 of 3 (set_bot_enabled)');
select lives_ok($q$select public.admin_set_bot_enabled('b8000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b8000000-0000-4000-8000-000000000220') s), false)$q$, 'write quota: call 3 of 3 (disable counts too)');
select lives_ok($q$select public.admin_update_settings('b8000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b8000000-0000-4000-8000-000000000220') s), '{"tone": "calm"}'::jsonb)$q$, 'write quota: the third counted write (disabling is not counted)');
select throws_ok($q$select public.admin_update_settings('b8000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b8000000-0000-4000-8000-000000000220') s), '{"greeting": "Over the limit"}')$q$, 'RB034', null, 'write quota: update_settings is refused at the limit');
select throws_ok($q$select public.admin_set_bot_enabled('b8000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b8000000-0000-4000-8000-000000000220') s), true)$q$, 'RB034', null, 'write quota: set_bot_enabled is refused at the limit');
select throws_ok($q$select public.admin_delete_conversation('f8000000-0000-4000-8000-000000000220')$q$, 'RB034', null, 'write quota: delete_conversation is refused at the limit');
reset role;
select is((select greeting from public.public_bot_config where bot_id = 'b8000000-0000-4000-8000-000000000220'), 'Hello again', 'write quota: the refused update changed nothing');
select is((select count(*)::int from public.conversations where id = 'f8000000-0000-4000-8000-000000000220'), 1, 'write quota: the refused delete kept the conversation');
select is((select request_count from public.rate_limit_buckets where key_hash = encode(sha256(convert_to('admin_quota:b8000000-0000-4000-8000-000000000220:write', 'utf8')), 'hex')), 3, 'write quota: refused calls are not counted (the counter stays at the limit)');

-- 11c. admin_update_settings writes bot_profiles.allowed_languages together with supported_languages.
select is((select allowed_languages from public.bot_profiles where id = 'b2000000-0000-4000-8000-000000000220'), array['en'], 'languages: allowed_languages followed supported_languages when B2 dropped German');
select is((select allowed_languages from public.bot_profiles where id = 'b3000000-0000-4000-8000-000000000220'), array['en', 'hi'], 'languages: allowed_languages is the same list in the same order as supported_languages (B3)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_update_settings('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), '{"supported_languages": ["fr", "en"]}')$q$, 'languages: a disabled bot may change its languages');
reset role;
select is((select allowed_languages from public.bot_profiles where id = 'b5000000-0000-4000-8000-000000000220'), array['fr', 'en'], 'languages: the update wrote allowed_languages in the patch order');
select is((select supported_languages from public.public_bot_config where bot_id = 'b5000000-0000-4000-8000-000000000220'), array['fr', 'en'], 'languages: and supported_languages');
-- the gate refuses a bot where the two differ (B4 is complete and disabled; B2 is enabled)
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), null, 'gate: B4 passes before the lists differ');
update public.bot_profiles set allowed_languages = array['en'] where id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), 'supported_languages', 'gate: allowed_languages that differ from supported_languages are refused');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'RB035', null, 'gate: enabling a bot whose language lists differ is refused');
reset role;
update public.bot_profiles set allowed_languages = array['de', 'en'] where id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), null, 'gate: the same languages in another order are the same set');
update public.bot_profiles set allowed_languages = array['en', 'de', 'fr'] where id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), 'supported_languages', 'gate: an extra allowed language is refused too');
update public.bot_profiles set allowed_languages = array['en', 'de'] where id = 'b4000000-0000-4000-8000-000000000220';
-- an enabled bot whose lists differ cannot take any other settings change
update public.bot_profiles set allowed_languages = array['en', 'de'] where id = 'b2000000-0000-4000-8000-000000000220';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings('b2000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b2000000-0000-4000-8000-000000000220') s), '{"greeting": "Languages differ"}')$q$, 'RB035', null, 'gate: an enabled bot whose language lists differ refuses an unrelated change');
reset role;
update public.bot_profiles set allowed_languages = array['en'] where id = 'b2000000-0000-4000-8000-000000000220';

-- 11d. Invisible format characters: one class, rejected in every text field; the edges of the class are not.
select is(public.admin_validate_settings_patch(jsonb_build_object('display_name', 'a' || chr(173) || 'b')), 'display_name', 'format: U+00AD in display_name');
select is(public.admin_validate_settings_patch(jsonb_build_object('greeting', 'a' || chr(8203) || 'b')), 'greeting', 'format: U+200B in greeting');
select is(public.admin_validate_settings_patch(jsonb_build_object('greeting', 'a' || chr(8207) || 'b')), 'greeting', 'format: U+200F (end of U+200B-U+200F) in greeting');
select is(public.admin_validate_settings_patch(jsonb_build_object('escalation_label', 'a' || chr(8238) || 'b')), 'escalation_label', 'format: U+202E (bidi override) in escalation_label');
select is(public.admin_validate_settings_patch(jsonb_build_object('suggested_questions', jsonb_build_array('ok', 'a' || chr(8288) || 'b'))), 'suggested_questions', 'format: U+2060 in a suggested question');
select is(public.admin_validate_settings_patch(jsonb_build_object('escalation_messages', jsonb_build_object('en', 'a' || chr(8303) || 'b'))), 'escalation_messages', 'format: U+206F (end of U+2060-U+206F) in an escalation message');
select is(public.admin_validate_settings_patch(jsonb_build_object('tone', 'a' || chr(65279) || 'b')), 'tone', 'format: U+FEFF inside tone');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(917505) || 'b')), 'scope', 'format: U+E0001 (tag character) in scope');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(917631) || 'b')), 'scope', 'format: U+E007F (end of the tag block) in scope');
select is(public.admin_validate_settings_patch(jsonb_build_object('display_name', 'a' || chr(172) || 'b')), null, 'format: U+00AC (just below U+00AD) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('display_name', 'a' || chr(174) || 'b')), null, 'format: U+00AE (just above U+00AD) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('greeting', 'a' || chr(8202) || 'b')), null, 'format: U+200A (just below U+200B) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('greeting', 'a' || chr(8208) || 'b')), null, 'format: U+2010 (just above U+200F) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(8233) || 'b')), null, 'format: U+2029 (paragraph separator, not in the class) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(8304) || 'b')), null, 'format: U+2070 (just above U+206F) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(65278) || 'b')), null, 'format: U+FEFE (just below U+FEFF) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(917632) || 'b')), null, 'format: U+E0080 (just above U+E007F) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('scope', 'a' || chr(917503) || 'b')), null, 'format: U+DFFFF-range neighbour U+E0000-1 is accepted');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), jsonb_build_object('display_name', 'Zero' || chr(8203) || 'Width'))$q$, 'RB035', null, 'format: update_settings refuses a display name with a zero-width space');
reset role;
select is((select display_name from public.public_bot_config where bot_id = 'b5000000-0000-4000-8000-000000000220'), 'Disabled Bot', 'format: and changed nothing');

-- 11e. tone is a single line (a newline or carriage return inside); scope keeps its newlines.
select is(public.admin_validate_settings_patch('{"tone": "line one\nline two"}'), 'tone', 'tone: a newline inside is refused');
select is(public.admin_validate_settings_patch('{"tone": "line one\rline two"}'), 'tone', 'tone: a carriage return inside is refused');
select is(public.admin_validate_settings_patch('{"tone": "  calm and brief\n"}'), null, 'tone: a trailing newline is trimmed first, so it is accepted');
select is(public.admin_validate_settings_patch('{"tone": "tab\tseparated"}'), null, 'tone: a tab is still allowed');
select is(public.admin_validate_settings_patch('{"scope": "line one\r\nline two"}'), 'scope', 'scope: a carriage return is still refused (free text allows tab and newline only, as before)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select public.admin_update_settings('b5000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b5000000-0000-4000-8000-000000000220') s), '{"tone": "two\nlines"}')$q$, 'RB035', null, 'tone: update_settings refuses a multi-line tone');
reset role;

-- 11f. URLs reject every C0 and C1 control character (and DEL).
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(1) || 'b')), 'privacy_url', 'url: C0 control U+0001');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(27) || 'b')), 'privacy_url', 'url: C0 control U+001B (escape)');
select is(public.admin_validate_settings_patch(jsonb_build_object('contact_page_url', 'https://example.com/a' || chr(31) || 'b')), 'contact_page_url', 'url: C0 control U+001F');
select is(public.admin_validate_settings_patch(jsonb_build_object('contact_whatsapp_url', 'https://example.com/a' || chr(127) || 'b')), 'contact_whatsapp_url', 'url: DEL U+007F');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(128) || 'b')), 'privacy_url', 'url: C1 control U+0080');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(133) || 'b')), 'privacy_url', 'url: C1 control U+0085 (next line)');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(159) || 'b')), 'privacy_url', 'url: C1 control U+009F');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(160) || 'b')), 'privacy_url', 'url: U+00A0 (no-break space) is still refused as whitespace');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a' || chr(161) || 'b')), null, 'url: U+00A1 (first character after the C1 block) is accepted');
select is(public.admin_validate_settings_patch(jsonb_build_object('privacy_url', 'https://example.com/a%7Fb')), null, 'url: a percent-encoded DEL is just text and is accepted');

-- 11g. Every path that re-validates a stored row: the gate checks tone and scope too (rows an operator wrote).
update public.bot_profiles set tone = E'two\nlines' where id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), 'tone', 'stored: a multi-line tone fails the gate');
update public.bot_profiles set tone = 'calm', scope = 'a' || chr(8203) || 'b' where id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), 'scope', 'stored: a scope with a format character fails the gate');
update public.bot_profiles set scope = 'ok' where id = 'b4000000-0000-4000-8000-000000000220';
update public.public_bot_config set greeting = 'Hel' || chr(8238) || 'lo' where bot_id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), 'greeting', 'stored: a greeting with a bidi override fails the gate');
update public.public_bot_config set greeting = 'Hello', privacy_url = 'https://example.com/p' || chr(1) where bot_id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), 'privacy_url', 'stored: a URL with a control character fails the gate (the table check allows it)');
update public.public_bot_config set privacy_url = null where bot_id = 'b4000000-0000-4000-8000-000000000220';
select is(public.admin_settings_gate_error('b4000000-0000-4000-8000-000000000220'), null, 'stored: with the rows repaired the gate passes again');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_set_bot_enabled('b4000000-0000-4000-8000-000000000220', (select s.settings_version from public.admin_get_settings('b4000000-0000-4000-8000-000000000220') s), true)$q$, 'stored: and the repaired bot can be enabled');
reset role;

-- 11h. Deleting a conversation cancels its queued analysis job (not a running one, not another conversation's).
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('f4000000-0000-4000-8000-000000000220', 'b1000000-0000-4000-8000-000000000220', 'a9000000-0000-4000-8000-000000000220');
insert into public.jobs (type, dedupe_key, payload, state, max_attempts) values
  ('analyze_conversation', 'analyze:f4-queued', '{"bot_id": "b1000000-0000-4000-8000-000000000220", "conversation_id": "f4000000-0000-4000-8000-000000000220"}', 'queued', 3),
  ('analyze_conversation', 'analyze:f4-running', '{"bot_id": "b1000000-0000-4000-8000-000000000220", "conversation_id": "f4000000-0000-4000-8000-000000000220"}', 'running', 3),
  ('analyze_conversation', 'analyze:f2-queued', '{"bot_id": "b1000000-0000-4000-8000-000000000220", "conversation_id": "f2000000-0000-4000-8000-000000000220"}', 'queued', 3);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000220","aal":"aal2","role":"authenticated"}', true);
select lives_ok($q$select public.admin_delete_conversation('f4000000-0000-4000-8000-000000000220')$q$, 'analysis jobs: delete a conversation that has a queued and a running analysis job');
reset role;
select is((select j.state from public.jobs j where j.dedupe_key = 'analyze:f4-queued'), 'cancelled', 'analysis jobs: the queued analysis job is cancelled');
select ok((select j.completed_at is not null from public.jobs j where j.dedupe_key = 'analyze:f4-queued'), 'analysis jobs: and has a completion time');
select is((select j.state from public.jobs j where j.dedupe_key = 'analyze:f4-running'), 'running', 'analysis jobs: a running analysis job is left to the worker');
select is((select j.state from public.jobs j where j.dedupe_key = 'analyze:f2-queued'), 'queued', 'analysis jobs: another conversation''s queued job is untouched');

select * from finish();
rollback;
