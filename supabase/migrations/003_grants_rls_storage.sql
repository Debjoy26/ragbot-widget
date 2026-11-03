-- 003_grants_rls_storage.sql — revoke defaults, enable RLS everywhere, policies per the
-- DATABASE_SCHEMA grants/RLS matrix, is_active_member(), safe admin RPCs, private storage bucket.
--
-- Orchestrator rulings applied (fail closed):
--   * analyst MAY read documents + document_versions; analyst has NO access to data_entries.
--   * bot_profiles / client_settings: no direct table access for any authenticated role.
--   * memberships / sessions / budgets / request_runs / jobs / usage_events / rate buckets / caches:
--     no authenticated access at all (jobs & usage only through the safe RPCs below).
--   * audit_logs: owner/admin SELECT only; service_role may SELECT + INSERT only (append-only, trigger-enforced).
--   * ADR 0015: every authenticated read of private data and the three admin RPCs require an active
--     membership AND an aal2 (MFA) session, checked in Postgres by is_active_member_mfa().
--     public_bot_config stays public (published bots only).
--   * Service-role credentials bypass RLS; the API must still do its own authorization (handover §4.3).

-- ---------------------------------------------------------------------------
-- 1. Revoke everything from the API roles on the whole schema, then grant back explicitly.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Postgres grants EXECUTE on functions to PUBLIC by default; remove it everywhere.
revoke all on all functions in schema public from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. RLS on every table (no policy = deny for anon/authenticated).
-- ---------------------------------------------------------------------------
alter table public.admin_memberships      enable row level security;
alter table public.bot_profiles           enable row level security;
alter table public.public_bot_config      enable row level security;
alter table public.client_settings        enable row level security;
alter table public.documents              enable row level security;
alter table public.document_versions      enable row level security;
alter table public.document_chunks        enable row level security;
alter table public.visitor_sessions       enable row level security;
alter table public.conversations          enable row level security;
alter table public.request_runs           enable row level security;
alter table public.messages               enable row level security;
alter table public.message_sources        enable row level security;
alter table public.conversation_analysis  enable row level security;
alter table public.data_entries           enable row level security;
alter table public.jobs                   enable row level security;
alter table public.usage_events           enable row level security;
alter table public.rate_limit_buckets     enable row level security;
alter table public.budget_reservations    enable row level security;
alter table public.audit_logs             enable row level security;
alter table public.query_embedding_cache  enable row level security;
alter table public.moderation_cache       enable row level security;
alter table public.answer_cache           enable row level security;

-- ---------------------------------------------------------------------------
-- 3. is_active_member(roles): the ONLY notion of "admin". authenticated != admin (handover §4.4).
--    SECURITY DEFINER so it can read admin_memberships (which authenticated cannot).
--    Reads the live row on every call (no caching) so revocation is immediate.
--    Only reports on the caller's own auth.uid(); it takes no user id argument.
-- ---------------------------------------------------------------------------
create function public.is_active_member(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select exists (
        select 1
        from public.admin_memberships m
        where m.user_id = (select auth.uid())
          and m.active
          and m.role = any (p_roles)
      )
    ),
    false
  );
$$;
revoke all on function public.is_active_member(text[]) from public, anon;
grant execute on function public.is_active_member(text[]) to authenticated, service_role;

