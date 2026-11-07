# Status — ragbot_widget

> Last updated: **2026-11-07**
> Overall: **🟡 P0 to P5 approved by owner and on `main`. Migrations 001–011 applied to the hosted dev project (2026-11-07). Public signup still on, TOTP unknown (§3a bj). Next phase only on owner go-ahead.**
> Docs baseline: v1.0 (`PRD.md`). Plan: `plan.md`. Context: `handover.md`. Decisions: `docs/decisions/` (ADRs 0001–0017; ADR 0014 revises the provider parts of D1–D3).

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked

---

## 1. Phase tracker

| # | Phase | State | Blocker / note |
|---|---|---|---|
| P0 | Decisions & prerequisites | ✅ | D1–D14 approved and phase accepted by owner 2026-11-03 (ADRs 0001–0013). Open items carried forward: §3a |
| P1 | Monorepo scaffold & tooling | ✅ | Accepted by owner 2026-11-05. Acceptance criteria met. Committed and pushed as `f848fb3`. CI run 41698369772 completed/success. Local gates: `docs/evidence/P1/rerun-2026-11-04-providers/SUMMARY.md`. Integration and E2E: no tests yet. Open: §3a i–r |
| P2 | Shared contracts | ✅ | Accepted by owner 2026-11-05. Acceptance criteria met (schema unit tests incl. negatives; browser-safe build). On `main` @ `19438c5` (code `6b24002`). Contract changes: `EmbeddingProvider.embed` returns `{vectors, inputTokens}`; `ModerationResult` has usage; `temperature` removed from `ChatStreamRequest`. Final gates: unit 157 passed, 0 failed, 0 skipped; all npm gates exit 0. Open: §3a t, af |
| P3 | Database & storage migrations | ✅ | Accepted by owner 2026-11-05. Acceptance criteria met (every DB-level matrix cell has a passing test; API-level cells documented for P5/P9). On `main` @ `19438c5` (code `6b24002`). Security chain: P3-R1 → P3-D1 (`65cc738`) → re-review P3-R2 (14 of 15 fixed, M4 partial) → P3-D2 (`6b24002`) → P3-R3 (2026-11-05, static) → P3-D3 (2026-11-05, committed `815cfb9`; R3-1, R3-2, R3-3 fixed; migration 006, applied to remote dev project 2026-11-05) → P3-R4 (2026-11-05, static; no fixes made; not an approval; findings au–ba) → P3-D4 (committed as `e2a044e`); migration 007 later applied to the remote; outcomes §3a au–bh) → P3-R5 (static; P3-D4 fixes not re-reviewed, §3a bg). Final P3-D4 gates (local, Opus reruns): pgTAP 19 files, 1601 passed; unit 157; 14 race orderings; 80 guard tests; npm lint, format:check, typecheck, build, test exit 0. Final pgTAP on `6b24002`: 17 files, 1465 passed, 0 failed; `db lint` clean. P3-D3 local gates (recorded before commit `815cfb9`): pgTAP 18 files, 1485 passed, 0 failed; unit 157 passed; `db lint` clean; lint, format:check, typecheck, build exit 0. D-a, D-b, D-c resolved via ADR 0015, ADR 0016 and approved debug cycles (ADR 0016 confirmation open, §3a ag). Migrations 001–006 applied to remote dev project 2026-11-05 (§2). D1 validation check pending (§3a c). Open: §3a ac (partly), ad, ae, af, ag, ah, am, an, ao, at (partly), av, aw (partly), az, bb–bh. Resolved: ai, aj–al, ap, aq, ar, as, au, ax, ay, ba. Audit gaps (§3b) closed in P3-D5, except G-17 and G-28 (partly) and L-1, L-6 (open on the remote); migrations 007–010 applied to the remote 2026-11-06. |
| P3.5 | Admin data layer (ADR 0017) | ✅ | Accepted by owner 2026-11-06. On `main` and on the remote dev project (migrations 009, 010). Evidence: `docs/evidence/P3-D5/SUMMARY.md`, `docs/evidence/P3-D5-remote/SUMMARY.md`. Open: §3a bj to bm |
| P4 | API foundation | ✅ | Merge approved by owner 2026-11-06; on `main`. Evidence `docs/evidence/P4/SUMMARY.md`. Open: §3a bn, bo |
| P5 | Visitor sessions & abuse controls | ✅ | Approved by owner and merged to `main` 2026-11-07; migration 011 on the hosted dev project. Evidence `docs/evidence/P5/SUMMARY.md`, `docs/evidence/P5-remote/SUMMARY.md`. Open: §3a bp |
| P6 | Ingestion pipeline (worker) | ⬜ | OCR out of scope (ADR 0005); file limits set (ADR 0007); depends on P3.5 (ADR 0017). Obligations: `DATABASE_SCHEMA.md` Admin RPCs |
| P7 | Retrieval & chat | ⬜ | Providers decided (ADRs 0003, 0004); no independent fallback configured (§3a o); D1 validation pending (§3a c) |
| P7.5 | Caching & latency | ⬜ | D13 decided (ADR 0012); C7 answer cache off by default; schema additions go into P3 |
| P8 | Widget | ⬜ | Markdown off (ADR 0008), sessionStorage + history endpoint (ADR 0009), feedback deferred (ADR 0011); UI_SCHEMA §3/§7 edits pending |
| P9 | Analysis, entries, retention | ⬜ | Settings moved to P3.5 (ADR 0017). Retention periods set (ADR 0006); jurisdiction per client and DPAs open (§3a b) |
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
- [x] P2 (shared contracts) and P3 (DB migrations, seed, pgTAP) implemented in parallel with sonnet workers (worktrees, base `f848fb3`), verified and integrated by Opus into the main checkout. Later committed to `main` (see below). Logs (gitignored): `docs/evidence/P2-P3/`. Remote dev project untouched. `supabase test db` pulled the `pg_prove` Docker image over the network (CLI behaviour)
- [x] P3 debug cycles: P3-D1 (commit `65cc738`) fixed M1–M5, L1–L7, L9, L10, L13 and added census tests. Re-review P3-R2 found 14 of 15 P3-R1 items fixed, M4 partial, and new items N1–N9. P3-D2 (commit `6b24002`) fixed N1–N5 and N7, and completed M4 via N3 (durable reply pairing). Evidence: `docs/evidence/P2-P3/SUMMARY.md`
- [x] Final gates on code `6b24002` (branch `phase/p2-p3`, since removed): unit 157 passed, 0 failed, 0 skipped; pgTAP 17 files, 1465 passed, 0 failed; `db lint` clean; all npm gates exit 0. CI now runs pgTAP (`npm run test:db` after `supabase db reset`). CI for the P2/P3 commits: run 41708210161 (`19438c5`) and run 41974998511 (`0059991`) completed with success (overall results only; individual jobs not inspected; `0059991` contains the P3-D3 code; `815cfb9` has no run of its own)
- [x] Decisions encoded: ADR 0015 (MFA aal2 enforced in the DB, accepted); ADR 0016 (`data_entries` deleted with their conversation, accepted; owner confirmation open, §3a ag)
- [x] Cleanup: agent worktrees and their branches removed (`git worktree list` shows only the main checkout); temp logs removed; `.claude/worktrees/` is gitignored
- [x] Remote apply 2026-11-05 (owner-approved): migrations 001–005 applied to remote dev project `rbejeqwxyxtklehuzibv` via `supabase db push --remote --yes`. `seed.sql` not applied. Remote: 22 tables, RLS on all, 0 rows, migration history 001–005. Policies, public function definitions and table grants match local by md5. Not compared: column-level grants and function execute grants in full. pgTAP not run against remote. Remote Auth TOTP not checked (§3a ao). This CLI version targets the local stack unless `--remote` is passed, so `db push` without it does not touch the remote. From now on 001–005 must not be edited; schema changes go in new migrations. Evidence: `docs/evidence/P3-R3/SUMMARY.md`
- [x] Security review P3-R3 2026-11-05 (`security-reviewer`, static, `65cc738..6b24002`; Opus verified R3-1, R3-2, R3-3 and closed R3-5). Open findings §3a aj–ap. Not accepted by owner
- [x] P3-D3 2026-11-05 (committed `815cfb9` on `main`, on top of `19438c5`; Opus implemented, no worker): migration `006_reaper_settle_reply_lock.sql` (R3-1 reaper sets `expired`; R3-2 row lock on the reply target, `SECURITY INVOKER`), pgTAP `180_p3d3_fixes.test.sql` (20 tests), two assertions changed in `170`, R3-3 `DATABASE_SCHEMA.md` fixes. Gates: `make db-local`, `db-test` (18 files, 1485 passed), `db-lint`, npm gates exit 0. Two-connection race script `docs/evidence/P3-D3/race_reply_to.sh` (manual): three orderings consistent after the fix. Applied to the remote dev project 2026-11-05 (owner-approved; `supabase db push --remote=<ref> --yes`, exit 0; only 006 applied). Remote checks: public function definitions match local by md5; execute grants on the two changed functions match local; remote advisors unchanged after 006 (5 WARN and 13 INFO security; 34 INFO unused indexes; 1 INFO unindexed FK). pgTAP and the race script ran on the local stack only, not against the remote. Not security-reviewed. Evidence: `docs/evidence/P3-D3/SUMMARY.md`
- [x] Makefile, `database/` and FDE section in `README.md` (2026-11-05, committed in `815cfb9`). `make` wraps local and remote DB commands with explicit `PROJECT_REF`. `database/` holds symlinks into `supabase/`; the single migration history stays in `supabase/migrations`. Tested: `db-local`, `db-test`, `db-lint`, `db-plan`, `db-status`, input guards. Not run: `install`, `db-create`, `db-start`, `db-stop`, `db-advisors`. Evidence: `docs/evidence/P3-D3/SUMMARY.md`
- [x] Security review P3-R4 (2026-11-05; `security-reviewer`, static, read-only, configured `claude-sonnet-5-5`; Opus verified key claims) of P3-D3 (`815cfb9`, base `main` @ `0059991`). No fixes made; not an approval. Findings in §3a au–ba (ar resolved). Evidence: `docs/evidence/P3-R4/SUMMARY.md`.
- [x] Debug cycle P3-D4 (2026-11-05 to 2026-11-06; owner-approved; Opus integrated `sonnet-implementer` T1 and T2, self-reported) and security review P3-R5 (static). Completes the P3-R4 findings and open R3 notes; outcomes in §3a au–bh. Migration 007 local only, not applied to the remote dev project (§3a bb). P3-D4 on `main` (`e2a044e`). Evidence: `docs/evidence/P3-D4/SUMMARY.md`.
- [x] Owner accepted P1, P2 and P3 on 2026-11-05. P0 accepted 2026-11-03.
- [x] P0–P3 audit (5 read-only agents: AUD-P0, P1, P2, P3-S, AUD-P3-X; static, self-reported) and live database check (2026-11-06, read-only): the remote differs from the repo only by migration 007. Evidence: `docs/evidence/P3-AUD/SUMMARY.md`
- [x] P3-D5 and P3.5 built, tested and debugged locally (2026-11-06; owner-approved; local stack only; no remote write). Migrations 008 (G-1 to G-8), 009 and 010 added; 007 from P3-D4. Final gates (Opus reruns on the integrated tree): `make db-local` 0 (001–010 and dev seed); `make db-test` 0 (23 files, 2478 passed); `make db-lint` 0; `make db-race` 0 (26 orderings, 0 problems, 0 warnings); `make test-make` 0 (116 passed); `npm run test:integration` 0 (530 passed, incl. real TOTP and `aal2` sessions over HTTP, and 209 settings parity cases); `npm test` 0 (760 passed); lint, format:check, typecheck, build 0; secret scan self-test and scan 0, no hits; local `supabase db advisors` no issues (exit not captured). Owner acceptance pending. Evidence: `docs/evidence/P3-D5/SUMMARY.md`.
- [x] P3.5 reviews, static and self-reported: P3.5-R1 (`security-reviewer`), P3.5-R2 (`reviewer`), P3.5-R3 (`security-reviewer`). Defects they found were fixed in P3-D5 (list in the evidence). Final fixes after P3.5-R3 not re-reviewed (§3a bk). Not owner acceptance. Evidence: `docs/evidence/P3-D5/SUMMARY.md`.

