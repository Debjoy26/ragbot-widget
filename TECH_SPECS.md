# Technical Specifications — ragbot_widget

## 1. Stack
- Widget: TypeScript compiled/bundled to a self-contained JavaScript entry; CSS inside encapsulated UI.
- API: Node.js LTS, TypeScript, Fastify; SSE-formatted streamed response to browser `fetch`.
- Worker: Node.js/TypeScript queue poller; asynchronous PDF text extraction and batched external embeddings.
- Data: Supabase Postgres, pgvector, private Storage, Supabase Auth for admins.
- Validation: shared runtime schemas (for example Zod); maintained HTML sanitiser if Markdown enabled.
- Tooling: npm workspaces, committed lockfile, ESLint, formatter, unit/integration/E2E tests.
- Select and pin compatible stable versions during implementation; do not use unpinned `latest` in production.

## 2. Public API
| Method/path | Authentication | Purpose |
|---|---|---|
| GET /health/live | Public, minimal | Process liveness |
| GET /health/ready | Public, minimal | Bounded readiness; no credentials/details |
| POST /v1/sessions | Abuse controls, optional challenge | Issue short-lived scoped visitor token |
| POST /v1/chat | Visitor bearer token | Stream answer from server-retrieved knowledge |
| POST /v1/entries | Visitor bearer token | Validate explicitly submitted approved form |
| GET /v1/conversations/:id | Visitor bearer token | Bounded history, same-session only; the query excludes `role = system` rows (enforced server-side, not just filtered in UI). Enabled in MVP (ADR 0009) |

Session creation is not proof of human identity. Rate limits/bot challenges and spending controls remain mandatory. Optional history may be disabled entirely in the MVP.

## 3. Administrative operations
The admin panel never calls the Render API (ADR 0017). It reads under RLS and writes through database functions and Storage policies, listed in `DATABASE_SCHEMA.md` "Admin RPCs". Every function requires active membership, the required role and `aal2`, and follows the ADR 0017 rules.
| Operation | Purpose |
|---|---|
| Register document | Validate metadata, create document and version, return the generated storage path |
| Add version | Same, for an existing document (replacement) |
| Upload original | Browser to Storage; a policy allows only the path of a `pending_upload` version |
| Complete upload | Confirm the object exists and queue `index_document`; a duplicate call queues one job |
| Retry or reindex | Retry a failed version; reindex an active one by creating a new version, so live chunks stay untouched |
| Document status | Per-document state, batches and safe failure code |
| Download original | An RPC writes the audit row, then a Storage policy for permitted roles allows a short-lived link. A stolen session could skip the RPC, so Storage logs are the backstop |
| Delete document | Exclude retrieval immediately and queue cleanup |
| Read settings | Safe read that works before publishing, including `bot_id` and upload limits |
| Update settings | Whitelisted fields only, audited; takes `expected_settings_version` and rejects a stale edit; validates the merged result, so an enabled bot keeps a contact channel and an escalation message per supported language |
| Delete conversation | Retention-aware deletion workflow |

Failures use stable SQLSTATEs rather than the API error envelope. The worker makes the final check on every file. Per-bot quotas limit registrations, uploads and reindexing, and an older version can never replace a newer one.

## 4. Chat request and event contract
```json
{
  "bot_slug": "website-support",
  "conversation_id": null,
  "message": "What services do you offer?",
  "preferred_language": "en"
}
```
Headers: `Authorization: Bearer <visitor-token>`, `Idempotency-Key: <uuid>`, JSON content type. No browser-supplied retrieved context, provider API key, system prompt, or assistant history is accepted.
Events: `meta` (request/conversation/message IDs), `delta` (approved text), `sources` (validated display references), `handoff` (contact routing), `done` (final status), `error` (safe code/request ID/retry hint).
`handoff` payload: `{ "reason": "no_knowledge" | "out_of_scope" | "human_requested" | "blocked" | "unavailable" | "repeated_no_knowledge", "message": "<localised escalation message from config>", "prominent": boolean, "contact": { email?, phone?, whatsapp_url?, page_url?, business_hours?, timezone? } }`. Contact values come from current server configuration only, never from model output. On `unavailable`, `handoff` follows the `error` event. Provider names/usage may be retained server-side rather than exposed publicly.
A duplicate idempotency key cannot spend twice; reconcile ongoing/completed requests. If replay is unsupported, return the completed result/status instead of regenerating.

## 5. Errors
Stable codes include `INVALID_REQUEST`, `SESSION_EXPIRED`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `BUDGET_EXCEEDED`, `FILE_UNSUPPORTED`, `OCR_REQUIRED`, `INDEXING_FAILED`, `PROVIDER_UNAVAILABLE`, `STREAM_INTERRUPTED`. Use appropriate HTTP status before streaming; after headers are sent, use an error event. Do not reveal stack traces or raw provider response bodies.

## 6. Retrieval/embedding
- Choose one embedding space and dimension per active indexed corpus; use its compatible query encoder.
- Persist model/version, extraction/chunk version, metric, and index configuration.
- Similarity score thresholds are calibrated per model; there is no universal threshold.
- Bound top-k, token budget, context length, and server-owned conversation history.
- Map citation tokens to retrieved chunks and deny invented source IDs/URLs.
- Embedding-provider outages do not trigger a silent switch to an incompatible embedding model.
- Multilingual tests include cross-language questions/documents where promised.

