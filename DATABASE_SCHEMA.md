# Database Schema — ragbot_widget


## Shared ownership
This is one schema in the client-specific Supabase project, not a database per frontend. `ragbot_widget/supabase/migrations` is the authoritative migration history. The admin repository consumes this contract and must not maintain competing migrations.

## Conventions
- IDs: UUID primary keys; timestamps: `timestamptz`, UTC.
- `bot_id` is retained even with one database per client to scope configuration and future multiple bots.
- `user_id` references Supabase `auth.users`; `storage_path` references a private bucket object by convention.
- No API/provider keys are stored in browser-readable relations.
- Validate enum-like fields with SQL constraints and validate JSON structures in backend code.
- Composite ownership checks ensure conversations/documents/versions belong to the selected bot.

## Tables
| Relation | Main columns | Notes |
|---|---|---|
| admin_memberships | user_id, role, active, created_at | Roles: owner, admin, analyst. Only trusted provisioning changes membership. |
| bot_profiles | id, slug, identity_prompt, tone, scope, allowed_languages, embedding_model, embedding_dimensions, settings_version, corpus_version, enabled, created_at, updated_at | Private settings; embedding changes require explicit reindexing. `settings_version` increments on any settings change; `corpus_version` increments inside `activate_document_version` and `mark_document_deleted`. Both are part of every cache key. |
| public_bot_config | bot_id, bot_slug, display_name, greeting, suggested_questions, primary_color, position, privacy_url, supported_languages, escalation_label, escalation_messages, contact_email, contact_phone, contact_whatsapp_url, contact_page_url, business_hours, timezone, updated_at | Separate relation with only intentionally public fields. Contact fields drive contact routing (PRD W-16): `escalation_messages` is jsonb keyed by language; `contact_phone` is E.164; URLs are `https:` only; `business_hours` is jsonb per weekday; `timezone` is IANA. `contact_page_url` replaces the former `escalation_url`. At least one contact channel is required before go-live. |
| documents | id, bot_id, title, status, active_version_id, disclosure_policy, created_by, created_at, deleted_at | `disclosure_policy`: public_answer or excluded. |
| document_versions | id, document_id, version_number, storage_path, checksum, media_type, byte_size, extraction_method, embedding_model, status, created_at, completed_at | Uploads create versions, not in-place replacement. |
| document_chunks | id, document_version_id, chunk_index, content, embedding, token_count, page_number, section, metadata | Unique `(document_version_id, chunk_index)`; fixed vector dimension per compatible search index. |
| visitor_sessions | id, bot_id, token_version, expires_at, revoked_at, created_at | Store session state; signed visitor tokens contain scoped identifiers and expiry. |
| conversations | id, bot_id, visitor_session_id, status, created_at, last_message_at, closed_at | Session ownership required for visitor access. |
| messages | id, conversation_id, request_id, role, content, status, provider, model, handoff_reason, created_at | Roles user/assistant/system; internal system records are not returned to visitors. `handoff_reason` is null or one of no_knowledge, out_of_scope, human_requested, blocked, unavailable, repeated_no_knowledge. |
| message_sources | id, message_id, chunk_id, document_version_id, source_label, excerpt | Server-validated citations; deletion behaviour follows retention policy. |
| conversation_analysis | conversation_id, summary, sentiment, intent, analysis_version, status, updated_at | Private admin data; model labels are probabilistic, not factual judgements. |
| data_entries | id, bot_id, conversation_id, schema_key, payload, consent_at, created_at | Validated approved form payloads only; minimise personal data. |
| jobs | id, type, dedupe_key, payload, state, attempts, max_attempts, available_at, locked_until, locked_by, progress, last_error, created_at, completed_at | Unique dedupe key; queued/running/succeeded/failed/cancelled. |
| request_runs | id, bot_id, visitor_session_id, idempotency_key, request_hash, state, reserved_tokens, started_at, finished_at | Unique scoped idempotency key; payload mismatch is rejected. |
| usage_events | id, bot_id, request_id, job_id, provider, model, operation, input_tokens, output_tokens, estimated_cost, latency_ms, created_at | Include failed/fallback attempts and indexing; estimates reconciled with provider usage. |
| rate_limit_buckets | key_hash, window_start, window_seconds, request_count, expires_at | Composite uniqueness; atomic increments. No plain IP storage by default. |
| budget_reservations | id, bot_id, request_id, amount, state, expires_at, created_at | Reserve before work, reconcile after; conservative estimates plus provider-side caps. `job_id` marks a job-based reservation for ingestion; both kinds count toward the same daily cap. Only one `reserved` row may exist per job, and a retry takes a new reservation. |
| audit_logs | id, actor_user_id, action, resource_type, resource_id, request_id, safe_metadata, created_at | Written by the backend and through `admin_audit`; no raw secrets or full document payloads. |
| client_settings | bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy, feature_flags, updated_at | Internal settings; only explicitly whitelisted fields editable by admin. `handoff_policy`: enabled triggers and repeated-miss threshold (default 2). `cache_policy`: answer-cache opt-in (default off), TTLs, kill switch. Planned in P3.5: attempt limits for `index_document` and `cleanup`, read by the admin RPCs; a missing value fails closed. |
| query_embedding_cache | key_hash, embedding_model, embedding, created_at, last_hit_at, expires_at | Key is a hash of model, dimensions and normalised query. Raw query text is not stored. |
| moderation_cache | key_hash, policy_version, verdict, created_at, expires_at | Key is a hash of moderation model, policy version and normalised text. |
| answer_cache | id, bot_id, cache_key_hash, language, answer_text, source_refs, handoff_reason, corpus_version, settings_version, prompt_template_version, chat_model, hit_count, created_at, last_hit_at, expires_at | Opt-in per client. First-turn, completed, moderated answers only. Contact details are never cached. Cited versions are re-checked as active on read. No session or visitor identifiers. |