- [x] Remote apply 2026-11-06 (owner-approved): migrations 007–010 applied to the dev project; history 001–010; catalog md5 identical to local; advisors as expected (19 WARN, the set in `database/README.md`). No seed. pgTAP and real sessions not run against the remote. Evidence: `docs/evidence/P3-D5-remote/SUMMARY.md`
- [x] P4 API foundation built, tested and debugged (2026-11-06; owner-approved; merged to `main` and pushed after owner approval). Final gates (Opus reruns, integrated tree; Node 24.22.2, Supabase CLI 3.0.0, local stack at migration 010): `npm run build` 0; `make db-local` and `make db-test` 0 (23 files, 2478 passed); `make db-lint` 0; `make db-race` 0 (26 orderings, 0 problems); `make test-make` 0 (116 passed); `npm run test:integration` 0 (576 passed); `npm test` 0 (1232 passed); `node scripts/api-smoke.mjs` 0 (25 passed); lint, format:check, typecheck 0; secret-scan self-test and scan 0, no hits. Evidence: `docs/evidence/P4/SUMMARY.md`. Awaiting owner approval.
- [x] P5 visitor sessions and abuse controls built, tested and debugged (2026-11-07; owner-approved; merged to `main` and pushed; migration 011 applied to the hosted dev project). Migration 011 local only, not on the hosted dev project. Final gates (Opus runs on the merged tree; Node 24.22.2, Supabase CLI 3.0.0, local stack at migration 011): `npm run build` 0; `make db-local` and `make db-test` 0 (24 files, 2639 passed); `make db-lint` 0; `make test-make` 0 (116 passed); `npm run test:integration` 0 (612 passed); `npm test` 0 (1515 passed); `node scripts/api-smoke.mjs` 0 (35 passed); lint, format:check, typecheck 0; secret-scan self-test and scan 0, no hits; `make db-race` 0 (35 orderings, 0 problems, at `9847aac`, before P5-D2). The owner stopped the race suite before it finished, so it was **not re-run on the final tree**. Reviews P5-R1, R2, R3 are static and self-reported. Evidence: `docs/evidence/P5/SUMMARY.md`.

