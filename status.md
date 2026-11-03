# Status — ragbot_widget

> Last updated: **2026-11-04**
> Overall: **🟡 P1 implemented locally — local gates pass; CI run and owner acceptance pending**
> Docs baseline: v1.0 (`PRD.md`). Plan: `plan.md`. Context: `handover.md`. Decisions: `docs/decisions/` (ADRs 0001–0014; ADR 0014 revises the provider parts of D1–D3).

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked

---

## 1. Phase tracker

| # | Phase | State | Blocker / note |
|---|---|---|---|
| P0 | Decisions & prerequisites | ✅ | D1–D14 approved and phase accepted by owner 2026-11-03 (ADRs 0001–0013). Open items carried forward: §3a |
| P1 | Monorepo scaffold & tooling | 🟡 | Implemented 2026-11-04, uncommitted. Local gates pass: 7 commands exit 0 on clean `npm ci` (`docs/evidence/P1/rerun-2026-11-04-providers/SUMMARY.md`). Unit: 21 passed (3 scaffold, 18 provider config). Local Supabase stack verified (§2). Integration and E2E: no tests yet. Only remaining acceptance item: CI green, which needs commit and push. Awaiting owner approval. Open: §3a i–r (s withdrawn) |
| P2 | Shared contracts | ⬜ | Waits on remaining doc fixes (§4); UI_SCHEMA edits pending |
| P3 | Database & storage migrations | ⬜ | D1 (ADR 0002) and D5 (ADR 0006) decided; `002_vectors.sql` unblocked. D1 validation check pending (§3a c); `005_retention.sql` jurisdiction per client open (§3a b) |
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
- [x] ADR 0014 accepted 2026-11-04: provider-agnostic AI config, Gemini default. Env-driven roles, fail-closed loader and capability matrix in `shared/src/providers.ts`, `api`/`worker` `.env.example` and README env section updated. Revises D1–D3 provider/model parts; dimension 1536 kept (uncommitted)
- [x] Local Supabase stack verified 2026-11-04: Docker installed by owner (docker.io 28.5.2, service active, user in `docker` group). `npx supabase start` exit 0 (12 containers up: 10 report healthy; `edge_runtime` and `rest` have no healthcheck). `npx supabase db reset` exit 0 (no migrations, no `seed.sql`). Local PostgreSQL 17.11, pgvector 0.8.2 available. Remote dev project (read-only MCP `SELECT` and `list_migrations`) also shows PostgreSQL 17.11, vector 0.8.2 available, 0 public tables, 0 migrations. Logs, keys redacted: `docs/evidence/P1/supabase-2026-11-04/`
- [x] Real Gemini calls, owner-directed, no client data (2026-11-04): model list (200) and two `embedContent` calls on the word "hello" with `outputDimensionality` 1536 (200, 1536 values each). Evidence: `docs/evidence/P1/rerun-2026-11-04-providers/SUMMARY.md`

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
1. Owner approves the P1 commit and push (needed to run CI).
2. Owner accepts P1 after CI is green.
3. Owner confirms paid-tier Gemini billing before any client data (§3a n), and decides whether to add a second provider key for independent fallback (§3a o).
4. Owner provides the production daily cap (§3a a) and confirms jurisdiction per client (§3a b) when available. Owner decides on the retrieval-quality check for embeddings (§3a c).
5. P2 only on owner go-ahead. Provider adapters (§3a r) come with P6/P7.

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

## 9. Agent model record
- `haiku-docs`: configured `model: claude-haiku-5-5` (`.claude/agents/haiku-docs.md`). First spawn: P0-DOC1, 2026-11-03. The orchestrator cannot observe the actual model resolution. The worker's self-report is **unverified**.
- `sonnet-implementer`, `reviewer`, `security-reviewer`: no spawn is recorded in the P0-DOC1 evidence packet.
- 2026-11-04 (P1): no new agents spawned. P1 was implemented directly by Opus.
- 2026-11-04 (ADR 0014): no new agents spawned. The real Gemini calls were made by Opus, not by a worker.
- 2026-11-04 (Supabase local stack): no new agents spawned. The stack and MCP read-only checks were run by Opus.