## Database operations
- `match_document_chunks`: bounded similarity query; filters by bot, active document version, deleted state, and disclosure policy. Execute by the backend role only, not `anon`.
- `claim_jobs`: atomically claim due work using transaction/row locks and a lease. Expired leases become recoverable.
- `activate_document_version`: atomically switch the active pointer and increment `corpus_version` after all expected chunks exist and validation succeeds. It refuses a version older than the active one (RB011).
- `reserve_request_budget`: atomically check caps and reserve capacity before external calls. It needs a request run, so ingestion uses `reserve_job_budget`.
- `record_rate_limit_attempt`: atomically increment a bounded window.
- `mark_document_deleted`: immediately exclude retrieval, increment `corpus_version`, then enqueue cleanup.
- Admin RPCs: see "Admin RPCs" below. Each checks membership, role and `aal2` first, validates its own input and writes `audit_logs` in the same transaction.
- `knowledge_gaps`: aggregate unanswered questions by `handoff_reason` and frequency for active admins/analysts; bounded and date-filtered.
- Never expose arbitrary SQL execution or unbounded search RPCs.
- Functions using SECURITY DEFINER require a fixed safe search path, explicit authorization, and restricted EXECUTE grants. Prefer SECURITY INVOKER where feasible.

## Grants and RLS matrix
| Resource | anon | Authenticated nonmember | analyst | admin/owner | API/worker |
|---|---|---|---|---|---|
| public_bot_config | Read public fields | Read | Read | Read | Maintain |
| documents/versions | None | None | Read metadata if permitted | Read; write through admin RPCs | Write/manage lifecycle |
| document_chunks | None | None | None by default | None directly | Read/write |
| conversations/messages/sources | None | None | Read scoped records | Read scoped records | Write |
| conversation_analysis | None | None | Read | Read | Write |
| data_entries | None | None | Read if permitted | Read | Validate/write |
| bot_profiles/client_settings | None | None | None or restricted RPC | Safe read and whitelisted update RPC | Manage |
| jobs/usage | None | None | Safe status/aggregate RPC | Safe status/aggregate RPC | Write/claim |
| memberships, sessions, budgets, request_runs | None | None | None | None directly; member list through `admin_list_members` | Manage |
| audit_logs | None | None | None | Read redacted records | Append |
| query_embedding_cache, moderation_cache, answer_cache | None | None | None | None (hit-rate via safe aggregate RPC) | Read/write |
| knowledge_gaps RPC | None | None | Execute | Execute | — |

