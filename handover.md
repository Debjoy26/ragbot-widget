# Handover — ragbot_widget

> For the engineer (or agent) picking up this project. Read this first, then `status.md` for current progress and `plan.md` for the build order.
> Last updated: 2026-11-06.

---

## 1. What this project is
An embeddable, client-branded, retrieval-augmented (RAG) chatbot that a client installs on their website with **one `<script>` tag**. It answers only from approved PDF/MD/TXT knowledge, cites sources, streams responses, and logs conversations for client admins.

This repo also owns the **shared backend** — Render API, Render worker, and the Supabase schema — used by both this widget and the separate `ragbot_adminpanel` repo. The admin panel is a second frontend, **not** a second backend.

## 2. Current state (honest summary)
- **Committed on `origin/main`:** planning docs, P0 decision records (ADRs 0001–0013, `5e416b6`), the P1 monorepo scaffold (`f848fb3`; ADR 0014 in the same commit), ADRs 0015–0016 (`65cc738`). CI run 41698369772 for `f848fb3` completed with success. P1 accepted by owner 2026-11-05.
- **On `main` (code `6b24002`):** P2 shared contracts and P3 database migrations, with debug cycles P3-D1 (`65cc738`) and P3-D2 (`6b24002`). Final gates pass locally: unit 157 passed; pgTAP 17 files, 1465 passed; `db lint` clean; all npm gates exit 0. P2 and P3 accepted by owner 2026-11-05. Security reviews P3-R3 and P3-R4 (static, 2026-11-05) done. Open review findings: see `status.md §3a` (not repeated here). CI: run 41708210161 (`19438c5`) and run 41974998511 (`0059991`) completed with success (overall results only; `0059991` contains the P3-D3 code; `815cfb9` has no run of its own). Logs: `docs/evidence/P1/`, `docs/evidence/P2-P3/`, `docs/evidence/P3-R3/`, `docs/evidence/P3-R4/`.
- **Remote dev project (2026-11-05, owner-approved):** migrations 001–005 applied to `rbejeqwxyxtklehuzibv` via `supabase db push --remote`; `seed.sql` not applied. Remote: 22 tables, RLS on all, 0 rows. Migrations 001–005 must not be edited; schema changes go in new migrations. Details: `status.md §2`, `docs/evidence/P3-R3/SUMMARY.md`.
- **Committed locally (2026-11-05, P3-D3, `815cfb9` on `main`):** migration `supabase/migrations/006_reaper_settle_reply_lock.sql` (fixes R3-1, R3-2) and pgTAP 180. Applied to the remote dev project 2026-11-05 (owner-approved; only 006 applied; remote history 001–006). Remote: public function definitions match local by md5; execute grants on the two changed functions match local; advisors unchanged after 006 (5 WARN and 13 INFO security; 34 INFO unused indexes; 1 INFO unindexed FK). pgTAP and the race script ran on the local stack only, not against the remote. Also a `Makefile` and `database/` (symlinks into `supabase/`; the single migration history stays in `supabase/migrations`), committed in `815cfb9`. Evidence: `docs/evidence/P3-D3/SUMMARY.md`.
- **Security review P3-R4 (2026-11-05, static, read-only; `security-reviewer` configured `claude-sonnet-5-5`; Opus verified key claims):** reviewed P3-D3 (`815cfb9`, base `main` @ `0059991`). No fixes made; not an approval. Findings au–ba in `status.md §3a`. Evidence: `docs/evidence/P3-R4/SUMMARY.md`.
- **Debug cycle P3-D4 and security review P3-R5 (2026-11-05 to 2026-11-06; static review; Opus integrated and verified):** completes the P3-R4 findings and open R3 notes; outcomes in `status.md §3a` au–bh. **Migration 007 is local only, not applied to the remote dev project** (owner approval needed; §5 bb). P3-D4 committed as `e2a044e` on `main`; CI run 42086386622 success, all steps. Evidence: `docs/evidence/P3-D4/SUMMARY.md`.
- **P0–P3 audit and live database check (2026-11-06; audits static, read-only and self-reported; live check read-only by Opus):** the remote differs from the repo only by migration 007 (not applied at that check). Docs baseline: ADRs 0001–0017, including ADR 0017 (admin panel direct to Supabase). Evidence: `docs/evidence/P3-AUD/SUMMARY.md`.
- **P3-D5 and P3.5 built, tested and debugged (2026-11-06; P3.5 accepted by owner):** migrations 008–010 added (007 from P3-D4); migrations 007–010 were later applied to the remote dev project (see below). Admin RPC table in `DATABASE_SCHEMA.md` ("Admin RPCs"). P3.5 not accepted by owner. Final gates and evidence: `docs/evidence/P3-D5/SUMMARY.md`. Backlog outcome and status: `status.md §3b`.
- **No chat routes, widget behaviour or provider adapters yet.** The P4 API foundation exists on `main` with health routes only (not on `main`; see the P4 bullet below). P2 contracts and P3 migrations are on `main`. Shared contracts are in `shared/src`; migrations in `supabase/migrations`. The scaffold has workspaces `shared`/`api`/`worker`/`widget` with placeholder entry files, plus `supabase/config.toml` from `supabase init`. Node 24.22.2 is pinned and `nvm use` is required (§5 l).
- **P4 API foundation (2026-11-06):** built, tested and debugged; merged to `main` with owner approval. Evidence: `docs/evidence/P4/SUMMARY.md`.
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

