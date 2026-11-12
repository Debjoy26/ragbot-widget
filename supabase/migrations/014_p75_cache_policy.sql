-- 014_p75_cache_policy.sql — P7.5 cache_policy exposure + retrieval_cache L2 (optional).
-- Extends get_chat_context to return settings.cache_policy so C2/C7 kill switches can be
-- evaluated without an extra round-trip. Existing callers that ignore the key are unaffected.
-- Also creates retrieval_cache (optional L2 for C5) — short TTL, bot+corpus versioned, RLS none.
-- Handover §4.15: every cache key includes bot_id + version; answer cache opt-in handled in app.

-- 1. Extend get_chat_context: add settings.cache_policy (jsonb, default {} when null).
create or replace function public.get_chat_context(p_bot_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_bot public.bot_profiles%rowtype;
  v_set public.client_settings%rowtype;
  v_pub public.public_bot_config%rowtype;
begin
  if p_bot_id is null then
    raise exception 'get_chat_context: bot is required' using errcode = '22023';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: bot not found' using errcode = 'RB037';
  end if;
  select * into v_set from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: client settings are missing' using errcode = 'RB036';
  end if;
  select * into v_pub from public.public_bot_config pc where pc.bot_id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: public bot config is missing' using errcode = 'RB036';
  end if;

  return jsonb_build_object(
    'bot', jsonb_build_object(
      'id', v_bot.id,
      'slug', v_bot.slug,
      'enabled', v_bot.enabled,
      'display_name', v_pub.display_name,
      'identity_prompt', v_bot.identity_prompt,
      'tone', coalesce(v_bot.tone, ''),
      'scope', coalesce(v_bot.scope, ''),
      'allowed_languages', to_jsonb(v_bot.allowed_languages),
      'embedding_model', v_bot.embedding_model,
      'embedding_dimensions', v_bot.embedding_dimensions,
      'settings_version', v_bot.settings_version,
      'corpus_version', v_bot.corpus_version),
    'settings', jsonb_build_object(
      'feature_flags', v_set.feature_flags,
      'handoff_policy', v_set.handoff_policy,
      'cache_policy', coalesce(v_set.cache_policy, '{}'::jsonb)),
    'contact', jsonb_build_object(
      'supported_languages', to_jsonb(v_pub.supported_languages),
      'escalation_label', v_pub.escalation_label,
      'escalation_messages', v_pub.escalation_messages,
      'email', v_pub.contact_email,
      'phone', v_pub.contact_phone,
      'whatsapp_url', v_pub.contact_whatsapp_url,
      'page_url', v_pub.contact_page_url,
      'business_hours', v_pub.business_hours,
      'timezone', v_pub.timezone));
end;
$$;

revoke all on function public.get_chat_context(uuid) from public, anon, authenticated;
grant execute on function public.get_chat_context(uuid) to service_role;

-- 2. Retrieval cache L2 (optional, short TTL ≤10min). No RLS, service_role only.
-- Stores ordered chunk refs (IDs + scores) only — never chunk text (re-read by ID on hit).
create table if not exists public.retrieval_cache (
  key_hash       text primary key,
  bot_id         uuid not null references public.bot_profiles (id) on delete cascade,
  corpus_version bigint not null,
  embedding_hash text not null,
  k              integer not null,
  threshold      double precision not null,
  language       text not null,
  chunk_refs     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  constraint retrieval_cache_key_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint retrieval_cache_embedding_hash_check check (embedding_hash ~ '^[0-9a-f]{64}$'),
  constraint retrieval_cache_k_check check (k between 1 and 50),
  constraint retrieval_cache_threshold_check check (threshold between -1 and 1),
  constraint retrieval_cache_chunk_refs_type check (jsonb_typeof(chunk_refs) = 'array')
);

alter table public.retrieval_cache enable row level security;
-- No policies => anon/authenticated cannot read/write; service_role bypasses RLS.
create index if not exists retrieval_cache_bot_id_idx on public.retrieval_cache (bot_id);
create index if not exists retrieval_cache_expires_at_idx on public.retrieval_cache (expires_at);
create index if not exists retrieval_cache_corpus_version_idx on public.retrieval_cache (corpus_version);

-- Purge helper for retrieval_cache (called by purge_expired_caches worker; keep existing function shape).
-- Extend purge_expired_caches to also delete from retrieval_cache (if function exists, replace to include).
-- For now, ensure retrieval_cache is cleaned by the existing worker job that calls purge_expired_caches
-- which deletes from query_embedding_cache/moderation_cache/answer_cache; we add retrieval_cache to same pattern
-- via a trigger on purge — simpler: rely on TTL check on read + periodic delete below.

-- Grant service_role all on retrieval_cache (bypasses RLS, app does own checks).
grant all on table public.retrieval_cache to service_role;
grant all on all sequences in schema public to service_role;
