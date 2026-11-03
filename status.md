# Status — ragbot_widget

> Last updated: **2026-11-04**
> Overall: **🟡 P1, P2 and P3 acceptance criteria met; owner acceptance pending. P0 ✅. Debug cycles P3-D1 and P3-D2 done. CI for the merged commit pending**
> Docs baseline: v1.0 (`PRD.md`). Plan: `plan.md`. Context: `handover.md`. Decisions: `docs/decisions/` (ADRs 0001–0014; ADR 0014 revises the provider parts of D1–D3).

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked

---

## 1. Phase tracker

| # | Phase | State | Blocker / note |
|---|---|---|---|
| P0 | Decisions & prerequisites | ✅ | D1–D14 approved and phase accepted by owner 2026-11-03 (ADRs 0001–0013). Open items carried forward: §3a |
| P1 | Monorepo scaffold & tooling | 🟡 | Acceptance criteria met; owner acceptance pending (not ✅). Committed and pushed as `f848fb3`. CI run 41698369772 completed/success. Local gates: `docs/evidence/P1/rerun-2026-11-04-providers/SUMMARY.md`. Integration and E2E: no tests yet. Open: §3a i–r |
| P2 | Shared contracts | 🟡 | Acceptance criteria met (schema unit tests incl. negatives; browser-safe build); owner acceptance pending. Branch `phase/p2-p3` @ `6b24002`. Contract changes: `EmbeddingProvider.embed` returns `{vectors, inputTokens}`; `ModerationResult` has usage; `temperature` removed from `ChatStreamRequest`. Final gates: unit 157 passed, 0 failed, 0 skipped; all npm gates exit 0. Open: §3a t, af |
| P3 | Database & storage migrations | 🟡 | Acceptance criteria met (every DB-level matrix cell has a passing test; API-level cells documented for P5/P9); owner acceptance pending. Branch `phase/p2-p3` @ `6b24002`. Security chain: P3-R1 → P3-D1 (`65cc738`) → re-review P3-R2 (14 of 15 fixed, M4 partial) → P3-D2 (`6b24002`). Final pgTAP: 17 files, 1465 passed, 0 failed; `db lint` clean. D-a, D-b, D-c resolved via ADR 0015, ADR 0016 and approved debug cycles (ADR 0016 confirmation open, §3a ag). Remote dev project untouched; migrations not applied remotely. D1 validation check pending (§3a c). Open: §3a ac–ai |
| P4 | API foundation | ⬜ | |
| P5 | Visitor sessions & abuse controls | ⬜ | Limits (ADR 0007) and Turnstile (ADR 0010) decided; production daily cap open, fails closed (§3a a) |
| P6 | Ingestion pipeline (worker) | ⬜ | OCR out of scope (ADR 0005); file limits set (ADR 0007) |
| P7 | Retrieval & chat | ⬜ | Providers decided (ADRs 0003, 0004); OpenAI fallback model ID pinned at P7; D1 validation pending (§3a c) |
| P7.5 | Caching & latency | ⬜ | D13 decided (ADR 0012); C7 answer cache off by default; schema additions go into P3 |
| P8 | Widget | ⬜ | Markdown off (ADR 0008), sessionStorage + history endpoint (ADR 0009), feedback deferred (ADR 0011); UI_SCHEMA §3/§7 edits pending |
| P9 | Analysis, entries, settings, retention | ⬜ | Retention periods set (ADR 0006); jurisdiction per client and DPAs open (§3a b) |
| P10 | Observability & ops | ⬜ | |
| P11 | Evaluation, security, load | ⬜ | |
| P12 | First client deployment | ⬜ | |