## 6.1 Contact routing (PRD W-16)
- `no_knowledge`: no evidence above the calibrated threshold → skip generation; send the configured localised message plus `handoff`.
- `out_of_scope`: scope check fails → `handoff`.
- `human_requested`: visitor asks for a person/contact → respond with `handoff` directly, skipping retrieval and generation.
- `blocked`: input moderation blocks → policy message plus `handoff`.
- `unavailable`: providers exhausted after retries/fallback → `error` then `handoff`.
- `repeated_no_knowledge`: configurable count of misses per conversation (default 2) → `handoff` with `prominent: true`.
- The model returns a structured `insufficient_evidence` flag; when set, the API emits `handoff` even if evidence was retrieved.
- Phone numbers, emails and URLs in model text that don't match configured contact details or validated sources are not linked.
- `messages.handoff_reason` is persisted; admins read aggregated gaps via the `knowledge_gaps` RPC.

## 6.2 Caching (latency)
All caches are version-keyed, backend-only, and can be disabled by a kill switch in `client_settings.cache_policy`. Answer and retrieval caches are bot-scoped. Query embedding and moderation caches are keyed by content hash, have no `bot_id`, and hold no raw text or visitor data, so a verdict or embedding can be reused for identical input.
| Layer | Key | Storage | Invalidation |
|---|---|---|---|
| Provider prompt caching | Byte-identical prefix per bot, settings version and prompt template | Provider | Prefix changes on version change |
| Bot config | `bot_id` + `settings_version` | In-process LRU | 30–60 s TTL and version bump |
| Public config | `bot_slug` + ETag | Browser storage + HTTP stale-while-revalidate | ETag change |
| Query embedding | hash(model, dims, normalised query) | LRU + `query_embedding_cache` | Key changes with model |
| Retrieval results (chunk IDs only) | bot, `corpus_version`, embedding hash, k, threshold, language | LRU | `corpus_version` bump; ≤10 min TTL |
| Moderation verdict | hash(model, policy version, text) | LRU + `moderation_cache` | Key changes with policy |
| Answer (opt-in) | bot, corpus/settings/prompt versions, model, language, hash(question) | `answer_cache` | Any version change; TTL from config |
Answer-cache hits are first-turn only, still pass session auth, rate limits, idempotency and input moderation, re-check that cited versions are active, never store contact details or PII-pattern questions, and record a zero-cost `usage_events` row. Run query embedding and input moderation in parallel; flush SSE headers and `meta` immediately; reuse keep-alive connections.

## 7. Files and jobs
File limits are required client configuration. Validate actual MIME/content, byte count, path, parser behaviour, and encryption/scan status. Treat MD/TXT as data, never instructions or executable content. Reject unsupported scans with `OCR_REQUIRED` rather than silently marking empty documents ready.
Use backoff, lease heartbeats, cancellation, bounded concurrency, and durable progress. Define worker shutdown handling and resumable batches. Isolate heavy extraction/OCR in a bounded subprocess/service where needed. Reindexing must not duplicate active chunks.

## 8. Security controls
- Public Supabase grants expose only public configuration; no anon read of knowledge or chat tables.
- Admin access is enforced in Postgres and Storage policies: active membership, role and `aal2` on every private read and admin RPC (ADR 0015, ADR 0017).
- Visitor bearer token binds bot, session, expiry; conversation lookup checks ownership.
- CORS is not authentication. Do not rely on IP or user-agent as identity.
- TLS, trusted proxy configuration, canonical IP handling, payload/concurrency/time limits.
- Atomic budget reservation; include fallback and ingestion usage; provider billing remains final authority. Ingestion uses a job-based reservation (`reserve_job_budget`), and the worker never calls a provider without one.
- Disable raw model HTML/remote images. Use safe source links and no inline scripts.
- Generic untrusted prompts/documents never grant access or change server configuration.

## 9. Test and release matrix
- Unit: validation, prompt assembly, citation mapping, token expiry, fallback eligibility, handoff triggers, contact-field validation.
- Cache: cross-bot isolation, invalidation on activation/deletion/settings change, kill switch, no caching of partial/failed answers.
- Integration: actual grants/RLS; every admin RPC and Storage policy as each role; SQL and `shared/src/schemas.ts` accept the same settings; vector dimension mismatch; membership revocation; source deletion; ownership rejection.
- Queue: duplicate delivery, lease expiry, kill/restart, retries, incomplete embeddings, atomic replacement.
- Security: forged visitor ID, cross-session history, prompt injection, XSS, file spoofing, budget races.
- E2E: embed on representative host pages, mobile, accessibility, streaming cancellation, partial response, contact card for each handoff reason and when the API is unreachable.
- Evaluation: known answers, refusal cases that always yield `handoff` with no invented contact details, multilingual cases, both primary/fallback, calibrated thresholds.
- Operations: deployment rollback, storage/database restore rehearsal, retained/deleted personal data audit.

## 10. Operational constraints
Choose compute from measurements, not a promise of unlimited scalability. Monitor Supabase/Postgres connection and quota limits, Render CPU/RAM/egress, queue age, and provider quotas. Use connection pooling if direct SQL is introduced; the initial design can use Supabase RPC/HTTP clients. No paid SLA is implied by these documents.
