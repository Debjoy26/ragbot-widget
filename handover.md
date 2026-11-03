# Handover — ragbot_widget

> For the engineer (or agent) picking up this project. Read this first, then `status.md` for current progress and `plan.md` for the build order.
> Last updated: 2026-11-04.

---

## 1. What this project is
An embeddable, client-branded, retrieval-augmented (RAG) chatbot that a client installs on their website with **one `<script>` tag**. It answers only from approved PDF/MD/TXT knowledge, cites sources, streams responses, and logs conversations for client admins.

This repo also owns the **shared backend** — Render API, Render worker, and the Supabase schema — used by both this widget and the separate `ragbot_adminpanel` repo. The admin panel is a second frontend, **not** a second backend.

## 2. Current state (honest summary)
- **Committed on `origin/main`:** planning docs, P0 decision records (ADRs 0001–0013, `5e416b6`) and the P1 monorepo scaffold (`f848fb3`). CI run 41698369772 for `f848fb3` completed with success. P1 meets its acceptance conditions and awaits owner acceptance (not ✅).
- **Uncommitted:** ADR 0014 (provider config), P2 shared contracts and P3 database migrations. P2 and P3 are implemented and verified locally (Opus integration; local Supabase: `db reset`, `db lint`, `supabase test db` exit 0). Security review P3-R1 has findings open (§5 u–y). Nothing is accepted yet. Logs: `docs/evidence/P1/`, `docs/evidence/P2-P3/`.
- **No API routes, widget behaviour or provider adapters yet.** P2 contracts and P3 migrations exist locally (uncommitted). Shared contracts are in `shared/src`; migrations in `supabase/migrations`. The scaffold has workspaces `shared`/`api`/`worker`/`widget` with placeholder entry files, plus `supabase/config.toml` from `supabase init`. Node 24.22.2 is pinned and `nvm use` is required (§5 l).
- **Provider config (ADR 0014):** each AI role is chosen from env vars (`<ROLE>_PROVIDER`, `<ROLE>_MODEL`, …) through a fail-closed loader and capability matrix in `shared/src/providers.ts`. Default is Gemini: `gemini-2.5-flash-lite` for chat, moderation classifier and analysis; `gemini-embedding-001` at 1536 dims for embeddings. Gemini is the only provider in use for now. **No provider adapters yet** (P6/P7). Real Gemini calls were made 2026-11-04 (model list, and two `hello` embeddings returning 1536 dims). No client data.
- Documents in the repo root:

| File | What it is authoritative for |
|---|---|
| `PRD.md` | Scope, non-goals, requirements W-01…W-15, release gates, open decisions |
| `ARCHITECTURE.md` | Topology, chat/worker sequences, fallback, trust boundaries, moderation strategy |
| `DATABASE_SCHEMA.md` | Tables, RPCs, grants/RLS matrix, storage, retention — **the shared data contract** |
| `TECH_SPECS.md` | Stack, API routes, chat event contract, errors, file/job rules, test matrix |
| `UI_SCHEMA.md` | Embed contract, component tree, widget states, rendering/a11y rules |
| `README.md` | Target repo layout, required npm scripts, env vars, per-client deployment order |
| `plan.md` | Phased implementation plan (P0–P12) derived from the above |
| `status.md` | Live progress tracker |

## 3. Deployment model (per client)
```
Client website ──<script>──> Vercel (widget.js, immutable versioned)
                                   │
                                   ▼
                       Render API (Fastify, SSE) ──> external chat / embedding / moderation APIs
                                   │
                                   ├─> Supabase Postgres + pgvector (search RPC runs in DB)
                                   └─> jobs table ──> Render worker ──> private Storage + AI APIs

Vercel admin panel ──> Supabase Auth + RLS reads + signed uploads
                   └─> Render API for privileged lifecycle ops
```
Per client: **1 Supabase project, 1 Render web service, 1 Render worker, 2 Vercel projects** (widget + admin). One shared codebase, deployed separately per client. No Supabase Edge Functions.

## 4. Non-negotiable invariants
Break any of these and you've introduced a security or correctness bug:

