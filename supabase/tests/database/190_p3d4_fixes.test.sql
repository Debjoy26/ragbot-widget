-- P3-D4 fixes (review P3-R4): migration 007 (R4-8 reserve needs a live run, R3-9 request_runs state
-- guard, comments for R3-4 and R4-8) plus the test gaps found by the reviewers (R4-2 pins, R4-6 grants
-- catalog, reaper edge cases, reply_to writer paths, retention, knowledge_gaps after question deletion).
-- All fixtures are synthetic. Sequential only: the real two-connection races are in scripts/race-db.sh.
--
-- Id scheme: bots b1..b5 = 'bN000000-0000-4000-8000-0000000000d4', sessions aN likewise,
-- run nn = 'f00000nn-0000-4000-8000-0000000000d4'.
begin;
select plan(116);

insert into auth.users (id, aud, role, email) values
  ('a0000000-0000-4000-8000-0000000000d4', 'authenticated', 'authenticated', 'd4-admin@example.test');
insert into public.admin_memberships (user_id, role) values ('a0000000-0000-4000-8000-0000000000d4', 'admin');

insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions) values
  ('b1000000-0000-4000-8000-0000000000d4', 'd4-one', 'x', array['en'], 'm', 1536),
  ('b2000000-0000-4000-8000-0000000000d4', 'd4-two', 'x', array['en'], 'm', 1536),
  ('b3000000-0000-4000-8000-0000000000d4', 'd4-overshoot', 'x', array['en'], 'm', 1536),
  ('b4000000-0000-4000-8000-0000000000d4', 'd4-reaper', 'x', array['en'], 'm', 1536),
  ('b5000000-0000-4000-8000-0000000000d4', 'd4-midnight', 'x', array['en'], 'm', 1536);
insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy) values
  ('b1000000-0000-4000-8000-0000000000d4', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}'),
  ('b2000000-0000-4000-8000-0000000000d4', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}'),
  ('b3000000-0000-4000-8000-0000000000d4', array['https://e.test'], '{}', '{"daily_cap_usd": 1}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}'),
  ('b4000000-0000-4000-8000-0000000000d4', array['https://e.test'], '{}', '{"daily_cap_usd": 5}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}'),
  ('b5000000-0000-4000-8000-0000000000d4', array['https://e.test'], '{}', '{"daily_cap_usd": 1}', '{"conversation_days": 90, "usage_months": 13}', '{}', '{}', '{}');
insert into public.visitor_sessions (id, bot_id, expires_at) values
  ('a1000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', now() + interval '1 hour'),
  ('a2000000-0000-4000-8000-0000000000d4', 'b2000000-0000-4000-8000-0000000000d4', now() + interval '1 hour'),
  ('a3000000-0000-4000-8000-0000000000d4', 'b3000000-0000-4000-8000-0000000000d4', now() + interval '1 hour'),
  ('a4000000-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', now() + interval '1 hour'),
  ('a5000000-0000-4000-8000-0000000000d4', 'b5000000-0000-4000-8000-0000000000d4', now() + interval '1 hour');

-- ===========================================================================
-- R4-8: reserve_request_budget needs a live run for a NEW reservation (007)
-- ===========================================================================
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state) values
  ('f0000001-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000001', repeat('a', 64), 'failed'),
  ('f0000002-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000002', repeat('a', 64), 'succeeded'),
  ('f0000003-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000003', repeat('a', 64), 'partial'),
  ('f0000004-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000004', repeat('a', 64), 'running'),
  ('f0000005-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000005', repeat('a', 64), 'reserved'),
  ('f0000006-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000006', repeat('a', 64), 'running'),
  ('f0000007-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000007', repeat('a', 64), 'reserved'),
  ('f0000008-0000-4000-8000-0000000000d4', 'b2000000-0000-4000-8000-0000000000d4', 'a2000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000008', repeat('a', 64), 'running');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000001-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request is not active', 'R4-8: a new reservation on a failed run is refused');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000002-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request is not active', 'R4-8: a new reservation on a succeeded run is refused');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000003-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request is not active', 'R4-8: a new reservation on a partial run is refused');
select is((select count(*)::int from public.budget_reservations where request_id in
  ('f0000001-0000-4000-8000-0000000000d4', 'f0000002-0000-4000-8000-0000000000d4', 'f0000003-0000-4000-8000-0000000000d4')), 0,
  'R4-8: the refused reserves created no reservation');
select lives_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000004-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'R4-8: a running run still reserves');
select lives_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000005-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'R4-8: a reserved run still reserves');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-00000000dead', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request not found for bot', 'R4-8: an unknown request is still RB004');

-- Idempotent retry on a settled reservation of a finished run returns the reservation.
select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000006-0000-4000-8000-0000000000d4', 1.0, 3600);
select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000006-0000-4000-8000-0000000000d4'), 0.5);
reset role;
update public.request_runs set state = 'succeeded', finished_at = now() where id = 'f0000006-0000-4000-8000-0000000000d4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000006-0000-4000-8000-0000000000d4', 1.0, 3600),
  (select id from public.budget_reservations where request_id = 'f0000006-0000-4000-8000-0000000000d4'),
  'R4-8: an idempotent retry on a settled reservation of a succeeded run returns it');
select is((select count(*)::int || ':' || min(amount)::text from public.budget_reservations where request_id = 'f0000006-0000-4000-8000-0000000000d4'), '1:0.500000',
  'R4-8: the retry changed nothing (one reservation, settled amount kept)');