- [x] P5 closed 2026-11-07: owner approved; migration 011 applied to the hosted dev project (schema matches local; advisors unchanged); `phase/p5` merged to `main`. Evidence: `docs/evidence/P5-remote/SUMMARY.md`

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
- **g)** ~~Nothing committed~~ P0 committed as `5e416b6`. P1 committed as `f848fb3`.
- **h)** ~~Docker not installed~~ Resolved 2026-11-04: Docker installed by owner; local stack verified (§2).
- **i)** ~~No secret scanner in CI yet (proposed for P10).~~ Resolved in P3-D5: `scripts/secret-scan.sh` (heuristic, S-10 in §3a bl); no hits on the integrated tree.
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
- **t)** P2 contract notes: invented request/response shapes for admin, session and entry routes and job payloads need confirmation. Model evidence flag is the first line `EVIDENCE: SUFFICIENT/INSUFFICIENT`; P7 must hold that line back. Settings cross-field validation must re-run on the merged config (P3.5, ADR 0017).
- **u)** ~~M1~~ Resolved in P3-D1 (ADR 0015: aal2 enforced in the DB for every private read and the three aggregate RPCs; see DATABASE_SCHEMA "Security hardening (debug cycle P3-D1)").
- **v)** ~~M2~~ Resolved in P3-D1 (embedding guard: activation and match check the model; changing the model while chunks exist raises RB012).
- **w)** ~~M3~~ Resolved in P3-D1 (ADR 0016: `data_entries` deleted with their conversation; orphans purged by `purge_expired_data_entries`). Owner confirmation open (§3a ag).
- **x)** ~~L1~~ Resolved in P3-D1 (`audit_logs` append-only; service role has SELECT and INSERT only; TRUNCATE rejected in P3-D2).
- **y)** ~~M4 and M5~~ Resolved in P3-D1 and P3-D2 (M4 was partial after re-review P3-R2 and was completed by P3-D2 N3; M5 is the atomic `begin_request_run`). Real multi-connection tests still open (§3a ac).
- **z)** Deferred by decision: L8, L11, L12, L14, N6, N9; purge fail-closed-for-all-bots is a design choice. Other lows (L2–L7, L9, L10, L13; N1–N5, N7) fixed in P3-D1 and P3-D2.
- **aa)** Partly resolved: census tests added in P3-D1 (column-level grant census gap). Real concurrency tests moved to §3a ac. Integration (vitest) and E2E still have no tests.
- **ab)** Owner decisions resolved: **D-a** via ADR 0015 (MFA aal2 enforced in the DB). **D-b** via ADR 0016 (`data_entries` cascade with the conversation; confirmation open, §3a ag). **D-c** via approved debug cycles P3-D1 (`65cc738`) and P3-D2 (`6b24002`).
- **ac)** ~~Partly resolved in P3-D4: reaper races are covered in `scripts/race-db.sh` (also in CI). `begin_request_run`, `claim_jobs` and rate limit races remain open. Planned for P5/P6.~~ Resolved in P3-D5: 26 race orderings pass (`make db-race`). Remaining: same-job reserve and retry against a running worker; stale settle under load (§3a bk).
- **ad)** MFA: Supabase Auth TOTP must be enabled per client project, and admins must enrol. ~~Real GoTrue aal2 tokens are not tested (claims are forged in tests).~~ Partly resolved in P3-D5: real `aal2` sessions and TOTP tested locally (integration gate). Remote TOTP open (§3a bj, §3b O-4). P9/P12.
- **ae)** API obligations from P3: set `messages.reply_to_message_id` on assistant inserts; ~~pass `token_version` to `begin_request_run`; use the 2-arg release and 3-arg settle~~ Done in P5. Cleanup scheduling stays open: schedule `expire_stuck_request_runs`, `expire_visitor_sessions(batch, grace)`, `purge_expired_data_entries` and `purge_expired_caches` in the worker cleanup job. P6/P9.
- **af)** P2 contract notes (item t) still open for P4 and later.
- **ag)** Owner to confirm ADR 0016 (`data_entries` retention: cascade with the conversation). Accepted; confirmation still open.
- **ah)** API-level matrix cells are not covered at DB level: field-level settings RPC (P3.5, ADR 0017), management API, audit redaction, signed URLs. Documented for P5/P9.
- **ai)** ~~P3-D2 was verified by tests and an Opus code read only. It has not been separately security-reviewed.~~ Resolved by P3-R3 (2026-11-05, static review; findings aj–am).
- **aj)** ~~R3-1 (Medium, confirmed, reproduced locally): `expire_stuck_request_runs` sets reservations to `released`, so a slow request's settle fails RB003 and real spend is not counted toward the cap. Fix proposed (new migration: reaper sets `expired`; pgTAP case for reap then settle), not implemented. Needs an owner-approved debug cycle.~~ Fixed in P3-D3 (migration 006, `815cfb9`); applied to the remote dev project 2026-11-05.
- **ak)** ~~R3-2 (Low, confirmed by code read; race not exercised): `messages_check_reply_to` takes no lock and skips its check if the target is not visible. Needs a writer that does not exist today. Fix proposed, not implemented.~~ Fixed in P3-D3 (migration 006, `815cfb9`); applied to the remote dev project 2026-11-05. Row lock used instead of the reviewer's composite foreign key; race tested with two connections.
- **al)** ~~R3-3 (doc): `DATABASE_SCHEMA.md` Budget line contradicts the later settle line, and Request start still shows the old 4-argument `begin_request_run`. Not edited yet.~~ Done in P3-D3.
- **am)** API obligations from P3-R3 for P5: a late settle can exceed the cap, by design; it counts toward the UTC day the reservation was created; settle is not idempotent; the API must update `request_runs` only conditionally (`WHERE state IN ('reserved','running')`), a state-transition guard now exists (007), ~~and conditional updates are still required (reviewer note, not verified)~~ conditional run updates done in P5 (`set_request_run_state`). The worker reaper threshold must exceed the maximum request duration: open for P7 (§3a av).
- **an)** Remote advisors after apply (2026-11-05): 5 WARN and 13 INFO security, 34 INFO unused indexes, 1 INFO unindexed FK. `request_runs_session_fk` is a false positive (tested; see evidence). Proposed extra index not added (Opus recommendation; owner has not decided). Admin panel read needs for `admin_memberships`, `bot_profiles`, `client_settings` to be confirmed by P9.
- **ao)** Remote Auth TOTP setting not checked. Related to item ad. Public settings checked 2026-11-06; TOTP still unknown, see bi.
- **ap)** ~~Reviewer notes not verified: R3-4, R3-6 to R3-9, and the listed test gaps. See `docs/evidence/P3-R3/SUMMARY.md`.~~ Resolved in P3-D4: R3-4 and R3-9 fixed; R3-6 tested with a defect left open (bc); R3-7 reviewed and documented; R3-8 closed as by design (owner may still want a policy).
- **aq)** ~~Migration 006 is not applied to the remote dev project, so the remote still has the R3-1 and R3-2 behaviour. Applying it needs owner approval: `make db-create PROJECT_REF=<ref>` or `supabase db push --remote=<ref>`.~~ Done 2026-11-05.
- **ar)** ~~P3-D3 has not been security-reviewed. Verified by tests, a two-connection race script and an Opus code read.~~ Resolved by P3-R4 (2026-11-05, static review). No fixes made; the review is not an approval.
- **as)** ~~The race script `docs/evidence/P3-D3/race_reply_to.sh` is manual and not in `make db-test` or CI.~~ ~~Resolved in P3-D4: race checks are in `scripts/race-db.sh` and CI. A writer now needs UPDATE on `messages` for the reply lock.~~ Race checks now also run as `make db-race` (P3-D5).
- **at)** Partly resolved in P3-D4: `db-status` and `db-advisors` have been run (remote, read-only). Not run: `install`, `db-create`, `db-start`, `db-stop`. Makefile otherwise not fully exercised, and no `make` target has been run against a project this machine is not linked to (`db-status` and `db-advisors` ran on the linked dev project) (P3-R4 ran `supabase migration list` directly with a placeholder ref: the ref was honoured, then the connection failed). Try `db-create` once on a throwaway project before an FDE relies on it.
- **au)** ~~R4-3 (Low-Medium, raised from Low; confirmed by execution): `check-ref` shell injection and exported `PROJECT_REF`. Fix proposed, not implemented.~~ Resolved in P3-D4 (took two attempts: shell injection, then make-function expansion; refs reach recipes only through the environment). `MAKEFLAGS` route: see bd.
- **av)** R4-2 (Low-Medium, confirmed by code read): reaper threshold not tied to max request duration. P5/P9 obligation, or a new migration. Owner decides. P3-D4: overshoot and UTC-day behaviour pinned by tests in 190. Hard request deadline stays a P5/P9 obligation. Stays open (P7).
- **aw)** R4-1 (Low, lowered from Medium): main claim refuted; the CLI honours `--remote=<ref>` on `migration list`. Partly resolved in P3-D4: typed confirmation added (`CONFIRM_REF` on `db-create`). `db push` with a non-linked ref still not run.
- **ax)** ~~R4-4 (Low, confirmed): race coverage is INSERT-only and manual; CI lock check is a regex.~~ Resolved in P3-D4: 14 orderings including UPDATE and DELETE paths, now in CI through `scripts/race-db.sh`; stricter lock assertion in 180.
- **ay)** ~~R4-6 (Low/Info, confirmed by code read, unreachable today): first trigger branch runs under invoker RLS. Only `service_role` writes today.~~ Resolved in P3-D4: catalog test limits INSERT and UPDATE on `messages`.
- **az)** R4-5 (Low, hypothesis, not tested): possible `FOR SHARE` deadlock. P5 obligation. P3-D4: still a hypothesis; recorded as a P5 obligation. Partly done in P5: race orderings for operator settings edits and corpus bumps added; load contention untested (P11).
- **ba)** ~~R4-7, R4-8, R4-9 (Info) and the reviewer's missing test list: see evidence, not triaged.~~ Resolved in P3-D4 (R4-7, R4-8, R4-9; see `docs/evidence/P3-D4/SUMMARY.md`). The reviewer's missing test list is covered in pgTAP 190 and `scripts/race-db.sh`, except the gaps in `docs/evidence/P3-D4/SUMMARY.md`.
- **bb)** Migration 007 is not applied to the remote dev project. Applying it needs owner approval; run advisors after.
- **bc)** `knowledge_gaps` defect (R3-6): after a question is deleted, an answer with no `request_id` pairs with an earlier question it did not answer. Report accuracy only, same conversation. No migration deletes single messages today. Pinned by a test, not fixed.
- **bd)** `MAKEFLAGS` route: `MAKEFLAGS='-- PROJECT_REF=<valid>'` in the environment counts as a command-line value, so the "exported value is refused" rule does not apply. Not fixable in make. The value must still pass the format check, cannot contain `$`, and is printed as the target.
- **be)** Reserve retry past TTL (reviewer note, not verified): the early return hands back a `reserved` reservation past its TTL, which no longer counts toward the cap.
- **bf)** ~~P5 obligation (R5-6): reserve in its own transaction, update the run only after it commits. Set `lock_timeout`, retry on 40P01.~~ Done in P5: separate RPC transactions, `lock_timeout`, retry on 40P01 and 55P03.
- **bg)** P3-R5 fixes not re-reviewed. Verified by tests and Opus only; P3-R5 itself was static.
- **bh)** ~~`plan.md` admin panel edits, other doc edits and ADR 0017 uncommitted.~~ Committed to `main` 2026-11-06 on the owner's instruction. Owner approval of P3.5 scope and the `plan.md` §1a rulings is still open (§3b O-5).
- **bi)** Remote Auth: signup is on, email confirmation required, TOTP not visible from the public endpoint (see §3b O-3, O-4).
- **bj)** Remote: migrations 007–010 applied 2026-11-06, schema matches local. Signup still on and TOTP unknown; both need the Supabase dashboard (§3b O-3, O-4).
- **bk)** Not done or not proven (P3-D5, `docs/evidence/P3-D5/SUMMARY.md`): mutation checks on the real-session suite not run; final fixes after P3.5-R3 not re-reviewed; three untested races (same job reserved twice, retry racing a running worker, stale settle under load).
- **bl)** Reviewer items left open (P3-D5): R3-4 and R3-5 (P6; recorded in `DATABASE_SCHEMA.md` per the evidence), R3-6 (URLs get no format-character check), ~~R3-7 (some operator faults map to caller-class codes; revisit in P4)~~ Resolved in P4 (server faults use `INTERNAL_ERROR`), S-10 (the secret scan is a heuristic).
- **bm)** Admin panel must run `contracts:sync`: `/v1/admin/*` types are gone, `AdminBotSettingsPatch` is now `BotSettingsPatch`, and there is a new error map and RPC schemas. The admin repo was not read.
- **bn)** P4 not proven (`docs/evidence/P4/SUMMARY.md`): P4-D2 and P4-D3 not independently re-reviewed (covered by tests and Opus integration). No mutation run across the API suite (individual fixes shown to fail on old code by workers; self-reported). Not on a real host: `TRUSTED_PROXY_HOPS` not measured on Render; no Render deploy; API not run against the hosted database. `REQUEST_TIMEOUT_MS` firing not tested (Node's check interval is 30 seconds). Redaction is a name list, four levels deep; later routes must log only ids, counts and codes.
- **bo)** Later-phase obligations from P4: see `plan.md` P4 section.
- **bp)** P5 not proven (`docs/evidence/P5/SUMMARY.md`): race suite not re-run on the final tree (owner stopped it); rule-following race ordering waits about 1.8 s against a 2 s lock timeout and may flake on a slow machine; Turnstile never called for real (fake verifier only), and the widget must render it with action `session_create` (not built yet); shared NAT: the per-IP preflight is shared across bots, so keep `SESSION_PREFLIGHT_PER_IP_LIMIT` well above the per-bot per-IP limit; a wrong `TRUSTED_PROXY_HOPS` puts everyone in one bucket, and measuring it on Render stays a P10 gate; `FOR SHARE` contention under load untested (P11); `rate_limit_buckets` grows under IPv6 rotation until P6 schedules `purge_expired_rate_limit_buckets`; the plan's `Db` insert, update and list methods were replaced by service-role RPCs (design deviation).
- **bq)** ~~Migration 011 is not on the hosted dev project (still at 010). Applying it needs owner approval; run `get_advisors` after.~~ Done 2026-11-07: 011 applied, schema matches local, advisors unchanged.

