-- 005_retention.sql — expiry / retention helpers (ADR 0006). EXECUTE: service_role ONLY.
-- Scheduling is done by worker `cleanup` jobs (no pg_cron; not approved). All helpers are
-- SECURITY INVOKER, empty search_path, fully qualified, and bounded by a batch size.
--
-- Retention periods are read from client_settings.retention_policy and FAIL CLOSED:
--   retention_policy.conversation_days  (integer > 0, ADR 0006: 90)
--   retention_policy.usage_months       (integer > 0, ADR 0006: 13)
-- A bot with no client_settings row or a missing/invalid value makes the purge raise (RB020)
-- rather than guess or silently skip. Usage/billing purge never touches message content.
--
-- Custom SQLSTATE: RB020 retention_policy_missing.

-- Detach nothing; delete expired visitor sessions (cascades request_runs; conversations are kept
-- until conversation retention and just lose the session link).
create function public.expire_visitor_sessions(p_batch integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare v_n integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'expire_visitor_sessions: batch must be 1..10000' using errcode = '22023';
  end if;
  with doomed as (
    select s.id from public.visitor_sessions s
     where s.expires_at < now()
     order by s.expires_at
     limit p_batch
     for update skip locked
  )
  delete from public.visitor_sessions s using doomed where s.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.purge_expired_rate_limit_buckets(p_batch integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare v_n integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 100000 then
    raise exception 'purge_expired_rate_limit_buckets: batch must be 1..100000' using errcode = '22023';
  end if;
  with doomed as (
    select b.key_hash, b.window_start, b.window_seconds from public.rate_limit_buckets b
     where b.expires_at < now()
     limit p_batch
     for update skip locked
  )
  delete from public.rate_limit_buckets b using doomed
   where b.key_hash = doomed.key_hash
     and b.window_start = doomed.window_start
     and b.window_seconds = doomed.window_seconds;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Expired rows in all three cache tables. Caches hold no visitor/session identifiers.
create function public.purge_expired_caches(p_batch integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_q integer;
  v_m integer;
  v_a integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 100000 then
    raise exception 'purge_expired_caches: batch must be 1..100000' using errcode = '22023';
  end if;
  delete from public.query_embedding_cache
   where key_hash in (select c.key_hash from public.query_embedding_cache c where c.expires_at < now() limit p_batch);
  get diagnostics v_q = row_count;
  delete from public.moderation_cache
   where key_hash in (select c.key_hash from public.moderation_cache c where c.expires_at < now() limit p_batch);
  get diagnostics v_m = row_count;
  delete from public.answer_cache
   where id in (select c.id from public.answer_cache c where c.expires_at < now() limit p_batch);
  get diagnostics v_a = row_count;
  return jsonb_build_object('query_embedding_cache', v_q, 'moderation_cache', v_m, 'answer_cache', v_a);
end;
$$;

-- Reservations still 'reserved' past expires_at become 'expired' (they stop counting toward the cap).
create function public.expire_stale_budget_reservations(p_batch integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare v_n integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'expire_stale_budget_reservations: batch must be 1..10000' using errcode = '22023';
  end if;
  with stale as (
    select r.id from public.budget_reservations r
     where r.state = 'reserved' and r.expires_at < now()
     order by r.expires_at
     limit p_batch
     for update skip locked
  )
  update public.budget_reservations r set state = 'expired' from stale where r.id = stale.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Delete conversations (and, by cascade, messages, sources, analysis) older than
-- retention_policy.conversation_days. data_entries are detached (conversation_id set null),
-- not deleted: their retention is not defined by ADR 0006 and is an open item.
-- The age clock is coalesce(last_message_at, created_at).
create function public.purge_expired_conversations(p_batch integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n   integer := 0;
  v_cnt integer;
  r     record;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'purge_expired_conversations: batch must be 1..10000' using errcode = '22023';
  end if;

  -- Fail closed before deleting anything.
  if exists (
    select 1
      from public.bot_profiles b
      left join public.client_settings cs on cs.bot_id = b.id
     where cs.bot_id is null
        or coalesce(cs.retention_policy ->> 'conversation_days', '') !~ '^[1-9][0-9]{0,5}$'
  ) then
    raise exception 'purge_expired_conversations: conversation retention is not configured for every bot'
      using errcode = 'RB020';
  end if;

  for r in
    select cs.bot_id, (cs.retention_policy ->> 'conversation_days')::integer as days
      from public.client_settings cs
  loop
    with doomed as (
      select c.id from public.conversations c
       where c.bot_id = r.bot_id
         and coalesce(c.last_message_at, c.created_at) < now() - make_interval(days => r.days)
       order by coalesce(c.last_message_at, c.created_at)
       limit greatest(p_batch - v_n, 0)
       for update skip locked
    )
    delete from public.conversations c using doomed where c.id = doomed.id;
    get diagnostics v_cnt = row_count;
    v_n := v_n + v_cnt;
  end loop;
  return v_n;
end;
$$;

-- Delete usage_events and settled/released/expired budget_reservations older than
-- retention_policy.usage_months. These records never contain message content.
create function public.purge_expired_usage_records(p_batch integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_u   integer := 0;
  v_b   integer := 0;
  v_cnt integer;
  r     record;
begin
  if p_batch is null or p_batch < 1 or p_batch > 100000 then
    raise exception 'purge_expired_usage_records: batch must be 1..100000' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.bot_profiles b
      left join public.client_settings cs on cs.bot_id = b.id
     where cs.bot_id is null
        or coalesce(cs.retention_policy ->> 'usage_months', '') !~ '^[1-9][0-9]{0,3}$'
  ) then
    raise exception 'purge_expired_usage_records: usage retention is not configured for every bot'
      using errcode = 'RB020';
  end if;

  for r in
    select cs.bot_id, (cs.retention_policy ->> 'usage_months')::integer as months
      from public.client_settings cs
  loop
    delete from public.usage_events
     where id in (
       select u.id from public.usage_events u
        where u.bot_id = r.bot_id and u.created_at < now() - make_interval(months => r.months)
        limit greatest(p_batch - v_u, 0)
     );
    get diagnostics v_cnt = row_count;
    v_u := v_u + v_cnt;

    delete from public.budget_reservations
     where id in (
       select br.id from public.budget_reservations br
        where br.bot_id = r.bot_id
          and br.state <> 'reserved'
          and br.created_at < now() - make_interval(months => r.months)
        limit greatest(p_batch - v_b, 0)
     );
    get diagnostics v_cnt = row_count;
    v_b := v_b + v_cnt;
  end loop;
  return jsonb_build_object('usage_events', v_u, 'budget_reservations', v_b);
end;
$$;

revoke all on function public.expire_visitor_sessions(integer) from public, anon, authenticated;
revoke all on function public.purge_expired_rate_limit_buckets(integer) from public, anon, authenticated;
revoke all on function public.purge_expired_caches(integer) from public, anon, authenticated;
revoke all on function public.expire_stale_budget_reservations(integer) from public, anon, authenticated;
revoke all on function public.purge_expired_conversations(integer) from public, anon, authenticated;
revoke all on function public.purge_expired_usage_records(integer) from public, anon, authenticated;

grant execute on function public.expire_visitor_sessions(integer) to service_role;
grant execute on function public.purge_expired_rate_limit_buckets(integer) to service_role;
grant execute on function public.purge_expired_caches(integer) to service_role;
grant execute on function public.expire_stale_budget_reservations(integer) to service_role;
grant execute on function public.purge_expired_conversations(integer) to service_role;
grant execute on function public.purge_expired_usage_records(integer) to service_role;