-- Same for a still-reserved reservation whose run has since failed (not reaped).
select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000007-0000-4000-8000-0000000000d4', 0.3, 3600);
reset role;
update public.request_runs set state = 'failed', finished_at = now() where id = 'f0000007-0000-4000-8000-0000000000d4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000007-0000-4000-8000-0000000000d4', 0.3, 3600),
  (select id from public.budget_reservations where request_id = 'f0000007-0000-4000-8000-0000000000d4'),
  'R4-8: an idempotent retry on a reserved reservation of a failed run returns it');

-- A reservation or request id that belongs to another bot's run.
select throws_ok($q$select public.reserve_request_budget('b2000000-0000-4000-8000-0000000000d4', 'f0000004-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request not found for bot', 'R4-8: another bot cannot reserve against a run that already has a reservation (id not returned)');
select throws_ok($q$select public.reserve_request_budget('b2000000-0000-4000-8000-0000000000d4', 'f0000001-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request not found for bot', 'R4-8: another bot cannot reserve against a foreign failed run (not-found wins over not-active)');
select throws_ok($q$select public.reserve_request_budget('b1000000-0000-4000-8000-0000000000d4', 'f0000008-0000-4000-8000-0000000000d4', 0.5, 3600)$q$,
  'RB004', 'reserve_request_budget: request not found for bot', 'R4-8: a run of another bot is refused for the first bot too');
select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.1)', 'b2000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000004-0000-4000-8000-0000000000d4')), 'RB003', null,
  'R4-8: another bot cannot settle a reserved reservation');
select throws_ok(format('select public.release_budget_reservation(%L, %L)', 'b2000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000004-0000-4000-8000-0000000000d4')), 'RB003', null,
  'R4-8: another bot cannot release a reserved reservation');
select throws_ok(format('select public.settle_budget_reservation(%L, %L, 0.1)', 'b2000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000006-0000-4000-8000-0000000000d4')), 'RB003', null,
  'R4-8: another bot cannot settle a settled reservation');
select is((select state || ':' || amount::text from public.budget_reservations where request_id = 'f0000006-0000-4000-8000-0000000000d4'), 'settled:0.500000',
  'R4-8: the foreign attempts changed nothing');
reset role;

-- 007 leaves owner, grants, search_path and security mode of reserve_request_budget as they were.
select is((select proowner::regrole::text from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure),
  (select proowner::regrole::text from pg_proc where oid = 'public.settle_budget_reservation(uuid,uuid,numeric)'::regprocedure),
  'R4-8: reserve_request_budget keeps the owner of its sibling functions');
select is((select proacl::text from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure),
  (select proacl::text from pg_proc where oid = 'public.settle_budget_reservation(uuid,uuid,numeric)'::regprocedure),
  'R4-8: reserve_request_budget has the same grants as settle (service_role only, none for public/anon/authenticated)');
select ok(not has_function_privilege('anon', 'public.reserve_request_budget(uuid,uuid,numeric,integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.reserve_request_budget(uuid,uuid,numeric,integer)', 'execute')
      and has_function_privilege('service_role', 'public.reserve_request_budget(uuid,uuid,numeric,integer)', 'execute'),
  'R4-8: EXECUTE on reserve_request_budget is service_role only');
select is((select proconfig::text from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure), '{"search_path=\"\""}',
  'R4-8: reserve_request_budget keeps the empty search_path');
select ok((select not prosecdef from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure),
  'R4-8: reserve_request_budget stays SECURITY INVOKER');