### 3b. P3-D5 backlog

These are the gaps to close before the next phase. The list covers what was found, not everything that exists. Source: `docs/evidence/P3-AUD/SUMMARY.md` (authoritative).

Key: **E** by execution · **R** by Opus read (code or live catalog) · **A** auditor report only.

**Database (migration 008, plus 007 on local first)**

| ID | Severity | Verified | Gap |
|---|---|---|---|
| G-1 | High | E | `mark_document_deleted` writes `{document_id, bot_id}`; `jobSchema` rejects it |
| G-2 | Medium | R | Nothing increments `settings_version` |
| G-3 | Medium | R | `jobs.dedupe_key` is unique forever, and `on conflict do nothing` hides it |
| G-4 | Low-Medium | R | `message_sources` can reference another bot's chunk or version |
| G-5 | Medium | R | Members can read `system` messages |
| G-6 | Medium | A | No `failure_code`, `batches_done`, `batches_total`, `chunking_version`, `extraction_version` on `document_versions` |
| G-7 | Low | A | Terminal `jobs` rows are never purged |
| G-8 | Low | A | `document_versions.storage_path` has no pattern CHECK |

**Tests**

| ID | Severity | Verified | Gap |
|---|---|---|---|
| G-9 | Medium | A | `query_embedding_cache` purge not exercised; argument bounds missing on 4 purge RPCs and on `expire_visitor_sessions` above 10000; no source-deletion snapshot test; no `data_entries_conversation_fk` test |
| G-10 | Medium | R | No race tests for `claim_jobs`, `begin_request_run`, `record_rate_limit_attempt` or parallel budget reservation |
| G-11 | Medium | A | No tests for session schemas, admin schemas, `idParamSchema`; happy-path only for `sourceRefSchema`; chat strictness doesn't name `role`, `usage`, `sources`, `citations`, `provider`, `temperature`; no NUL case |
| G-12 | Low | A | The enum test checks TypeScript copies, so SQL drift goes unnoticed. Compare against the migrations |
| G-13 | Medium | A | Storage negative tests lack `aal2`, and the policy census matches text only |

