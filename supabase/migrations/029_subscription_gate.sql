-- ADR 0022: tenant subscription cache (provider is source of truth).
-- Tenant caches status+version pushed by provider sync; runtime gates fail closed.
create table public.subscription_state (
  bot_id uuid primary key references public.bot_profiles (id) on delete cascade,
  status text not null constraint subscription_state_status
    check (status in ('active','past_due','suspended','cancelled')),
  version bigint not null constraint subscription_state_version check (version >= 0),
  synced_at timestamptz not null default now(),
  constraint subscription_state_active_version check ((status = 'active') or (version >= 0))
);

alter table public.subscription_state enable row level security;

-- Service-role-only gate: active passes; anything else -> RB042.
-- Missing row fails closed (RB036 policy_missing -> mapped to INTERNAL/subscription).
create or replace function public.require_active_subscription(p_bot_id uuid)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_status text;
begin
  if p_bot_id is null then
    raise exception 'subscription: invalid bot' using errcode = '22023';
  end if;
  select s.status into v_status from public.subscription_state s where s.bot_id = p_bot_id;
  if not found then
    raise exception 'subscription: policy missing' using errcode = 'RB036';
  end if;
  if v_status is distinct from 'active' then
    raise exception 'subscription: not active' using errcode = 'RB042';
  end if;
end;
$$;

-- Provider sync upserts cache (service_role only). Version must move forward.
create or replace function public.sync_subscription_status(p_bot_id uuid, p_status text, p_version bigint)
returns void language plpgsql set search_path = '' set lock_timeout = '2s' as $$
begin
  if p_bot_id is null or p_status is null
     or p_status not in ('active','past_due','suspended','cancelled')
     or p_version is null or p_version < 0 then
    raise exception 'subscription: invalid sync' using errcode = '22023';
  end if;
  insert into public.subscription_state (bot_id, status, version, synced_at)
  values (p_bot_id, p_status, p_version, now())
  on conflict (bot_id) do update set
    status = excluded.status, version = excluded.version, synced_at = now()
  where public.subscription_state.version < excluded.version
     or public.subscription_state.status is distinct from excluded.status;
  if not found then
    -- same version+status: refresh synced_at only when row exists
    update public.subscription_state set synced_at = now() where bot_id = p_bot_id;
    if not found then
      insert into public.subscription_state (bot_id, status, version) values (p_bot_id, p_status, p_version);
    end if;
  end if;
end;
$$;

revoke all on table public.subscription_state from public, anon, authenticated;
revoke all on function public.require_active_subscription(uuid) from public, anon, authenticated;
revoke all on function public.sync_subscription_status(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.require_active_subscription(uuid) to service_role;
grant execute on function public.sync_subscription_status(uuid, text, bigint) to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 29; $$;