RLS does not itself provide column-level security. Use column grants, minimal security-invoker views with correct privileges, or narrowly scoped RPCs for safe settings/status reads. Revoke default permissions on internal tables/functions. Authenticated role alone does not imply active admin membership. Supabase privileged credentials bypass RLS, so application checks remain mandatory.

### Matrix rulings (2026-11-04, implemented in `003_grants_rls_storage.sql`)
Ambiguous cells above are resolved fail-closed:
- Analyst **may** read `documents`/`document_versions` metadata; analyst has **no** access to `data_entries` (admin/owner read).
- No authenticated role reads or writes `bot_profiles`/`client_settings` directly; settings change only through the whitelisted admin RPCs (revised by ADR 0017).
- Membership is project-wide (one database per client): `admin_memberships(user_id unique, role, active)`; `is_active_member(roles)` re-reads the live row on every call, so revocation is immediate.
- Safe aggregate RPCs callable by authenticated users, each re-checking active membership: `job_status_summary()`, `usage_daily_summary(from, to)` (≤ 92 days; cache hit-rate derives from `operation = 'answer_cache_hit'`), `knowledge_gaps(from, to, limit)` (≤ 92 days, limit ≤ 200).
- `audit_logs`: admin/owner read. Writers are the service role and `admin_audit`, which only the admin RPCs can reach. `admin_audit` allows a fixed list of metadata keys with short scalar values. A refused or failed call rolls back, so it leaves no audit row.

### Database conventions fixed in P3
- Custom SQLSTATEs: `RB001` budget exceeded · `RB002` budget policy missing/invalid · `RB003` reservation not active · `RB004` request conflict · `RB010` document not found · `RB011` activation failed · `RB012` embedding change requires reindex · `RB013` lease not held · `RB020` retention policy missing · `22023` invalid argument · `RB030` conflict (stale version or wrong state) · `RB031` file too large · `RB032` MFA required · `RB033` forbidden · `RB034` quota exceeded · `RB035` settings invalid · `RB036` policy missing · `RB037` not found · `RB038` upload missing · `RB039` bot disabled. PostgREST returns `42501` when a role lacks EXECUTE. `shared/src/errors.ts` maps all of them.
- `client_settings` JSON keys read by SQL: `budget_policy.daily_cap_usd`, `retention_policy.conversation_days`, `retention_policy.usage_months`, `rate_policy.concurrent_requests_per_session`, `rate_policy.session_create_per_ip` and `rate_policy.session_create_per_bot` (`{limit, window_seconds}`), `rate_policy.message_per_session` and `message_per_ip` (read by the API), and in `upload_policy`: `max_bytes`, `max_pages`, `index_max_attempts`, `cleanup_max_attempts`, `quotas.{register,upload,reindex,write}.{limit,window_seconds}`. Missing values fail closed.
- `match_document_chunks(bot_id, query_embedding, match_count 1..50, min_similarity)` rejects out-of-range `match_count` (no clamping).
- Fail-closed defaults: `documents.disclosure_policy` defaults to `excluded`; `bot_profiles.enabled` defaults to `false`; policy columns and `jobs.max_attempts` have no default.
- Rate-limit and cache keys are 64-char lowercase hex digests (CHECK).
- `client_settings.feature_flags` keys, read by the API and widget config: `output_moderation_mode` (`buffer` or `rolling`, ADR 0004), `turnstile_required` (ADR 0010), `markdown_enabled` (ADR 0008), `history_enabled` (ADR 0009). A missing key takes the ADR default; `turnstile_required` therefore defaults to true (fail closed). Consumers land in P5, P7 and P8.

