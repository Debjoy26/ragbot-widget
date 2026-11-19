# Implementation Plan — ragbot_widget

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](docs/reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

> Source of truth: `PRD.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `TECH_SPECS.md`, `UI_SCHEMA.md`, `README.md`.
> This plan turns that planning baseline (v1.0) into an ordered, testable build. Requirement IDs (W-01…W-16) refer to `PRD.md §5`.
> Created: 2026-11-03. Updated 2026-11-06 with the admin panel's backend requests (§1a) and ADR 0017. Progress is tracked in `status.md`; context for whoever picks this up is in `handover.md`.

---

## 0. Guiding principles

1. **Security invariants first, features second.** RLS/grants, visitor-token auth, atomic budgets and idempotency are built before the chat endpoint goes anywhere near a real provider.
2. **Fail closed.** Missing limits, missing embedding dimensions, missing retention policy → the service refuses to start or refuses the request (PRD §8).
3. **Server owns truth.** The browser never supplies context, history, roles, usage numbers, system prompts or citations (TECH_SPECS §4, PRD §7).
4. **One migration history.** `supabase/migrations` in this repo is authoritative; the admin panel repo consumes it (DATABASE_SCHEMA "Shared ownership").
5. **Every phase ends with a green test gate.** No phase is "done" without its tests from TECH_SPECS §9.
6. **Pin everything.** Exact Node LTS, exact dependency versions, committed root lockfile. No `latest`.

---

## 1. Phase overview

| # | Phase | Main output | Depends on | Gate |
|---|---|---|---|---|
| P0 | Decisions & prerequisites | Resolved open decisions, accounts, credentials | — | Decision log signed off |
| P1 | Monorepo scaffold & tooling | npm workspaces, TS, lint, test runners, CI | P0 (Node version) | `npm ci && npm run build && npm test` green on empty skeleton |
| P2 | Shared contracts package | Zod schemas, API/event contracts, error codes, provider interfaces | P1 | Unit tests for every schema |
| P3 | Database & storage | Migrations 001–008, RPCs, grants/RLS, bucket, seed | P0 (embedding dims), P1 | RLS/grant integration matrix green |
| P3.5 | Admin data layer | RPCs and Storage policies for all admin writes (ADR 0017) | P3 | Role tests for every function; security review |
| P4 | API foundation | Fastify server, config validation, logging, health, visitor auth | P2, P3 | Health + auth integration tests |
| P5 | Visitor sessions & abuse controls | `/v1/sessions`, rate limits, budget reservation, idempotency | P4 | Forged-token, race, and idempotency tests |
| P6 | Ingestion pipeline (worker) | Job queue, extract/chunk/embed, atomic activation | P3, P3.5, P4 | Queue test suite (TECH_SPECS §9 "Queue") |
| P7 | Retrieval & chat | `/v1/chat` SSE: moderation, retrieval, prompt, provider + fallback, citations | P5, P6 | Unit + evaluation set baseline |
| P7.5 | Caching & latency | Layered caches (config, embeddings, retrieval, provider prompt cache, opt-in answer cache), cache warming | P7 | Invalidation + isolation tests; measured latency gain |
| P8 | Widget | Shadow-DOM custom element, states, streaming, a11y, build to `/v1.0.0/widget.js` | P2, P7 (contract) | E2E on host pages, a11y, XSS tests |
| P9 | Async analysis, entries, retention | Summaries/sentiment/intent jobs, `/v1/entries`, cleanup/retention jobs | P6, P7 | Integration tests + retention audit |
| P10 | Observability & ops hardening | Metrics, redaction, alerts, render.yaml, vercel.json, deploy/smoke scripts | P4–P9 | Smoke test against staging |
| P11 | Evaluation, security review, load test | Eval sets, pen-test checklist, latency measurement | P7–P10 | PRD §8 release gates met & recorded |
| P12 | First client deployment | Client-A rollout per README "Deployment order" | P11, admin AP6 | Signed handover to client |

P6 and P8 can run in parallel with P7 once P5 is merged and the chat event contract (P2) is frozen.

### 1a. Admin panel integration

The admin panel (`../ragbot-admin_pannel`, phases `AP0`–`AP7`) talks only to Supabase and never calls the Render API (ADR 0017). It raised these requests in its `plan.md §3`, where each gap is described in full. This table is the schedule for them. Scheduling an item doesn't approve it: migrations, shared-contract changes and any remote change still need owner approval when they are built.

| Lands in | Items | What this repo delivers |
|---|---|---|
| Before P3.5, test stack only | B-13, B-14, B-15 | Local TOTP on; a test-only fixture with owner, admin, analyst, nonmember and revoked users plus sample rows, never applied to a client project; admin dev origin in the local Auth redirects |
| P3.5 | B-1 to B-7, B-11, B-12 | See the P3.5 section |
| P6 | B-2 (worker side) | The worker writes per-document progress and safe failure codes |
| P7 | B-9 | See the P7 section |
| P9 | B-10 | See the P9 section |
| Only if admin Q5 keeps the language filter | B-8 | Store the language on conversations or messages |
| Withdrawn | B-16 | The panel makes no API calls, so it needs no API CORS |

B-13 to B-15 unblock the admin panel's first real `aal2` test, so they come first. Per-client redirect URLs and turning off open sign-up (B-15) belong in the P12 runbook.

**Rulings on conflicts between the two repos:**
- **MFA:** every admin RPC and Storage policy requires `aal2`, not only "privileged" ones (ADR 0015).
- **System messages:** staff must not see them either, so the fix is in RLS (B-5). Keeping them out by convention alone isn't enough.
- **Repeated-miss threshold:** operator-managed in `client_settings.handoff_policy`. `shared/src/schemas.ts` deliberately keeps policies out of the settings whitelist (ADR 0013 default: 2).
- **Contact details:** the admin Settings form must be able to set every contact and escalation field, because go-live needs them (PRD §5.1, ADR 0013).
- **Knowledge gaps:** the admin panel shows the `knowledge_gaps` RPC (PRD §5.1, ADR 0011).
- **First deployment:** P12 and admin AP7 are one joint rollout (see P12).

Each change to `shared/src` reaches the admin panel through its `npm run contracts:sync`, so tell that repo when one lands.

---

## 2. Phase details

### P0 — Decisions & prerequisites
Resolve PRD §9 open decisions before writing code that depends on them. Record outcomes in `docs/decisions/` (ADR format).

| Decision | Blocks | Notes |
|---|---|---|
| Embedding provider, model and **vector dimension** | `002_vectors.sql`, worker, retrieval | Never guess a dimension (DATABASE_SCHEMA "Indexes"). |
| Primary + fallback chat providers | P7 fallback | Must have independent quota (ARCHITECTURE §5). |
| Moderation provider & policy (full buffer vs rolling batches) | P7 streaming | Per-client setting; affects UX latency. |
| OCR in scope? Provider? | P6 | If not, scanned PDFs → `OCR_REQUIRED`. |
| Retention periods, deletion/anonymisation rules, jurisdiction | `005_retention.sql`, P9 | Provider data-processing terms too. |
| File limits (bytes, pages), rate limits, daily budget caps | P5, P6 | Missing values fail closed. |
| Markdown rendering on/off (W-14) and sanitiser choice | P8 | Plain text is default. |
| Conversation history endpoint in MVP? | P7/P8 | `GET /v1/conversations/:id` "may be disabled". |
| Token persistence: memory only vs sessionStorage | P8 | Memory is default (UI_SCHEMA §7). |
| Bot challenge for `/v1/sessions` (e.g. Turnstile) | P5 | "Optional challenge". |
| Node LTS exact version, Fastify/Zod versions | P1 | Pin. |
| Feedback buttons (D12) | P8 | Deferred (ADR 0011). |
| Answer cache and TTL (D13) | P7.5 | Off by default (ADR 0012). |
| Contact channels, hours, messages, miss threshold (D14) | P3, P7, P8 | ADR 0013. |

Also: create dev Supabase project (or local stack via Supabase CLI), dev Render/Vercel accounts, test provider keys with low spending caps.

**Deliverables:** `docs/decisions/0001-…md` per decision; `.env.example` files listing every variable with no real values.

### P1 — Monorepo scaffold & tooling
- Root `package.json` with workspaces `widget`, `api`, `worker`, `shared`; root `tsconfig.json` (strict) with project references.
- `.nvmrc` / `engines` pinning Node LTS; committed `package-lock.json`.
- ESLint + formatter (Prettier or equivalent), `lint`, `typecheck`, `test`, `build` root scripts.
- Root scripts required by README: `db:migrate:dev`, `dev:api`, `dev:worker`, `dev:widget`, `test`, `build`.
- Test stack: unit (Vitest or node:test), integration (against local Supabase), E2E (Playwright).
- `.gitignore` covering `.env*` (except `.env.example`), `dist/`, `node_modules/`, Supabase local state.
- CI workflow: install → lint → typecheck → unit → integration (with Supabase CLI service) → build.
- Directory layout exactly as `README.md` "Project structure".

**Acceptance:** fresh clone → `npm ci && npm run build && npm test` succeeds; CI green.

### P2 — Shared contracts (`shared/`)
- `contracts.ts`: request/response types for every route in TECH_SPECS §2–3; SSE event union `meta | delta | sources | handoff | done | error`. `handoff` carries `{reason, message, contact}` where `contact` comes from server config only.
- `schemas.ts`: Zod schemas — chat request (rejects unknown fields such as `context`, `system`, `history`), public bot config (colour hex + https URL validation, no HTML), contact block (email format, E.164 phone, `https:` contact/WhatsApp URLs, hours + IANA time zone, localised escalation messages, at least one channel required), visitor token claims, job payloads per job type, data-entry form schemas keyed by `schema_key`, settings whitelist.
- Error code enum: `INVALID_REQUEST, SESSION_EXPIRED, UNAUTHORIZED, FORBIDDEN, RATE_LIMITED, BUDGET_EXCEEDED, FILE_UNSUPPORTED, OCR_REQUIRED, INDEXING_FAILED, PROVIDER_UNAVAILABLE, STREAM_INTERRUPTED, INTERNAL_ERROR` (note `OCR_REQUIRED` appears in TECH_SPECS §7 but not §5 — add it).
- `providers.ts`: `ChatProvider`, `EmbeddingProvider`, `ModerationProvider` interfaces with typed, classified errors (`transient | rate_limited | auth | billing | permanent`).
- `prompts.ts`: prompt template builder with delimited evidence blocks and versioned template IDs.

**Acceptance:** schema unit tests incl. negative cases; contract package builds for both Node and browser (widget imports only browser-safe parts).

### P3 — Database & storage (`supabase/`)
| Migration | Contents |
|---|---|
| `001_core.sql` | Tables from DATABASE_SCHEMA (all except vector column), UUID PKs, `timestamptz`, CHECK constraints for enum-like fields, FKs with deliberate cascade/restrict/set-null, unique constraints (bot slug, `(document_id, version_number)`, `(document_version_id, chunk_index)`, job `dedupe_key`, scoped idempotency key), B-tree indexes. |
| `002_vectors.sql` | `create extension vector`; `document_chunks.embedding vector(<DIM from P0>)`; HNSW/IVFFlat index with opclass matching chosen metric (start HNSW, re-evaluate after dataset testing); `match_document_chunks` RPC (bounded `k`, filters bot, active version, `deleted_at is null`, `disclosure_policy = 'public_answer'`). |
| `003_grants_rls_storage.sql` | Revoke defaults on all tables/functions; enable RLS everywhere; policies per the grants matrix; `is_active_member(role[])` helper (SECURITY DEFINER, fixed `search_path`); anon may read **only** `public_bot_config`; private bucket `knowledge` and storage policies; column grants / security-invoker views for safe status reads. |
| `004_jobs_limits_budgets.sql` | `claim_jobs` (FOR UPDATE SKIP LOCKED + lease), `activate_document_version`, `reserve_request_budget`, `record_rate_limit_attempt`, `mark_document_deleted`; EXECUTE granted only to service role. |
| `005_retention.sql` | Retention helpers, expiry functions for sessions/rate buckets/stale reservations; scheduling via worker cleanup jobs (or pg_cron if approved). |
| `006_reaper_settle_reply_lock.sql` | Debug cycle P3-D3: reaper sets reservations to `expired`; row lock on the reply target. |
| `007_run_state_guard.sql` | Debug cycle P3-D4: a new reservation needs a live run; `request_runs` state guard. |
| `008_p3d5_fixes.sql` | Debug cycle P3-D5: audit gaps G-1 to G-8. |
| `009_admin_documents.sql`, `010_admin_settings.sql` | P3.5 (below). |
| `seed.sql` | Dev-only bot profile, public config, client_settings with conservative limits. **No** real admin users. |

Also: operator script for first admin membership (trusted tooling, not seed).

**Tests (integration, against local stack):** run the full grants/RLS matrix as anon, authenticated nonmember, analyst, admin, owner, service role. Vector dimension mismatch rejected. Membership revocation takes effect immediately. RPCs not callable by anon/authenticated where not granted.

**Acceptance:** every cell of the DATABASE_SCHEMA matrix has a passing test.

### P3.5 — Admin data layer (ADR 0017)
Everything the admin panel writes, as database functions and Storage policies. It needs only P3, so it can start before P4. New migrations are numbered after the latest one. Function names are decided at build time. It follows debug cycle P3-D5 if the owner approves that (`status.md §3b`). B-5, the B-2 columns and B-13 to B-15 are also in that backlog as G-5, G-6 and G-24, so whichever lands first closes them.

Every browser-callable function follows the rules in ADR 0017: `is_active_member_mfa` first, fixed `search_path`, `authenticated` only, own input validation, audit in the same transaction.

- **Documents (replaces the planned `/v1/admin/documents` routes):** register a document and first version, returning the generated storage path; add a version to an existing document (B-1); complete an upload, which confirms the object exists and queues `index_document`; retry a failed version, or reindex an active one by creating a new version so the live chunks stay untouched; delete a document, which uses `mark_document_deleted` and queues `cleanup`.
- **Storage:** policies on the `knowledge` bucket, always `to authenticated`, never `to public` (`anon` holds table grants on `storage.objects`, so RLS is the only barrier). Upload is allowed only to the path of a `pending_upload` version; download only for the roles in the B-12 table. No overwrite of an active original.
- **Status (B-2):** per-document state, processed/total batches and safe failure code. P6 fills in the values.
- **Identity and settings (B-3, B-4):** a safe read that works before publishing and returns `bot_id`, upload limits, whitelisted settings and `settings_version`. An update function takes `expected_settings_version`, rejects a stale edit, and bumps `settings_version` so the P7.5 caches refresh.
- **Conversation delete:** retention-aware deletion of messages, sources, analysis and entries.
- **B-5:** restrict the `messages` member policy to exclude `role = 'system'`, before P7 writes messages.
- **B-6:** schema version from a public-safe RPC.
- **B-7:** a display label on audit rows, or a safe member lookup RPC.
- **B-11:** stable SQLSTATEs for conflict, file too large and MFA required.
- **B-12:** a published table of RPCs and allowed roles.
- **Contracts:** remove the `/v1/admin/*` types and schemas from `shared/src`. Keep the settings whitelist schema: the panel and the parity test use it.

**Fixes from the 2026-11-06 review:**
- **Version order:** `activate_document_version` refuses a version older than the active one, and the worker marks it `failed`. Reproduced on the local stack: v2 finishing after v3 replaced it as the live version.
- **Reindex paths:** `document_versions.storage_path` is unique, so a new version can't reuse the original's path. Copy the object or change the constraint, and decide which at build time.
- **Ingestion budget:** `reserve_request_budget` needs a request run, and a run needs a visitor session, so the worker can't reserve today. Add a job-based reservation that counts toward the same daily cap (`TECH_SPECS §8`). The worker reserves before embedding and settles afterwards. If the cap is reached, the job fails with `BUDGET_EXCEEDED` and the old version stays live.
- **Quotas:** per-bot limits on registrations, uploads and reindexing in each window. No API rate-limits these calls any more.
- **Job attempts:** add attempt limits for `index_document` and `cleanup` to `client_settings`. Each RPC reads them there, and a missing value fails closed. `mark_document_deleted` used to expect this from API config, and the browser must never supply it.
- **Download audit:** the panel calls an RPC that writes the audit row, then gets the Storage link. A stolen session could skip that RPC, because Storage can't write to `audit_logs`. Storage logs are the backstop, and this stays a documented limit.
- **Merged settings:** validate the merged result, not just the patch. While a bot is enabled, reject any change that leaves no contact channel, or a supported language with no escalation message.
- **Enable gate:** a bot can't be enabled until those same rules pass (P3S-7).
- **Audit hygiene:** an allowlist for `audit_logs.safe_metadata` (P3X-8), and an allowlist census test covering every browser-callable function.
- **First admin (G-23):** the operator script uses a short-lived invite link and never sets a password. A password that leaks before TOTP enrolment gives full access, because the first factor can be enrolled at `aal1`.
- **Client Auth settings:** add these to the manual steps in `database/README.md` and the P12 runbook: public signup off, TOTP on, phone MFA off, a minimum password length of at least 12, and `secure_password_change` on.

**Tests (pgTAP plus a real session):** each function as anon, nonmember, analyst, admin, owner, revoked and `aal1`; unknown settings keys rejected; stale version conflict; audit row written, and rolled back with a failed change; upload to any other path refused; duplicate `complete` queues one job; system messages unreadable; an older version can't replace a newer one; reindex leaves the live version in place until the new one is ready; quotas refuse excess calls; a missing attempts setting fails closed; a merged patch that removes the last contact channel from an enabled bot is refused; enabling a bot without contact details is refused; job-based reservations count toward the cap and can't exceed it. A shared-fixture test proves SQL and `shared/src/schemas.ts` accept and reject the same settings.

**Acceptance:** all tests pass; `security-reviewer` has reviewed every browser-callable function; advisors reviewed, and the expected list in `database/README.md` updated. Remote apply needs owner approval, with public signup off and TOTP on.

### P4 — API foundation (`api/`)
- `lib/config.ts`: Zod-validated env; refuse to start on missing/invalid values (limits, model names, deadlines, max attempts, allowed origins).
- `lib/logger.ts`: pino-style structured logging with request IDs and a redaction list (auth headers, tokens, keys, message content, document bodies).
- `lib/supabase.ts`: service-role client (server only).
- `server.ts`: Fastify with body-size limits, timeouts, trusted-proxy config, canonical client IP derivation, CORS from `ALLOWED_ORIGINS` (supplementary only), global error handler mapping to stable codes (no stack traces).
- `routes/health.ts`: `/health/live`, `/health/ready` (bounded DB ping, no details).
- `services/auth.ts`:
  - Visitor tokens: HMAC (`VISITOR_TOKEN_SECRET`) signed, claims `{bot_id, session_id, token_version, exp}`; verify against `visitor_sessions` (not revoked, not expired, token_version matches).
- No admin routes or admin JWT handling: the panel doesn't call this API (ADR 0017).

**Acceptance:** tests for expired/forged/wrong-bot visitor tokens.

**Obligations from the P4 reviews:**
- **P5:** add `Db` insert, conditional update and list methods; add a 40P01 retry and set `lock_timeout` in SQL. Pass `auth` into `ServerDeps`. Derive the bot only from `req.visitor`, and check `bot_profiles.enabled` in the same RPC as the budget reservation. Rate-limit on bot and session first and `request.clientIp` second, using an IPv6 /64. Routes log only ids, counts and codes.
- **P7:** enforce `CHAT_DEADLINE_MS` with an AbortController. SSE needs reply hijacking, CORS headers set on the raw response, and heartbeats shorter than `CONNECTION_TIMEOUT_MS`. The worker reaper threshold must exceed `CHAT_DEADLINE_MS` plus a settle margin.
- **P10/P12:** measure `X-Forwarded-For` on a real Render deploy and set `TRUSTED_PROXY_HOPS` from it.

### P5 — Visitor sessions & abuse controls
- `POST /v1/sessions`: resolve bot by slug, check enabled, record rate-limit attempt (hashed key, no plain IP), optional challenge verification, insert `visitor_sessions`, return token + expiry.
- `services/limits.ts`: wrappers around `record_rate_limit_attempt` (per-session and per-IP-hash windows) and `reserve_request_budget` / settle / release.
- Idempotency: `request_runs` with unique `(bot_id, visitor_session_id, idempotency_key)`; request hash comparison → mismatch = `INVALID_REQUEST`; duplicate in progress → 409-style status; completed → return stored final status, never regenerate.
- Concurrency: one active generation per visitor session (`begin_request_run`). `request_runs` has no conversation link.

**Tests:** parallel budget race (N concurrent reservations never exceed cap), duplicate idempotency key cannot spend twice, payload-mismatch rejection, rate-limit window rollover.

**Design notes (P5, closed 2026-11-07):**
- The plan's `Db` insert, conditional update and list methods were replaced by service-role RPCs (`create_visitor_session`, `set_request_run_state`, `get_request_run` and others in migration 011). One round trip each, no table grants to the API, and conditional updates enforced in SQL.
- The per-IP preflight limit on `/v1/sessions` is shared across bots, so heavy use from one address can block session creation for others behind it (shared NAT). Accepted: it caps database load before any lookup. Keep `SESSION_PREFLIGHT_PER_IP_LIMIT` well above the per-bot per-IP limit.
- Turnstile was verified with a fake only. The widget renders it with `TURNSTILE_SESSION_ACTION` from `shared` (P8); the first real verification with live keys is a P12 step.

### P6 — Ingestion pipeline (`worker/`)
- From P5: schedule `purge_expired_rate_limit_buckets` in the worker cleanup job, because buckets grow under IPv6 rotation until purged.
- Jobs arrive from the P3.5 functions; there are no admin document routes (ADR 0017).
- First step of every `index_document` job: verify the object's size and sniffed MIME against the upload policy, and compute and store the checksum. No API checks the upload first, so this is the authoritative check.
- B-2: write per-document progress and safe failure codes for the P3.5 status read.
- Reserve budget before embedding and settle after, using the P3.5 job-based reservation. Never call a provider without a reservation.
- `worker.ts`: poll `claim_jobs` with lease, heartbeat to extend lease, bounded concurrency, graceful shutdown (stop claiming, finish/release current), recover expired leases, exponential backoff with jitter, dead-letter after `max_attempts`.
- `lib/extract.ts`: PDF (text layer), MD, TXT; validate actual content; detect empty/scanned PDFs → `OCR_REQUIRED`; encrypted PDFs → `FILE_UNSUPPORTED`; run heavy parsing in a bounded subprocess with time/memory limits.
- `lib/chunk.ts`: deterministic chunking with versioned config; capture page number/section metadata; token counts.
- `lib/embeddings.ts`: batched calls, resumable progress, usage_events per batch.
- `jobs/index-document.ts`: write inactive chunks (idempotent on `(version_id, chunk_index)`), then `activate_document_version`. On failure previous version stays active (W-15).

**Tests (TECH_SPECS §9 Queue):** duplicate delivery, lease expiry, kill -9 mid-job then restart, retry exhaustion, incomplete embeddings never activate, atomic replacement, delete → immediately unretrievable, spoofed file types rejected. Also: a failed replacement keeps the old version active; progress and failure codes are readable per document; a job over the daily cap fails safely without calling the provider; an older version finishing late is marked `failed`.

### P7 — Retrieval & chat (`POST /v1/chat`)
Pipeline per ARCHITECTURE §3:
1. Verify visitor token, bot scope, payload schema/limits, conversation ownership.
2. Idempotency + rate limit + budget reservation (P5).
3. `services/moderation.ts`: input moderation; blocked → `blocked` event/state, never reaches generation (W-09).
4. Query embedding with the **same** model as the corpus (no silent switch).
5. `services/retrieval.ts`: `match_document_chunks` with bounded k; per-model calibrated threshold; language handling; token-budgeted context.
6. **Contact routing (W-05, W-16).** `services/handoff.ts` decides whether to route the visitor to contact details:
   - **No knowledge:** no evidence above the calibrated threshold → skip generation. Send a short localised "I don't have that information" message (template from config, not the LLM) plus a `handoff` event with `reason = no_knowledge`.
   - **Out of scope:** a scope check (cheap classifier or prompt rule) → `reason = out_of_scope`.
   - **Human requested:** intent detection for "talk to a person / contact / phone number" → `reason = human_requested`. This answers directly with the contact card and skips retrieval and generation.
   - **Blocked:** input moderation block (step 3) → `reason = blocked`, with the policy message plus contact card.
   - **Unavailable:** providers exhausted after retries and fallback → `error` event followed by `handoff` with `reason = unavailable`.
   - **Repeated misses:** count `no_knowledge` per conversation; at the configured threshold (default 2), set `prominent: true` so the widget pins the card.
   - **Model hedges:** if the model itself says it can't answer despite evidence (detected via a structured "insufficient_evidence" flag in the prompt's output format), also emit `handoff`.
   - **Persist:** `messages.handoff_reason`, plus the question text for the admin "knowledge gaps" view, subject to retention.
7. Prompt: private identity/tone/scope/languages from `bot_profiles`, bounded server-owned history, delimited untrusted evidence.
8. `services/llm.ts`: primary provider with bounded total deadline; retry/fallback only **before** first emitted token for eligible errors; after tokens emitted → terminate as partial (`STREAM_INTERRUPTED`) with retry hint (W-08).
9. Output moderation per client policy (buffer-all or rolling batch).
10. SSE events: `meta` → `delta`* → `sources` → (`handoff`) → `done`, or `error` (+ `handoff`). Citation tokens mapped to retrieved chunk IDs only; invented IDs/URLs dropped (W-07). Phone numbers, emails or URLs in model text that don't match configured contact details or validated sources are de-linked (W-16).
11. `services/conversations.ts`: persist user + assistant messages (status complete/partial/failed), `message_sources` with citation page and section readable by members (B-9: snapshot them or fix the `source_label` format), `usage_events` (incl. failed/fallback attempts), settle reservation, enqueue debounced `analyze-conversation`.
12. Client disconnect → abort upstream provider call; still record usage.
- Optional `GET /v1/conversations/:id` (same-session only, bounded, no system rows) — behind a feature flag.

**Tests:** each `handoff_reason` trigger fires correctly and carries config contact details; unanswerable eval set always yields `handoff` and never an invented answer or invented phone/email; prompt assembly, citation mapping, fallback eligibility matrix, abort handling, browser-supplied context rejected, prompt-injection docs don't change behaviour, cross-session history denied.

### P7.5 — Caching & latency
Remaining pre-P11 repairs are split into bounded tasks in
`docs/reports/PRE-P11-TASKS.md`. Save continuity at every task end and obey the
owner's5%-remaining usage stop; this task breakdown does not change phase gates.

Goal: cut time-to-first-token and total response time without weakening any invariant in `handover.md §4`. Every cache is **bot-scoped, version-keyed, backend-only, and bypassable** by a kill switch in `client_settings.cache_policy`.

**Where the time goes on a cache miss (expected order of cost):** chat-provider generation ≫ input/output moderation ≈ query embedding > vector search > config/profile reads > session/limit checks. Caches below target each step, biggest win first.

#### Cache layers

| # | Layer | What is cached | Key | Storage | TTL / invalidation | Expected win |
|---|---|---|---|---|---|---|
| C1 | Provider prompt caching | Stable prompt prefix: system instructions + bot identity/tone/scope (+ tool-free policy text) | Handled by provider; we guarantee a byte-identical prefix per `(bot_id, settings_version, prompt_template_version)` | Provider-side (e.g. Anthropic `cache_control`, OpenAI automatic prefix caching) | Provider TTL; prefix changes when settings/template version changes | Lower TTFT and input-token cost on every request |
| C2 | Bot config cache | `bot_profiles`, `client_settings`, `public_bot_config` rows | `bot_id` + `settings_version` | In-process LRU in API and worker | 30–60 s TTL **and** immediate bust when `settings_version` changes (checked cheaply or pushed via Postgres `LISTEN/NOTIFY`) | Removes 2–3 DB round-trips per request |
| C3 | Public config at the edge | `public_bot_config` JSON for the widget | `bot_slug` + `ETag` | Widget `localStorage` (stale-while-revalidate) + HTTP `Cache-Control: max-age=60, stale-while-revalidate=600` | ETag change on settings update | Instant first paint of launcher/greeting |
| C4 | Query embedding cache | Embedding vector of the normalised query | `sha256(embedding_model ‖ embedding_dimensions ‖ normalised_query)` | L1 in-process LRU; L2 Postgres `query_embedding_cache` | 7–30 days; key changes automatically when the model changes. Raw query text **not** stored, only its hash | Skips one external API call for repeated questions |
| C5 | Retrieval result cache | Ordered chunk IDs + scores (not chunk text) | `bot_id ‖ corpus_version ‖ query_embedding_hash ‖ k ‖ threshold ‖ language` | L1 in-process LRU; optional L2 Postgres | Short TTL (≤10 min); **`corpus_version` bump on any activation/delete invalidates instantly** | Skips vector search; chunk text re-read by ID so deleted chunks can't leak |
| C6 | Moderation verdict cache | Allow/block verdict for input text | `sha256(moderation_model ‖ policy_version ‖ normalised_text)` | L1 + L2 Postgres | 24 h; key changes with policy version | Skips input-moderation call for repeated questions |
| C7 | Answer cache (opt-in per client) | Final moderated answer text + validated source IDs (+ `handoff_reason` if it was a no-knowledge reply; contact details are **not** cached, they are read from current config at serve time) | `bot_id ‖ corpus_version ‖ settings_version ‖ prompt_template_version ‖ chat_model ‖ language ‖ sha256(normalised_question)` | Postgres `answer_cache` | TTL from `client_settings` (default 24 h); invalidated by any version change | Near-instant full answers for FAQs (biggest win) |
| C8 | Cache warming | Pre-populate C4–C7 for `suggested_questions` and an FAQ list | — | Worker job `warm-answer-cache` | Runs after each `activate_document_version` and settings change | First visitor also gets the fast path |

#### Answer cache (C7) safety rules
The answer cache is the largest speed-up and the riskiest, so it is **off by default** and only serves when **all** of these hold:
1. **First turn only.** No prior conversation history, so the answer can't depend on earlier context.
2. **Exact normalised match** (lower-case, trimmed, collapsed whitespace, Unicode NFKC) for v1.0. Semantic or near-duplicate matching is deferred; it needs its own evaluation set and threshold calibration before it can be enabled.
3. The cached answer was **completed** (not partial or failed), **passed output moderation**, and had **validated citations** or was a deliberate scoped refusal.
4. Current `corpus_version`, `settings_version`, `prompt_template_version` and chat model all match the key.
5. Every cited `document_version_id` is **still active and not deleted**. Re-checked on read; any failure is treated as a miss and the entry is purged.
6. **Input moderation, session auth, rate limits and idempotency still run** on cache hits. Only retrieval, generation and output moderation are skipped.
7. Questions that look like they contain personal data (email/phone/ID patterns) are **never written** to the cache.
8. Cache hits still create normal `messages`, `message_sources` and a `usage_events` row with `operation = 'answer_cache_hit'`, cost 0. No budget reservation is needed beyond a minimal hold.
9. Cached answers are replayed through the same SSE contract (`meta` → `delta` chunks → `sources` → `done`) so the widget needs no special path. They are sent in a few large `delta` events rather than token by token.

#### Contact-routing schema additions (into P3 `001_core.sql`)
- `public_bot_config`: `escalation_label`, `escalation_messages jsonb` (per language), `contact_email`, `contact_phone`, `contact_whatsapp_url`, `contact_page_url` (replaces/aliases `escalation_url`), `business_hours jsonb`, `timezone`. CHECK constraints for format where SQL can enforce it; full validation in backend.
- `client_settings.handoff_policy jsonb`: repeated-miss threshold, enabled triggers.
- `messages.handoff_reason text` CHECK in (`no_knowledge`, `out_of_scope`, `human_requested`, `blocked`, `unavailable`, `repeated_no_knowledge`).
- Index on `(handoff_reason, created_at)` via conversations for the knowledge-gaps view.

#### Cache schema additions (into P3 migrations)
- `bot_profiles.settings_version int` and `bot_profiles.corpus_version bigint`. `activate_document_version` and `mark_document_deleted` increment `corpus_version` in the same transaction; the settings update increments `settings_version`.
- `query_embedding_cache (key_hash pk, embedding_model, embedding vector(DIM), created_at, last_hit_at, expires_at)`
- `moderation_cache (key_hash pk, policy_version, verdict, created_at, expires_at)`
- `answer_cache (id, bot_id, cache_key_hash unique, language, answer_text, source_refs jsonb, corpus_version, settings_version, prompt_template_version, chat_model, hit_count, created_at, last_hit_at, expires_at)`
- All cache tables: RLS enabled, **no anon/authenticated grants**, API/worker only. Admins see only aggregate hit-rate via the safe status RPC.
- Cleanup job (P9) deletes expired rows. Conversation/retention deletion does not need to touch caches because no visitor or session identifiers are stored in them.

#### Related latency work (not caching, same phase)
- HTTP keep-alive / connection pooling to Supabase and providers (undici `Agent`); reuse one client per process.
- Run the query embedding and input moderation **in parallel**, not one after the other.
- Send the SSE `meta` event and flush headers immediately so the widget leaves `connecting` fast.
- Keep the API and worker in the same region as Supabase (ARCHITECTURE §8). Warm instances (paid Render, no sleeping).
- Rolling-batch output moderation (if chosen in D3) lets tokens stream instead of waiting for the full answer.

#### Tests
- **Isolation:** bot A can never get bot B's cache entry (keys and queries always include `bot_id`).
- **Invalidation:** activate a new version → stale retrieval/answer caches miss; delete a document → no cached answer citing it is served; settings change → C1/C2/C7 refresh.
- **Safety:** cache hit still blocked by input moderation and rate limits; follow-up turns never hit C7; partial/failed answers never cached; PII-pattern questions not stored.
- **Kill switch:** flag off → every layer bypassed, behaviour identical to P7.
- **Measurement (P11):** p50/p95 TTFT and total latency recorded for cold miss, warm miss (C1–C6 hits) and answer-cache hit.

**Acceptance:** all tests green; measured p95 TTFT improves on the P7 baseline for warm-miss traffic; hit rates visible in metrics.

### P8 — Widget (`widget/`)
- `widget.ts`: read `data-*` attributes from `document.currentScript`; singleton guard (`window.__ragbotWidget`/`customElements.get`) so duplicate script tags reuse one instance.
- `public-config.ts`: fetch `public_bot_config` via Supabase REST with publishable key; validate with shared schema; fall back to bundled branding for first paint (`clients/<client>/theme.css`).
- `session.ts`: create/refresh visitor session; token in `sessionStorage` (ADR 0009); reset clears local state.
- `api.ts`: `fetch` + SSE parser over `ReadableStream`; `AbortController` for Stop; idempotency key per send; reconcile on reconnect, never auto-resend after partial output.
- `ui.ts`: component tree from UI_SCHEMA §3 in Shadow DOM; state machine `booting → closed ↔ ready → connecting → streaming → ready` plus `limited`, `blocked`, `unavailable`.
- `ContactCard` component (UI_SCHEMA addition): renders on `handoff` events and in `blocked` / `unavailable` states. It shows the escalation message, `mailto:` / `tel:` / `https:` links built only from validated config, and business hours with an "open now / closed" hint from the time zone. Keyboard and screen-reader accessible; pinned above the composer when `prominent`. It stays usable offline from cached or bundled config when the API is down.
- Footer escalation link always present (existing UI_SCHEMA item), using the same config.
- `render.ts`: `textContent` only by default; optional Markdown via maintained sanitiser with raw HTML, remote images, iframes and `javascript:` URLs disabled; source list from validated `sources` event only.
- Accessibility: `role=log`, batched live-region announcements, focus trap/restore, Escape to close, labelled buttons, visible focus, `prefers-reduced-motion`, RTL support if languages require.
- Mobile: viewport-constrained panel, composer stays visible with on-screen keyboard (`visualViewport`).
- `scripts/build.mjs`: esbuild → single IIFE `dist/v1.0.0/widget.js` (CSS inlined into the shadow root), source maps not published publicly; `vercel.json` sets JS content type and `Cache-Control: public, max-age=31536000, immutable` for versioned paths.
- `public/index.html`: demo host page only.

**Tests:** contact card for each handoff reason, `tel:`/`mailto:` links correct, malicious config values (`javascript:` URL, HTML in message) rejected, card shown when API unreachable; Playwright E2E on representative host pages (aggressive global CSS, CSP-strict page, SPA), mobile viewport, keyboard-only, axe a11y scan, XSS payloads in answers/config/sources, streaming cancel, partial response display.

### P9 — Analysis, entries, retention
Local repairs018/019 add generation-bound spend accounting and revision-based
successor scheduling; both remain local until explicit hosted approval. See
`DATABASE_SCHEMA.md` and P9-D3/P9-D4 evidence. Final integrated acceptance is open.
- `jobs/analyze-conversation.ts`: debounced by dedupe key per conversation; summary, sentiment, intent → `conversation_analysis` with `analysis_version`; never on the answer path (W-10).
- `POST /v1/entries`: only approved `schema_key`s; schema validation; consent timestamp required; minimal personal data (W-13).
- Knowledge-gaps RPC for admins: already in migration 003. Check it returns real data here, once messages exist: aggregated unanswered questions by `handoff_reason` and frequency, so clients can add missing documents.
- Settings updates and conversation deletion moved to P3.5 (ADR 0017). The whitelist covers the contact block, escalation messages and business hours; the repeated-miss threshold stays operator-managed in `client_settings.handoff_policy` (§1a). Embedding changes require an explicit reindex workflow.
- B-10: publish field labels and sensitivity per `schema_key`, readable by owner/admin.
- `jobs/cleanup.ts`: delete storage originals + chunks for deleted documents, abandoned staging uploads, expired sessions/rate buckets, stale reservations, records past retention.

**Tests:** analysis does not delay first `delta`; invalid entry payloads rejected; deleted data audit shows nothing retained beyond policy.

### P10 — Observability & ops
- From P4 and P5: measure `X-Forwarded-For` on a real Render deploy and set `TRUSTED_PROXY_HOPS` from it before launch; a wrong value puts every visitor in one rate-limit bucket.
- Metrics: request latency (first-event and total, split by cache path), cache hit rate per layer (C1–C7), queue age, job failures, rate/budget denials, fallback frequency, indexing failures, provider usage/cost.
- Alerts: provider auth/billing errors, queue age threshold, dead-letter jobs, budget ≥80%, readiness failures.
- `render.yaml`: API web service (health `/health/ready`) and worker, workspace build/start commands, env var keys (no values).
- `scripts/deploy-client.mjs`: reads `clients/<client>/deployment.example.json` (public IDs only), sets up widget build per client.
- `scripts/smoke-test.mjs`: health → session → chat (known answer) → sources present → done.
- Runbooks in `docs/runbooks/`: provider outage, key rotation, rollback (widget version + API), restore rehearsal, incident response.

### P11 — Evaluation, security, load
- From P5: load-test chat starts for contention on the `bot_profiles` row (`FOR SHARE` in `begin_request_run` and `reserve_request_budget`) and for 55P03 under load.
- Evaluation sets (`tests/evaluation/`): known answers, unanswerable questions, multilingual & cross-language, injection attempts — run against primary **and** fallback providers; calibrate similarity thresholds.
- Security checklist (TECH_SPECS §9 Security) executed and recorded.
- Load test to measure p95 first meaningful event (target ≤5s) and full answer (target ≤20s); record actual numbers, size compute from them.
- Backup/restore rehearsal incl. Storage objects.

### P12 — First client deployment
Follow README "Deployment order per client" steps 1–10 exactly. Apply the client Auth settings from P3.5, and create the first admin with an invite link. Record schema/API/widget versions, deliver embed snippet and dashboard login, enable alerts.

This is one joint rollout with admin AP7, because step 9 uploads knowledge through the panel:
1. README steps 1–7 here: backend, API, worker and widget.
2. README step 8 is admin AP7-T3 to T5: deploy the panel, configure Auth, provision the first admin.
3. README step 9 uses the deployed panel, and admin AP7-T6 runs its production smoke test.
4. README step 10 and admin AP7-T7 close the rollout together.

---

## 3. Requirement traceability

| Req | Phase(s) | Key test |
|---|---|---|
| W-01 One-script install | P8 | E2E on test host sites |
| W-02 Encapsulated UI | P8 | Hostile-CSS host page |
| W-03 Streaming | P7, P8 | Ordered events, abort, interruption |
| W-04 Grounded retrieval | P3, P7 | Only active/eligible versions returned |
| W-05 Missing knowledge | P7, P11 | Unanswerable eval set |
| W-06 Identity | P7 | Prompt assembly tests, eval |
| W-07 Citations | P7, P8 | Invented source IDs dropped |
| W-08 Fallback | P7, P11 | Fallback eligibility + eval on fallback |
| W-09 Moderation | P7 | Blocked input never reaches LLM |
| W-10 Analysis | P9 | First-delta latency unaffected |
| W-11 Logs integrity | P3, P7 | RLS: browser can't insert messages |
| W-12 Limits | P5 | Race/limit tests |
| W-13 Data entries | P9 | Schema rejection tests |
| W-14 Safe presentation | P8 | XSS suite |
| W-16 Contact routing | P2, P3, P3.5, P7, P8, P9 | Handoff trigger tests, unanswerable eval set, contact card E2E |
| W-15 Indexing | P3.5, P6 | Queue suite; role tests for the admin RPCs |

---

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Embedding dimension chosen late → migration rework | P0 hard gate before P3 `002_vectors.sql` |
| Streaming vs strict moderation conflict | Per-client policy decided in P0; documented residual risk |
| Budget race / cost blow-up on public endpoint | Atomic DB reservations + provider-side caps + alerts |
| Prompt injection via documents | Delimited evidence, no tools in v1, eval set with injections, only approved public docs indexed |
| Admin panel drift from schema | Single migration history here; publish schema version; contract tests in admin repo |
| Free-tier cold starts in demos mistaken for production | README production baseline: paid Render services |
| Scanned PDFs silently empty | `OCR_REQUIRED` rejection unless OCR configured |
| Documentation inconsistencies (see `handover.md §6`) | Resolve in P0 before contracts are frozen in P2 |
| Stale or deleted knowledge served from cache | Version-keyed caches (`corpus_version`, `settings_version`), citation re-check on read, answer cache opt-in |
| Cache leaks data across bots or visitors | `bot_id` in every key; first-turn-only answer cache; no session IDs or raw queries stored; PII-pattern filter |
| Bot invents contact details or dead-ends the visitor | Contact info only from config via `handoff` event; model contact text de-linked; unanswerable eval set |
| Slow first response | P7.5 caching layers, parallel embed + moderate, warm paid instances, provider prompt caching |

---

## 5. Definition of done (v1.0.0)
- At least one validated contact channel configured per client (go-live gate).
- Every admin panel request in §1a is delivered or formally waived by the owner.
- All W-01…W-16 acceptance conditions demonstrated with linked tests.
- Full TECH_SPECS §9 matrix executed; results recorded in `docs/release/1.0.0.md`.
- Latency measured and recorded (not just targeted), for cold, warm-miss and cache-hit paths.
- Cache invalidation and isolation tests green; answer cache defaults to off unless the client opted in.
- Rollback rehearsed; backup restore rehearsed incl. Storage.
- No secrets in repo, bundles, logs, or prompts (secret scan in CI).
- `status.md` shows all phases complete; `handover.md` updated with as-built deviations.