**Shared contracts**

| ID | Severity | Verified | Gap |
|---|---|---|---|
| G-14 | High for P3.5 | A | No SQLSTATE-to-error mapping in `shared`; `RB0xx`, `begin_request_run` outcomes and B-11 codes absent |
| G-15 | Medium | E | `excerpt` rejects newlines and `a > b`. Specify a normaliser or loosen it |
| G-16 | Medium | A | Mark `/v1/admin/*` shapes `@deprecated`. Removal stays in P3.5 |
| G-17 | Medium | A | Invented shapes unconfirmed. History `has_more` has no cursor; idempotent replay response undefined |
| G-18 | Low | A | Policy JSON keys SQL depends on have no contract in `shared` |

**Tooling and CI**

| ID | Severity | Verified | Gap |
|---|---|---|---|
| G-19 | High | E | `test:integration` passes with zero tests; `test:e2e` exits 1 with zero tests and isn't in CI; no secret scan |
| G-20 | Medium | R | API and worker dev scripts share root `.env`. The secret isn't there today. Load per workspace; worker refuses `VISITOR_TOKEN_SECRET` |
| G-21 | Medium | R | 45 evidence `.log` files ignored by git, and none are tracked for P1, while summaries cite them |
| G-22 | Low | R | ESLint doesn't ignore `.claude/**`; CI has no `db lint`; no `--max-warnings 0` |
| G-23 | Medium | R | Operator script for the first admin is missing (`plan.md:126`). Add it, with a test that a new owner at `aal1` sees nothing |
| G-24 | Medium | R | Local TOTP off, no admin dev redirect, no test-user fixture. No real `aal2` test possible until done |

