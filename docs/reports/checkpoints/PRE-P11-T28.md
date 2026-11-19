# T28 - final documentation and handoff (STOP BEFORE P11)

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay (now including this program's harness/support changes), Node26.13.1.
No hosted/provider/release/commit action. No product change in T28 (docs and
evidence sync only). Local schema 027, hosted-last 017 unchanged.

What this program did (2026-11-19, owner-continued, one checkpoint per task):
- T18b first-admin 21/21; T18c settings-parity 264/264 + helper 8/8; T18d
  admin-real-session 244/244; T18e api-wiring 10/10 + limits/visitor-auth
  40/40; T18f ingestion-e2e + chat-e2e 82/82 + worker-runtime 7/7 (4
  worker-drain cases diagnosed as Windows-harness, routed to T20);
  ingestion-process.log archived at `docs/evidence/T18f/`.
- T19: dropped deprecated `--local` from `db-lint` (lint clean); guard script
  111/116 via Git Bash (5 fail only on absent `make` binary — install needs
  owner approval); WSL broken, Makefile itself unrunnable here.
- T20: POSIX-only guards for the 6 signal-delivery scenarios (2 smoke + 4
  worker-process); smoke 33/0/2 skipped, ingestion-process 6/4 skipped;
  POSIX assertions intact.
- T21: self-test 27/27; tracked scan 1 known owner-kept demo hit;
  untracked 14 classified by location only (values never printed).
- T22: clean reset + combined analysis 18/18.
- T23: restore-checker 18/18, widget 73/73, shared/policy 1140/1140;
  restore-test URLs confirmed runtime-generated fakes; bundle raw 497021 /
  gzip 106721 bytes (perf unmeasured = P11).
- T24: build/lint/format/typecheck all exit 0 (TEMP profiler lint fix +
  7-file prettier normalization incl. T20/T18a lineage; semantics re-proven).
- T25: replay/pgTAP 37/3671/lint/advisors PASS; race OPEN (npipe guard fixed;
  4 runs 14/4/8/10 problems, confirmed 3.5-7s docker-exec overhead vs
  sub-second harness margins, zero data violations in 204 orderings).
  Race logs archived at `docs/evidence/T25/race-run{1,2}.log` (T25 checkpoint
  cites pre-move Temp paths; canonical locations are these).
- T26: single-command full gates blocked by host OOM (0.5/7.7 GB free, node
  spawn up to 24s, 43+ 5s-timeouts); ALL failing unit files green alone
  (incl. index-document 129/129); integration covered file-by-file, all
  green. Full log archived at `docs/evidence/T26/unit-full.log`.
- T27: smoke 33/0/2, dist-check PASS, guards 111/116, self-test 27/27,
  untracked scan unchanged (no new hits).

ON COMMIT-files changed by this program (still UNCOMMITTED, preserved):
`Makefile` (db-lint flag), `scripts/api-smoke.mjs` (POSIX-only drain +
SKIP reporting), `scripts/race-db.sh` (local-npipe acceptance),
`tests/integration/ingestion-process.test.ts` (tSignal POSIX guard),
`tests/integration/zz-t18-prof.ts` (lint), 7-file prettier normalization,
`docs/evidence/T{18f,25,26}/` logs, `docs/reports/checkpoints/PRE-P11-T18b.md`
through `PRE-P11-T28.md` (this file) + continuity updates below.

Continuity updated in T28: PRE-P11-TASKS.md (states), REPAIR-TRACKER.md,
LATEST-CHECKPOINT.md, OPENCODE-HANDOFF.md, status.md, handover.md.

KNOWN-OPEN (do not claim, re-run on a healthy host, owner decides):
1. T25-d real races (51/0) — needs sub-second docker-exec.
2. T26-a full unit + T26-b full integration as single commands — need free
   host memory. File-by-file evidence stands in this program's checkpoints.
3. `make` binary absent; managed Storage static-lint findings; POSIX drain
   paths unverified on this box; codex transcript owner triage; widget
   loading performance; actual restore; live provider evaluation (all P11).

STOP BEFORE P11. No merge/push/hosted write/deploy/provider action was
performed or is approved. Next work needs owner continuation.