### Security hardening (debug cycle P3-D1, 2026-11-04)
- **MFA in the database (ADR 0015):** every authenticated private read (documents, versions, conversations, messages, sources, analysis, data entries, audit logs) and the three aggregate RPCs require `is_active_member_mfa(roles)` = active membership **and** JWT `aal = 'aal2'`. `is_active_member(roles)` stays as a role probe only.
- **Embedding guard:** `activate_document_version` requires the version's `embedding_model` to equal the bot's (RB011); `match_document_chunks` only returns chunks whose version model equals the bot's; changing `bot_profiles.embedding_model`/`embedding_dimensions` while chunks exist raises **RB012** (reindex required).
- **Data entries (ADR 0016):** deleted with their conversation (cascade); orphans purged by `purge_expired_data_entries(batch)` after `retention_policy.conversation_days`.
- **Request start:** `begin_request_run(bot, session, token_version, idempotency_key, request_hash)` (service-only) locks the session row and returns `new | duplicate | hash_mismatch | concurrency_limited`; cap from `client_settings.rate_policy.concurrent_requests_per_session` (missing → RB002); invalid/expired/revoked session → RB004. `idempotency_key` must be a lowercase UUID; `request_hash` 64 lowercase hex.
- **Jobs:** `complete_job`, `fail_job` (dead-letters at `max_attempts`, error truncated to 1000 chars), `heartbeat_job` require `state = 'running'` and `locked_by = worker`, else **RB013**.
- **Budget:** `settle_budget_reservation(bot_id, reservation_id, actual_amount)` locks the bot's settings row. It accepts `reserved` or `expired` reservations and rejects foreign, `settled` or `released` ones (RB003).
- **Audit logs:** append-only — service role has SELECT/INSERT only, and a trigger rejects UPDATE/DELETE (42501), except the FK set-null when an auth user is deleted.
- **Public config:** `public_bot_config.is_published` is derived from `bot_profiles.enabled` by triggers; anon/authenticated only see published rows.
- **Retention/caches:** `expire_visitor_sessions(batch, grace_seconds 1..86400)` (grace required); `purge_expired_caches` also drops `answer_cache` rows from older corpus/settings versions.
- **Other:** rate-limit counter clamps at `limit + 1`; global default `EXECUTE` on new functions revoked from PUBLIC; `knowledge` bucket limited to PDF/Markdown/plain text; `knowledge_gaps` pairs answers to questions by `request_id`, returns ≤ 500 chars, hides `blocked` from analysts.
- **Known limits:** two-connection race orderings run in `scripts/race-db.sh` (also in CI); multi-run batches and load are not covered; `fail_job` requeues without backoff.

### Follow-up hardening (debug cycle P3-D2, 2026-11-04)
- `begin_request_run(bot_id, visitor_session_id, token_version, idempotency_key, request_hash)` — token version must match the locked session row (RB004).
- `settle_budget_reservation` accepts `reserved` (even past `expires_at`) or `expired`, so real spend from slow requests always counts toward the cap; `settled`/`released`/foreign → RB003. A late settle counts toward the UTC day the reservation was created.
- `release_budget_reservation(bot_id, reservation_id)` — ownership check and settings-row lock (RB002/RB003).
- `expire_stuck_request_runs(older_than_seconds 60..86400, batch 1..10000)` (service-only) fails stuck `reserved`/`running` runs and expires their reservations (006); the worker cleanup job must schedule it alongside `expire_visitor_sessions` and `purge_expired_data_entries`.
- `messages.reply_to_message_id` (assistant rows only; must reference a `user` message in the same conversation, enforced by trigger, 23514). The API sets it on every assistant insert. `knowledge_gaps` pairs by `reply_to_message_id`, then `request_id`, then latest prior user message; hiding `blocked` from analysts is UX-only (analysts can read messages directly).
- `audit_logs` also rejects TRUNCATE (statement trigger). `is_active_member` is executable by `authenticated` only.
- Retention purges fail closed for **all** bots if any bot lacks retention config (design choice; one bot per client project in practice).

### Fixes from review P3-R3 (debug cycle P3-D3, migration 006, 2026-11-05)
- `expire_stuck_request_runs` sets reservations to `expired`, not `released`. A reaped request that is still running can settle, so its real spend counts toward the cap. Until it settles, it holds no budget. The worker's threshold must exceed the longest possible request.
- `messages_check_reply_to` locks the target row (`FOR SHARE`), so a concurrent move or role change of the question cannot break the pairing. A missing target, or one the writer cannot see, is rejected with 23514. A writer needs `UPDATE` on `messages` for the lock.