1. **Browser is untrusted.** Never accept browser-supplied retrieved context, history, system prompt, roles, usage numbers, provider keys, or assistant messages.
2. **Publishable key + bot ID are public config, not auth.** Visitors authenticate with short-lived, server-signed tokens bound to `{bot, session, expiry}`.
3. **Service-role credentials bypass RLS.** Every privileged API route must do its own ownership + role checks.
4. **Admin auth = JWT signature + issuer + audience + expiry + active membership + MFA (for privileged ops).** "Authenticated" ≠ admin.
5. **anon can read only `public_bot_config`.** Nothing else.
6. **Rate limits and budgets are atomic in Postgres**, never process-local.
7. **Idempotency key cannot spend twice.** Completed duplicates return stored status; never regenerate.
8. **No provider switch after the first token is emitted.** Terminate as partial (`STREAM_INTERRUPTED`) and let the user retry.
9. **No silent embedding-model switch.** Query encoder must match the corpus; changing models = explicit reindex.
10. **Document replacement is atomic.** A failed reindex leaves the old version active.
11. **Citations only from retrieved chunk IDs.** Drop anything the model invents.
12. **Widget renders plain text via `textContent`** unless sanitised Markdown is explicitly enabled (no raw HTML, remote images, iframes, `javascript:` URLs).
13. **Fail closed** on missing limits/config.
14. **Secrets live only in Render env.** Never in bundles, git, prompts, or logs.
15. **Caches never outrank invariants.** Every cache key includes `bot_id` and the relevant version (`corpus_version`, `settings_version`, model, prompt template). Answer cache is opt-in, first-turn only, and re-checks that cited documents are still active. Input moderation, auth and rate limits run on every request, including cache hits. See `plan.md` P7.5.
16. **Single migration history** in `supabase/migrations` here; admin repo must not add competing migrations.

## 5. Decisions (P0) — approved 2026-11-03
All 14 P0 decisions (D1–D14) were approved by the owner as recommended. The ADRs in `docs/decisions/` are authoritative (0001–0014; D8 and D9 share 0009). ADR 0014 (2026-11-04) revises the provider and model parts of D1–D3 (ADRs 0002–0004); the 1536 dimension is kept. Do not re-decide these without a new ADR. Index and states: `status.md §3`.

Remaining open items (not done):
- **a)** Production daily budget cap per client: not set; fails closed (ADR 0007).
- **b)** Jurisdiction (India/DPDP) is an assumption; owner to confirm per client; provider DPAs outstanding (ADR 0006).
- **c)** Gemini embeddings verified to return 1536 dims only (2026-11-04). Retrieval-quality check on real documents not run (ADR 0002).
- **d)** ~~Supabase CLI install~~ done 2026-11-04: CLI 3.0.0 pinned as devDependency.
- **e)** Non-Anthropic provider details (OpenAI, Voyage, Cloudflare) not verified (ADRs 0002, 0003, 0004, 0010).
- **f)** ~~Spec edits~~ done 2026-11-03: UI_SCHEMA §3/§7, ARCHITECTURE §3 (item 7), TECH_SPECS §2 (item 10).
- **g)** ~~Nothing committed~~ P0 committed as `5e416b6`. P1 files are uncommitted.
- **h)** ~~Docker not installed~~ Resolved 2026-11-04: Docker installed by owner; local stack verified (§2).
- **i)** No secret scanner in CI yet (proposed for P10).
- **j)** GitHub Actions pinned by major tag, not commit SHA.
- **k)** Resolved: ADR 0014.
- **l)** Users must run `nvm use`. The system Node 24.18.0 is rejected by the engine pin.
- **m)** `npm audit`: production 0 vulnerabilities; dev-only 11 moderate (one `minimatch` advisory via ESLint).
- **n)** Gemini free tier may use submitted content to improve Google products. Client or visitor data only through a paid-tier Gemini project. Owner to confirm billing is enabled before any client data (ADR 0014, ADR 0006).
- **o)** No independent chat fallback configured. A Gemini-only setup shares one quota. Real failover needs a second provider key.
- **p)** LLM-classifier moderation is weaker than a dedicated moderation endpoint. Residual risk, covered by the P11 evaluation (ADR 0014).
- **q)** Runtime guard refusing an embedding model that differs from the stored corpus model is not implemented (P3/P7).
- **r)** Provider adapters (actual API calls, streaming, retries) not implemented (P6/P7).
- **s)** ~~Migration naming~~ withdrawn 2026-11-04: CLI accepts `001_…` names (verified with a probe migration, since removed); only `.gitkeep` is skipped (harmless warning).
- **t)** P2 contract notes: invented request/response shapes for admin, session and entry routes and job payloads need confirmation. Model evidence flag is the first line `EVIDENCE: SUFFICIENT/INSUFFICIENT`; P7 must hold that line back. Settings PATCH cross-field validation must re-run on the merged config (P9).
- **u)** M1 (confirmed by Opus): no MFA (aal2) check on DB read paths. Authenticated members can read transcripts, `data_entries` and audit via PostgREST without MFA, bypassing the API MFA check. Decision D-a.
- **v)** M2 (confirmed): no DB guard against an embedding-model switch; match and activate do not compare `embedding_model`.
- **w)** M3 (confirmed): `data_entries` are never purged, only detached on conversation purge (DPDP exposure). Decision D-b.
- **x)** L1 (confirmed): `audit_logs` is not append-only for service_role.
- **y)** M4 and M5 (reviewer-reported, not yet confirmed by Opus): M4 knowledge_gaps question attribution can pick the wrong message on timestamp ties and returns untruncated visitor text. M5 no atomic `begin_request_run`; idempotency and concurrency cap rely only on a unique constraint.
- **z)** Lower items L2–L14 (reviewer-reported, unconfirmed): settle without cap lock; no job complete or heartbeat RPCs; global PUBLIC EXECUTE default; `public_bot_config` readable for disabled bots; dead service_role grants on member RPCs; answer_cache stale rows; analyst can see `storage_path`; immediate session hard-delete; fixed-window burst; HNSW plan untested at scale; seed enabled in `config.toml`; bucket has no `allowed_mime_types`; cross-bot citation links unenforced in DB. Which lows go into a debug cycle is D-c.
- **aa)** Test gaps: no real concurrency tests (sequential only); no column-level grant census. Integration (vitest) and E2E still have no tests.
- **ab)** Owner decisions needed: **D-a** MFA (enforce aal2 in DB policies and RPCs, or admin reads only via API with direct grants revoked). **D-b** `data_entries` retention period, or cascade with the conversation. **D-c** approve debug cycle P3-D1 for M1–M5 and L1, and which lows.