select ok((select regexp_replace(regexp_replace(prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
                  ~* 'from\s+public\.request_runs\s+r\s+where\s+r\.id\s*=\s*p_request_id\s+and\s+r\.bot_id\s*=\s*p_bot_id\s+for\s+share'
  from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure),
  'R4-8, R5-3: the run row is read FOR SHARE, scoped to the bot (source smoke check, not a race test; see scripts/race-db.sh)');
select ok((select position('return v_existing.id' in prosrc) between 1 and position('request is not active' in prosrc) - 1
  from pg_proc where oid = 'public.reserve_request_budget(uuid,uuid,numeric,integer)'::regprocedure),
  'R4-8: the existing-reservation early return comes before the run-state check');

-- ===========================================================================
-- R3-9: request_runs.state moves forward only (007 trigger)
-- ===========================================================================
create function pg_temp.try_transition(p_from text, p_to text) returns text
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash, state)
  values ('b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', gen_random_uuid()::text, repeat('a', 64), p_from)
  returning id into v_id;
  begin
    update public.request_runs set state = p_to where id = v_id;
  exception when others then
    return sqlstate || ':' || (select state from public.request_runs where id = v_id);
  end;
  return 'ok:' || (select state from public.request_runs where id = v_id);
end;
$$;

-- allowed
select is(pg_temp.try_transition('reserved', 'reserved'), 'ok:reserved', 'R3-9: reserved -> reserved (no-op) is allowed');
select is(pg_temp.try_transition('reserved', 'running'), 'ok:running', 'R3-9: reserved -> running is allowed');
select is(pg_temp.try_transition('reserved', 'succeeded'), 'ok:succeeded', 'R3-9: reserved -> succeeded is allowed');
select is(pg_temp.try_transition('reserved', 'failed'), 'ok:failed', 'R3-9: reserved -> failed is allowed');
select is(pg_temp.try_transition('reserved', 'partial'), 'ok:partial', 'R3-9: reserved -> partial is allowed');
select is(pg_temp.try_transition('running', 'running'), 'ok:running', 'R3-9: running -> running (no-op) is allowed');
select is(pg_temp.try_transition('running', 'succeeded'), 'ok:succeeded', 'R3-9: running -> succeeded is allowed');
select is(pg_temp.try_transition('running', 'failed'), 'ok:failed', 'R3-9: running -> failed is allowed');
select is(pg_temp.try_transition('running', 'partial'), 'ok:partial', 'R3-9: running -> partial is allowed');
select is(pg_temp.try_transition('succeeded', 'succeeded'), 'ok:succeeded', 'R3-9: succeeded -> succeeded (no-op) is allowed');
select is(pg_temp.try_transition('failed', 'failed'), 'ok:failed', 'R3-9: failed -> failed (no-op) is allowed');
select is(pg_temp.try_transition('partial', 'partial'), 'ok:partial', 'R3-9: partial -> partial (no-op) is allowed');

-- rejected: 23514 and the state stays as it was
select is(pg_temp.try_transition('running', 'reserved'), '23514:running', 'R3-9: running -> reserved is rejected');
select is(pg_temp.try_transition('succeeded', 'reserved'), '23514:succeeded', 'R3-9: succeeded -> reserved is rejected');
select is(pg_temp.try_transition('succeeded', 'running'), '23514:succeeded', 'R3-9: succeeded -> running is rejected');
select is(pg_temp.try_transition('succeeded', 'failed'), '23514:succeeded', 'R3-9: succeeded -> failed is rejected');
select is(pg_temp.try_transition('succeeded', 'partial'), '23514:succeeded', 'R3-9: succeeded -> partial is rejected');
select is(pg_temp.try_transition('failed', 'reserved'), '23514:failed', 'R3-9: failed -> reserved is rejected');
select is(pg_temp.try_transition('failed', 'running'), '23514:failed', 'R3-9: failed -> running is rejected');
select is(pg_temp.try_transition('failed', 'succeeded'), '23514:failed', 'R3-9: failed -> succeeded is rejected');
select is(pg_temp.try_transition('failed', 'partial'), '23514:failed', 'R3-9: failed -> partial is rejected');
select is(pg_temp.try_transition('partial', 'reserved'), '23514:partial', 'R3-9: partial -> reserved is rejected');
select is(pg_temp.try_transition('partial', 'running'), '23514:partial', 'R3-9: partial -> running is rejected');
select is(pg_temp.try_transition('partial', 'succeeded'), '23514:partial', 'R3-9: partial -> succeeded is rejected');
select is(pg_temp.try_transition('partial', 'failed'), '23514:partial', 'R3-9: partial -> failed is rejected');

-- An unknown state is still refused by the table CHECK (23514 too), not let through by the trigger.
select is(pg_temp.try_transition('running', 'bogus'), '23514:running', 'R3-9: an unknown target state is rejected');

-- Only UPDATE OF state is guarded: other columns of a finished run can still be written.
select lives_ok($q$update public.request_runs set finished_at = now() + interval '1 second', reserved_tokens = 7 where id = 'f0000001-0000-4000-8000-0000000000d4'$q$,
  'R3-9: updating other columns of a terminal run is not guarded');
select lives_ok($q$update public.request_runs set state = state where id = 'f0000001-0000-4000-8000-0000000000d4'$q$,
  'R3-9: SET state = state on a terminal run is a no-op, not an error');

-- As the real caller: service_role.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$update public.request_runs set state = 'running' where id = 'f0000001-0000-4000-8000-0000000000d4'$q$,
  '23514', 'request_runs: state cannot change from failed to running', 'R3-9: service_role cannot revive a failed run');
select lives_ok($q$update public.request_runs set state = 'running' where id = 'f0000005-0000-4000-8000-0000000000d4'$q$,
  'R3-9: service_role can move a reserved run to running');
select lives_ok($q$update public.request_runs set state = 'partial', finished_at = now() where id = 'f0000005-0000-4000-8000-0000000000d4'$q$,
  'R3-9: service_role can finish a running run');
select throws_ok($q$update public.request_runs set state = 'running' where id = 'f0000005-0000-4000-8000-0000000000d4'$q$,
  '23514', 'request_runs: state cannot change from partial to running', 'R3-9: and cannot reopen it');
reset role;

-- Catalog: BEFORE UPDATE OF state, row level, state column only; function not callable by clients.
select is((select tgtype::int from pg_trigger where tgrelid = 'public.request_runs'::regclass and tgname = 'request_runs_check_state_transition' and not tgisinternal),
  19, 'R3-9: the trigger is BEFORE UPDATE FOR EACH ROW');
select is((select tgattr::text from pg_trigger where tgrelid = 'public.request_runs'::regclass and tgname = 'request_runs_check_state_transition'),
  (select attnum::text from pg_attribute where attrelid = 'public.request_runs'::regclass and attname = 'state'),
  'R3-9: the trigger fires on UPDATE OF state only');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.request_runs'::regclass and tgname = 'request_runs_check_state_transition' and tgenabled = 'O'), 1,
  'R3-9: the trigger is enabled');
