-- ADR 0022: tenant widget keys (public ID only, never auth).
-- Table holds sha256 fingerprint, never the raw `wgk_` value.
create table public.widget_keys (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bot_profiles (id) on delete cascade,
  key_fingerprint text not null constraint widget_keys_fp_format
    check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  label text not null constraint widget_keys_label_len check (char_length(label) between 1 and 64),
  allowed_hosts text[] not null default '{}',
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint widget_keys_fp_unique unique (key_fingerprint)
);
create index widget_keys_bot_idx on public.widget_keys (bot_id);

alter table public.widget_keys enable row level security;

-- Resolve + enforce in one service-role-only call. Fail-closed:
-- unknown fingerprint, revoked, bot disabled, or host not allowlisted -> RB040/RB041/RB039.
create or replace function public.resolve_widget_key(p_fingerprint text, p_host text)
returns uuid language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare v_row public.widget_keys%rowtype; v_enabled boolean;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'widget key: invalid fingerprint' using errcode = 'RB040';
  end if;
  select * into v_row from public.widget_keys k where k.key_fingerprint = p_fingerprint;
  if not found then
    raise exception 'widget key: unknown' using errcode = 'RB040';
  end if;
  if v_row.revoked_at is not null then
    raise exception 'widget key: revoked' using errcode = 'RB041';
  end if;
  select b.enabled into v_enabled from public.bot_profiles b where b.id = v_row.bot_id;
  if not found or not v_enabled then
    raise exception 'widget key: bot disabled' using errcode = 'RB039';
  end if;
  if array_length(v_row.allowed_hosts, 1) is not null then
    if p_host is null or p_host = '' then
      raise exception 'widget key: host mismatch' using errcode = 'RB043';
    end if;
    if not exists (select 1 from unnest(v_row.allowed_hosts) h where lower(h) = lower(p_host)) then
      raise exception 'widget key: host mismatch' using errcode = 'RB043';
    end if;
  end if;
  return v_row.bot_id;
end;
$$;

revoke all on table public.widget_keys from public, anon, authenticated;
revoke all on function public.resolve_widget_key(text, text) from public, anon, authenticated;
grant execute on function public.resolve_widget_key(text, text) to service_role;

create or replace function public.schema_version() returns integer language sql stable
  set search_path = '' set lock_timeout = '2s' as $$ select 28; $$;