## 6. Inconsistencies / gaps found in the docs
Resolve these in P0 before freezing shared contracts. **Resolved 2026-11-03:** items 1, 2 (embed attribute is now `data-bot-slug`), 3, 5, 6, 8, 9. **Decided 2026-11-03:** item 4 (ADR 0011; UI_SCHEMA §3 updated). **Resolved 2026-11-03 (P0 close):** 7, 10. **Still open:** none.

1. **`escalation_label` missing from DB.** `UI_SCHEMA §5` public config has `escalation_label`; `DATABASE_SCHEMA` `public_bot_config` does not. → Add column.
2. **`bot_id` vs `bot_slug` naming.** Embed uses `data-bot-id="website-support"` (a slug value), the chat request uses `bot_slug`, and public config returns a UUID `bot_id`. → Suggest renaming the embed attribute to `data-bot-slug` or documenting that `data-bot-id` carries the slug.
3. **`OCR_REQUIRED` error code** is used in `TECH_SPECS §7` but missing from the stable code list in `§5`. → Add to list.
4. **Feedback buttons without a backend.** `UI_SCHEMA §3` has `FeedbackButtons`; no table or endpoint exists. → **Decided 2026-11-03: defer (ADR 0011).** `UI_SCHEMA §3` updated.
5. **Stop → "upstream cancellation"** (`UI_SCHEMA §4`) has no explicit cancel endpoint. → Implement as server-side abort on client disconnect of the SSE request; document it.
6. **`request_runs.session_id`** vs `visitor_session_id` elsewhere. → Normalise to `visitor_session_id`.
7. **Public config fetch path.** `UI_SCHEMA` reads it via Supabase (publishable key); `ARCHITECTURE §3` step 1 is ambiguous. → Widget reads `public_bot_config` directly from Supabase REST; sessions go through the API.
8. **Route file mapping.** README lists `routes/{chat,sessions,documents,settings,entries,health}.ts` but no file for `conversations` (history + admin delete). → Add `routes/conversations.ts`.
9. **`analysing` UI state** is listed as a state but is background-only; treat it as non-visible metadata, not a state-machine node.
10. **`messages.role = system`** rows exist but must never be returned to visitors — enforce in the history query, not just docs.

