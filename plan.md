# Implementation Plan — ragbot_widget

> Source of truth: `PRD.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `TECH_SPECS.md`, `UI_SCHEMA.md`, `README.md`.
> This plan turns that planning baseline (v1.0) into an ordered, testable build. Requirement IDs (W-01…W-15) refer to `PRD.md §5`.
> Created: 2026-11-03. Progress is tracked in `status.md`; context for whoever picks this up is in `handover.md`.

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
| P3 | Database & storage | Migrations 001–005, RPCs, grants/RLS, bucket, seed | P0 (embedding dims), P1 | RLS/grant integration matrix green |
| P4 | API foundation | Fastify server, config validation, logging, health, auth services | P2, P3 | Health + auth integration tests |
| P5 | Visitor sessions & abuse controls | `/v1/sessions`, rate limits, budget reservation, idempotency | P4 | Forged-token, race, and idempotency tests |
| P6 | Ingestion pipeline (worker) | Job queue, extract/chunk/embed, atomic activation, admin document API | P3, P4 | Queue test suite (TECH_SPECS §9 "Queue") |
| P7 | Retrieval & chat | `/v1/chat` SSE: moderation, retrieval, prompt, provider + fallback, citations | P5, P6 | Unit + evaluation set baseline |
| P8 | Widget | Shadow-DOM custom element, states, streaming, a11y, build to `/v1.0.0/widget.js` | P2, P7 (contract) | E2E on host pages, a11y, XSS tests |
| P9 | Async analysis, entries, settings, retention | Summaries/sentiment/intent jobs, `/v1/entries`, settings PATCH, cleanup/retention jobs | P6, P7 | Integration tests + retention audit |
| P10 | Observability & ops hardening | Metrics, redaction, alerts, render.yaml, vercel.json, deploy/smoke scripts | P4–P9 | Smoke test against staging |
| P11 | Evaluation, security review, load test | Eval sets, pen-test checklist, latency measurement | P7–P10 | PRD §8 release gates met & recorded |
| P12 | First client deployment | Client-A rollout per README "Deployment order" | P11 | Signed handover to client |

P6 and P8 can run in parallel with P7 once P5 is merged and the chat event contract (P2) is frozen.

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
- `contracts.ts`: request/response types for every route in TECH_SPECS §2–3; SSE event union `meta | delta | sources | done | error`.
- `schemas.ts`: Zod schemas — chat request (rejects unknown fields such as `context`, `system`, `history`), public bot config (colour hex + https URL validation, no HTML), visitor token claims, job payloads per job type, data-entry form schemas keyed by `schema_key`, settings whitelist.
- Error code enum: `INVALID_REQUEST, SESSION_EXPIRED, UNAUTHORIZED, FORBIDDEN, RATE_LIMITED, BUDGET_EXCEEDED, FILE_UNSUPPORTED, OCR_REQUIRED, INDEXING_FAILED, PROVIDER_UNAVAILABLE, STREAM_INTERRUPTED` (note `OCR_REQUIRED` appears in TECH_SPECS §7 but not §5 — add it).
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
| `seed.sql` | Dev-only bot profile, public config, client_settings with conservative limits. **No** real admin users. |

Also: operator script for first admin membership (trusted tooling, not seed).

**Tests (integration, against local stack):** run the full grants/RLS matrix as anon, authenticated nonmember, analyst, admin, owner, service role. Vector dimension mismatch rejected. Membership revocation takes effect immediately. RPCs not callable by anon/authenticated where not granted.

**Acceptance:** every cell of the DATABASE_SCHEMA matrix has a passing test.

### P4 — API foundation (`api/`)
- `lib/config.ts`: Zod-validated env; refuse to start on missing/invalid values (limits, model names, deadlines, max attempts, allowed origins).
- `lib/logger.ts`: pino-style structured logging with request IDs and a redaction list (auth headers, tokens, keys, message content, document bodies).
- `lib/supabase.ts`: service-role client (server only).
- `server.ts`: Fastify with body-size limits, timeouts, trusted-proxy config, canonical client IP derivation, CORS from `ALLOWED_ORIGINS` (supplementary only), global error handler mapping to stable codes (no stack traces).
- `routes/health.ts`: `/health/live`, `/health/ready` (bounded DB ping, no details).
- `services/auth.ts`:
  - Visitor tokens: HMAC (`VISITOR_TOKEN_SECRET`) signed, claims `{bot_id, session_id, token_version, exp}`; verify against `visitor_sessions` (not revoked, not expired, token_version matches).
  - Admin: verify Supabase JWT (signature via JWKS, issuer, audience, expiry), check active membership + role, check MFA assurance level (`aal2`) for privileged operations.

**Acceptance:** tests for expired/forged/wrong-bot visitor tokens; admin JWT with wrong aud/iss, revoked membership, missing MFA → 401/403.

### P5 — Visitor sessions & abuse controls
- `POST /v1/sessions`: resolve bot by slug, check enabled, record rate-limit attempt (hashed key, no plain IP), optional challenge verification, insert `visitor_sessions`, return token + expiry.
- `services/limits.ts`: wrappers around `record_rate_limit_attempt` (per-session and per-IP-hash windows) and `reserve_request_budget` / settle / release.
- Idempotency: `request_runs` with unique `(bot_id, session_id, idempotency_key)`; request hash comparison → mismatch = `INVALID_REQUEST`; duplicate in progress → 409-style status; completed → return stored final status, never regenerate.
- Concurrency: one active generation per conversation.

**Tests:** parallel budget race (N concurrent reservations never exceed cap), duplicate idempotency key cannot spend twice, payload-mismatch rejection, rate-limit window rollover.

### P6 — Ingestion pipeline (`worker/` + admin document routes)
- Admin routes (`api/routes/documents.ts`): create document + version + scoped signed upload URL; `complete` (verify object exists, size, checksum, sniffed MIME) → enqueue `index-document`; `reindex`; `download` (short-lived signed URL, admin only); `DELETE` → `mark_document_deleted` + enqueue cleanup. Audit log every action.
- `worker.ts`: poll `claim_jobs` with lease, heartbeat to extend lease, bounded concurrency, graceful shutdown (stop claiming, finish/release current), recover expired leases, exponential backoff with jitter, dead-letter after `max_attempts`.
- `lib/extract.ts`: PDF (text layer), MD, TXT; validate actual content; detect empty/scanned PDFs → `OCR_REQUIRED`; encrypted PDFs → `FILE_UNSUPPORTED`; run heavy parsing in a bounded subprocess with time/memory limits.
- `lib/chunk.ts`: deterministic chunking with versioned config; capture page number/section metadata; token counts.
- `lib/embeddings.ts`: batched calls, resumable progress, usage_events per batch.
- `jobs/index-document.ts`: write inactive chunks (idempotent on `(version_id, chunk_index)`), then `activate_document_version`. On failure previous version stays active (W-15).

**Tests (TECH_SPECS §9 Queue):** duplicate delivery, lease expiry, kill -9 mid-job then restart, retry exhaustion, incomplete embeddings never activate, atomic replacement, delete → immediately unretrievable, spoofed file types rejected.

### P7 — Retrieval & chat (`POST /v1/chat`)
Pipeline per ARCHITECTURE §3:
1. Verify visitor token, bot scope, payload schema/limits, conversation ownership.
2. Idempotency + rate limit + budget reservation (P5).
3. `services/moderation.ts`: input moderation; blocked → `blocked` event/state, never reaches generation (W-09).
4. Query embedding with the **same** model as the corpus (no silent switch).
5. `services/retrieval.ts`: `match_document_chunks` with bounded k; per-model calibrated threshold; language handling; token-budgeted context.
6. No evidence above threshold → scoped refusal + escalation (W-05).
7. Prompt: private identity/tone/scope/languages from `bot_profiles`, bounded server-owned history, delimited untrusted evidence.
8. `services/llm.ts`: primary provider with bounded total deadline; retry/fallback only **before** first emitted token for eligible errors; after tokens emitted → terminate as partial (`STREAM_INTERRUPTED`) with retry hint (W-08).
9. Output moderation per client policy (buffer-all or rolling batch).
10. SSE events: `meta` → `delta`* → `sources` → `done`, or `error`. Citation tokens mapped to retrieved chunk IDs only; invented IDs/URLs dropped (W-07).
11. `services/conversations.ts`: persist user + assistant messages (status complete/partial/failed), `message_sources`, `usage_events` (incl. failed/fallback attempts), settle reservation, enqueue debounced `analyze-conversation`.
12. Client disconnect → abort upstream provider call; still record usage.
- Optional `GET /v1/conversations/:id` (same-session only, bounded, no system rows) — behind a feature flag.

**Tests:** prompt assembly, citation mapping, fallback eligibility matrix, abort handling, browser-supplied context rejected, prompt-injection docs don't change behaviour, cross-session history denied.

### P8 — Widget (`widget/`)
- `widget.ts`: read `data-*` attributes from `document.currentScript`; singleton guard (`window.__ragbotWidget`/`customElements.get`) so duplicate script tags reuse one instance.
- `public-config.ts`: fetch `public_bot_config` via Supabase REST with publishable key; validate with shared schema; fall back to bundled branding for first paint (`clients/<client>/theme.css`).
- `session.ts`: create/refresh visitor session; token in memory (sessionStorage only if P0 approves); reset clears local state.
- `api.ts`: `fetch` + SSE parser over `ReadableStream`; `AbortController` for Stop; idempotency key per send; reconcile on reconnect, never auto-resend after partial output.
- `ui.ts`: component tree from UI_SCHEMA §3 in Shadow DOM; state machine `booting → closed ↔ ready → connecting → streaming → ready` plus `limited`, `blocked`, `unavailable`.
- `render.ts`: `textContent` only by default; optional Markdown via maintained sanitiser with raw HTML, remote images, iframes and `javascript:` URLs disabled; source list from validated `sources` event only.
- Accessibility: `role=log`, batched live-region announcements, focus trap/restore, Escape to close, labelled buttons, visible focus, `prefers-reduced-motion`, RTL support if languages require.
- Mobile: viewport-constrained panel, composer stays visible with on-screen keyboard (`visualViewport`).
- `scripts/build.mjs`: esbuild → single IIFE `dist/v1.0.0/widget.js` (CSS inlined into the shadow root), source maps not published publicly; `vercel.json` sets JS content type and `Cache-Control: public, max-age=31536000, immutable` for versioned paths.
- `public/index.html`: demo host page only.

**Tests:** Playwright E2E on representative host pages (aggressive global CSS, CSP-strict page, SPA), mobile viewport, keyboard-only, axe a11y scan, XSS payloads in answers/config/sources, streaming cancel, partial response display.

**Open gap:** `FeedbackButtons` appear in UI_SCHEMA but there is no feedback endpoint or table — either defer (hide component) or add `message_feedback` table + `POST /v1/feedback` (needs PRD update).

### P9 — Analysis, entries, settings, retention
- `jobs/analyze-conversation.ts`: debounced by dedupe key per conversation; summary, sentiment, intent → `conversation_analysis` with `analysis_version`; never on the answer path (W-10).
- `POST /v1/entries`: only approved `schema_key`s; schema validation; consent timestamp required; minimal personal data (W-13).
- `PATCH /v1/admin/bot-settings`: whitelisted fields only, audited, role-checked; embedding changes require explicit reindex workflow.
- `POST /v1/admin/conversations/:id/delete`: retention-aware deletion (messages, sources, analysis, entries).
- `jobs/cleanup.ts`: delete storage originals + chunks for deleted documents, abandoned staging uploads, expired sessions/rate buckets, stale reservations, records past retention.

**Tests:** analysis does not delay first `delta`; invalid entry payloads rejected; non-whitelisted settings rejected; deleted data audit shows nothing retained beyond policy.

### P10 — Observability & ops
- Metrics: request latency (first-event and total), queue age, job failures, rate/budget denials, fallback frequency, indexing failures, provider usage/cost.
- Alerts: provider auth/billing errors, queue age threshold, dead-letter jobs, budget ≥80%, readiness failures.
- `render.yaml`: API web service (health `/health/ready`) and worker, workspace build/start commands, env var keys (no values).
- `scripts/deploy-client.mjs`: reads `clients/<client>/deployment.example.json` (public IDs only), sets up widget build per client.
- `scripts/smoke-test.mjs`: health → session → chat (known answer) → sources present → done.
- Runbooks in `docs/runbooks/`: provider outage, key rotation, rollback (widget version + API), restore rehearsal, incident response.

### P11 — Evaluation, security, load
- Evaluation sets (`tests/evaluation/`): known answers, unanswerable questions, multilingual & cross-language, injection attempts — run against primary **and** fallback providers; calibrate similarity thresholds.
- Security checklist (TECH_SPECS §9 Security) executed and recorded.
- Load test to measure p95 first meaningful event (target ≤5s) and full answer (target ≤20s); record actual numbers, size compute from them.
- Backup/restore rehearsal incl. Storage objects.

### P12 — First client deployment
Follow README "Deployment order per client" steps 1–10 exactly. Record schema/API/widget versions, deliver embed snippet and dashboard login, enable alerts.

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
| W-15 Indexing | P6 | Queue suite |

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

---

## 5. Definition of done (v1.0.0)
- All W-01…W-15 acceptance conditions demonstrated with linked tests.
- Full TECH_SPECS §9 matrix executed; results recorded in `docs/release/1.0.0.md`.
- Latency measured and recorded (not just targeted).
- Rollback rehearsed; backup restore rehearsed incl. Storage.
- No secrets in repo, bundles, logs, or prompts (secret scan in CI).
- `status.md` shows all phases complete; `handover.md` updated with as-built deviations.
