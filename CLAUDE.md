# ragbot_widget — development contract v0.1

> Adapted from the PWT Workbench contract v0.3 for this repo (Node/TypeScript monorepo + Supabase). Phase IDs are `plan.md` P0–P12; invariants are `handover.md §4`.

**Working rules:** read and follow `rules.md` (owner, 2026-11-08). It replaces CI with testing on this system, adds post-push verification, and makes the main session responsible for debug cycles. Where it differs from this file on CI, testing or starting debug cycles, `rules.md` wins: the main session starts and runs a debug cycle without waiting for approval, while merges, pushes and hosted changes still need the owner.

## Start/resume
Read `status.md`, `handover.md` and the active `plan.md` phase section; inspect actual Git/dirty-worktree state (`git status`, `git log -5`). Load only the spec sections the active phase needs (`PRD.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `TECH_SPECS.md`, `UI_SCHEMA.md`, `README.md`), not every doc each session. Preserve existing work. Never invent commits, test results, decisions or approvals. Open P0 decisions (`status.md §3`) are never guessed — a task that depends on one stops and asks.

## Roles
- **Human (owner)** owns phase scope, P0 decisions, debug authorisation, scope changes and next-phase acceptance.
- **Opus 5.5 (`claude-opus-5-5`, main session)** orchestrates, owns shared contracts and integration, runs all functional/regression checks itself, diagnoses failures and proposes fixes. Verify the actual configured model IDs; disclose unavailability/substitution.
- **Sonnet 5.5 workers** implement bounded assigned tasks/fixes with explicit file ownership and base revision. No self-approval, no phase progression, no unapproved shared-contract changes. Spawned as `sonnet-implementer`.
- **Haiku 5.5 documentation worker** drafts/updates only `status.md` and `handover.md` (and explicitly assigned phase-report drafts under `docs/reports/`) from Opus's structured evidence packet. No code/spec/plan edits, no independent pass/fail/security judgements. Opus validates its diff before accepting the checkpoint. One documentation writer at a time. Spawned as `haiku-docs`.
- Runtime chat/embedding/moderation providers (P0 D1–D3) are separate from the coding agents.

## Sub-agents (`.claude/agents/`)
| Agent | Model (pinned) | Tools | Use |
|---|---|---|---|
| `sonnet-implementer` | `claude-sonnet-5-5` | Read, Write, Edit, Glob, Grep, Bash, SendMessage, ListAgents | Implementation inside an owner-approved phase/debug cycle only |
| `haiku-docs` | `claude-haiku-5-5` | Read, Edit, Write | `status.md` / `handover.md` checkpoints from an evidence packet |
| `reviewer` | `claude-sonnet-5-5` | Read, Grep, Glob | Read-only correctness/spec-conformance review of a diff |
| `security-reviewer` | `claude-sonnet-5-5` | Read, Grep, Glob | Read-only review against `handover.md §4` invariants and TECH_SPECS §8 |

Workers get **no** Supabase MCP tools — only Opus touches the live project.

### Assignment packet (required for every spawn)
Missing any item → do not spawn.
1. **Task ID** — `P<n>-T<k>` (or `P<n>-D<k>` for a debug fix).
2. **Base** — branch + commit SHA.
3. **Owned files** — exact paths/globs the worker may create or modify, exclusively.
4. **Frozen contracts** — files it must read but not change (e.g. `shared/src/contracts.ts`, `supabase/migrations/*`).
5. **Spec references** — the doc sections it implements (e.g. `TECH_SPECS §4`, `DATABASE_SCHEMA` grants matrix).
6. **Tests to add** — named cases, incl. negative cases from TECH_SPECS §9.
7. **Permitted commands / network** — default: none beyond read-only shell and the project's local test/lint/typecheck scripts once they exist; no network.
8. **Stop condition** — what "done" means, and when to stop and report instead (blocked, contract change needed, ambiguity).
9. **Report format** — files changed, commands run with exit codes, tests added, open questions, known gaps. Self-reported only.

### Concurrency
- From P1: up to three mutating workers, only where `plan.md §1` dependencies allow (e.g. P6 ∥ P8 after P5 and frozen P2 contracts), each with disjoint owned files, its own worktree/branch (`isolation: "worktree"`) and a common baseline commit. Otherwise one at a time.
- Workers never commit, push, install dependencies, fetch, run migrations against any remote, or call real provider APIs unless the packet grants it explicitly.

### Opus-owned shared contracts (workers never edit unless the packet names them)
`shared/src/{contracts,schemas,providers,prompts}.ts` and the error-code enum · `supabase/migrations/**`, `supabase/seed.sql` · root `package.json`, `package-lock.json`, `tsconfig*.json`, `.nvmrc`, lint/format config, CI workflows · `.env.example` files · all spec docs, `plan.md`, `status.md`, `handover.md`, `docs/decisions/**`, `CLAUDE.md`, `.claude/**`.

### Model recording
At the first spawn of each agent, record in `status.md`: the configured `model:` value, any observable resolution or substitution, and that the worker's self-report is unverified.

## Phase loop
An explicitly approved phase includes its scoped implementation **and** the local functional/regression checks listed for it in `plan.md`. Opus: delegate → integrate → verify → report → `haiku-docs` updates continuity → Opus validates the docs diff → **STOP for the owner**.

A failing check does not authorise repairs. Report confirmed bugs separately from hypotheses, with severity, evidence and a bounded proposed fix. An owner-approved debug cycle covers the named fixes plus retests, then the same report/document/stop loop. Two unsuccessful cycles on the same defect → revised diagnosis and an owner decision, not more retries. No automatic next phase, even when every gate passes.

Separate owner permission is always needed for: real provider API calls or client data; dependency installs; destructive operations; commits, pushes, merges, PRs; any Render/Vercel deploy; any Supabase write (below). Do not enable permission bypass. This Markdown is guidance, not a sandbox.

## Supabase (live project via MCP)
- Project ref `rbejeqwxyxtklehuzibv` is a **remote** dev project. Changes made through MCP are immediate.
- Free, read-only: `list_tables`, `list_migrations`, `list_extensions`, `get_advisors`, `get_logs`/`query_logs`, `get_project_url`, `search_docs`, `execute_sql` with `SELECT`-only statements.
- Owner approval per action: `apply_migration`, any non-`SELECT` `execute_sql`, enabling extensions, branch create/merge/reset/delete, secrets, `deploy_edge_function` (none are planned — `ARCHITECTURE §2`).
- Every schema change exists first as a file in `supabase/migrations/` (single migration history, `handover.md §4.16`) and is tested on the local stack (`supabase start` / `supabase db reset`) or a Supabase branch before it is applied to the dev project. Never hand-edit the remote schema without a matching migration file.
- After applying any migration, run `get_advisors` (security + performance) and report findings.
- Load the `supabase` and `supabase-postgres-best-practices` skills before writing migrations, RLS policies or RPCs.

## Invariants
`handover.md §4` (1–16) is binding for all agents. In addition:
- No raw keys, secrets, visitor tokens, chat content or document bodies in code, configs, logs, reports, docs, commits or prompts to sub-agents. `.env*` stays gitignored except `.env.example` with placeholder values.
- Missing config/limits/decisions fail closed — in code and in agent behaviour.
- Mocks and fakes are labelled and never satisfy a real acceptance gate (e.g. a mocked provider cannot pass the P11 evaluation gate; a mocked DB cannot pass the P3 RLS matrix).
- Pin everything: exact Node LTS, exact dependency versions, committed lockfile; no `latest`.
- No blanket "all green = done/secure". Manual checks and untested matrix cells stay listed explicitly.

## Verification/evidence
Before P1 scaffolding exists, all `npm`/`supabase` commands are unverified proposals. After scaffolding, verify each command (`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `supabase db reset`, integration/E2E runners, secret scan) actually works before relying on it as a gate.

For every check record: command, cwd, environment (Node version, local stack vs remote), Git revision, exit code, pass/fail/skip counts, evidence paths, manual-pending checks and known limitations. Do not weaken assertions or delete regression cases to get green. Inspect the integrated code, not just worker reports — a worker's report is not evidence. Archive long logs under `docs/evidence/<phase>/`; keep `status.md` and `handover.md` compact and truthful.