-- is_active_member_mfa(roles): active membership AND an MFA-verified session (JWT aal = 'aal2').
--   Used by EVERY authenticated data policy and the admin RPCs (ADR 0015). is_active_member() above
--   stays as a role probe for the UI and grants no data access by itself. A missing/other aal claim
--   is denied. authenticated only: service_role bypasses RLS and has no auth.uid().
create function public.is_active_member_mfa(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
     and public.is_active_member(p_roles);
$$;
revoke all on function public.is_active_member_mfa(text[]) from public, anon, service_role;
grant execute on function public.is_active_member_mfa(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Table grants + RLS policies (authenticated/anon only; service_role is granted in section 6).
--    RLS is additionally enforced by policy so a grant alone never exposes rows to nonmembers.
-- ---------------------------------------------------------------------------

-- public_bot_config: anon + authenticated read. This is the ONLY relation anon can touch.
grant select on public.public_bot_config to anon, authenticated;
-- Only rows of enabled bots are visible (is_published mirrors bot_profiles.enabled via triggers).
create policy public_bot_config_select_public on public.public_bot_config
  for select to anon, authenticated using (is_published);

-- documents / document_versions: analyst (metadata), admin, owner read.
grant select on public.documents, public.document_versions to authenticated;
create policy documents_select_members on public.documents
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));
create policy document_versions_select_members on public.document_versions
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));

-- conversations / messages / message_sources / conversation_analysis: analyst, admin, owner read.
grant select on public.conversations, public.messages, public.message_sources, public.conversation_analysis
  to authenticated;
create policy conversations_select_members on public.conversations
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));
create policy messages_select_members on public.messages
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));
create policy message_sources_select_members on public.message_sources
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));
create policy conversation_analysis_select_members on public.conversation_analysis
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin', 'analyst'])));

-- data_entries: admin/owner only (analyst has none, ruling above).
grant select on public.data_entries to authenticated;
create policy data_entries_select_admins on public.data_entries
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin'])));

-- audit_logs: admin/owner read only.
grant select on public.audit_logs to authenticated;
create policy audit_logs_select_admins on public.audit_logs
  for select to authenticated
  using ((select public.is_active_member_mfa(array['owner', 'admin'])));

-- Everything else: RLS enabled, no policy, no grant for anon/authenticated:
--   admin_memberships, bot_profiles, client_settings, document_chunks, visitor_sessions, request_runs,
--   jobs, usage_events, rate_limit_buckets, budget_reservations, query_embedding_cache,
--   moderation_cache, answer_cache.

-- ---------------------------------------------------------------------------
-- 5. Safe aggregate / status RPCs for the admin UI (SECURITY DEFINER, explicit authorization).
--    Each re-checks live membership inside the function and raises 42501 for nonmembers.
--    No payloads, errors, tokens, or per-user identifiers are returned except where documented.
-- ---------------------------------------------------------------------------

