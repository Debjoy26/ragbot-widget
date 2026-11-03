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
| budget_reservations | id, bot_id, request_id, amount, state, expires_at, created_at | Reserve before work, reconcile after; conservative estimates plus provider-side caps. |
| audit_logs | id, actor_user_id, action, resource_type, resource_id, request_id, safe_metadata, created_at | Backend writes; no raw secrets or full document payloads. |
| client_settings | bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy, feature_flags, updated_at | Internal settings; only explicitly whitelisted fields editable by admin. `handoff_policy`: enabled triggers and repeated-miss threshold (default 2). `cache_policy`: answer-cache opt-in (default off), TTLs, kill switch. |
| query_embedding_cache | key_hash, embedding_model, embedding, created_at, last_hit_at, expires_at | Key is a hash of model, dimensions and normalised query. Raw query text is not stored. |
| moderation_cache | key_hash, policy_version, verdict, created_at, expires_at | Key is a hash of moderation model, policy version and normalised text. |
| answer_cache | id, bot_id, cache_key_hash, language, answer_text, source_refs, handoff_reason, corpus_version, settings_version, prompt_template_version, chat_model, hit_count, created_at, last_hit_at, expires_at | Opt-in per client. First-turn, completed, moderated answers only. Contact details are never cached. Cited versions are re-checked as active on read. No session or visitor identifiers. |

## Database operations
- `match_document_chunks`: bounded similarity query; filters by bot, active document version, deleted state, and disclosure policy. Execute by the backend role only, not `anon`.
- `claim_jobs`: atomically claim due work using transaction/row locks and a lease. Expired leases become recoverable.
- `activate_document_version`: atomically switch the active pointer and increment `corpus_version` after all expected chunks exist and validation succeeds.
- `reserve_request_budget`: atomically check caps and reserve capacity before external calls.
- `record_rate_limit_attempt`: atomically increment a bounded window.
- `mark_document_deleted`: immediately exclude retrieval, increment `corpus_version`, then enqueue cleanup.
- `knowledge_gaps`: aggregate unanswered questions by `handoff_reason` and frequency for active admins/analysts; bounded and date-filtered.
- Never expose arbitrary SQL execution or unbounded search RPCs.
- Functions using SECURITY DEFINER require a fixed safe search path, explicit authorization, and restricted EXECUTE grants. Prefer SECURITY INVOKER where feasible.

## Grants and RLS matrix
| Resource | anon | Authenticated nonmember | analyst | admin/owner | API/worker |
|---|---|---|---|---|---|
| public_bot_config | Read public fields | Read | Read | Read | Maintain |
| documents/versions | None | None | Read metadata if permitted | Read | Write/manage lifecycle |
| document_chunks | None | None | None by default | None directly | Read/write |
| conversations/messages/sources | None | None | Read scoped records | Read scoped records | Write |
| conversation_analysis | None | None | Read | Read | Write |
| data_entries | None | None | Read if permitted | Read | Validate/write |
| bot_profiles/client_settings | None | None | None or restricted RPC | Restricted field-level update RPC | Manage |
| jobs/usage | None | None | Safe status/aggregate RPC | Safe status/aggregate RPC | Write/claim |
| memberships, sessions, budgets, request_runs | None | None | None | Restricted management API | Manage |
| audit_logs | None | None | None | Read redacted records | Append |
| query_embedding_cache, moderation_cache, answer_cache | None | None | None | None (hit-rate via safe aggregate RPC) | Read/write |
| knowledge_gaps RPC | None | None | Execute | Execute | — |

RLS does not itself provide column-level security. Use column grants, minimal security-invoker views with correct privileges, or narrowly scoped RPCs for safe settings/status reads. Revoke default permissions on internal tables/functions. Authenticated role alone does not imply active admin membership. Supabase privileged credentials bypass RLS, so application checks remain mandatory.

## Storage
- Private bucket `knowledge`; path pattern `{bot_id}/{document_id}/{version_id}/{generated_filename}`.
- Upload staging paths are authorised by a short-lived signed upload URL issued after backend validation, or equivalent tightly scoped policies.
- Browser cannot overwrite active originals or upload arbitrary paths.
- API validates final object size and content before indexing.
- Signed download URLs are issued only for authorised admins, with short expiry.
- Delete original objects through the lifecycle endpoint; do not let the browser orphan active chunks.

## Indexes and integrity
- Unique bot slug; unique document/version sequence; unique chunk sequence; unique job dedupe key; unique `answer_cache.cache_key_hash`.
- Index on `messages (handoff_reason, created_at)` where `handoff_reason` is not null, for the knowledge-gaps view; `expires_at` indexes on cache tables for cleanup.
- B-tree indexes on ownership, foreign keys, conversation time, job availability/state, and usage date.
- pgvector HNSW or IVFFlat index selected after dataset testing, using the operator class matching the distance metric.
- Vector dimensions are chosen with the embedding provider before migration. Never guess a fixed dimension or mix incompatible embeddings in one index.
- Define cascade/restrict/set-null behaviour deliberately; retained citation snapshots may remain after chunk deletion only if policy permits.
- Configure and test backup/restore separately from service deployment. Restore coverage for Storage objects must be verified, not assumed from database backups.

## Retention
Scheduled jobs expire sessions, rate buckets and cache rows, reconcile stale reservations, and delete/anonymise records under the agreed retention policy. Original-file, chunk, message, source-excerpt, export, and analysis deletion must be coordinated. Backup retention and provider-side retention are separate policies.
