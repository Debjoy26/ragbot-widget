-- Review P3.5-R3 fixes: emergency disable ignores the write quota (R3-2), an expired job reservation keeps
-- counting toward the cap until settled (R3-3), and retry recovers a stuck version (R3-8).
begin;
select plan(12);

insert into auth.users (id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000230', 'authenticated', 'authenticated', 'p35d2-owner@example.test');
insert into public.admin_memberships (user_id, role, active) values
  ('a1000000-0000-4000-8000-000000000230', 'owner', true);
insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-000000000230', 'p35d2-main', 'x', array['en'], 'm', 1536);
insert into public.public_bot_config (bot_id, bot_slug, display_name, greeting, primary_color, supported_languages, escalation_label, escalation_messages, contact_email) values
  ('b1000000-0000-4000-8000-000000000230', 'p35d2-main', 'Bot', 'Hi', '#112233', array['en'], 'Contact', '{"en": "Please contact us."}', 'help@example.com');
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-000000000230', array['https://e.test'], '{}', '{"daily_cap_usd": 2}', '{}',
   '{"max_bytes": 1048576, "index_max_attempts": 3, "cleanup_max_attempts": 3, "quotas": {"register": {"limit": 9, "window_seconds": 3600}, "upload": {"limit": 9, "window_seconds": 3600}, "reindex": {"limit": 9, "window_seconds": 3600}, "write": {"limit": 1, "window_seconds": 3600}}}',
   '{}', '{}');

select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000230","aal":"aal2","role":"authenticated"}', true);

-- R3-2
select lives_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000230', (select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000230'), true)$q$, 'R3-2: enabling uses the one write allowed');
select is((select enabled from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000230'), true, 'R3-2: the bot is enabled');
select lives_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000230', (select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000230'), false)$q$, 'R3-2: disabling works with the write quota spent');
select is((select enabled from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000230'), false, 'R3-2: the bot is disabled');
select throws_ok($q$select public.admin_set_bot_enabled('b1000000-0000-4000-8000-000000000230', (select settings_version from public.bot_profiles where id = 'b1000000-0000-4000-8000-000000000230'), true)$q$, 'RB034', null, 'R3-2: enabling again is still limited');

-- R3-3
-- Moved in P6-D2 from reserve_job_budget (dropped in 012) to the fenced reserve_index_budget / settle_index_budget.
-- The fence needs a document, a version and a running job held by worker 'w' whose payload names that version, and
-- the bot is enabled for this section only (R3-2 left it disabled; reserve_index_budget does not refuse a disabled bot, so
-- this is not needed for the fence; it only keeps the section as it was).
insert into public.documents (id, bot_id, title, status) values
  ('d2000000-0000-4000-8000-000000000230', 'b1000000-0000-4000-8000-000000000230', 'Doc3', 'indexing');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, status) values
  ('e2000000-0000-4000-8000-000000000230', 'd2000000-0000-4000-8000-000000000230', 1,
   'b1000000-0000-4000-8000-000000000230/d2000000-0000-4000-8000-000000000230/e2000000-0000-4000-8000-000000000230/original.txt', 'text/plain', 'embedding');
insert into public.jobs (id, type, dedupe_key, payload, state, max_attempts, locked_by, locked_until) values
  ('c1000000-0000-4000-8000-000000000230', 'index_document', 'd2:job1', '{"bot_id": "b1000000-0000-4000-8000-000000000230", "document_id": "d2000000-0000-4000-8000-000000000230", "version_id": "e2000000-0000-4000-8000-000000000230"}', 'running', 3, 'w', now() + interval '1 hour');
update public.bot_profiles set enabled = true where id = 'b1000000-0000-4000-8000-000000000230';
select set_config('t.r1', public.reserve_index_budget('c1000000-0000-4000-8000-000000000230', 'w', 'e2000000-0000-4000-8000-000000000230', 1.5, 3600)::text, true);
update public.budget_reservations set expires_at = now() - interval '1 minute' where id = current_setting('t.r1')::uuid;
-- P6-R5 #1: the next attempt of the same job (the fenced holder) settles the earlier row at its recorded usage (none
-- here) before the cap check, so 1.0 fits the cap of 2 although 1.5 + 1.0 would not. A row of another job, reserved or
-- expired, still counts in full: 250 covers that.
select ok(public.reserve_index_budget('c1000000-0000-4000-8000-000000000230', 'w', 'e2000000-0000-4000-8000-000000000230', 1.0, 3600) is not null, 'R3-3: the next attempt settles the earlier expired row of its job at its usage and fits');
select results_eq(format($q$select state, amount from public.budget_reservations where id = %L$q$, current_setting('t.r1')), $q$values ('settled'::text, 0.000000::numeric)$q$, 'R3-3: the earlier row is settled at 0 (no usage recorded in its window)');
select throws_ok(format($q$select public.settle_index_budget('c1000000-0000-4000-8000-000000000230', 'w', %L, 0.25)$q$, current_setting('t.r1')), 'RB003', null, 'R3-3: a settled earlier row cannot be settled again');

update public.budget_reservations set expires_at = now() - interval '1 minute' where job_id = 'c1000000-0000-4000-8000-000000000230' and state = 'reserved';
select ok(public.reserve_index_budget('c1000000-0000-4000-8000-000000000230', 'w', 'e2000000-0000-4000-8000-000000000230', 0.5, 3600) is not null, 'R3-3: with room under the cap, the next attempt replaces an expired row');
select is((select array_agg(state order by state) from public.budget_reservations where job_id = 'c1000000-0000-4000-8000-000000000230'), array['reserved', 'settled', 'settled'], 'R3-3: the replaced rows are settled, only the newest is reserved');

-- R3-8
insert into public.documents (id, bot_id, title, status) values
  ('d1000000-0000-4000-8000-000000000230', 'b1000000-0000-4000-8000-000000000230', 'Doc', 'indexing');
insert into public.document_versions (id, document_id, version_number, storage_path, media_type, status) values
  ('e1000000-0000-4000-8000-000000000230', 'd1000000-0000-4000-8000-000000000230', 1,
   'b1000000-0000-4000-8000-000000000230/d1000000-0000-4000-8000-000000000230/e1000000-0000-4000-8000-000000000230/original.txt', 'text/plain', 'extracting');
insert into public.jobs (type, dedupe_key, payload, state, max_attempts) values
  ('index_document', 'index:version:e1000000-0000-4000-8000-000000000230', '{"bot_id": "b1000000-0000-4000-8000-000000000230", "document_id": "d1000000-0000-4000-8000-000000000230", "version_id": "e1000000-0000-4000-8000-000000000230"}', 'running', 3);
select throws_ok($q$select public.admin_retry_version('e1000000-0000-4000-8000-000000000230')$q$, 'RB030', null, 'R3-8: retry refuses a version whose job is still live');
update public.jobs set state = 'failed', completed_at = now() where dedupe_key = 'index:version:e1000000-0000-4000-8000-000000000230';
select lives_ok($q$select public.admin_retry_version('e1000000-0000-4000-8000-000000000230')$q$, 'R3-8: retry recovers a stuck version after its job is dead-lettered');

select * from finish();
rollback;