-- Counts of jobs by type and state. No payloads, progress, or last_error.
create function public.job_status_summary()
returns table (job_type text, job_state text, job_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_active_member_mfa(array['owner', 'admin', 'analyst']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  select j.type, j.state, count(*)::bigint
  from public.jobs j
  group by j.type, j.state
  order by j.type, j.state;
end;
$$;
revoke all on function public.job_status_summary() from public, anon, service_role;
grant execute on function public.job_status_summary() to authenticated;

-- Daily usage aggregates (UTC days). Range is inclusive and bounded to 92 days.
-- Cache hit-rate for admins is derivable from operation = 'answer_cache_hit' rows.
create function public.usage_daily_summary(p_from date, p_to date)
returns table (
  usage_day      date,
  bot_id         uuid,
  operation      text,
  event_count    bigint,
  input_tokens   bigint,
  output_tokens  bigint,
  estimated_cost numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_active_member_mfa(array['owner', 'admin', 'analyst']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'usage_daily_summary: invalid date range' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 92 then
    raise exception 'usage_daily_summary: range must not exceed 92 days' using errcode = '22023';
  end if;

  return query
  select
    (u.created_at at time zone 'UTC')::date,
    u.bot_id,
    u.operation,
    count(*)::bigint,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.estimated_cost), 0)
  from public.usage_events u
  where u.created_at >= (p_from::timestamp at time zone 'UTC')
    and u.created_at <  ((p_to + 1)::timestamp at time zone 'UTC')
  group by 1, 2, 3
  order by 1, 2, 3;
end;
$$;
revoke all on function public.usage_daily_summary(date, date) from public, anon, service_role;
grant execute on function public.usage_daily_summary(date, date) to authenticated;

-- Knowledge gaps: unanswered questions grouped by handoff_reason + question text with counts.
-- Question pairing (deterministic): the user message with the same request_id as the assistant
-- message (request_id present); only when the assistant message has NO request_id, the latest earlier
-- user message in the same conversation, ordered by (created_at desc, id desc). Only assistant
-- messages count as answers. Question text is btrim'd and truncated to 500 characters.
-- handoff_reason = 'blocked' (moderation hits; may quote abusive/sensitive text) is visible to
-- owner/admin only; analysts do not see those rows. Date range is inclusive (UTC days), at most
-- 92 days; limit is 1..200. Returns user-authored text, so access is MFA members only and the
-- result follows conversation retention (rows disappear when messages do).
create function public.knowledge_gaps(p_from date, p_to date, p_limit integer)
returns table (handoff_reason text, question text, occurrences bigint, last_seen timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_admin boolean;
begin
  if not public.is_active_member_mfa(array['owner', 'admin', 'analyst']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'knowledge_gaps: invalid date range' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 92 then
    raise exception 'knowledge_gaps: range must not exceed 92 days' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'knowledge_gaps: limit must be between 1 and 200' using errcode = '22023';
  end if;

  v_is_admin := public.is_active_member_mfa(array['owner', 'admin']);

  return query
  select
    a.handoff_reason,
    left(btrim(q.content), 500),
    count(*)::bigint,
    max(a.created_at)
  from public.messages a
  cross join lateral (
    select u.content
    from public.messages u
    where u.conversation_id = a.conversation_id
      and u.role = 'user'
      and case
            when a.request_id is not null then u.request_id = a.request_id
            else u.created_at <= a.created_at
          end
    order by u.created_at desc, u.id desc
    limit 1
  ) q
  where a.handoff_reason is not null
    and a.role = 'assistant'
    and (v_is_admin or a.handoff_reason <> 'blocked')
    and a.created_at >= (p_from::timestamp at time zone 'UTC')
    and a.created_at <  ((p_to + 1)::timestamp at time zone 'UTC')
  group by a.handoff_reason, left(btrim(q.content), 500)
  order by count(*) desc, max(a.created_at) desc
  limit p_limit;
end;
$$;
revoke all on function public.knowledge_gaps(date, date, integer) from public, anon, service_role;
grant execute on function public.knowledge_gaps(date, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. service_role (API/worker): explicit grants. It also bypasses RLS; application checks remain mandatory.
-- ---------------------------------------------------------------------------
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- audit_logs is append-only for everybody, including the service role (SELECT + INSERT only).
-- Defence in depth: the trigger also blocks the table owner. The only permitted UPDATE is the
-- referential set-null of actor_user_id when an auth user is deleted (no other column may change).
revoke all on public.audit_logs from service_role;
grant select, insert on public.audit_logs to service_role;

create function public.audit_logs_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.actor_user_id is not null
     and new.actor_user_id is null
     and (new.id, new.action, new.resource_type, new.resource_id, new.request_id, new.safe_metadata, new.created_at)
         is not distinct from
         (old.id, old.action, old.resource_type, old.resource_id, old.request_id, old.safe_metadata, old.created_at) then
    return new;
  end if;
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;
revoke all on function public.audit_logs_append_only() from public, anon, authenticated;
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function public.audit_logs_append_only();

-- ---------------------------------------------------------------------------
-- 7. Private storage bucket. No object policies for anon/authenticated: browsers cannot read,
--    list, overwrite or upload directly. Uploads use short-lived signed upload URLs and downloads
--    use short-lived signed URLs, both issued by the API with the service role after authorization.
--    The 20 MiB cap mirrors ADR 0007's starting value as defence in depth; the authoritative
--    limit lives in client_settings.upload_policy.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('knowledge', 'knowledge', false, 20971520, array['application/pdf', 'text/markdown', 'text/plain'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
