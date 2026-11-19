# T25 - local DB gates (replay/pgTAP/lint/advisors PASS; race OPEN on timing)

PARTIAL 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. One
harness-support fix (below). Local schema 027, hosted-last 017 unchanged.

PASS (main-run, root):
- T25-a clean replay: `supabase db reset` exit True (001-027 + seed).
- T25-b full pgTAP: `supabase test db` — 37 files, 3671 tests, PASS.
- T25-c lint: `supabase db lint` — "No schema errors found", exit 0
  (uses the T19-fixed recipe without the deprecated `--local`).
- T25-e local advisors: `supabase db advisors` — "No issues found".

OPEN — T25-d real races (diagnosed platform limitation, no product defect):
- Fix (kept): `scripts/race-db.sh` context guard now also accepts the local
  Docker Desktop Windows endpoint `npipe:////./pipe/dockerDesktopLinuxEngine`
  next to `unix://`; TCP/ssh/remote endpoints still refused, unreadable
  context still fails closed. This enabled 4 full end-to-end runs on Windows.
- Results: 51 orderings each; problems 14 / 4 / 8 / 10 across runs (logs:
  `C:\Users\DEBJOY\AppData\Local\Temp\opencode\race1.log`, `race2.log`;
  move to evidence in T28 if kept).
- Confirmed root cause (measured, not hypothesized): a single
  `docker exec ... psql -c 'SELECT 1'` takes 3.5-7.0s on this box (before and
  after restarting the crash-looping pg_meta sidecar; C: has 14.8 GB free, so
  not the old disk-full state). The script's timing model needs sub-second
  statement setup (BLOCKED_MS=800ms, lock_timeout 2s vs HOLD 2.0s — zero
  margin). Every per-statement round trip blows the margins, so overlap
  probes report UNEXPECTED BLOCK, waits hit 55P03 lock_timeout, and winner
  flips (e.g. RB030/RB003/RB013-unexpected, one stale-release-timing case).
- Zero data-consistency violations attributable to product logic in 204
  ordering executions: every final-state verdict that could complete its
  overlap check read CONSISTENT (no lost update, duplicate, or missing row
  from the DB logic). Failures are exclusively overlap/timing-measurement
  artifacts of the 3.5-7s exec overhead.
- Not fixed by tuning: RACE_DELAY/HOLD/lock margins are the assertions — the
  box must get faster (sub-second docker-exec), not the test slower. No
  margins were changed and no ordering was skipped.

Carry: T25-d stays OPEN until a run on a healthy host shows 51/0. The gate
must be re-run (not claimed) after any source change touching RPCs/leases.
T26-T28 proceed (independent gates); T28 records this as known-open.