## 7. Where to start
1. Read `PRD.md` then `DATABASE_SCHEMA.md` (the contract everyone depends on).
2. P0 decisions D1–D14 are approved (2026-11-03). See `docs/decisions/` ADRs 0001–0013, and §5 above for remaining open items.
3. Fix the doc inconsistencies in §6 directly in the source docs.
4. P1 is committed (`f848fb3`) with CI green; it awaits owner acceptance. P2 and P3 are implemented locally and uncommitted. Next: owner decisions D-a, D-b, D-c (§5 ab), then commit after fixes. P4 only on owner go-ahead.
5. Update `status.md` at the end of every working session.

## 8. Environment & access needed
- Supabase: dev project (or `supabase start` local stack) + per-client production project.
- Render: account for API web service + background worker (paid for production).
- Vercel: projects for widget and admin panel.
- Provider keys: chat (primary + fallback), embeddings, moderation, optional OCR — each with provider-side spending caps.
- Env vars (from `README.md` "Environment variables"):
  - API: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VISITOR_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`, `PORT`, `LOG_LEVEL`, plus AI roles `CHAT_PRIMARY_*`, optional `CHAT_FALLBACK_*`, `EMBEDDING_*` (incl. `EMBEDDING_DIMENSIONS=1536`), `MODERATION_*`.
  - Worker: database/storage credentials plus `EMBEDDING_*` and `ANALYSIS_*`. The worker does **not** get `VISITOR_TOKEN_SECRET`.
- AI role variables follow ADR 0014 (`<ROLE>_PROVIDER`, `<ROLE>_MODEL`, optional `<ROLE>_API_KEY`, `<ROLE>_BASE_URL`). See `README.md` and `api/.env.example` / `worker/.env.example`.

## 9. Related repos
- `ragbot_adminpanel` — dashboard; consumes this repo's schema and admin API. Coordinate any schema/API change with it and bump the schema version.

## 10. Handover log
| Date | From | To | Notes |
|---|---|---|---|
| 2026-11-03 | Planning | Implementation | Docs baseline v1.0 reviewed; plan/status/handover created. No code yet. |
| 2026-11-03 | Planning | Implementation | Added caching (P7.5) and contact routing (W-16); synced all docs. |
| 2026-11-03 | P0 (owner + Opus) | P1 (pending owner go-ahead) | D1–D14 approved as recommended; ADRs 0001–0013 written in `docs/decisions/` (uncommitted). Status/handover updated by `haiku-docs`. Open items in §5 (a–g). No code, tests or Supabase changes. |
| 2026-11-04 | Opus (owner-approved) | P2 (on owner go-ahead) | P0 accepted and committed (`5e416b6`). P1 scaffold implemented locally, uncommitted; 8 local gates exit 0; CI not run; no feature code. Open items §5 (a–m). Docs updated by `haiku-docs`. |
| 2026-11-04 | Owner direction via Opus | P2 (on owner go-ahead) | ADR 0014 accepted: provider-agnostic AI config, Gemini default; revises D1–D3 provider/model parts. Config loader and tests added (21 unit passed; 7 local gates exit 0). Real Gemini calls: model list and two `hello` embeddings. P1 still 🟡 (uncommitted, CI not run). Open items §5 (a–r). Docs updated by `haiku-docs`. |
| 2026-11-04 | Owner (Docker) / Opus | P2 (on owner go-ahead) | Docker installed by owner. Local Supabase stack verified: `supabase start` and `db reset` exit 0; local and remote PostgreSQL 17.11 and pgvector 0.8.2 match. P1 still 🟡 (CI needs commit and push). Docs updated by `haiku-docs`. |
| 2026-11-04 | Owner / Opus (correction) | P2 (on owner go-ahead) | Correction P1-DOC4: §5 s withdrawn (CLI accepts `001_…` names, verified by a probe migration since removed; only `.gitkeep` skipped). Plan/README unchanged. Docs updated by `haiku-docs`. |
| 2026-11-04 | Owner / Opus | P4 (on owner go-ahead) | P1 committed and pushed (`f848fb3`); CI run 41698369772 green; awaiting owner acceptance. P2 and P3 implemented and verified locally, uncommitted. Security review P3-R1: M1–M5 and L1 open (§5 u–y). Owner decisions D-a, D-b, D-c pending (§5 ab). Nothing accepted. Docs updated by `haiku-docs`. |
