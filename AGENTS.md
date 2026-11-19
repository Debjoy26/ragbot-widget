# AGENTS.md — ragbot_widget


## Current owner instructions and handoff

Work is STOPPED for documentation handoff after completedT03c-3a; latest owner
usage report10% remaining of the five-hour allowance. NextT03c-3b full local
pgTAP NOT STARTED. Read docs/reports/OPENCODE-HANDOFF.md and LATEST-CHECKPOINT.md
before resuming. This applies to OpenCode, Codex and other agents equally.

Resume local tasks only when the owner says continue. After continuation, the
owner monitors usage; do not repeatedly block solely because tools lack a meter.
Stop immediately on owner signal or an authoritative reading<=5% remaining;
save continuity only. Never substitute context/elapsed time or invent a reset.
Checkpoint EVERY task including failure/interruption. STOP BEFORE P11. Main
runs verification; no CI as evidence. No new release/hosted/provider permission.

> Operational guide for any AI/human agent working in this repo.
> Derived from `CLAUDE.md` v0.1 + `rules.md` (2026-11-08). Where they conflict on CI, testing, or starting debug cycles, `rules.md` wins. Phase IDs are `plan.md` P0–P12; invariants are `handover.md §4`.

## 1. What this repo is

Embeddable, client-branded RAG chatbot (one `<script>` tag). Monorepo `shared` / `api` / `worker` / `widget` + Supabase Postgres+pgvector. This repo owns the **shared backend** (API on Render, worker on Render, Supabase schema) used by both the widget and the separate `ragbot_adminpanel` repo (ADR 0017). No Supabase Edge Functions (`ARCHITECTURE.md §2`).

- **Node:** `26.13.1` pinned in `.nvmrc:1` and `package.json:7` (ADR 0018, revises ADR 0001) — run `nvm use`.
- **Package manager:** `npm` workspaces, committed `package-lock.json`. No `latest`.
- **Current state:** P0–P6 accepted; P7–P10 implementations are on `main`, phase acceptance remains open. The active pre-P11 repair overlay is uncommitted from `aa6425a`; local schema020, hosted last recorded017. Stop before P11. Use `status.md:1`, `handover.md:2` and `docs/reports/SESSION-CHECKPOINT-2026-11-17.md` for exact live state; do not infer acceptance from earlier implementation history.

## 2. Start / resume every session