select ok((select not prosecdef from pg_proc where oid = to_regprocedure('public.request_runs_check_state_transition()'))
      and (select proconfig::text from pg_proc where oid = to_regprocedure('public.request_runs_check_state_transition()')) = '{"search_path=\"\""}',
  'R3-9: the trigger function is SECURITY INVOKER with an empty search_path');
select ok(not has_function_privilege('anon', to_regprocedure('public.request_runs_check_state_transition()'), 'execute')
      and not has_function_privilege('authenticated', to_regprocedure('public.request_runs_check_state_transition()'), 'execute')
      and (select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = to_regprocedure('public.request_runs_check_state_transition()') and a.grantee = 0) = 0,
  'R3-9: EXECUTE on the trigger function is revoked from public, anon and authenticated');
set local role authenticated;
select throws_ok($q$select public.request_runs_check_state_transition()$q$, '42501', null, 'R3-9: authenticated cannot call the trigger function');
reset role;

-- ===========================================================================
-- R3-4 / R4-8 comments
-- ===========================================================================
select ok(obj_description('public.audit_logs_no_truncate()'::regprocedure, 'pg_proc') ~ 'table owner can still drop or disable',
  'R3-4: the TRUNCATE trigger comment says an owner can still drop or disable it');
select ok(obj_description('public.expire_stuck_request_runs(integer,integer)'::regprocedure, 'pg_proc') ~ 'expired'
      and obj_description('public.expire_stuck_request_runs(integer,integer)'::regprocedure, 'pg_proc') ~ 'settleable',
  'R4-8: the reaper comment says reservations become expired and stay settleable');

-- ===========================================================================
-- R4-6: only service_role, postgres and the owner can write public.messages
-- ===========================================================================
select is((select count(*)::int from pg_roles r
  where r.rolname !~ '^pg_' and not r.rolsuper
    and r.rolname not in ('postgres', 'service_role')
    and r.oid <> (select relowner from pg_class where oid = 'public.messages'::regclass)
    and (has_any_column_privilege(r.oid, 'public.messages', 'INSERT') or has_any_column_privilege(r.oid, 'public.messages', 'UPDATE'))),
  0, 'R4-6: no other non-superuser role (inherited privileges included) can INSERT or UPDATE public.messages');
select is((select count(*)::int from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.messages'::regclass and a.privilege_type in ('INSERT', 'UPDATE')
    and a.grantee not in ('postgres'::regrole, 'service_role'::regrole, c.relowner)),
  0, 'R4-6: the table ACL grants INSERT/UPDATE only to postgres, service_role and the owner (PUBLIC is grantee 0)');
select is((select count(*)::int from pg_attribute t, aclexplode(t.attacl) a
  where t.attrelid = 'public.messages'::regclass and t.attacl is not null and a.privilege_type in ('INSERT', 'UPDATE')
    and a.grantee not in ('postgres'::regrole, 'service_role'::regrole, (select relowner from pg_class where oid = 'public.messages'::regclass))),
  0, 'R4-6: no column-level INSERT/UPDATE grant on messages for anyone else');
select ok(has_table_privilege('service_role', 'public.messages', 'INSERT') and has_table_privilege('service_role', 'public.messages', 'UPDATE'),
  'R4-6: service_role, the real writer, does hold INSERT and UPDATE');
select ok(not has_table_privilege('anon', 'public.messages', 'INSERT') and not has_table_privilege('authenticated', 'public.messages', 'INSERT')
      and not has_table_privilege('anon', 'public.messages', 'UPDATE') and not has_table_privilege('authenticated', 'public.messages', 'UPDATE'),
  'R4-6: anon and authenticated cannot INSERT or UPDATE messages');

-- ===========================================================================
-- Reaper (expire_stuck_request_runs) edge cases, bot 4 (cap 5)
-- ===========================================================================
-- batch below the stuck count: runs and reservations stay in step.
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('f0000030-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', 'a4000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000030', repeat('a', 64), 'running', now() - interval '5 hours'),
  ('f0000031-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', 'a4000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000031', repeat('a', 64), 'running', now() - interval '4 hours'),
  ('f0000032-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', 'a4000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000032', repeat('a', 64), 'running', now() - interval '3 hours');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000d4', 'f0000030-0000-4000-8000-0000000000d4', 0.1, 3600);
select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000d4', 'f0000031-0000-4000-8000-0000000000d4', 0.1, 3600);
select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000d4', 'f0000032-0000-4000-8000-0000000000d4', 0.1, 3600);

select is(public.expire_stuck_request_runs(60, 2), 2, 'reaper: p_batch 2 of 3 stuck reaps two (with the 007 trigger in place)');
select is((select string_agg(r.state || '/' || b.state, ' ' order by r.started_at) from public.request_runs r
  join public.budget_reservations b on b.request_id = r.id where r.bot_id = 'b4000000-0000-4000-8000-0000000000d4'),
  'failed/expired failed/expired running/reserved', 'reaper: run and reservation state stay in step under a small batch (oldest first)');
select is(public.expire_stuck_request_runs(60, 2), 1, 'reaper: the next call reaps the remaining one');
select is((select string_agg(r.state || '/' || b.state, ' ' order by r.started_at) from public.request_runs r
  join public.budget_reservations b on b.request_id = r.id where r.bot_id = 'b4000000-0000-4000-8000-0000000000d4'),
  'failed/expired failed/expired failed/expired', 'reaper: all three runs failed and all three reservations expired');
select is(public.expire_stuck_request_runs(60, 2), 0, 'reaper: nothing left');