- **Remote dev project (2026-11-06, owner-approved):** migrations 007–010 applied; history 001–010; schema matches local by md5; advisors as expected. No seed. Public signup still on and TOTP unknown: both need the Supabase dashboard. Evidence: `docs/evidence/P3-D5-remote/SUMMARY.md`.

## 3. Deployment model (per client)
```
Client website ──<script>──> Vercel (widget.js, immutable versioned)
                                   │
                                   ▼
                       Render API (Fastify, SSE) ──> external chat / embedding / moderation APIs
                                   │
                                   ├─> Supabase Postgres + pgvector (search RPC runs in DB)
                                   └─> jobs table ──> Render worker ──> private Storage + AI APIs

Vercel admin panel ──> Supabase Auth + RLS reads + admin RPCs + Storage
                   └─> no connection to Render: jobs queued in Postgres reach the worker
```
Per client: **1 Supabase project, 1 Render web service, 1 Render worker, 2 Vercel projects** (widget + admin). One shared codebase, deployed separately per client. No Supabase Edge Functions.

## 4. Non-negotiable invariants
Break any of these and you've introduced a security or correctness bug:

1. **Browser is untrusted.** Never accept browser-supplied retrieved context, history, system prompt, roles, usage numbers, provider keys, or assistant messages.
2. **Publishable key + bot ID are public config, not auth.** Visitors authenticate with short-lived, server-signed tokens bound to `{bot, session, expiry}`.
3. **Service-role credentials bypass RLS.** Every privileged API route must do its own ownership + role checks.
4. **Admin access = Supabase session + active membership + `aal2`, enforced in Postgres and Storage policies (ADR 0015, ADR 0017).** "Authenticated" ≠ admin.
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
All 14 P0 decisions (D1–D14) were approved by the owner as recommended. The ADRs in `docs/decisions/` are authoritative (0001–0017; D8 and D9 share 0009). ADR 0014 (2026-11-04) revises the provider and model parts of D1–D3 (ADRs 0002–0004); the 1536 dimension is kept. Do not re-decide these without a new ADR. Index and states: `status.md §3`.

