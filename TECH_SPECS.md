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
| GET /v1/conversations/:id | Visitor bearer token | Optional bounded history, same-session only |

Session creation is not proof of human identity. Rate limits/bot challenges and spending controls remain mandatory. Optional history may be disabled entirely in the MVP.

## 3. Administrative API
All administrative routes require a valid Supabase access token, active membership, required role, and applicable MFA assurance.
| Method/path | Purpose |
|---|---|
| POST /v1/admin/documents | Validate metadata, create version, issue scoped upload URL |
| POST /v1/admin/documents/:id/complete | Verify upload and enqueue indexing |
| POST /v1/admin/documents/:id/reindex | Retry/reindex permitted version |
| POST /v1/admin/documents/:id/download | Issue short-lived original-file URL |
| DELETE /v1/admin/documents/:id | Exclude retrieval immediately and enqueue cleanup |
| PATCH /v1/admin/bot-settings | Whitelisted settings only, audited |
| POST /v1/admin/conversations/:id/delete | Retention-aware deletion workflow |

The dashboard may read RLS-protected records directly. Settings updates and destructive lifecycle operations use the API to preserve invariants.

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
Events: `meta` (request/conversation/message IDs), `delta` (approved text), `sources` (validated display references), `done` (final status), `error` (safe code/request ID/retry hint). Provider names/usage may be retained server-side rather than exposed publicly.
A duplicate idempotency key cannot spend twice; reconcile ongoing/completed requests. If replay is unsupported, return the completed result/status instead of regenerating.

## 5. Errors
Stable codes include `INVALID_REQUEST`, `SESSION_EXPIRED`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `BUDGET_EXCEEDED`, `FILE_UNSUPPORTED`, `INDEXING_FAILED`, `PROVIDER_UNAVAILABLE`, `STREAM_INTERRUPTED`. Use appropriate HTTP status before streaming; after headers are sent, use an error event. Do not reveal stack traces or raw provider response bodies.

## 6. Retrieval/embedding
- Choose one embedding space and dimension per active indexed corpus; use its compatible query encoder.
- Persist model/version, extraction/chunk version, metric, and index configuration.
- Similarity score thresholds are calibrated per model; there is no universal threshold.
- Bound top-k, token budget, context length, and server-owned conversation history.
- Map citation tokens to retrieved chunks and deny invented source IDs/URLs.
- Embedding-provider outages do not trigger a silent switch to an incompatible embedding model.
- Multilingual tests include cross-language questions/documents where promised.

## 7. Files and jobs
File limits are required client configuration. Validate actual MIME/content, byte count, path, parser behaviour, and encryption/scan status. Treat MD/TXT as data, never instructions or executable content. Reject unsupported scans with `OCR_REQUIRED` rather than silently marking empty documents ready.
Use backoff, lease heartbeats, cancellation, bounded concurrency, and durable progress. Define worker shutdown handling and resumable batches. Isolate heavy extraction/OCR in a bounded subprocess/service where needed. Reindexing must not duplicate active chunks.

## 8. Security controls
- Public Supabase grants expose only public configuration; no anon read of knowledge or chat tables.
- JWT signature/issuer/audience/expiry validation; require active admin role and configured MFA assurance.
- Visitor bearer token binds bot, session, expiry; conversation lookup checks ownership.
- CORS is not authentication. Do not rely on IP or user-agent as identity.
- TLS, trusted proxy configuration, canonical IP handling, payload/concurrency/time limits.
- Atomic budget reservation; include fallback and ingestion usage; provider billing remains final authority.
- Disable raw model HTML/remote images. Use safe source links and no inline scripts.
- Generic untrusted prompts/documents never grant access or change server configuration.

## 9. Test and release matrix
- Unit: validation, prompt assembly, citation mapping, token expiry, fallback eligibility.
- Integration: actual grants/RLS; vector dimension mismatch; membership revocation; source deletion; ownership rejection.
- Queue: duplicate delivery, lease expiry, kill/restart, retries, incomplete embeddings, atomic replacement.
- Security: forged visitor ID, cross-session history, prompt injection, XSS, file spoofing, budget races.
- E2E: embed on representative host pages, mobile, accessibility, streaming cancellation, partial response.
- Evaluation: known answers, refusal cases, multilingual cases, both primary/fallback, calibrated thresholds.
- Operations: deployment rollback, storage/database restore rehearsal, retained/deleted personal data audit.

## 10. Operational constraints
Choose compute from measurements, not a promise of unlimited scalability. Monitor Supabase/Postgres connection and quota limits, Render CPU/RAM/egress, queue age, and provider quotas. Use connection pooling if direct SQL is introduced; the initial design can use Supabase RPC/HTTP clients. No paid SLA is implied by these documents.