## 2. Done so far
- [x] Planning docs written: `PRD.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `TECH_SPECS.md`, `UI_SCHEMA.md`, `README.md`
- [x] Docs reviewed end-to-end; 10 inconsistencies/gaps logged (`handover.md §6`)
- [x] `plan.md`, `handover.md`, `status.md` created
- [x] Caching & latency phase (P7.5) added to plan and TECH_SPECS
- [x] Contact routing (W-16) added to PRD, plan, DATABASE_SCHEMA, UI_SCHEMA, TECH_SPECS
- [x] Planning docs committed and pushed to `main`
- [x] Supabase MCP connected to dev project `rbejeqwxyxtklehuzibv` (verified 2026-11-03: empty `public` schema, no migrations)
- [x] `CLAUDE.md` dev contract v0.1 + sub-agents in `.claude/agents/` (`sonnet-implementer`, `haiku-docs`, `reviewer`, `security-reviewer`). Committed to `main`. Model record: §9.
- [x] P0 decisions D1–D14 approved by owner 2026-11-03 as recommended; ADRs 0001–0013 in `docs/decisions/`, committed in `5e416b6`
- [x] P1 monorepo scaffold implemented 2026-11-04 (uncommitted): Node 24.22.2 pin, workspaces `shared`/`api`/`worker`/`widget` with placeholder entries, `supabase/config.toml` from `supabase init`, `.env.example` files, CI workflow written. Gate results in `docs/evidence/P1/SUMMARY.md`
- [x] ADR 0014 accepted 2026-11-04: provider-agnostic AI config, Gemini default. Env-driven roles, fail-closed loader and capability matrix in `shared/src/providers.ts`, `api`/`worker` `.env.example` and README env section updated. Revises D1–D3 provider/model parts; dimension 1536 kept (committed in `f848fb3`; ADRs 0015/0016 committed in `65cc738`)
- [x] Local Supabase stack verified 2026-11-04: Docker installed by owner (docker.io 28.5.2, service active, user in `docker` group). `npx supabase start` exit 0 (12 containers up: 10 report healthy; `edge_runtime` and `rest` have no healthcheck). `npx supabase db reset` exit 0 (no migrations, no `seed.sql`). Local PostgreSQL 17.11, pgvector 0.8.2 available. Remote dev project (read-only MCP `SELECT` and `list_migrations`) also shows PostgreSQL 17.11, vector 0.8.2 available, 0 public tables, 0 migrations. Logs, keys redacted: `docs/evidence/P1/supabase-2026-11-04/`
- [x] Real Gemini calls, owner-directed, no client data (2026-11-04): model list (200) and two `embedContent` calls on the word "hello" with `outputDimensionality` 1536 (200, 1536 values each). Evidence: `docs/evidence/P1/rerun-2026-11-04-providers/SUMMARY.md`
- [x] P1 CI green: run 41698369772 for `f848fb3` completed/success (read via `gh` 2.103.3, installed in `~/.local/bin`, checksum verified). Commits `5e416b6` (P0) and `f848fb3` (P1) pushed to `origin/main`
- [x] P2 (shared contracts) and P3 (DB migrations, seed, pgTAP) implemented in parallel with sonnet workers (worktrees, base `f848fb3`), verified and integrated by Opus into the main checkout. Later committed on branch `phase/p2-p3` (see below). Logs (gitignored): `docs/evidence/P2-P3/`. Remote dev project untouched. `supabase test db` pulled the `pg_prove` Docker image over the network (CLI behaviour)
- [x] P3 debug cycles: P3-D1 (commit `65cc738`) fixed M1–M5, L1–L7, L9, L10, L13 and added census tests. Re-review P3-R2 found 14 of 15 P3-R1 items fixed, M4 partial, and new items N1–N9. P3-D2 (commit `6b24002`) fixed N1–N5 and N7, and completed M4 via N3 (durable reply pairing). Evidence: `docs/evidence/P2-P3/SUMMARY.md`
- [x] Final gates on `phase/p2-p3` @ `6b24002`: unit 157 passed, 0 failed, 0 skipped; pgTAP 17 files, 1465 passed, 0 failed; `db lint` clean; all npm gates exit 0. CI now runs pgTAP (`npm run test:db` after `supabase db reset`). CI for the merged commit: pending (to be confirmed after push)
- [x] Decisions encoded: ADR 0015 (MFA aal2 enforced in the DB, accepted); ADR 0016 (`data_entries` deleted with their conversation, accepted; owner confirmation open, §3a ag)
- [x] Cleanup: agent worktrees and their branches removed (`git worktree list` shows only the main checkout); temp logs removed; `.claude/worktrees/` is gitignored

## 3. Open decisions (P0)

All 14 decisions were approved by the owner on 2026-11-03 as recommended. Each decision's ADR is the authoritative record. **D1, D2 and D3 are revised by ADR 0014 (2026-11-04)** for provider and model selection (Gemini default, env-switched). Dimension 1536 is kept.

| # | Decision | Blocks | Owner | State |
|---|---|---|---|---|
| D1 | Embedding provider/model + vector dimension | P3, P6, P7 | Owner (approved 2026-11-03) | ✅ ADR 0002, provider/model revised by ADR 0014 (Gemini `gemini-embedding-001`, 1536 dims; retrieval check open, §3a c) |
| D2 | Primary + fallback chat providers | P7 | Owner (approved 2026-11-03) | ✅ ADR 0003, revised by ADR 0014 (Gemini `gemini-2.5-flash-lite`; no independent fallback, §3a o) |
| D3 | Moderation provider + streaming policy | P7 | Owner (approved 2026-11-03) | ✅ ADR 0004, revised by ADR 0014 (`llm_classifier` default, §3a p) |
| D4 | OCR scope/provider | P6 | Owner (approved 2026-11-03) | ✅ ADR 0005 |
| D5 | Retention, jurisdiction, provider DPA | P3 (005), P9 | Owner (approved 2026-11-03) | ✅ ADR 0006 (open: jurisdiction per client, DPAs, §3a b) |
| D6 | File limits, rate limits, budget caps | P5, P6 | Owner (approved 2026-11-03) | ✅ ADR 0007 (open: production daily cap, §3a a) |
| D7 | Markdown rendering + sanitiser | P8 | Owner (approved 2026-11-03) | ✅ ADR 0008 (off for v1) |
| D8 | History endpoint in MVP | P7, P8 | Owner (approved 2026-11-03) | ✅ ADR 0009 (enabled in MVP) |
| D9 | Visitor token persistence | P8 | Owner (approved 2026-11-03) | ✅ ADR 0009 (sessionStorage) |
| D10 | Bot challenge on `/v1/sessions` | P5 | Owner (approved 2026-11-03) | ✅ ADR 0010 (Turnstile; Cloudflare details unverified, §3a e) |
| D11 | Node LTS + dependency pins | P1 | Owner (approved 2026-11-03) | ✅ ADR 0001 (Node 24 LTS; Supabase CLI install pending, §3a d) |
| D12 | Feedback buttons: defer or add endpoint | P8 | Owner (approved 2026-11-03) | ✅ ADR 0011 (defer; UI_SCHEMA §3 edit pending) |
| D14 | Per-client contact channels, hours, localised escalation messages, repeated-miss threshold | P3, P7, P8 | Owner (approved 2026-11-03) | ✅ ADR 0013 (threshold 2; per-client details at P12) |
| D13 | Answer cache: enable per client? TTL? Which provider prompt caching? | P7.5 | Owner (approved 2026-11-03) | ✅ ADR 0012 (C7 off by default; TTL 24 h) |

### 3a. Open items after P0 (not done)
- **a)** Production daily budget cap per client: no value given. Fails closed until set (ADR 0007).
- **b)** Jurisdiction India/DPDP is an assumption. Owner to confirm per client. Provider DPAs outstanding (ADR 0006).
- **c)** Gemini embeddings verified to return 1536 dims only (2026-11-04). Retrieval-quality check on real documents not run (ADR 0002).
- **d)** ~~Supabase CLI install~~ done 2026-11-04: CLI 3.0.0 pinned as devDependency (owner approved).
- **e)** Non-Anthropic provider details (OpenAI, Voyage, Cloudflare) not verified in the P0 session (ADRs 0002, 0003, 0004, 0010).
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
- **u)** ~~M1~~ Resolved in P3-D1 (ADR 0015: aal2 enforced in the DB for every private read and the three aggregate RPCs; see DATABASE_SCHEMA "Security hardening (debug cycle P3-D1)").
- **v)** ~~M2~~ Resolved in P3-D1 (embedding guard: activation and match check the model; changing the model while chunks exist raises RB012).
- **w)** ~~M3~~ Resolved in P3-D1 (ADR 0016: `data_entries` deleted with their conversation; orphans purged by `purge_expired_data_entries`). Owner confirmation open (§3a ag).
- **x)** ~~L1~~ Resolved in P3-D1 (`audit_logs` append-only; service role has SELECT and INSERT only; TRUNCATE rejected in P3-D2).
- **y)** ~~M4 and M5~~ Resolved in P3-D1 and P3-D2 (M4 was partial after re-review P3-R2 and was completed by P3-D2 N3; M5 is the atomic `begin_request_run`). Real multi-connection tests still open (§3a ac).
- **z)** Deferred by decision: L8, L11, L12, L14, N6, N9; purge fail-closed-for-all-bots is a design choice. Other lows (L2–L7, L9, L10, L13; N1–N5, N7) fixed in P3-D1 and P3-D2.
- **aa)** Partly resolved: census tests added in P3-D1 (column-level grant census gap). Real concurrency tests moved to §3a ac. Integration (vitest) and E2E still have no tests.
- **ab)** Owner decisions resolved: **D-a** via ADR 0015 (MFA aal2 enforced in the DB). **D-b** via ADR 0016 (`data_entries` cascade with the conversation; confirmation open, §3a ag). **D-c** via approved debug cycles P3-D1 (`65cc738`) and P3-D2 (`6b24002`).
- **ac)** Real multi-connection race tests for `begin_request_run`, reserve/settle, `claim_jobs` and rate limits. Planned for P5/P6. Current tests are sequential only.
- **ad)** MFA: Supabase Auth TOTP must be enabled per client project (local config has it off), and admins must enrol. Real GoTrue aal2 tokens are not tested (claims are forged in tests). P9/P12.
- **ae)** API obligations from P3: set `messages.reply_to_message_id` on assistant inserts; pass `token_version` to `begin_request_run`; use the 2-arg release and 3-arg settle; schedule `expire_stuck_request_runs`, `expire_visitor_sessions(batch, grace)`, `purge_expired_data_entries` and `purge_expired_caches` in the worker cleanup job. P5/P6/P9.
- **af)** P2 contract notes (item t) still open for P4 and later.
- **ag)** Owner to confirm ADR 0016 (`data_entries` retention: cascade with the conversation). Accepted; confirmation still open.
- **ah)** API-level matrix cells are not covered at DB level: field-level settings RPC (P9), management API, audit redaction, signed URLs. Documented for P5/P9.
- **ai)** P3-D2 was verified by tests and an Opus code read only. It has not been separately security-reviewed.

## 4. Doc fixes pending (from `handover.md §6`)
- [x] Add `escalation_label` to `public_bot_config`
- [x] Resolve `data-bot-id` (slug) vs `bot_slug` vs UUID `bot_id` naming
- [x] Add `OCR_REQUIRED` to TECH_SPECS §5 error list
- [x] Decide on feedback buttons (D12): defer, ADR 0011
- [x] Remove `FeedbackButtons` from `UI_SCHEMA §3` (ADR 0011)
- [x] Change `UI_SCHEMA §7` token default from memory-only to sessionStorage (ADR 0009)
- [x] Document Stop → server abort on client disconnect
- [x] Rename `request_runs.session_id` → `visitor_session_id`
- [x] Clarify public-config fetch path (Supabase REST direct) — ARCHITECTURE §3
- [x] Add `routes/conversations.ts` to README layout
- [x] Mark `analysing` as background metadata, not a UI state
- [x] Enforce exclusion of `system` messages in history query spec — TECH_SPECS §2

## 5. Requirements coverage

| Req | Description | Implemented | Tested |
|---|---|---|---|
| W-01 | One-script installation | ⬜ | ⬜ |
| W-02 | Encapsulated UI | ⬜ | ⬜ |
| W-03 | Streaming chat | ⬜ | ⬜ |
| W-04 | Grounded retrieval | ⬜ | ⬜ |
| W-05 | Missing knowledge refusal | ⬜ | ⬜ |
| W-06 | Identity | ⬜ | ⬜ |
| W-07 | Citations | ⬜ | ⬜ |
| W-08 | Fallback | ⬜ | ⬜ |
| W-09 | Moderation | ⬜ | ⬜ |
| W-10 | Async analysis | ⬜ | ⬜ |
| W-11 | Conversation log integrity | ⬜ | ⬜ |
| W-12 | Limits | ⬜ | ⬜ |
| W-13 | Data entries | ⬜ | ⬜ |
| W-14 | Safe presentation | ⬜ | ⬜ |
| W-15 | Indexing | ⬜ | ⬜ |
| W-16 | Contact routing | ⬜ | ⬜ |

## 6. Release gates (PRD §8)

| Gate | State | Recorded result |
|---|---|---|
| Evaluation sets (languages, unanswerable, fallback, injection) | ⬜ | — |
| p95 first meaningful event ≤ 5 s (target) | ⬜ | — |
| p95 ordinary response ≤ 20 s (target) | ⬜ | — |
| Limits/retention/caps configured (fail closed) | ⬜ | — |
| Rollback rehearsed (widget + API) | ⬜ | — |
| Backup/restore rehearsed incl. Storage | ⬜ | — |
| Security test matrix executed | ⬜ | — |

## 7. Next actions
1. Owner accepts P1, P2 and P3 (acceptance criteria met, §1).
2. Owner confirms ADR 0016 (`data_entries` retention) (§3a ag).
3. CI for the merged commit: pending, to be confirmed after push.
4. Owner confirms paid-tier Gemini billing before any client data (§3a n), and decides whether to add a second provider key for independent fallback (§3a o). Owner provides the production daily cap and confirms jurisdiction per client (§3a a, b). Owner decides on the retrieval-quality check for embeddings (§3a c).
5. Applying migrations to the remote dev project needs separate owner approval. Not done.
6. P4 only on owner go-ahead. P4 must address the API obligations in §3a ae, and the race tests in §3a ac.

## 8. Change log
| Date | Change |
|---|---|
| 2026-11-03 | Created status tracker; project in planning, no code. |
| 2026-11-03 | Added W-16 contact routing across docs; resolved 7 doc inconsistencies; decision D14. |
| 2026-11-03 | Added P7.5 caching & latency phase and decision D13. |
| 2026-11-03 | P0 decisions D1–D14 approved by owner; ADRs 0001–0013 written in `docs/decisions/` (uncommitted). Status and handover updated (docs-only checkpoint, `haiku-docs`). No code, tests or Supabase changes. |
| 2026-11-04 | P0 accepted by owner and committed (`5e416b6`). P1 scaffold implemented locally (uncommitted): all 8 local gates exit 0 on clean `npm ci`; CI not run; no feature code. Open items §3a h–m. Status and handover updated (docs checkpoint, `haiku-docs`). |
| 2026-11-04 | ADR 0014 accepted: provider-agnostic AI config, Gemini default; revises D1–D3 provider/model parts (dimension 1536 kept). Config loader and tests added: 21 unit passed; 7 local gates exit 0. Real Gemini calls (no client data): model list and two `hello` embeddings, 200, 1536 dims. P1 still 🟡 (uncommitted, CI not run). Open items §3a n–r. Docs updated by `haiku-docs`. |
| 2026-11-04 | Docker installed by owner. Local Supabase stack verified: `supabase start` and `db reset` exit 0; local and remote PostgreSQL 17.11 and pgvector 0.8.2 match. P1 still 🟡 (CI needs commit and push). Logs: `docs/evidence/P1/supabase-2026-11-04/`. Docs updated by `haiku-docs`. |
| 2026-11-04 | Correction (P1-DOC4): earlier finding §3a s (migration naming) withdrawn. The CLI accepts `001_…` names, verified with a probe migration (since removed); only `.gitkeep` is skipped. Container count corrected to 12 up, 10 healthy, `edge_runtime` and `rest` without healthcheck. Plan/README unchanged. |
| 2026-11-04 | P1 committed and pushed (`f848fb3`); CI run 41698369772 green. P2 and P3 implemented and verified locally by sonnet workers and Opus (uncommitted). Security review P3-R1: M1–M5 and L1 open. Owner decisions D-a, D-b, D-c pending (§3a ab). P1 not accepted; P2 and P3 not accepted. Docs updated by `haiku-docs`. |
| 2026-11-04 | Debug cycles P3-D1 (`65cc738`) and P3-D2 (`6b24002`) done. ADR 0015 (MFA aal2 in DB) accepted; ADR 0016 (`data_entries` cascade) accepted, owner confirmation open. Final gates on `phase/p2-p3` @ `6b24002`: unit 157; pgTAP 1465; `db lint` clean. Worktrees and temp logs cleaned up. P1, P2 and P3 acceptance criteria met, owner acceptance pending. CI for the merged commit pending. Evidence: `docs/evidence/P2-P3/SUMMARY.md`. Docs updated by `haiku-docs`. |

## 9. Agent model record
- `haiku-docs`: configured `model: claude-haiku-5-5` (`.claude/agents/haiku-docs.md`). First spawn: P0-DOC1, 2026-11-03. The orchestrator cannot observe the actual model resolution. The worker's self-report is **unverified**.
- `reviewer`: no spawn recorded.
- 2026-11-04 (P1): no new agents spawned. P1 was implemented directly by Opus.
- 2026-11-04 (ADR 0014): no new agents spawned. The real Gemini calls were made by Opus, not by a worker.
- 2026-11-04 (Supabase local stack): no new agents spawned. The stack and MCP read-only checks were run by Opus.
- 2026-11-04 (P2 ∥ P3, first spawns): `sonnet-implementer` ×2 (P2-T1 and P3-T1; configured `claude-sonnet-5-5`; worktree isolation; base `f848fb3`). `security-reviewer` ×1 (P3-R1; configured `claude-sonnet-5-5`; read-only). Actual model resolution is not observable. Self-reports are **unverified**.
- 2026-11-04 (debug cycles P3-D1, P3-D2): `sonnet-implementer` ×2 more (P3-D1, P3-D2; configured `claude-sonnet-5-5`). P3-D1 first started from the wrong base, stopped correctly, and re-based. `security-reviewer` ×1 more (P3-R2). Self-reports are **unverified**. All results were verified by Opus reruns.