**Docs**

| ID | Gap |
|---|---|
| G-25 | `DATABASE_SCHEMA`: "Restricted management API" and "only the service role writes" audit rows predate ADR 0017; RB012 and RB013 missing; `is_published` and `reply_to_message_id` missing from Tables |
| G-26 | `README` layout: mark the tree as cumulative by phase; add missing files; migrations stop at 005; "no runnable application code" is stale |
| G-27 | `PRD` open decisions; `plan.md` P3 table stops at 005, D12–D14 missing; ADR 0012 and 0006 need Gemini notes; ADR 0001 stale |
| G-28 | `TECH_SPECS:80` "All caches are bot-scoped" conflicts with tables that have no `bot_id`; `plan.md:244` index differs; P5 "one generation per conversation" has no schema support; `usage_events` lacks a failed or fallback flag |
| G-29 | Name the feature-flag keys for moderation mode, Turnstile, Markdown and history in `DATABASE_SCHEMA` |

**Owner decisions**

| ID | Decision | Blocks |
|---|---|---|
| O-1 | ~~Approve P3-D5 scope~~ Done 2026-11-06: owner approved ("I approve all necessary changes") | P3-D5 |
| O-2 | ~~Apply 007 and 008 to the remote~~ Done 2026-11-06: 007–010 applied | Remote compliance |
| O-3 | Turn off public signup on the remote (L-6) | P3.5 acceptance |
| O-4 | Check remote TOTP in the dashboard; disable phone MFA | P3.5 acceptance |
| O-5 | ~~Approve P3.5 scope and the `plan.md` §1a rulings; no ADR covers them~~ Done 2026-11-06: owner approved ("I approve all necessary changes") | P3.5 |
| O-6 | ~~Commit the doc edits and ADR 0017~~ Done 2026-11-06 | Doc baseline |
| O-7 | Confirm ADR 0016 | Retention |
| O-8 | Blocked text for analysts: policy, or accept (R3-8) | P7 |
| O-9 | `audit_logs` retention policy | P9 |
| O-10 | Run the embedding retrieval check before corpus grows; 1536 is live | P6 |
| O-11 | P3.5 before P4, or in parallel | Sequencing |

**Live non-compliance (2026-11-06 check)**
- L-1: Fixed: 007–010 applied to the remote 2026-11-06.
- L-2: Fixed: admin write RPCs are on the remote (2026-11-06).
- L-3: Fixed: `storage.objects` policies are on the remote, `to authenticated` only (2026-11-06).
- L-4: Fixed: `messages_select_members` excludes `system` rows on the remote (2026-11-06).
- L-5: Fixed: `admin_get_settings` reads unpublished bots on the remote (2026-11-06).
- L-6: **Open:** public signup is on (`disable_signup: false`). Needs the Supabase dashboard (O-3).
- L-7: Fixed: admin RPCs write `audit_logs` through `admin_audit` on the remote (2026-11-06).

