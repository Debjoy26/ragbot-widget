-- Provider registry (separate project, NOT tenant schema). ADR 0022.
-- Portal flow: portal signup -> clients(pending); request service ->
-- deployments(pending: bot_name/origin/plan); provider approve ->
-- provisioning_jobs -> live; script shown on client dashboard.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 128),
  contact_email text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  created_at timestamptz not null default now()
);
create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  bot_slug text not null,
  bot_name text null,
  website_origin text null,
  plan text null,
  supabase_ref text null,
  api_url text null,
  widget_url text null,
  admin_url text null,
  state text not null default 'pending' check (state in ('pending','provisioning','live','failed','suspended')),
  created_at timestamptz not null default now(),
  unique (client_id, bot_slug)
);
create table public.subscriptions (
  client_id uuid primary key references public.clients (id) on delete cascade,
  status text not null default 'active' check (status in ('active','past_due','suspended','cancelled')),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);
create table public.provider_widget_keys (
  fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{64}$'),
  deployment_id uuid not null references public.deployments (id) on delete cascade,
  label text not null,
  allowed_hosts text[] not null default '{}',
  revoked_at timestamptz null,
  created_at timestamptz not null default now()
);
create table public.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.deployments (id) on delete cascade,
  step text not null,
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed')),
  attempt integer not null default 0,
  updated_at timestamptz not null default now()
);
create table public.provider_audit (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  target_id uuid null,
  created_at timestamptz not null default now()
);
alter table public.clients enable row level security;
alter table public.deployments enable row level security;
alter table public.subscriptions enable row level security;
alter table public.provider_widget_keys enable row level security;
alter table public.provisioning_jobs enable row level security;
alter table public.provider_audit enable row level security;