1. Read `status.md`, `handover.md`, and the active `plan.md` phase section.
2. Inspect Git truth: `git status`, `git log -5`, `git worktree list`.
3. Load **only** the spec sections the active phase needs (`PRD.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `TECH_SPECS.md`, `UI_SCHEMA.md`, `README.md`) — not every doc.
4. Preserve existing work. Never invent commits, test results, decisions, or approvals.
5. Open P0 decisions (`status.md §3`) are never guessed — stop and ask if a task depends on one.

### Small tasks, checkpoints and quota stop (owner instruction, 2026-11-18)

Follow `docs/reports/PRE-P11-TASKS.md` for the ordered remaining local tasks.
At the end of every task, including failure/interruption, save a task checkpoint
and update `status.md`, `handover.md`, the repair tracker and exact session
checkpoint; update affected specs/runbooks without rewriting historical evidence.
At an authoritative reading of **5% remaining or less** of the five-hour account
allowance, stop implementation/workers/checks and save continuity only. The
current tools do not expose that usage reading: never substitute elapsed time,
context tokens or a goal budget, and never claim automatic monitoring exists.
The owner monitors usage after continuation; lack of agent telemetry alone
does not block authorized work. Stop on owner signal/known5% threshold. No automatic P11 progression, commit, push or hosted write.

## 3. Repository layout

```
shared/src/{contracts,schemas,errors,providers,prompts}.ts  # frozen contracts (P2)
supabase/migrations/ 001..020  + supabase/seed.sql            # single migration history
database/             # symlinks into supabase/ + FDE runbook
api/src/{server,routes/*,services/*,lib/*}
worker/src/{worker,jobs/*,lib/*}
widget/src/{widget,ui,api,session,public-config,render}.ts
tests/{unit,integration,evaluation,e2e}  + supabase/tests/database (pgTAP)
scripts/{race-db,secret-scan,test-make-guards}.sh  + scripts/api-smoke.mjs
Makefile  # make help — wraps db-local/db-test/db-lint/db-race/db-plan/db-status etc.
```

Key docs: `PRD.md` (requirements W-01..W-16), `DATABASE_SCHEMA.md` (grants/RLS matrix — shared contract), `TECH_SPECS.md` (routes, errors, test matrix §9), `UI_SCHEMA.md` (widget), `ARCHITECTURE.md` (topology), `plan.md` (P0–P12), `handover.md` (§4 invariants), `rules.md` (testing gates).

## 4. Roles

| Role | Model (pinned) | Scope |
|---|---|---|
| **Human (owner)** | — | Phase scope, P0 decisions, debug authorisation, merges/pushes, hosted writes, next-phase gate |
| **Opus 5.5 `claude-opus-5-5` (main session)** | `claude-opus-5-5` | Orchestrates, owns shared contracts & integration, runs **all** verification itself, diagnoses failures, proposes fixes |
| `sonnet-implementer` | `claude-sonnet-5-5` | Bounded implementation inside owner-approved phase/debug cycle. See `.claude/agents/sonnet-implementer.md:1` |
| `haiku-docs` | `claude-haiku-5-5` | Drafts **only** `status.md`/`handover.md` (and `docs/reports/` if packet names them) from Opus evidence packet. No code/spec/plan edits. See `.claude/agents/haiku-docs.md:1` |
| `reviewer` | `claude-sonnet-5-5` | Read-only correctness/spec-conformance review. See `.claude/agents/reviewer.md:1` |
| `security-reviewer` | `claude-sonnet-5-5` | Read-only review vs `handover.md §4` + `TECH_SPECS.md §8`. See `.claude/agents/security-reviewer.md:1` |

Workers get **no Supabase MCP tools** — only the main session touches the live project.

### Assignment packet — required for every worker spawn

Missing any item → do not spawn (`CLAUDE.md:27`):

1. Task ID `P<n>-T<k>` (or `P<n>-D<k>`)
2. Base branch + commit SHA
3. Owned files — exact paths/globs, exclusive
4. Frozen contracts — files to read but not change (e.g. `shared/src/contracts.ts`, `supabase/migrations/*`)
5. Spec references (e.g. `TECH_SPECS.md §4`, `DATABASE_SCHEMA.md` grants matrix)
6. Tests to add — named cases incl. negatives from `TECH_SPECS.md §9`
7. Permitted commands / network — default: none beyond read-only shell + local `npm`/`make` scripts; no network
8. Stop condition — what "done" means and when to stop/report
9. Report format — files changed, commands (cwd + exit code), tests added, open questions, known gaps. Self-reported, unverified.

At first spawn of each agent, record in `status.md`: configured `model:` value, any substitution, and that the report is unverified.

### Concurrency

- From P1: up to 3 mutating workers only where `plan.md §1` allows (e.g. P6 ∥ P8 after P5 + frozen P2 contracts), each with disjoint owned files, own worktree/branch (`isolation: "worktree"`), common baseline commit.
- Otherwise one at a time.
- Workers never commit, push, install deps, fetch, run migrations on remote, or call real provider APIs unless packet grants it.

### Opus-owned shared contracts (workers never edit unless packet names them)

`shared/src/{contracts,schemas,providers,prompts}.ts` + error-code enum · `supabase/migrations/**`, `supabase/seed.sql` · root `package.json`, `package-lock.json`, `tsconfig*.json`, `.nvmrc`, lint/format config, CI workflows · `.env.example` files · all spec docs, `plan.md`, `status.md`, `handover.md`, `docs/decisions/**`, `CLAUDE.md`, `.claude/**` (`CLAUDE.md:43`).

## 5. Phase loop

```
owner approves phase → delegate (packet) → integrate → verify (full suite §6) →
independent reviews (security-reviewer + reviewer) → fix confirmed findings in debug cycle →
rerun suite + re-review → write docs/evidence/<phase>/SUMMARY.md →
haiku-docs updates continuity → Opus validates diff → STOP for owner
```

- A failing check does **not** authorise repairs. Report confirmed bugs separately from hypotheses (severity, evidence, bounded fix).
- Two unsuccessful debug cycles on same defect → revised diagnosis + owner decision, not more retries.
- No automatic next phase, even when all gates pass.

## 6. Verification — system test suite (`rules.md:16`)

Run by the **main session** from repo root on the **integrated tree**. A commit is made only when every command exits 0 (chain commit after checks).

| Area | Commands |
|---|---|
| Build & static | `npm run build`, `npm run lint`, `npm run format:check`, `npm run typecheck` |
| Database | `make db-local`, `make db-test`, `make db-lint`, `make db-race` |
| Unit & integration | `npm test`, `npm run test:integration` |
| Running system | `node scripts/api-smoke.mjs` (local stack); `node scripts/worker-dist-check.mjs` after build |
| Guards & secrets | `make test-make`, `npm run secret-scan:self-test`, `bash scripts/secret-scan.sh --include-untracked` |
| Advisors | `npx supabase db advisors --type all --level warn` (local) |

After scaffolding, verify each command actually works before using it as a gate. For every check record: command, cwd, env (Node version, local vs remote), Git revision, exit code, pass/fail/skip counts, evidence paths, manual-pending checks, known limitations. Archive long logs under `docs/evidence/<phase>/`; keep `status.md`/`handover.md` compact. Do not weaken assertions or delete regression cases to get green. Inspect integrated code — a worker report is not evidence.

**No CI as evidence** (`rules.md:11`): never check/wait/report CI runs, never use CI result as a gate. Editing a workflow is allowed, its result is never a gate.

### Post-push verification (`rules.md:41`)

After owner approves merge to `main` + push:

1. Local on `main`: rerun full suite.
2. Hosted dev project (read-only): `make db-plan` shows nothing pending; local vs hosted catalog fingerprints match (grants, column privs, policies, functions, triggers, constraints, indexes, columns); advisors show no new finding; anonymous HTTP probes with publishable key: only `public_bot_config` readable.
3. Record in `docs/evidence/<phase>/post-push.md`. Any regression/drift/vuln → debug cycle.

## 7. Supabase — live project via MCP

- **Project ref `rbejeqwxyxtklehuzibv`** is remote dev, changes via MCP are immediate (`CLAUDE.md:57`).
- Free read-only: `list_tables`, `list_migrations`, `list_extensions`, `get_advisors`, `get_logs`/`query_logs`, `get_project_url`, `search_docs`, `execute_sql` with `SELECT` only.
- **Owner approval per action:** `apply_migration`, any non-`SELECT` `execute_sql`, enabling extensions, branch create/merge/reset/delete, secrets, `deploy_edge_function` (none planned).
- Every schema change exists first as `supabase/migrations/` file (single history, `handover.md §4.16`), tested on local stack (`supabase start` / `supabase db reset`) or a Supabase branch before remote. Never hand-edit remote without a matching migration.
- After any migration: run `get_advisors` (security + performance) and report.
- Load `supabase` + `supabase-postgres-best-practices` skills before writing migrations/RLS/RPCs.
- `database/` is FDE entry: `make db-plan PROJECT_REF=<ref>` (preview), `make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref>` (apply; type ref twice), then `make db-status` / `make db-advisors`. `PROJECT_REF` must be on CLI, not exported.

## 8. Non-negotiable invariants (`handover.md:59`)

Break any one → security/correctness bug:

1. Browser is untrusted — never accept browser-supplied context/history/system prompt/roles/usage/keys/assistant messages.
2. Publishable key + bot ID are public config, not auth — visitors use short-lived HMAC tokens `{bot, session, expiry}`.
3. Service-role bypasses RLS — every privileged route does its own ownership + role checks.
4. Admin = Supabase session + active membership + `aal2`, enforced in Postgres + Storage (ADR 0015/0017). "Authenticated" ≠ admin.
5. anon can read only `public_bot_config`. Nothing else.
6. Rate limits & budgets are atomic in Postgres, never process-local.
7. Idempotency key cannot spend twice — duplicates return stored status.
8. No provider switch after first token — terminate as `STREAM_INTERRUPTED`.
9. No silent embedding-model switch — query encoder must match corpus; changing models = reindex.
10. Document replacement is atomic — failed reindex leaves old version active.
11. Citations only from retrieved chunk IDs — drop invented ones.
12. Widget renders plain text via `textContent` unless sanitised Markdown is explicitly enabled (no raw HTML, remote images, iframes, `javascript:`).
13. Fail closed on missing limits/config.
14. Secrets only in Render env — never in bundles, git, prompts, or logs.
15. Caches never outrank invariants — every key includes `bot_id` + version (`corpus_version`, `settings_version`, model, prompt); answer cache opt-in, first-turn only, re-checks cited docs still active. Input moderation/auth/rate limits run on every request incl. cache hits.
16. Single migration history in `supabase/migrations` — admin repo must not add competing migrations.

Plus (`CLAUDE.md:65`): no raw keys/tokens/chat content/document bodies in code/configs/logs/reports/commits/prompts; ` .env*` gitignored except `.env.example`; mocks/fakes labelled and never satisfy a real gate; pin exact Node/deps/lockfile; no blanket "all green = done".

## 9. Debug cycles (`rules.md:51`)

Main session starts/runs a debug cycle whenever testing/review finds an error/vuln — does not wait to be asked.

1. **Confirm:** reproduce on system or record why not; classify severity; separate confirmed defects from hypotheses.
2. **Branch:** `<phase>/d<n>` from affected commit; bounded fix + owned files in packet.
3. **Fix test-first:** regression test that fails before, passes after.
4. **Verify:** rerun full suite; security fix → re-reviewed by `security-reviewer`.
5. **Record:** defect + fix + evidence in `docs/evidence/<phase>/` and `status.md`.
6. **Report:** tell owner what was found/fixed and what remains open.

Two unsuccessful cycles → stop + revised diagnosis + owner decision. Reachable vuln on hosted project → report to owner immediately, before/alongside fix. Fixes reach `main` / migrations reach hosted only with owner approval.

## 10. Still needs owner approval

Merging to `main` + pushing · any write to hosted Supabase (migrations, SQL writes, Auth/Storage, branches, secrets) · starting a new phase · dependency installs · real provider API calls or client data · deployments · destructive operations. Do not enable permission bypass.

## 11. Always / never

- Never weaken an assertion or delete a test to get green — report every expectation change + why.
- Fake secrets generated at runtime — no keys/tokens/chat/document bodies in code, logs, evidence, or prompts to sub-agents.
- Migrations that reached hosted are never edited — fixes go in a new migration.
- Fakes/mocks are labelled; mocked provider/DB cannot pass a real gate (e.g. P11 eval, P3 RLS matrix).
- Report results exactly, incl. what was not run and what is unproven.
- Inspect integrated code, not just worker reports — a worker's report is not evidence.
- When referencing code, use `file_path:line_number`.

## 12. References

- `CLAUDE.md:1` — full development contract (authoritative for roles, invariants, evidence)
- `rules.md:1` — working rules that override CLAUDE.md on CI/testing/debug
- `handover.md:1` — invariants, deployment model, open decisions, handover log
- `status.md:1` — live phase tracker & open items (`§3a`/`§3b`)
- `plan.md:1` — phased plan P0–P12 + admin integration §1a
- `DATABASE_SCHEMA.md` — shared data contract (grants/RLS matrix)
- `TECH_SPECS.md §9` — test matrix; `§8` — security controls
- `README.md:1` — project structure, local setup, CI, env vars, FDE/ deployment order