**Stays in P3.5, by design:** L-2, L-3, L-5, L-7 (admin RPCs, Storage policies, safe settings read, audit writes), plus the settings parity fixture (P2-5, P3X-9), quotas on admin RPCs (P3X-4), reindex by new version (P3X-3), audit metadata allowlist (P3X-8), census allowlist, removal of admin shapes, and the enable-time contact gate (P3S-7).

**Before client data or go-live only:** production daily cap; jurisdiction and DPAs; paid Gemini billing; second provider key; Cloudflare details; per-client contacts; Render and Vercel accounts and spend caps; `jwt_expiry` and session limits.

**Status (P3-D5 outcome, 2026-11-06, local):** G-1 to G-16, G-18 to G-27 and G-29 closed. G-17 and G-28 partly closed: G-17 has a `before` cursor and replay shape, but the shapes stay unconfirmed by the owner (§3a t); G-28 doc conflicts are fixed, and the `usage_events` failed or fallback flag is deferred to P7. Migrations 007–010 are not applied to the remote. Evidence: `docs/evidence/P3-D5/SUMMARY.md`.

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
1. Owner turns off public signup and checks TOTP in the Supabase dashboard (§3b O-3, O-4).
2. Admin panel runs `contracts:sync` (§3a bm).
3. Keep the existing items: ADR 0016 (§3a ag); paid-tier Gemini billing before any client data (n); a second provider key for independent fallback (o); the production daily cap (a); jurisdiction per client and DPAs (b); the embedding retrieval check (c).
4. P6 only on owner go-ahead; obligations in `plan.md` P4 section and §3a ae, ac, av, az, bf.

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
| 2026-11-05 | Remote apply (owner-approved): migrations 001–005 applied to dev project `rbejeqwxyxtklehuzibv` via `supabase db push --remote`; `seed.sql` not applied; 22 tables, RLS on all, 0 rows. Security review P3-R3 (static): aj–am open, ai resolved; debug-cycle and `006` index decisions pending (§7). Branch `phase/p2-p3` no longer exists; P2/P3 on `main` at `19438c5` (code `6b24002`). CI for P2/P3 commits not checked. P1, P2 and P3 not accepted. Evidence: `docs/evidence/P3-R3/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC3). |
| 2026-11-05 | P3-D3 (owner-approved; Opus implemented): migration 006 fixes R3-1 and R3-2; R3-3 doc fixes; pgTAP 18 files, 1485 passed; unit 157; `db lint` clean; npm gates exit 0. Local, uncommitted; 006 not applied to remote; not security-reviewed. Makefile and `database/` added (uncommitted). P1, P2 and P3 not accepted. Evidence: `docs/evidence/P3-D3/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC4). |
| 2026-11-05 | P3-D3 committed as `815cfb9` on `main`. Migration 006 applied to remote dev project `rbejeqwxyxtklehuzibv` (owner-approved; `supabase db push --remote=<ref> --yes`; exit 0; only 006 applied). Remote history 001–006; public function definitions match local by md5; execute grants on the two changed functions match local; remote advisors unchanged. pgTAP and the race script ran on the local stack only. aj and ak fixed in P3-D3; aq done. P1, P2 and P3 not accepted; P3-D3 not security-reviewed (ar). Docs updated by `haiku-docs` (P3-DOC5). |
| 2026-11-05 | Owner accepted P1, P2 and P3. Security review P3-R4 (`security-reviewer`, static, read-only; Opus verified key claims) of P3-D3 (`815cfb9`): findings recorded as §3a au–ba (ar resolved); no fixes made; not an approval. CI: runs 41708210161 (`19438c5`) and 41974998511 (`0059991`) completed with success (overall results only; `815cfb9` has no run of its own). Uncommitted: `docs/evidence/P3-R4/SUMMARY.md` and these doc updates. Evidence: `docs/evidence/P3-R4/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC6). |
| 2026-11-06 | Debug cycle P3-D4 (owner-approved; Opus integrated `sonnet-implementer` T1 and T2) and static review P3-R5 done. Migration 007 local only, not applied to remote. Gates (local): pgTAP 19 files, 1601 passed; unit 157; 14 race orderings; 80 guard tests; npm gates exit 0. Remote read-only `db-status` and `db-advisors` run. P3-D4 on `main` (`e2a044e`). P3-R5 fixes not re-reviewed. P1, P2 and P3 accepted. Evidence: `docs/evidence/P3-D4/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC7). |
| 2026-11-06 | P0–P3 audit (AUD-P0, P1, P2, P3-S, AUD-P3-X; static, read-only, self-reported) and live database check (read-only, Opus): the remote differs from the repo only by migration 007. Findings in `status.md §3b`; P3.5 added (not started); P3-D5 required before the next phase; no fixes made. ADR 0017 (admin panel direct to Supabase) written, uncommitted. P3-D4 committed as `e2a044e`; CI run 42086386622 success, all steps. Evidence: `docs/evidence/P3-AUD/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC8). |
| 2026-11-06 | P3-D5 and P3.5 built, tested and debugged locally (owner-approved; local stack only; no remote write). Migrations 008–010 added; 007 from P3-D4; 007–010 local only, remote still at 006. Final gates in §2 (Opus reruns). Reviews P3.5-R1, R2, R3 (static, self-reported). Owner acceptance of P3.5 pending; open items §3a bj–bm and §3b. Evidence: `docs/evidence/P3-D5/SUMMARY.md`. Docs updated by `haiku-docs` (P3-DOC9). |
| 2026-11-06 | Remote apply (owner-approved): migrations 007–010 on dev project; schema matches local; advisors as expected. Signup still on, TOTP unknown. Evidence: `docs/evidence/P3-D5-remote/SUMMARY.md`. Recorded by Opus. |
| 2026-11-06 | Owner accepted P3.5 and started P4 (branch `phase/p4`, not on `main` until owner approval). Recorded by Opus. |
| 2026-11-06 | P4 API foundation built, tested and debugged on `phase/p4`; not on `main`, not pushed; awaiting owner approval. Final gates in §2; open items §3a bn, bo. Evidence: `docs/evidence/P4/SUMMARY.md`. Docs updated by `haiku-docs` (P4-DOC1). |
| 2026-11-06 | Owner approved merging P4; `phase/p4` merged to `main`. Recorded by Opus. |
| 2026-11-07 | P5 visitor sessions and abuse controls built, tested and debugged on `phase/p5`; not on `main`; awaiting owner approval. Migration 011 local only, not on the hosted project. Final gates in §2; race suite not re-run on the final tree. Open: §3a ae, am, av, az, bp, bq. Evidence: `docs/evidence/P5/SUMMARY.md`. Docs updated by `haiku-docs` (P5-DOC1). |
| 2026-11-07 | P5 closed: migration 011 applied to the hosted dev project; `phase/p5` merged to `main`. Recorded by Opus. |

## 9. Agent model record
- `haiku-docs`: configured `model: claude-haiku-5-5` (`.claude/agents/haiku-docs.md`). First spawn: P0-DOC1, 2026-11-03. The orchestrator cannot observe the actual model resolution. The worker's self-report is **unverified**.
- `reviewer`: no spawn recorded before 2026-11-06; first spawns 2026-11-06 (see the last entry below).
- 2026-11-04 (P1): no new agents spawned. P1 was implemented directly by Opus.
- 2026-11-04 (ADR 0014): no new agents spawned. The real Gemini calls were made by Opus, not by a worker.
- 2026-11-04 (Supabase local stack): no new agents spawned. The stack and MCP read-only checks were run by Opus.
- 2026-11-04 (P2 ∥ P3, first spawns): `sonnet-implementer` ×2 (P2-T1 and P3-T1; configured `claude-sonnet-5-5`; worktree isolation; base `f848fb3`). `security-reviewer` ×1 (P3-R1; configured `claude-sonnet-5-5`; read-only). Actual model resolution is not observable. Self-reports are **unverified**.
- 2026-11-04 (debug cycles P3-D1, P3-D2): `sonnet-implementer` ×2 more (P3-D1, P3-D2; configured `claude-sonnet-5-5`). P3-D1 first started from the wrong base, stopped correctly, and re-based. `security-reviewer` ×1 more (P3-R2). Self-reports are **unverified**. All results were verified by Opus reruns.
- 2026-11-05 (P3-R3, P3-DOC3): `security-reviewer` ×1 more (P3-R3; configured `claude-sonnet-5-5`; read-only). `haiku-docs` ×1 more (P3-DOC3; configured `claude-haiku-5-5`). Actual model resolution is not observable. Self-reports are **unverified**. Opus verified R3-1, R3-2 and R3-3, and closed R3-5.
- 2026-11-05 (P3-D3): no `sonnet-implementer` spawned; implemented by Opus. `haiku-docs` ×1 more (P3-DOC4; configured `claude-haiku-5-5`). Actual model resolution is not observable; self-reports are **unverified**.
- 2026-11-05 (P3-DOC5): `haiku-docs` ×1 more (configured `claude-haiku-5-5`). Actual model resolution is not observable; self-reports are **unverified**.
- 2026-11-05 (P3-R4, P3-DOC6): `security-reviewer` ×1 more (P3-R4; configured `claude-sonnet-5-5`; read-only, static). `haiku-docs` ×1 more (P3-DOC6; configured `claude-haiku-5-5`). Actual model resolution is not observable; self-reports are **unverified**.
- 2026-11-05/06 (P3-D4, P3-R5, P3-DOC7): `sonnet-implementer` ×2 more (P3-D4-T1, T2; configured `claude-sonnet-5-5`; worktrees, removed). `security-reviewer` ×1 more (P3-R5; configured `claude-sonnet-5-5`; read-only, static). `haiku-docs` ×1 more (P3-DOC7; configured `claude-haiku-5-5`). Actual model resolution is not observable; self-reports are **unverified**. Results verified by Opus reruns.
- 2026-11-06 (P3-AUD, P3-DOC8): `reviewer` ×4 (first spawns; AUD-P0, P1, P2, P3-S; configured `claude-sonnet-5-5`; read-only). `security-reviewer` ×1 more (AUD-P3-X; configured `claude-sonnet-5-5`; read-only, static). `haiku-docs` ×1 more (P3-DOC8; configured `claude-haiku-5-5`). Actual model resolution not observable; self-reports **unverified**.
- 2026-11-06 (P3-D5, P3.5, P3-DOC9): `sonnet-implementer` ×8 more (P3-D5-T1 to T3, P3.5-T1 to T3, P35-D1-A, B; configured `claude-sonnet-5-5`). `security-reviewer` ×2 more (P3.5-R1, R3; configured `claude-sonnet-5-5`). `reviewer` ×1 more (P3.5-R2; configured `claude-sonnet-5-5`). `haiku-docs` ×1 more (P3-DOC9; configured `claude-haiku-5-5`). Actual model resolution not observable; self-reports **unverified**; results verified by Opus reruns.
- 2026-11-06 (P4, P4-DOC1): `sonnet-implementer` ×5 more (P4-T1, T2, D1, D2, D3; configured `claude-sonnet-5-5`). `security-reviewer` ×2 more (P4-R1, R3). `reviewer` ×1 more (P4-R2). `haiku-docs` ×1 more (P4-DOC1; configured `claude-haiku-5-5`). Actual model resolution not observable; self-reports **unverified**; results verified by Opus reruns.
- 2026-11-07 (P5, P5-DOC1): `sonnet-implementer` ×5 more (P5-A, P5-B, P5-D1-A, P5-D1-B, P5-D2; configured `claude-sonnet-5-5`). `security-reviewer` ×2 more (P5-R1, R3). `reviewer` ×1 more (P5-R2). `haiku-docs` ×1 more (P5-DOC1; configured `claude-haiku-5-5`). Actual model resolution not observable; self-reports **unverified**; results verified by Opus reruns except where the evidence says otherwise.