### Fixes from review P3-R4 (debug cycle P3-D4, migration 007, 2026-11-05)
- `reserve_request_budget` reads the run `FOR SHARE`. The lock query includes the bot, so a foreign run is never locked. A new reservation needs a run in `reserved` or `running`, otherwise RB004. An idempotent retry still returns the existing reservation whatever the run state.
- `request_runs.state` moves forward only (trigger, 23514): `reserved` to `running`, and `reserved` or `running` to `succeeded`, `failed` or `partial`. A terminal run never changes state through UPDATE. A no-op state update is allowed. The API still updates conditionally, because a blocked transition is an error, not 0 rows. This backstops API bugs. It is not a boundary against `service_role`, which can still DELETE or TRUNCATE.
- The `audit_logs` TRUNCATE trigger stops TRUNCATE by any role, but a table owner can still drop or disable the trigger.
- Lock order (P5): `bot_profiles` (`FOR SHARE`, so a disable can't race a start), then `visitor_sessions` or `client_settings`, then `request_runs`, then `budget_reservations`. The reaper takes runs then reservations with `SKIP LOCKED` on runs and does not take the settings lock. The API runs begin, reserve and run updates as separate RPCs (separate transactions). Operators editing settings by hand must lock the bot row first, or risk a 40P01 against an in-flight reserve. Every function from migration 011, plus settle, release and `record_rate_limit_attempt`, has `lock_timeout = 2s`; the API retries 40P01 and 55P03 once for functions safe to repeat.
- Only `service_role`, `postgres` and the table owner may hold INSERT or UPDATE on `messages` (catalog test). The reply trigger depends on this: its first branch runs under the writer's RLS.
- `knowledge_gaps` after a question is deleted: the reply pointer becomes null, so an answer with no `request_id` falls to rule 3 and pairs with the latest earlier question. No migration deletes single messages today. Pinned by test.

## Admin RPCs (B-12)
Browser-callable, `SECURITY DEFINER`, `EXECUTE` to `authenticated` only, in migrations 009 and 010. "Quota" is the `upload_policy.quotas` kind each consumes.

| Function | Roles (`aal2`) | Quota | Purpose |
|---|---|---|---|
| `admin_register_document` | owner, admin | register | New document and first version; returns the generated path |
| `admin_add_document_version` | owner, admin | register | New version of a document |
| `admin_complete_upload` | owner, admin | upload | Confirm the object and queue indexing; repeat calls queue one job |
| `admin_retry_version` | owner, admin | reindex | Retry a failed or stuck version |
| `admin_reindex_document` | owner, admin | reindex | New version from the active file; the live version keeps serving |
| `admin_document_status` | owner, admin, analyst | — | Paged state, batches and safe failure code |
| `admin_request_download` | owner, admin | write | Audit a download and return the path |
| `admin_delete_document` | owner, admin | write | Exclude from retrieval, cancel queued indexing, queue cleanup |
| `admin_list_bots` | owner, admin, analyst | — | Bots, including unpublished ones |
| `admin_get_settings` | owner, admin, analyst | — | Safe settings read, works before publishing |
| `admin_update_settings` | owner, admin | write | Whitelisted fields; `expected_settings_version` required; merged result validated |
| `admin_set_bot_enabled` | owner, admin | write | Enable (gate applies) or disable |
| `admin_delete_conversation` | owner, admin | write | Delete a conversation and everything under it |
| `admin_list_members` | owner, admin | — | Members with their email as a label (B-7) |
| `schema_version` | any signed-in user | — | Migration number |

Use the `settings_version` an update returns for the next call. One update can move it by more than one, and operator edits move it too. `schema_version()` must be raised with every migration.

Visitor runtime, service role only (migration 011): `get_session_policy(slug)` (bot, enabled, Turnstile flag, per-IP and per-bot session limits; `turnstile_required` defaults to true unless `feature_flags.turnstile_required` is `false`), `create_visitor_session(bot, ttl)` (60..86400 s), `get_rate_policy(bot)`, `set_request_run_state(bot, run, state)` (conditional: only from `reserved` or `running`), `get_request_run(bot, run)` (for idempotent replay). `begin_request_run` and `reserve_request_budget` refuse a disabled bot with RB039. `schema_version()` is 11.

Service role only: `reserve_job_budget` (the worker reserves per attempt, then settles or releases on every exit path), `purge_terminal_jobs`. An expired job reservation keeps counting toward the cap until settled, because a stale worker can still settle it. `admin_set_bot_enabled` uses the write quota only when enabling, so disabling always works.

**Ingestion (P6, migration 012).** All service role only, `lock_timeout = 2s`. Index-job functions are fenced on the job lease (`index_job_fence`: running, held by this worker, lease not expired, right version, document not deleted; else RB013 or RB010), so a worker that lost its lease can't write anything.
- Job flow for `index_document`: `get_index_job_context` → verify size, eTag (null or changed fails closed), sniffed type and checksum → `update_version_progress` (`extracting`, then `embedding`) → `reserve_index_budget` → per batch: provider call, `record_usage_event`, `write_document_chunks`, progress → `settle_index_budget` → `activate_version_for_job`. Permanent failures call `fail_document_version`; transient ones `retry_job_later` with backoff, dead-lettering after `max_attempts` and failing the version with `INDEXING_FAILED`.
- Retries resume from `written_chunks` unless the stored chunking or extraction version or embedding model differs, in which case `reset_version_chunks` starts again from 0. A lost lease's reservation is marked `expired` by the next attempt and keeps counting toward the cap.
- Version status: `uploaded` → `extracting` → `embedding` → `ready` (activation only); any active state → `failed` with a failure code. A first version that fails sets the document `failed`; a ready document stays `ready`.
- Maintenance (worker): every retention and purge function, `expire_abandoned_uploads` (then removes the objects), `fail_orphaned_index_versions`, `prune_superseded_chunks`, `purge_terminal_jobs`, `purge_expired_rate_limit_buckets`. Shutdown returns a running job's lease with `release_job_lease`.
- Cleanup job: `cleanup_document` removes a deleted document's chunks in batches; objects come from `cleanup_storage_targets`, which never returns a path still used by a live document's version (reindexed versions share paths). An in-flight job for a deleted document is refused by the fence; its writes never land.
- `schema_version()` is 12.

## Storage
- Private bucket `knowledge`; path pattern `{bot_id}/{document_id}/{version_id}/{generated_filename}`.
- Uploads go directly from the admin panel. Policy `knowledge_insert_pending_version` allows only the path of a `pending_upload` version, for owner and admin at `aal2`, within 24 hours of registering. There is no UPDATE or DELETE policy, so nothing in the browser can overwrite or remove an object. All policies are `to authenticated`.
- `admin_complete_upload` confirms the object in `storage.objects` and compares its size and type with the registered values. Signed URLs are bearer links: revoking a member doesn't recall one already issued, so keep their expiry short.
- A reindex version reuses the active version's `storage_path`, so the path isn't unique. Cleanup may delete an object only when no other `document_versions` row references it.
- Browser cannot overwrite active originals or upload arbitrary paths.
- The worker validates final object size and content before indexing.
- Original-file downloads are allowed only to authorised admins by Storage policy, with short-lived links, after an RPC writes the audit row. Storage can't write to `audit_logs`, so a stolen session could skip that RPC; Storage logs are the backstop.
- Delete original objects through the delete RPC and the worker cleanup job; do not let the browser orphan active chunks.

## Indexes and integrity
- Unique bot slug; unique document/version sequence; unique chunk sequence; job dedupe key unique among live jobs (use a plain insert or an RPC, because a partial index can't be named by an upsert); unique `answer_cache.cache_key_hash`.
- Index on `messages (handoff_reason, created_at)` where `handoff_reason` is not null, for the knowledge-gaps view; `expires_at` indexes on cache tables for cleanup.
- B-tree indexes on ownership, foreign keys, conversation time, job availability/state, and usage date.
- pgvector HNSW or IVFFlat index selected after dataset testing, using the operator class matching the distance metric.
- Vector dimensions are chosen with the embedding provider before migration. Never guess a fixed dimension or mix incompatible embeddings in one index.
- Define cascade/restrict/set-null behaviour deliberately; retained citation snapshots may remain after chunk deletion only if policy permits.
- Configure and test backup/restore separately from service deployment. Restore coverage for Storage objects must be verified, not assumed from database backups.

## Retention
Scheduled jobs expire sessions, rate buckets and cache rows, reconcile stale reservations, and delete/anonymise records under the agreed retention policy. Original-file, chunk, message, source-excerpt, export, and analysis deletion must be coordinated. Backup retention and provider-side retention are separate policies.
