# T26-b isolation classification — 2026-11-20 (packet item 1b follow-up)

CLASSIFICATION COMPLETE: every failure from the 2026-11-20 full
single-command integration run is host contention / parallel cross-talk.
Zero product assertions outstanding. Single-command re-proves (T26-a unit,
T26-b integration, T25-d race) stay OPEN until a run on a genuinely healthy
host goes green. Root `main` @ `8a38455`. Node v26.13.1. No hosted
write/query, no install, no provider call, no commit. No source, test, or
timeout change.

## Host at task time

~0.68 GB free of 7.7 GB; `docker exec echo` 554 ms; DB container healthy
(vector sidecar restarting, non-critical — same as prior sessions).
Marginal host, same class as the 2026-11-20 re-run session.

## Commands (cwd `D:/Projects1/Text_AI/ragbot-widget`, PowerShell)

1. `npx supabase db reset` → exit 0 (clean 001–027 + seed).
2. Five previously-failing files, one at a time, same tree — ALL GREEN,
   exit 0 each (console-captured; a PowerShell `2>&1` redirect-syntax slip
   meant no log file was written, so exact counts are transcribed here):
   - `tests/integration/api-wiring.test.ts` — 10/10 passed (14.79 s).
     Full-run failure was a `beforeAll` hook timeout (+ one setup
     `service call -> 400` under parallel load).
   - `tests/integration/db-boundary.test.ts` — 24/24 passed (10.35 s).
     Full-run failure was a `beforeAll` hook timeout.
   - `tests/integration/first-admin.test.ts` — 21/21 passed (43.27 s).
     Full-run failure was a `beforeAll` hook timeout.
   - `tests/integration/worker-runtime.test.ts` — 7/7 passed (22.47 s).
     Full-run failure was a `beforeAll` hook timeout.
   - `tests/integration/admin-real-session.test.ts` — 244/244 passed
     (45.56 s), INCLUDING the two `seed-test-users.mjs` cases that timed
     out at 5 s in the full run.
3. Prior session already closed the sixth file: analysis-budget 8/8 alone
   (assertion `analysis_generation` 2 holds; full-run mismatch was
   parallel cross-talk). See PRE-P11-T26b-rerun-2026-11-20.md.

## Verdict

6/6 full-run integration failures reproduced green in isolation with zero
code changes → all are host-load artifacts (10 s stack-boot hooks, 5 s
node spawns, parallel DB cross-talk). No timeout raised (T16 rule), no
test weakened/skipped/deleted. T26-b's earlier CLOSED basis
(`--maxWorkers=4`, 848 passed) stands on the unchanged tree; the default-
parallelism single-command re-prove remains OPEN and must be re-run (not
claimed) on an idle host with multi-GB free RAM.

## Packet state after this task

- 1a (T25-d race): still OPEN (3×51 all-CONSISTENT, same 4 fast artifacts).
- 1b unit (T26-a): still OPEN (45 failed under load; all 6 files green alone).
- 1b integration (T26-b): failures FULLY CLASSIFIED as contention; single-
  command re-prove still OPEN.
- 1c (mark complete): NOT MET — nothing marked complete.
- Items 2–4 (hosted 018–027, carries, P11): untouched, each needs explicit
  owner per-action / phase approval. No `make` install, no hosted write,
  no provider call was approved or attempted.

Usage reading: UNKNOWN (no agent meter; owner monitors).
