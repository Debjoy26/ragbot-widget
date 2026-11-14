-- P9-T1 (migration 016): service-role RPC for visitor data entries (W-13).
-- Success, ownership (RB037, no oracle), fail-closed validation (22023),
-- consent timestamping, grants and proconfig. All fixtures are synthetic.
-- Ids end in 000000000230: bots bN, session aN, conversation cN.
begin;
select plan(19);

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions, enabled) values
  ('b1000000-0000-4000-8000-000000000230', 'p9-main',  'x', array['en'], 'm', 1536, true),
  ('b2000000-0000-4000-8000-000000000230', 'p9-other', 'x', array['en'], 'm', 1536, true),
  ('b3000000-0000-4000-8000-000000000230', 'p9-off',   'x', array['en'], 'm', 1536, false);
insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-000000000230', 'b1000000-0000-4000-8000-000000000230', now() + interval '1 hour');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c1000000-0000-4000-8000-000000000230', 'b1000000-0000-4000-8000-000000000230', 'a1000000-0000-4000-8000-000000000230'),
  ('c2000000-0000-4000-8000-000000000230', 'b2000000-0000-4000-8000-000000000230', null);

-- ===== standalone entry (no conversation) =====
create temp table e1 as
  select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'callback_request', '{"name":"Asha"}', now());
select isnt((select entry_id from e1), null, 'create_data_entry: standalone entry returns an id');
select is((select count(*)::int from public.data_entries where bot_id = 'b1000000-0000-4000-8000-000000000230' and conversation_id is null and schema_key = 'callback_request'), 1, 'create_data_entry: the standalone row is stored');
select ok((select consent_at is not null from public.data_entries where id = (select entry_id from e1)), 'create_data_entry: consent is stored as a timestamp (W-13)');

-- ===== entry on the bot's own conversation =====
create temp table e2 as
  select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', 'c1000000-0000-4000-8000-000000000230', 'callback_request', '{"name":"Asha"}', now());
select isnt((select entry_id from e2), null, 'create_data_entry: entry on the own conversation returns an id');

-- ===== ownership: no oracle (RB037 for foreign, unknown, and unknown bot) =====
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', 'c2000000-0000-4000-8000-000000000230', 'callback_request', '{"name":"Asha"}', now())$q$, 'RB037', null, 'create_data_entry: another bot conversation -> RB037');
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', 'c9000000-0000-4000-8000-000000000230', 'callback_request', '{"name":"Asha"}', now())$q$, 'RB037', null, 'create_data_entry: unknown conversation -> RB037');
select throws_ok($q$select * from public.create_data_entry('b9000000-0000-4000-8000-000000000230', null, 'callback_request', '{"name":"Asha"}', now())$q$, 'RB037', null, 'create_data_entry: unknown bot -> RB037 (same code, no oracle)');

-- ===== fail-closed validation (22023) =====
select throws_ok($q$select * from public.create_data_entry(null, null, 'callback_request', '{"name":"Asha"}', now())$q$, '22023', null, 'create_data_entry: null bot -> 22023');
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'Bad Key', '{"name":"Asha"}', now())$q$, '22023', null, 'create_data_entry: bad schema_key -> 22023');
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, null, '{"name":"Asha"}', now())$q$, '22023', null, 'create_data_entry: null schema_key -> 22023');
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'callback_request', '"just a string"', now())$q$, '22023', null, 'create_data_entry: non-object payload -> 22023');
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'callback_request', null, now())$q$, '22023', null, 'create_data_entry: null payload -> 22023');
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'callback_request', '{"name":"Asha"}', null)$q$, '22023', null, 'create_data_entry: null consent -> 22023 (consent mandatory)');
select is((select count(*)::int from public.data_entries), 2, 'create_data_entry: refused calls inserted nothing');

-- ===== grants and configuration =====
select ok(has_function_privilege('service_role', 'public.create_data_entry(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE'), 'grants: service_role can EXECUTE create_data_entry');
select ok(not has_function_privilege('anon', 'public.create_data_entry(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.create_data_entry(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE') and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.create_data_entry(uuid,uuid,text,jsonb,timestamptz)'::regprocedure and a.grantee = 0), 'catalog: anon/authenticated/PUBLIC cannot EXECUTE create_data_entry');
select ok((select 'lock_timeout=2s' = any (proconfig) and 'search_path=""' = any (proconfig) and not prosecdef from pg_proc where oid = 'public.create_data_entry(uuid,uuid,text,jsonb,timestamptz)'::regprocedure), 'proconfig: create_data_entry sets lock_timeout, an empty search_path and is SECURITY INVOKER');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'callback_request', '{"name":"Asha"}', now())$q$, '42501', null, 'anon: create_data_entry -> permission denied');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000230","aal":"aal2","role":"authenticated"}', true);
select throws_ok($q$select * from public.create_data_entry('b1000000-0000-4000-8000-000000000230', null, 'callback_request', '{"name":"Asha"}', now())$q$, '42501', null, 'authenticated: create_data_entry -> permission denied');
reset role;

select * from finish();
rollback;