-- release after reap, reserve retry after reap
select throws_ok(format('select public.release_budget_reservation(%L, %L)', 'b4000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000030-0000-4000-8000-0000000000d4')), 'RB003', null,
  'reaper: release after reap raises RB003 (the reservation is expired, not active)');
select is((select state from public.budget_reservations where request_id = 'f0000030-0000-4000-8000-0000000000d4'), 'expired',
  'reaper: the rejected release left the reservation expired');
select throws_ok($q$select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000d4', 'f0000030-0000-4000-8000-0000000000d4', 0.1, 3600)$q$,
  'RB004', 'reserve_request_budget: existing reservation is not reusable', 'reaper: a reserve retry after reap raises RB004 (expired reservation is not reusable)');

-- a run with no reservation, and a run whose reservation is already expired
reset role;
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('f0000021-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', 'a4000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000021', repeat('a', 64), 'reserved', now() - interval '2 hours'),
  ('f0000022-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', 'a4000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000022', repeat('a', 64), 'running', now() - interval '1 hour');
insert into public.budget_reservations (id, bot_id, request_id, amount, state, expires_at) values
  ('e2200000-0000-4000-8000-0000000000d4', 'b4000000-0000-4000-8000-0000000000d4', 'f0000022-0000-4000-8000-0000000000d4', 0.4, 'expired', now() - interval '10 minutes');
create temp table before_row as select md5(b::text) as h from public.budget_reservations b where b.id = 'e2200000-0000-4000-8000-0000000000d4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.expire_stuck_request_runs(60, 100), 2, 'reaper: a run with no reservation and a run with an expired reservation are both reaped');
select is((select state from public.request_runs where id = 'f0000021-0000-4000-8000-0000000000d4') || ':'
  || (select count(*)::int from public.budget_reservations where request_id = 'f0000021-0000-4000-8000-0000000000d4'), 'failed:0',
  'reaper: a run with no reservation is failed and no reservation is invented');
select isnt((select finished_at from public.request_runs where id = 'f0000021-0000-4000-8000-0000000000d4'), null, 'reaper: finished_at is set on the run with no reservation');
select is((select state from public.request_runs where id = 'f0000022-0000-4000-8000-0000000000d4'), 'failed', 'reaper: the run with an expired reservation is failed');
reset role;
select is((select md5(b::text) from public.budget_reservations b where b.id = 'e2200000-0000-4000-8000-0000000000d4'), (select h from before_row),
  'reaper: an already expired reservation is left untouched (row identical)');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($q$select public.reserve_request_budget('b4000000-0000-4000-8000-0000000000d4', 'f0000021-0000-4000-8000-0000000000d4', 0.1, 3600)$q$,
  'RB004', 'reserve_request_budget: request is not active', 'reaper: a NEW reserve on a reaped run without reservation raises RB004 (R4-8)');
reset role;

-- ===========================================================================
-- R4-2 pins: late settle may overshoot the cap, and counts toward the reservation's creation day
-- ===========================================================================
-- Bot 3 (cap 1). The slow request is reaped, then settles with an actual cost above the cap.
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('f0000040-0000-4000-8000-0000000000d4', 'b3000000-0000-4000-8000-0000000000d4', 'a3000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000040', repeat('a', 64), 'running', now() - interval '10 minutes'),
  ('f0000041-0000-4000-8000-0000000000d4', 'b3000000-0000-4000-8000-0000000000d4', 'a3000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000041', repeat('a', 64), 'running', now());
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.reserve_request_budget('b3000000-0000-4000-8000-0000000000d4', 'f0000040-0000-4000-8000-0000000000d4', 0.8, 3600);
select is(public.expire_stuck_request_runs(60, 100), 1, 'R4-2: the slow request is reaped');
select is((select state from public.budget_reservations where request_id = 'f0000040-0000-4000-8000-0000000000d4'), 'expired', 'R4-2: its reservation is expired');
select lives_ok(format('select public.settle_budget_reservation(%L, %L, 3.0)', 'b3000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000040-0000-4000-8000-0000000000d4')),
  'R4-2: a late settle that overshoots the daily cap (3.0 vs cap 1) still succeeds: the spend already happened');
select is((select state || ':' || amount::text from public.budget_reservations where request_id = 'f0000040-0000-4000-8000-0000000000d4'), 'settled:3.000000',
  'R4-2: the overshooting amount is recorded in full');
select throws_ok($q$select public.reserve_request_budget('b3000000-0000-4000-8000-0000000000d4', 'f0000041-0000-4000-8000-0000000000d4', 0.1, 3600)$q$,
  'RB001', 'reserve_request_budget: daily budget exceeded', 'R4-2: after the overshoot every later reserve is refused RB001');

-- Settle across UTC midnight (created_at backdated to 23:00 UTC yesterday instead of waiting). Bot 5 (cap 1).
reset role;
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('f0000050-0000-4000-8000-0000000000d4', 'b5000000-0000-4000-8000-0000000000d4', 'a5000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000050', repeat('a', 64), 'running', now()),
  ('f0000051-0000-4000-8000-0000000000d4', 'b5000000-0000-4000-8000-0000000000d4', 'a5000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000051', repeat('a', 64), 'running', now());
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.reserve_request_budget('b5000000-0000-4000-8000-0000000000d4', 'f0000050-0000-4000-8000-0000000000d4', 0.9, 3600);
reset role;
update public.budget_reservations set created_at = (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') - interval '1 hour'
 where request_id = 'f0000050-0000-4000-8000-0000000000d4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(format('select public.settle_budget_reservation(%L, %L, 4.0)', 'b5000000-0000-4000-8000-0000000000d4',
  (select id from public.budget_reservations where request_id = 'f0000050-0000-4000-8000-0000000000d4')),
  'R4-2: a reservation made before UTC midnight settles after it');
