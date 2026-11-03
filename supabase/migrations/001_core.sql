-- 001_core.sql — core relations (DATABASE_SCHEMA "Tables"), constraints, FKs, B-tree indexes.
-- The vector column and vector-backed cache column are added in 002_vectors.sql.
-- Grants / RLS / storage are in 003_grants_rls_storage.sql.
-- Canonical enum-like values are mirrored by shared/src (P2). Do not invent others.

-- Nothing in `public` is ever granted to anon/authenticated by default (handover §4.5).
-- Supabase installs default privileges for these roles; remove them before any table exists.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- Postgres grants EXECUTE on new functions to PUBLIC by default. Remove that for everything the
-- migration owner (postgres) creates from here on (global form: not limited to one schema).
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Generic helper: keep updated_at honest. SECURITY INVOKER, fixed search path.
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_memberships: project-wide (one database per client). Trusted provisioning only.
-- ---------------------------------------------------------------------------
create table public.admin_memberships (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint admin_memberships_role_check check (role in ('owner', 'admin', 'analyst'))
);

-- ---------------------------------------------------------------------------
-- bot_profiles: private settings. enabled defaults to false (fail closed).
-- ---------------------------------------------------------------------------
create table public.bot_profiles (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null,
  identity_prompt      text not null,
  tone                 text,
  scope                text,
  allowed_languages    text[] not null,
  embedding_model      text not null,
  embedding_dimensions integer not null,
  settings_version     integer not null default 1,
  corpus_version       bigint not null default 0,
  enabled              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint bot_profiles_slug_key unique (slug),
  constraint bot_profiles_id_slug_key unique (id, slug),
  constraint bot_profiles_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint bot_profiles_languages_nonempty check (cardinality(allowed_languages) > 0),
  -- ADR 0002 / 0014: vector column is fixed at 1536 dimensions.
  constraint bot_profiles_embedding_dimensions_check check (embedding_dimensions = 1536),
  constraint bot_profiles_settings_version_check check (settings_version >= 1),
  constraint bot_profiles_corpus_version_check check (corpus_version >= 0)
);
create trigger bot_profiles_set_updated_at before update on public.bot_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- public_bot_config: only intentionally public fields (anon may read this relation).
-- ---------------------------------------------------------------------------
create table public.public_bot_config (
  bot_id               uuid primary key references public.bot_profiles (id) on delete cascade,
  bot_slug             text not null,
  display_name         text not null,
  greeting             text,
  suggested_questions  jsonb not null default '[]'::jsonb,
  primary_color        text,
  position             text not null default 'bottom-right',
  privacy_url          text,
  supported_languages  text[] not null,
  escalation_label     text,
  escalation_messages  jsonb not null default '{}'::jsonb,
  contact_email        text,
  contact_phone        text,
  contact_whatsapp_url text,
  contact_page_url     text,
  business_hours       jsonb,
  timezone             text,
  -- Mirrors bot_profiles.enabled (maintained ONLY by the triggers below; any value written here
  -- is overwritten). anon cannot read bot_profiles, so the public RLS policy filters on this column.
  is_published         boolean not null default false,
  updated_at           timestamptz not null default now(),
  constraint public_bot_config_bot_slug_key unique (bot_slug),
  constraint public_bot_config_bot_id_slug_key unique (bot_id, bot_slug),
  -- Slug cannot drift from the private profile (composite ownership check).
  constraint public_bot_config_profile_fk foreign key (bot_id, bot_slug)
    references public.bot_profiles (id, slug) on update cascade on delete cascade,
  constraint public_bot_config_position_check check (position in ('bottom-right', 'bottom-left')),
  constraint public_bot_config_color_check check (primary_color is null or primary_color ~ '^#[0-9a-fA-F]{6}$'),
  constraint public_bot_config_languages_nonempty check (cardinality(supported_languages) > 0),
  constraint public_bot_config_suggested_type check (jsonb_typeof(suggested_questions) = 'array'),
  constraint public_bot_config_escalation_type check (jsonb_typeof(escalation_messages) = 'object'),
  constraint public_bot_config_hours_type check (business_hours is null or jsonb_typeof(business_hours) = 'object'),
  -- URLs are https only; phone is E.164.
  constraint public_bot_config_privacy_url_https check (privacy_url is null or privacy_url ~ '^https://[^\s]+$'),
  constraint public_bot_config_whatsapp_https check (contact_whatsapp_url is null or contact_whatsapp_url ~ '^https://[^\s]+$'),
  constraint public_bot_config_page_https check (contact_page_url is null or contact_page_url ~ '^https://[^\s]+$'),
  constraint public_bot_config_phone_e164 check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint public_bot_config_email_format check (contact_email is null or contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create trigger public_bot_config_set_updated_at before update on public.public_bot_config
  for each row execute function public.set_updated_at();

-- is_published is derived, never caller-controlled (fail closed: unknown bot -> false).
create function public.public_bot_config_sync_published()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.is_published := coalesce((select b.enabled from public.bot_profiles b where b.id = new.bot_id), false);
  return new;
end;
$$;
revoke all on function public.public_bot_config_sync_published() from public, anon, authenticated;
create trigger public_bot_config_sync_published before insert or update on public.public_bot_config
  for each row execute function public.public_bot_config_sync_published();

-- Disabling/enabling a bot (un)publishes its public config in the same transaction.
create function public.bot_profiles_sync_published()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.public_bot_config set is_published = new.enabled where bot_id = new.id;
  return null;
end;
$$;
revoke all on function public.bot_profiles_sync_published() from public, anon, authenticated;
create trigger bot_profiles_sync_published after update of enabled on public.bot_profiles
  for each row when (old.enabled is distinct from new.enabled)
  execute function public.bot_profiles_sync_published();

-- ---------------------------------------------------------------------------
-- client_settings: internal limits/policies. No defaults for policies: missing = fail closed (ADR 0007).
-- JSON keys used by DB functions:
--   budget_policy.daily_cap_usd (numeric >= 0)      -> reserve_request_budget
--   rate_policy.concurrent_requests_per_session (int > 0) -> begin_request_run
--   retention_policy.conversation_days (int > 0)    -> purge_expired_conversations, purge_expired_data_entries
--   retention_policy.usage_months (int > 0)         -> purge_expired_usage_records
-- Other structure is validated in backend code (Zod).
-- ---------------------------------------------------------------------------
create table public.client_settings (
  bot_id           uuid primary key references public.bot_profiles (id) on delete cascade,
  allowed_origins  text[] not null,
  rate_policy      jsonb not null,
  budget_policy    jsonb not null,
  retention_policy jsonb not null,
  upload_policy    jsonb not null,
  handoff_policy   jsonb not null,
  cache_policy     jsonb not null,
  feature_flags    jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  constraint client_settings_policy_types check (
    jsonb_typeof(rate_policy) = 'object'
    and jsonb_typeof(budget_policy) = 'object'
    and jsonb_typeof(retention_policy) = 'object'
    and jsonb_typeof(upload_policy) = 'object'
    and jsonb_typeof(handoff_policy) = 'object'
    and jsonb_typeof(cache_policy) = 'object'
    and jsonb_typeof(feature_flags) = 'object'
  )
);
create trigger client_settings_set_updated_at before update on public.client_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- documents / document_versions / document_chunks
-- ---------------------------------------------------------------------------
create table public.documents (
  id                uuid primary key default gen_random_uuid(),
  bot_id            uuid not null references public.bot_profiles (id) on delete cascade,
  title             text not null,
  status            text not null default 'draft',
  active_version_id uuid,
  -- Fail closed: a document is not retrievable-in-public unless explicitly marked.
  disclosure_policy text not null default 'excluded',
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint documents_status_check check (status in ('draft', 'indexing', 'ready', 'failed', 'deleted')),
  constraint documents_disclosure_policy_check check (disclosure_policy in ('public_answer', 'excluded')),
  constraint documents_deleted_consistent check ((status = 'deleted') = (deleted_at is not null))
);

create table public.document_versions (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references public.documents (id) on delete cascade,
  version_number    integer not null,
  storage_path      text not null,
  checksum          text,
  media_type        text not null,
  byte_size         bigint,
  extraction_method text,
  embedding_model   text,
  status            text not null default 'pending_upload',
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint document_versions_doc_version_key unique (document_id, version_number),
  constraint document_versions_id_doc_key unique (id, document_id),
  constraint document_versions_storage_path_key unique (storage_path),
  constraint document_versions_version_number_check check (version_number >= 1),
  constraint document_versions_byte_size_check check (byte_size is null or byte_size > 0),
  constraint document_versions_media_type_check check (media_type in ('application/pdf', 'text/markdown', 'text/plain')),
  constraint document_versions_extraction_method_check check (extraction_method is null or extraction_method in ('pdf_text', 'markdown', 'plain_text')),
  constraint document_versions_status_check check (status in ('pending_upload', 'uploaded', 'extracting', 'embedding', 'ready', 'failed', 'superseded'))
);

-- Active pointer must reference a version of the SAME document. Composite FK, MATCH SIMPLE:
-- not enforced while active_version_id is null.
alter table public.documents
  add constraint documents_active_version_fk foreign key (active_version_id, id)
  references public.document_versions (id, document_id) on delete set null (active_version_id);

create table public.document_chunks (
  id                  uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions (id) on delete cascade,
  chunk_index         integer not null,
  content             text not null,
  token_count         integer,
  page_number         integer,
  section             text,
  metadata            jsonb not null default '{}'::jsonb,
  constraint document_chunks_version_index_key unique (document_version_id, chunk_index),
  constraint document_chunks_index_check check (chunk_index >= 0),
  constraint document_chunks_token_count_check check (token_count is null or token_count >= 0),
  constraint document_chunks_page_check check (page_number is null or page_number >= 1),
  constraint document_chunks_metadata_type check (jsonb_typeof(metadata) = 'object')
);

-- ---------------------------------------------------------------------------
-- visitor_sessions / conversations / messages / message_sources / analysis / data_entries
-- ---------------------------------------------------------------------------
create table public.visitor_sessions (
  id            uuid primary key default gen_random_uuid(),
  bot_id        uuid not null references public.bot_profiles (id) on delete cascade,
  token_version integer not null default 1,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint visitor_sessions_id_bot_key unique (id, bot_id),
  constraint visitor_sessions_token_version_check check (token_version >= 1)
);

create table public.conversations (
  id                 uuid primary key default gen_random_uuid(),
  bot_id             uuid not null references public.bot_profiles (id) on delete cascade,
  visitor_session_id uuid,
  status             text not null default 'open',
  created_at         timestamptz not null default now(),
  last_message_at    timestamptz,
  closed_at          timestamptz,
  constraint conversations_id_bot_key unique (id, bot_id),
  constraint conversations_status_check check (status in ('open', 'closed')),
  -- Session must belong to the same bot. Session expiry cleanup detaches, not deletes (retention is separate).
  constraint conversations_session_fk foreign key (visitor_session_id, bot_id)
    references public.visitor_sessions (id, bot_id) on delete set null (visitor_session_id)
);

create table public.request_runs (
  id                 uuid primary key default gen_random_uuid(),
  bot_id             uuid not null,
  visitor_session_id uuid not null,
  idempotency_key    text not null,
  request_hash       text not null,
  state              text not null default 'reserved',
  reserved_tokens    integer not null default 0,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  -- Scoped idempotency (handover §4.7): a duplicate key within (bot, session) is rejected here.
  constraint request_runs_idempotency_key unique (bot_id, visitor_session_id, idempotency_key),
  constraint request_runs_state_check check (state in ('reserved', 'running', 'succeeded', 'failed', 'partial')),
  constraint request_runs_reserved_tokens_check check (reserved_tokens >= 0),
  -- Canonical lowercase UUID string (the client's Idempotency-Key) and sha256 hex of the request.
  constraint request_runs_idempotency_key_format check
    (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint request_runs_request_hash_format check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint request_runs_session_fk foreign key (visitor_session_id, bot_id)
    references public.visitor_sessions (id, bot_id) on delete cascade
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  request_id      uuid references public.request_runs (id) on delete set null,
  -- Durable question pairing (P3-D2 N3): an assistant message points at the user message it answers.
  -- Unlike request_id (set null when the run/session is purged), this survives session cleanup.
  -- Set null if the question message itself is deleted. Integrity trigger below.
  reply_to_message_id uuid references public.messages (id) on delete set null,
  role            text not null,
  content         text not null,
  status          text not null default 'complete',
  provider        text,
  model           text,
  handoff_reason  text,
  created_at      timestamptz not null default now(),
  constraint messages_role_check check (role in ('user', 'assistant', 'system')),
  constraint messages_status_check check (status in ('complete', 'partial', 'failed', 'blocked')),
  constraint messages_handoff_reason_check check (
    handoff_reason is null or handoff_reason in
      ('no_knowledge', 'out_of_scope', 'human_requested', 'blocked', 'unavailable', 'repeated_no_knowledge')
  ),
  -- Only assistant messages answer a question; a message cannot reply to itself.
  constraint messages_reply_to_check check (
    reply_to_message_id is null or (role = 'assistant' and reply_to_message_id <> id)
  )
);

-- The referenced message must be a USER message of the SAME conversation (SQLSTATE 23514 otherwise).
-- A missing target is left to the foreign key (23503). Also protects the target: once an assistant
-- message points at a user message, that message cannot be moved to another conversation or change role.
create function public.messages_check_reply_to()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_conv uuid;
  v_role text;
begin
  if tg_op = 'UPDATE' and old.role = 'user'
     and (new.role is distinct from old.role or new.conversation_id is distinct from old.conversation_id)
     and exists (select 1 from public.messages m where m.reply_to_message_id = old.id) then
    raise exception 'messages: a message that is the target of reply_to_message_id cannot change role or conversation'
      using errcode = '23514';
  end if;

  if new.reply_to_message_id is not null then
    select m.conversation_id, m.role into v_conv, v_role
      from public.messages m where m.id = new.reply_to_message_id;
    if found and (v_conv is distinct from new.conversation_id or v_role <> 'user') then
      raise exception 'messages: reply_to_message_id must reference a user message of the same conversation'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.messages_check_reply_to() from public, anon, authenticated;
create trigger messages_check_reply_to before insert or update of reply_to_message_id, conversation_id, role
  on public.messages for each row execute function public.messages_check_reply_to();

-- Citation snapshots survive chunk/version deletion only until the message itself is
-- purged by retention (messages cascade); chunk and version links are set null.
create table public.message_sources (
  id                  uuid primary key default gen_random_uuid(),
  message_id          uuid not null references public.messages (id) on delete cascade,
  chunk_id            uuid references public.document_chunks (id) on delete set null,
  document_version_id uuid references public.document_versions (id) on delete set null,
  source_label        text not null,
  excerpt             text
);

create table public.conversation_analysis (
  conversation_id  uuid primary key references public.conversations (id) on delete cascade,
  summary          text,
  sentiment        text,
  intent           text,
  analysis_version text,
  status           text not null default 'pending',
  updated_at       timestamptz not null default now(),
  constraint conversation_analysis_status_check check (status in ('pending', 'complete', 'failed')),
  constraint conversation_analysis_sentiment_check check (sentiment is null or sentiment in ('positive', 'neutral', 'negative'))
);
create trigger conversation_analysis_set_updated_at before update on public.conversation_analysis
  for each row execute function public.set_updated_at();

-- ADR 0016: entries live exactly as long as their conversation (ON DELETE CASCADE). Entries with no
-- conversation are purged by purge_expired_data_entries() after retention_policy.conversation_days.
create table public.data_entries (
  id              uuid primary key default gen_random_uuid(),
  bot_id          uuid not null references public.bot_profiles (id) on delete cascade,
  conversation_id uuid,
  schema_key      text not null,
  payload         jsonb not null,
  consent_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint data_entries_payload_type check (jsonb_typeof(payload) = 'object'),
  constraint data_entries_conversation_fk foreign key (conversation_id, bot_id)
    references public.conversations (id, bot_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- jobs / usage / limits / budgets / audit
-- ---------------------------------------------------------------------------
create table public.jobs (
  id           uuid primary key default gen_random_uuid(),
  type         text not null,
  dedupe_key   text,
  payload      jsonb not null default '{}'::jsonb,
  state        text not null default 'queued',
  attempts     integer not null default 0,
  max_attempts integer not null,  -- no default: caller supplies from validated config (fail closed)
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  locked_by    text,
  progress     jsonb not null default '{}'::jsonb,
  last_error   text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  constraint jobs_dedupe_key_key unique (dedupe_key),
  constraint jobs_type_check check (type in ('index_document', 'analyze_conversation', 'cleanup', 'warm_answer_cache')),
  constraint jobs_state_check check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint jobs_attempts_check check (attempts >= 0),
  constraint jobs_max_attempts_check check (max_attempts >= 1),
  constraint jobs_payload_type check (jsonb_typeof(payload) = 'object'),
  constraint jobs_progress_type check (jsonb_typeof(progress) = 'object')
);

create table public.usage_events (
  id             uuid primary key default gen_random_uuid(),
  bot_id         uuid not null references public.bot_profiles (id) on delete cascade,
  request_id     uuid references public.request_runs (id) on delete set null,
  job_id         uuid references public.jobs (id) on delete set null,
  provider       text,
  model          text,
  operation      text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  estimated_cost numeric(14, 6) not null default 0,
  latency_ms     integer,
  created_at     timestamptz not null default now(),
  constraint usage_events_operation_check check (operation in
    ('chat', 'embedding_query', 'embedding_index', 'moderation', 'analysis', 'answer_cache_hit')),
  constraint usage_events_tokens_check check (input_tokens >= 0 and output_tokens >= 0),
  constraint usage_events_cost_check check (estimated_cost >= 0),
  constraint usage_events_latency_check check (latency_ms is null or latency_ms >= 0)
);

-- key_hash is a hex digest (sha256/HMAC-SHA256); plain IPs or identifiers are never stored.
create table public.rate_limit_buckets (
  key_hash       text not null,
  window_start   timestamptz not null,
  window_seconds integer not null,
  request_count  integer not null default 0,
  expires_at     timestamptz not null,
  primary key (key_hash, window_start, window_seconds),
  constraint rate_limit_buckets_key_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint rate_limit_buckets_window_check check (window_seconds between 1 and 86400),
  constraint rate_limit_buckets_count_check check (request_count >= 0)
);

create table public.budget_reservations (
  id         uuid primary key default gen_random_uuid(),
  bot_id     uuid not null references public.bot_profiles (id) on delete cascade,
  request_id uuid references public.request_runs (id) on delete set null,
  amount     numeric(14, 6) not null,
  state      text not null default 'reserved',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint budget_reservations_amount_check check (amount >= 0),
  constraint budget_reservations_state_check check (state in ('reserved', 'settled', 'released', 'expired'))
);

create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid references auth.users (id) on delete set null,
  action         text not null,
  resource_type  text not null,
  resource_id    text,
  request_id     uuid,
  safe_metadata  jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint audit_logs_metadata_type check (jsonb_typeof(safe_metadata) = 'object')
);

-- ---------------------------------------------------------------------------
-- Caches (backend only). The query-embedding vector column is added in 002.
-- ---------------------------------------------------------------------------
create table public.query_embedding_cache (
  key_hash        text primary key,
  embedding_model text not null,
  created_at      timestamptz not null default now(),
  last_hit_at     timestamptz,
  expires_at      timestamptz not null,
  constraint query_embedding_cache_key_hash_check check (key_hash ~ '^[0-9a-f]{64}$')
);

create table public.moderation_cache (
  key_hash       text primary key,
  policy_version text not null,
  verdict        text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  constraint moderation_cache_key_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint moderation_cache_verdict_check check (verdict in ('allow', 'block'))
);

-- No session or visitor identifiers; contact details are never cached (enforced in backend).
create table public.answer_cache (
  id                      uuid primary key default gen_random_uuid(),
  bot_id                  uuid not null references public.bot_profiles (id) on delete cascade,
  cache_key_hash          text not null,
  language                text not null,
  answer_text             text not null,
  source_refs             jsonb not null default '[]'::jsonb,
  handoff_reason          text,
  corpus_version          bigint not null,
  settings_version        integer not null,
  prompt_template_version text not null,
  chat_model              text not null,
  hit_count               integer not null default 0,
  created_at              timestamptz not null default now(),
  last_hit_at             timestamptz,
  expires_at              timestamptz not null,
  constraint answer_cache_cache_key_hash_key unique (cache_key_hash),
  constraint answer_cache_key_hash_check check (cache_key_hash ~ '^[0-9a-f]{64}$'),
  constraint answer_cache_source_refs_type check (jsonb_typeof(source_refs) = 'array'),
  constraint answer_cache_hit_count_check check (hit_count >= 0),
  constraint answer_cache_handoff_reason_check check (
    handoff_reason is null or handoff_reason in
      ('no_knowledge', 'out_of_scope', 'human_requested', 'blocked', 'unavailable', 'repeated_no_knowledge')
  )
);

-- ---------------------------------------------------------------------------
-- B-tree indexes (every foreign key is covered; verified by a pgTAP test).
-- ---------------------------------------------------------------------------
create index documents_bot_id_idx on public.documents (bot_id);
create index documents_created_by_idx on public.documents (created_by) where created_by is not null;
create index documents_active_version_idx on public.documents (active_version_id, id) where active_version_id is not null;

create index visitor_sessions_bot_id_idx on public.visitor_sessions (bot_id);
create index visitor_sessions_expires_at_idx on public.visitor_sessions (expires_at);

create index conversations_bot_time_idx on public.conversations (bot_id, last_message_at desc);
create index conversations_session_idx on public.conversations (visitor_session_id, bot_id) where visitor_session_id is not null;
create index conversations_created_at_idx on public.conversations (created_at);

create index messages_conversation_time_idx on public.messages (conversation_id, created_at);
create index messages_request_id_idx on public.messages (request_id) where request_id is not null;
create index messages_reply_to_idx on public.messages (reply_to_message_id) where reply_to_message_id is not null;
-- Knowledge-gaps view (DATABASE_SCHEMA "Indexes and integrity").
create index messages_handoff_reason_idx on public.messages (handoff_reason, created_at) where handoff_reason is not null;

create index message_sources_message_id_idx on public.message_sources (message_id);
create index message_sources_chunk_id_idx on public.message_sources (chunk_id) where chunk_id is not null;
create index message_sources_version_id_idx on public.message_sources (document_version_id) where document_version_id is not null;

create index data_entries_bot_id_idx on public.data_entries (bot_id);
create index data_entries_conversation_idx on public.data_entries (conversation_id, bot_id) where conversation_id is not null;

-- Job availability / state (claim_jobs) and lease recovery.
create index jobs_queued_available_idx on public.jobs (available_at) where state = 'queued';
create index jobs_running_lease_idx on public.jobs (locked_until) where state = 'running';
create index jobs_type_state_idx on public.jobs (type, state);

create index usage_events_bot_time_idx on public.usage_events (bot_id, created_at);
create index usage_events_created_at_idx on public.usage_events (created_at);
create index usage_events_request_id_idx on public.usage_events (request_id) where request_id is not null;
create index usage_events_job_id_idx on public.usage_events (job_id) where job_id is not null;

create index rate_limit_buckets_expires_at_idx on public.rate_limit_buckets (expires_at);

create index budget_reservations_bot_time_idx on public.budget_reservations (bot_id, created_at);
-- One reservation per request: a retried/duplicate request cannot reserve (spend) twice.
create unique index budget_reservations_request_id_key on public.budget_reservations (request_id) where request_id is not null;
create index budget_reservations_expiry_idx on public.budget_reservations (expires_at) where state = 'reserved';

create index audit_logs_actor_idx on public.audit_logs (actor_user_id) where actor_user_id is not null;
create index audit_logs_created_at_idx on public.audit_logs (created_at);

create index query_embedding_cache_expires_at_idx on public.query_embedding_cache (expires_at);
create index moderation_cache_expires_at_idx on public.moderation_cache (expires_at);
create index answer_cache_expires_at_idx on public.answer_cache (expires_at);
create index answer_cache_bot_id_idx on public.answer_cache (bot_id);