Remaining open items (not done):
- **a)** Production daily budget cap per client: not set; fails closed (ADR 0007).
- **b)** Jurisdiction (India/DPDP) is an assumption; owner to confirm per client; provider DPAs outstanding (ADR 0006).
- **c)** Gemini embeddings verified to return 1536 dims only (2026-11-04). Retrieval-quality check on real documents not run (ADR 0002).
- **d)** ~~Supabase CLI install~~ done 2026-11-04: CLI 3.0.0 pinned as devDependency.
- **e)** Non-Anthropic provider details (OpenAI, Voyage, Cloudflare) not verified (ADRs 0002, 0003, 0004, 0010).
- **f)** ~~Spec edits~~ done 2026-11-03: UI_SCHEMA §3/§7, ARCHITECTURE §3 (item 7), TECH_SPECS §2 (item 10).
- **g)** ~~Nothing committed~~ P0 committed as `5e416b6`. P1 committed as `f848fb3`.
- **h)** ~~Docker not installed~~ Resolved 2026-11-04: Docker installed by owner; local stack verified (§2).
- **i)** ~~No secret scanner in CI yet (proposed for P10).~~ Resolved in P3-D5: `scripts/secret-scan.sh` (heuristic, S-10 in `status.md §3a` bl); no hits on the integrated tree.
- **j)** GitHub Actions pinned by major tag, not commit SHA.
- **k)** Resolved: ADR 0014.
- **l)** Users must run `nvm use`. The system Node 24.18.0 is rejected by the engine pin.
- **m)** `npm audit`: production 0 vulnerabilities; dev-only 11 moderate (one `minimatch` advisory via ESLint).
- **n)** Gemini free tier may use submitted content to improve Google products. Client or visitor data only through a paid-tier Gemini project. Owner to confirm billing is enabled before any client data (ADR 0014, ADR 0006).
- **o)** No independent chat fallback configured. A Gemini-only setup shares one quota. Real failover needs a second provider key.
- **p)** LLM-classifier moderation is weaker than a dedicated moderation endpoint. Residual risk, covered by the P11 evaluation (ADR 0014).
- **q)** ~~Runtime guard refusing an embedding model that differs from the stored corpus model is not implemented (P3/P7).~~ Superseded by `v`.
- **r)** Provider adapters (actual API calls, streaming, retries) not implemented (P6/P7).
- **s)** ~~Migration naming~~ withdrawn 2026-11-04: CLI accepts `001_…` names (verified with a probe migration, since removed); only `.gitkeep` is skipped (harmless warning).
- **t)** P2 contract notes: invented request/response shapes for admin, session and entry routes and job payloads need confirmation. Model evidence flag is the first line `EVIDENCE: SUFFICIENT/INSUFFICIENT`; P7 must hold that line back. Settings PATCH cross-field validation must re-run on the merged config (P3.5, ADR 0017).
- **u)** ~~M1~~ Resolved in P3-D1 (ADR 0015: aal2 enforced in the DB for every private read and the three aggregate RPCs; see DATABASE_SCHEMA "Security hardening (debug cycle P3-D1)").
- **v)** ~~M2~~ Resolved in P3-D1 (embedding guard: activation and match check the model; changing the model while chunks exist raises RB012).
- **w)** ~~M3~~ Resolved in P3-D1 (ADR 0016: `data_entries` deleted with their conversation; orphans purged by `purge_expired_data_entries`). Owner confirmation open (ag).
- **x)** ~~L1~~ Resolved in P3-D1 (`audit_logs` append-only; service role has SELECT and INSERT only; TRUNCATE rejected in P3-D2).
- **y)** ~~M4 and M5~~ Resolved in P3-D1 and P3-D2 (M4 was partial after re-review P3-R2 and was completed by P3-D2 N3; M5 is the atomic `begin_request_run`). Real multi-connection tests still open (ac).
- **z)** Deferred by decision: L8, L11, L12, L14, N6, N9; purge fail-closed-for-all-bots is a design choice. Other lows (L2–L7, L9, L10, L13; N1–N5, N7) fixed in P3-D1 and P3-D2.
- **aa)** Partly resolved: census tests added in P3-D1 (column-level grant census gap). Real concurrency tests moved to ac. Integration (vitest) and E2E still have no tests.
- **ab)** Owner decisions resolved: **D-a** via ADR 0015 (MFA aal2 enforced in the DB). **D-b** via ADR 0016 (`data_entries` cascade with the conversation; confirmation open, ag). **D-c** via approved debug cycles P3-D1 (`65cc738`) and P3-D2 (`6b24002`).
- **ac)** ~~Partly resolved in P3-D4: reaper races are covered in `scripts/race-db.sh` (also in CI). `begin_request_run`, `claim_jobs` and rate limit races remain open. Planned for P5/P6.~~ Resolved in P3-D5: 26 race orderings pass (`make db-race`). Remaining: same-job reserve and retry against a running worker; stale settle under load (`status.md §3a` bk).
- **ad)** MFA: Supabase Auth TOTP must be enabled per client project, and admins must enrol. ~~Real GoTrue aal2 tokens are not tested (claims are forged in tests).~~ Partly resolved in P3-D5: real `aal2` sessions and TOTP tested locally (integration gate). Remote TOTP open (`status.md §3a` bj, §3b O-4). P9/P12.
- **ae)** API obligations from P3: set `messages.reply_to_message_id` on assistant inserts; pass `token_version` to `begin_request_run`; use the 2-arg release and 3-arg settle; schedule `expire_stuck_request_runs`, `expire_visitor_sessions(batch, grace)`, `purge_expired_data_entries` and `purge_expired_caches` in the worker cleanup job. P5/P6/P9.
- **af)** P2 contract notes (item t) still open for P4 and later.
- **ag)** Owner to confirm ADR 0016 (`data_entries` retention: cascade with the conversation). Accepted; confirmation still open.
- **ah)** API-level matrix cells are not covered at DB level: field-level settings RPC (P3.5, ADR 0017), management API, audit redaction, signed URLs. Documented for P5/P9.
- **ai)** ~~P3-D2 was verified by tests and an Opus code read only. It has not been separately security-reviewed.~~ Resolved by P3-R3 (2026-11-05, static review; findings aj–am).
- **aj)** ~~R3-1 (Medium, confirmed, reproduced locally): `expire_stuck_request_runs` sets reservations to `released`, so a slow request's settle fails RB003 and real spend is not counted toward the cap. Fix proposed (new migration: reaper sets `expired`; pgTAP case for reap then settle), not implemented. Needs an owner-approved debug cycle.~~ Fixed in P3-D3 (migration 006, `815cfb9`); applied to the remote dev project 2026-11-05.
- **ak)** ~~R3-2 (Low, confirmed by code read; race not exercised): `messages_check_reply_to` takes no lock and skips its check if the target is not visible. Needs a writer that does not exist today. Fix proposed, not implemented.~~ Fixed in P3-D3 (migration 006, `815cfb9`); applied to the remote dev project 2026-11-05. Row lock used instead of the reviewer's composite foreign key; race tested with two connections.
- **al)** ~~R3-3 (doc): `DATABASE_SCHEMA.md` Budget line contradicts the later settle line, and Request start still shows the old 4-argument `begin_request_run`. Not edited yet.~~ Done in P3-D3.
- **am)** API obligations from P3-R3 for P5: a late settle can exceed the cap, by design; it counts toward the UTC day the reservation was created; settle is not idempotent; the API must update `request_runs` only conditionally (`WHERE state IN ('reserved','running')`), a state-transition guard now exists (007), and conditional updates are still required (reviewer note, not verified); the worker reaper threshold must exceed the maximum request duration.
- **an)** Remote advisors after apply (2026-11-05): 5 WARN and 13 INFO security, 34 INFO unused indexes, 1 INFO unindexed FK. `request_runs_session_fk` is a false positive (tested; see evidence). Proposed extra index not added (Opus recommendation; owner has not decided). Admin panel read needs for `admin_memberships`, `bot_profiles`, `client_settings` to be confirmed by P9.
- **ao)** Remote Auth TOTP setting not checked. Related to item ad. Public settings checked 2026-11-06; TOTP still unknown, see bi.
- **ap)** ~~Reviewer notes not verified: R3-4, R3-6 to R3-9, and the listed test gaps. See `docs/evidence/P3-R3/SUMMARY.md`.~~ Resolved in P3-D4: R3-4 and R3-9 fixed; R3-6 tested with a defect left open (bc); R3-7 reviewed and documented; R3-8 closed as by design (owner may still want a policy).
- **aq)** ~~Migration 006 is not applied to the remote dev project, so the remote still has the R3-1 and R3-2 behaviour. Applying it needs owner approval: `make db-create PROJECT_REF=<ref>` or `supabase db push --remote=<ref>`.~~ Done 2026-11-05.
- **ar)** ~~P3-D3 has not been security-reviewed. Verified by tests, a two-connection race script and an Opus code read.~~ Resolved by P3-R4 (2026-11-05, static review). No fixes made; the review is not an approval.
- **as)** ~~The race script `docs/evidence/P3-D3/race_reply_to.sh` is manual and not in `make db-test` or CI.~~ ~~Resolved in P3-D4: race checks are in `scripts/race-db.sh` and CI. A writer now needs UPDATE on `messages` for the reply lock.~~ Race checks now also run as `make db-race` (P3-D5).
- **at)** Partly resolved in P3-D4: `db-status` and `db-advisors` have been run (remote, read-only). Not run: `install`, `db-create`, `db-start`, `db-stop`. Makefile otherwise not fully exercised, and no `make` target has been run against a project this machine is not linked to (`db-status` and `db-advisors` ran on the linked dev project) (P3-R4 ran `supabase migration list` directly with a placeholder ref: the ref was honoured, then the connection failed). Try `db-create` once on a throwaway project before an FDE relies on it.
- **au–bo)** P3-R4 findings, P3-D4 / P3-R5 items, remote Auth (bi), remote items (bj), not done or not proven (bk), reviewer items left open (bl), the admin panel `contracts:sync` step (bm), and P4 not proven (bn) and later-phase obligations (bo): see `status.md §3a`.
- **P3-D5 backlog (G-1 to G-29), owner decisions (O-1 to O-11) and live non-compliance (L-1 to L-7):** outcome and status in `status.md §3b`. O-1 and O-5 done (owner approved 2026-11-06). Local only; remote apply pending (O-2).

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
4. Next actions (summary of `status.md §7`): owner turns off public signup and checks TOTP in the dashboard; admin panel runs `contracts:sync`; ADR 0016 and the Gemini, fallback, cap, jurisdiction and retrieval items stay open; P5 only on owner go-ahead, with the obligations in the `plan.md` P4 section.
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
- `ragbot_adminpanel` — dashboard; consumes this repo's schema and admin RPCs (ADR 0017). Coordinate any schema/API change with it and bump the schema version.

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
| 2026-11-04 | Owner / Opus | P4 (on owner go-ahead) | Debug cycles P3-D1 (`65cc738`) and P3-D2 (`6b24002`) done. ADR 0015 (MFA aal2) accepted; ADR 0016 (`data_entries` cascade) accepted, owner confirmation open. Final gates on `phase/p2-p3` @ `6b24002`: unit 157; pgTAP 1465; `db lint` clean. P1, P2 and P3 acceptance criteria met, owner acceptance pending. CI for the merged commit pending. Docs updated by `haiku-docs`. |
| 2026-11-05 | Owner / Opus | P3 owner acceptance; debug-cycle decision (§5 aj, ak) and `006` index decision (§5 an) | Remote apply (owner-approved): migrations 001–005 applied to dev project `rbejeqwxyxtklehuzibv` via `supabase db push --remote`; `seed.sql` not applied; 22 tables, RLS on all, 0 rows. Security review P3-R3 (static): aj–am open, ai resolved. Branch `phase/p2-p3` no longer exists; P2/P3 on `main` at `19438c5` (code `6b24002`). CI for P2/P3 commits not checked. P1, P2 and P3 not accepted. Evidence: `docs/evidence/P3-R3/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC3). |
| 2026-11-05 | Opus (P3-D3) | Owner (P3 acceptance; 006 remote apply, §5 aq; commit; §5 ar) | P3-D3 (owner-approved; Opus implemented): migration 006 fixes R3-1 and R3-2; R3-3 doc fixes; pgTAP 18 files, 1485 passed; unit 157; `db lint` clean; npm gates exit 0. Local and uncommitted; 006 not applied to remote; not security-reviewed (§5 ar). Makefile and `database/` added (uncommitted). P1, P2 and P3 not accepted. Evidence: `docs/evidence/P3-D3/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC4). |
| 2026-11-05 | Owner / Opus | P4 (on owner go-ahead) | P3-D3 committed as `815cfb9` on `main`. Migration 006 applied to remote dev project `rbejeqwxyxtklehuzibv` (owner-approved; `supabase db push --remote=<ref> --yes`; exit 0; only 006 applied). Remote history 001–006; function definitions and execute grants match local; advisors unchanged. pgTAP and race script ran on local stack only. aj and ak fixed in P3-D3; aq done. P1, P2 and P3 not accepted; P3-D3 not security-reviewed (§5 ar). Docs updated by `haiku-docs` (P3-DOC5). |
| 2026-11-05 | Owner / Opus | P4 (on owner go-ahead; debug-cycle decision on §3a au–ba) | P1, P2 and P3 accepted by owner. CI runs 41708210161 (`19438c5`) and 41974998511 (`0059991`) completed with success (overall only). Security review P3-R4 (static; no fixes; not an approval): findings §3a au–ba; owner decides on a debug cycle. Uncommitted: `docs/evidence/P3-R4/SUMMARY.md` and these doc updates. Docs updated by `haiku-docs` (P3-DOC6). |
| 2026-11-06 | Opus (P3-D4, P3-R5) | Owner (007 remote decision §5 bb; `plan.md` review §5 bh; ADR 0016 §5 ag) | Debug cycle P3-D4 (owner-approved) and static review P3-R5 done. Migration 007 local only, not applied to remote. Gates (local): pgTAP 19 files, 1601 passed; unit 157; 14 race orderings; 80 guard tests; npm gates exit 0. Remote read-only `db-status` and `db-advisors` run. P3-D4 on `main` (commit follows this checkpoint). P3-R5 fixes not re-reviewed (§5 bg). Evidence: `docs/evidence/P3-D4/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC7). |
| 2026-11-06 | Opus (P3-AUD audit and live check) | Owner (P3-D5 scope, O-1; decisions O-2 to O-11, `status.md §3b`) | P0–P3 audit (AUD-P0, P1, P2, P3-S, AUD-P3-X; static, self-reported) and read-only live check: remote differs from the repo only by 007. P3-D4 committed as `e2a044e`; CI run 42086386622 success, all steps. ADR 0017 and `plan.md` edits uncommitted (O-6). P3.5 added (not started). P3-D5 required before the next phase; no fixes made. Evidence: `docs/evidence/P3-AUD/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC8). |
| 2026-11-06 | Opus (P3-D5, P3.5) | Owner (review and accept or send back P3.5; remote decisions O-2, O-3, O-4; push decision; admin panel `contracts:sync`, `status.md §3a` bm) | P3-D5 and P3.5 built, tested and debugged locally; owner approved P3-D5 and P3.5 scope (O-1, O-5). Final gates and evidence: `docs/evidence/P3-D5/SUMMARY.md`. Migrations 007–010 local only; remote still at 006; no remote write. Reviews P3.5-R1, R2, R3 (static, self-reported); final fixes not re-reviewed. P3.5 not accepted. Docs updated by `haiku-docs` (P3-DOC9). |
| 2026-11-06 | Opus | Owner (P3.5 acceptance; signup off and TOTP; next phase) | Migrations 007–010 applied to the remote dev project; schema matches local; advisors as expected. Pushed to `main`. |
| 2026-11-06 | Owner | Opus (P4 on branch `phase/p4`) | P3.5 accepted. P4 started; it reaches `main` only on owner approval. |
| 2026-11-06 | Opus (P4) | Owner (P4 review and approval to merge `phase/p4` to `main`; P5 go-ahead) | P4 API foundation built, tested and debugged on `main`; final gates in `status.md §2`; evidence `docs/evidence/P4/SUMMARY.md`. Not on `main`, not pushed. Open: `status.md §3a` bn, bo. Docs updated by `haiku-docs` (P4-DOC1). |
| 2026-11-06 | Owner | Opus (P5 on owner go-ahead) | P4 merge approved; `phase/p4` merged to `main`. |