select is((select state || ':' || amount::text from public.budget_reservations where request_id = 'f0000050-0000-4000-8000-0000000000d4'), 'settled:4.000000',
  'R4-2: the cross-midnight settle recorded the actual amount');
select lives_ok($q$select public.reserve_request_budget('b5000000-0000-4000-8000-0000000000d4', 'f0000051-0000-4000-8000-0000000000d4', 1.0, 3600)$q$,
  'R4-2 pin: the settled spend counts toward the reservation''s CREATION day (yesterday), not the settle day: today''s full cap is free');
reset role;

-- The matcher used for the R4-4 source check (180) rejects a body where the statement appears only in a comment.
select ok(regexp_replace(regexp_replace(E'-- from public.messages m where m.id = new.reply_to_message_id for share\nreturn new;', '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
  !~* 'from\s+public\.messages\s+m\s+where\s+m\.id\s*=\s*new\.reply_to_message_id\s+for\s+share',
  'R4-4: the 180 source matcher is not satisfied by a line comment alone');
select ok(regexp_replace(regexp_replace(E'/* from public.messages m where m.id = new.reply_to_message_id\n for share */ return new;', '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
  !~* 'from\s+public\.messages\s+m\s+where\s+m\.id\s*=\s*new\.reply_to_message_id\s+for\s+share',
  'R4-4: the 180 source matcher is not satisfied by a block comment alone');
select ok(regexp_replace(regexp_replace((select prosrc from pg_proc where oid = 'public.messages_check_reply_to()'::regprocedure), '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
  ~* 'from\s+public\.messages\s+m\s+where\s+m\.id\s*=\s*new\.reply_to_message_id\s+for\s+share',
  'R4-4: the real trigger body contains the locking statement outside comments');

-- ===========================================================================
-- messages.reply_to_message_id: UPDATE path, CHECK, writer privileges
-- ===========================================================================
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c1000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4');
insert into public.messages (id, conversation_id, role, content) values
  ('e1000000-0000-4000-8000-0000000000d4', 'c1000000-0000-4000-8000-0000000000d4', 'user', 'q1'),
  ('e2000000-0000-4000-8000-0000000000d4', 'c1000000-0000-4000-8000-0000000000d4', 'user', 'q2');
insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values
  ('ea000000-0000-4000-8000-0000000000d4', 'c1000000-0000-4000-8000-0000000000d4', 'e1000000-0000-4000-8000-0000000000d4', 'assistant', 'a1');

-- UPDATE to a missing target: rejected by the trigger, pointer unchanged.
select throws_ok($q$update public.messages set reply_to_message_id = '00000000-0000-4000-8000-00000000dead' where id = 'ea000000-0000-4000-8000-0000000000d4'$q$,
  '23514', 'messages: reply_to_message_id must reference a user message of the same conversation', 'reply_to: UPDATE to a missing target is rejected (fail closed, not skipped)');
select is((select reply_to_message_id from public.messages where id = 'ea000000-0000-4000-8000-0000000000d4'), 'e1000000-0000-4000-8000-0000000000d4'::uuid,
  'reply_to: the rejected UPDATE left the pointer as it was');

-- R4-7: the CHECK reply_to_message_id <> id. On INSERT the trigger fires first (row does not exist yet),
-- and on UPDATE of an assistant row the trigger rejects an assistant target too. So the CHECK is reached
-- only with the trigger disabled (table owner, inside this rolled-back transaction); that is what is used.
alter table public.messages disable trigger messages_check_reply_to;
select throws_ok($q$update public.messages set reply_to_message_id = id where id = 'ea000000-0000-4000-8000-0000000000d4'$q$,
  '23514', 'new row for relation "messages" violates check constraint "messages_reply_to_check"',
  'R4-7: with the trigger disabled, UPDATE of an assistant row to reply to itself hits the CHECK messages_reply_to_check');
alter table public.messages enable trigger messages_check_reply_to;
select throws_ok($q$update public.messages set reply_to_message_id = id where id = 'ea000000-0000-4000-8000-0000000000d4'$q$,
  '23514', 'messages: reply_to_message_id must reference a user message of the same conversation',
  'R4-7: with the trigger enabled the same UPDATE is rejected by the trigger (assistant target)');
select ok((select pg_get_constraintdef(oid) ~ 'reply_to_message_id <> id' from pg_constraint where conrelid = 'public.messages'::regclass and conname = 'messages_reply_to_check' and contype = 'c'),
  'R4-7: the CHECK messages_reply_to_check exists and contains reply_to_message_id <> id (pg_constraint)');
select is((select tgenabled::text from pg_trigger where tgrelid = 'public.messages'::regclass and tgname = 'messages_check_reply_to'), 'O',
  'R4-7: the reply trigger is enabled again');

-- Invisible writer on the UPDATE path. The writer can see and update only the reply row, not the new target.
create role p3d4_upd nologin nobypassrls;
grant p3d4_upd to current_user;
grant anon to p3d4_upd;  -- schema usage and pgTAP access only; anon has no grant on messages
grant select, update on public.messages to p3d4_upd;
create policy p3d4_upd_vis on public.messages for all to p3d4_upd
  using (id = 'ea000000-0000-4000-8000-0000000000d4') with check (true);
set local role p3d4_upd;
select is((select count(*)::int from public.messages), 1, 'reply_to: the UPDATE writer sees only the reply row (RLS)');
select throws_ok($q$update public.messages set reply_to_message_id = 'e2000000-0000-4000-8000-0000000000d4' where id = 'ea000000-0000-4000-8000-0000000000d4'$q$,
  '23514', 'messages: reply_to_message_id must reference a user message of the same conversation',
  'reply_to: UPDATE to an existing but invisible target is rejected by the trigger, not skipped');
reset role;
select is((select reply_to_message_id from public.messages where id = 'ea000000-0000-4000-8000-0000000000d4'), 'e1000000-0000-4000-8000-0000000000d4'::uuid,
  'reply_to: the rejected invisible-target UPDATE changed nothing');
-- Control: once the target is visible the same UPDATE goes through, so the rejection above was the visibility.
alter policy p3d4_upd_vis on public.messages using (id in ('ea000000-0000-4000-8000-0000000000d4', 'e2000000-0000-4000-8000-0000000000d4'));
set local role p3d4_upd;
select lives_ok($q$update public.messages set reply_to_message_id = 'e2000000-0000-4000-8000-0000000000d4' where id = 'ea000000-0000-4000-8000-0000000000d4'$q$,
  'reply_to control: the same UPDATE succeeds when the target is visible to the writer');
reset role;
update public.messages set reply_to_message_id = 'e1000000-0000-4000-8000-0000000000d4' where id = 'ea000000-0000-4000-8000-0000000000d4';

-- A writer with INSERT (and SELECT) but no UPDATE: a plain message inserts, a reply gets 42501
-- (the trigger's FOR SHARE needs the UPDATE privilege).
create role p3d4_ins nologin nobypassrls;
grant p3d4_ins to current_user;
grant anon to p3d4_ins;
grant select, insert on public.messages to p3d4_ins;
create policy p3d4_ins_all on public.messages for select to p3d4_ins using (true);
create policy p3d4_ins_ins on public.messages for insert to p3d4_ins with check (true);
set local role p3d4_ins;
select lives_ok($q$insert into public.messages (conversation_id, role, content) values ('c1000000-0000-4000-8000-0000000000d4', 'user', 'plain')$q$,
  'reply_to: a writer with INSERT but no UPDATE can insert a message without a reply pointer');
select throws_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content)
  values ('c1000000-0000-4000-8000-0000000000d4', 'e1000000-0000-4000-8000-0000000000d4', 'assistant', 'a')$q$,
  '42501', 'permission denied for table messages', 'reply_to: a writer with INSERT but no UPDATE gets 42501 on a reply');
reset role;
-- Control: with UPDATE (and an UPDATE policy) the same reply insert succeeds.
grant update on public.messages to p3d4_ins;
create policy p3d4_ins_upd on public.messages for update to p3d4_ins using (true) with check (true);
set local role p3d4_ins;
select lives_ok($q$insert into public.messages (conversation_id, reply_to_message_id, role, content)
  values ('c1000000-0000-4000-8000-0000000000d4', 'e1000000-0000-4000-8000-0000000000d4', 'assistant', 'a')$q$,
  'reply_to control: the same reply insert succeeds once the writer also holds UPDATE');
reset role;

-- ===========================================================================
-- purge_expired_conversations with reply pairs
-- ===========================================================================
insert into public.conversations (id, bot_id, visitor_session_id, created_at, last_message_at) values
  ('c2000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', now() - interval '120 days', now() - interval '100 days'),
  ('c3000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', now() - interval '120 days', now() - interval '10 days');
insert into public.messages (id, conversation_id, role, content) values
  ('e3000000-0000-4000-8000-0000000000d4', 'c2000000-0000-4000-8000-0000000000d4', 'user', 'old q'),
  ('e4000000-0000-4000-8000-0000000000d4', 'c3000000-0000-4000-8000-0000000000d4', 'user', 'recent q');
insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values
  ('eb000000-0000-4000-8000-0000000000d4', 'c2000000-0000-4000-8000-0000000000d4', 'e3000000-0000-4000-8000-0000000000d4', 'assistant', 'old a1'),
  ('ec000000-0000-4000-8000-0000000000d4', 'c2000000-0000-4000-8000-0000000000d4', 'e3000000-0000-4000-8000-0000000000d4', 'assistant', 'old a2'),
  ('ed000000-0000-4000-8000-0000000000d4', 'c3000000-0000-4000-8000-0000000000d4', 'e4000000-0000-4000-8000-0000000000d4', 'assistant', 'recent a');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.purge_expired_conversations(100), 1, 'retention: the old conversation with question/answer reply pairs is purged without error');
select is((select count(*)::int from public.messages where conversation_id = 'c2000000-0000-4000-8000-0000000000d4'), 0,
  'retention: the old conversation''s questions and answers are all gone (self-referencing FK cascade works)');
select is((select count(*)::int || ':' || count(reply_to_message_id)::int from public.messages where conversation_id = 'c3000000-0000-4000-8000-0000000000d4'), '2:1',
  'retention: the recent conversation and its reply pointer are untouched');
reset role;

-- ===========================================================================
-- settle after the retention purge of the reservation
-- ===========================================================================
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at) values
  ('f0000070-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000070', repeat('a', 64), 'failed', now() - interval '15 months');
insert into public.budget_reservations (id, bot_id, request_id, amount, state, expires_at, created_at) values
  ('e7000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'f0000070-0000-4000-8000-0000000000d4', 0.2, 'expired', now() - interval '15 months', now() - interval '15 months');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((public.purge_expired_usage_records(100) ->> 'budget_reservations')::int, 1, 'retention: the 15-month-old expired reservation is purged');
select throws_ok($q$select public.settle_budget_reservation('b1000000-0000-4000-8000-0000000000d4', 'e7000000-0000-4000-8000-0000000000d4', 0.2)$q$,
  'RB003', 'settle_budget_reservation: reservation is not settleable', 'retention: settle after the purge raises RB003');
select throws_ok($q$select public.release_budget_reservation('b1000000-0000-4000-8000-0000000000d4', 'e7000000-0000-4000-8000-0000000000d4')$q$,
  'RB003', 'release_budget_reservation: reservation is not active', 'retention: release after the purge raises RB003');
reset role;

-- ===========================================================================
-- knowledge_gaps after the question is deleted (pins the actual behaviour)
-- ===========================================================================
insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state) values
  ('f0000080-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000080', repeat('a', 64), 'succeeded');
insert into public.conversations (id, bot_id, visitor_session_id) values
  ('c4000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4'),
  ('c5000000-0000-4000-8000-0000000000d4', 'b1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-0000000000d4');
-- c4: an earlier unrelated question, then the question that gets deleted, answered twice
-- (once with a request_id, once without, as after a session purge). c5: a lone question and its answer.
insert into public.messages (id, conversation_id, request_id, role, content, created_at) values
  ('e5000000-0000-4000-8000-0000000000d4', 'c4000000-0000-4000-8000-0000000000d4', null, 'user', 'Q-earlier', now() - interval '3 hours'),
  ('e6000000-0000-4000-8000-0000000000d4', 'c4000000-0000-4000-8000-0000000000d4', 'f0000080-0000-4000-8000-0000000000d4', 'user', 'Q-deleted', now() - interval '2 hours'),
  ('e7000000-0000-4000-8000-0000000000d4', 'c5000000-0000-4000-8000-0000000000d4', null, 'user', 'Q-lone', now() - interval '1 hour');
insert into public.messages (id, conversation_id, request_id, reply_to_message_id, role, content, handoff_reason, created_at) values
  ('ee000000-0000-4000-8000-0000000000d4', 'c4000000-0000-4000-8000-0000000000d4', 'f0000080-0000-4000-8000-0000000000d4', 'e6000000-0000-4000-8000-0000000000d4', 'assistant', 'a', 'no_knowledge', now() - interval '2 hours' + interval '1 second'),
  ('ef000000-0000-4000-8000-0000000000d4', 'c4000000-0000-4000-8000-0000000000d4', null, 'e6000000-0000-4000-8000-0000000000d4', 'assistant', 'a', 'out_of_scope', now() - interval '2 hours' + interval '2 seconds'),
  ('e8000000-0000-4000-8000-0000000000d4', 'c5000000-0000-4000-8000-0000000000d4', null, 'e7000000-0000-4000-8000-0000000000d4', 'assistant', 'a', 'human_requested', now() - interval '1 hour' + interval '1 second');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000d4","aal":"aal2","role":"authenticated"}', true);
select set_eq(
  $q$select handoff_reason, question from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)
     where question in ('Q-earlier', 'Q-deleted', 'Q-lone')$q$,
  $q$values ('no_knowledge'::text, 'Q-deleted'::text), ('out_of_scope', 'Q-deleted'), ('human_requested', 'Q-lone')$q$,
  'knowledge_gaps before deletion: each answer pairs with its own question');
reset role;
delete from public.messages where id in ('e6000000-0000-4000-8000-0000000000d4', 'e7000000-0000-4000-8000-0000000000d4');
select is((select count(*)::int from public.messages where id in ('ee000000-0000-4000-8000-0000000000d4', 'ef000000-0000-4000-8000-0000000000d4', 'e8000000-0000-4000-8000-0000000000d4') and reply_to_message_id is null), 3,
  'knowledge_gaps: deleting the questions set the three answers'' reply_to_message_id to null and kept the answers');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000d4","aal":"aal2","role":"authenticated"}', true);
-- PINNED ACTUAL BEHAVIOUR (reported to the orchestrator as a likely defect, function not changed):
--   * answer with a request_id whose question was deleted: no same-request question is left, so it drops out;
--   * answer with no request_id and no question left: it silently falls to rule 3 and pairs with the
--     latest EARLIER question of the conversation ('Q-earlier'), which it never answered (mispairing);
--   * lone answer with no earlier question: drops out.
select set_eq(
  $q$select handoff_reason, question from public.knowledge_gaps((now() at time zone 'UTC')::date - 2, (now() at time zone 'UTC')::date + 1, 50)
     where question in ('Q-earlier', 'Q-deleted', 'Q-lone')$q$,
  $q$values ('out_of_scope'::text, 'Q-earlier'::text)$q$,
  'knowledge_gaps after question deletion (pinned): request_id answer and lone answer drop out; the request_id-less answer is re-paired to the earlier question');
reset role;

select * from finish();
rollback;
