# PRE-P11-T32 contaminated race attempt — 2026-11-24 (invalid, no code change)

## Git truth
- Root `D:/Projects1/Text_AI/ragbot-widget`, branch `main`, HEAD `495db6f`.
- Dirty overlay + both worktrees preserved. No commit/push/hosted write/phase change.

## What happened
1. Foreground race (`Git bash scripts/race-db.sh`, 7-min tool timebox) TIMED OUT
   with no output (T31). The tool wrapper was killed — but the bash child
   SURVIVED detached (found later as PIDs 25236 + 27892, started 14:25:10).
2. Detached re-launch (PID 19808, later 28404) ran CONCURRENTLY with the
   surviving first runner, sharing the same synthetic BOT/SESS ids.
3. Result: 34 orderings logged, then `fixture setup failed` (deadlock 40P01 on
   `documents` DELETE) and run aborted. 13+ `VIOLATION` lines (e.g. "found 0",
   "no counter row", "0 jobs queued") are RUNNER-ON-RUNNER interference, NOT
   product defects: same tree was 0-violations on 2026-11-21; "found 0" pattern
   = fixtures deleted by the competing runner.
4. Evidence preserved but QUARANTINED (must never be cited as a gate result):
   `docs/evidence/T25/race-2026-11-24-CONTAMINATED-two-runners.log` (+ `.err.log`).
5. Cleanup: all three bash PIDs killed (`Stop-Process -Force`, verified none
   remain), then `npx supabase db reset --yes` exit 0. Verified clean (local
   docker-exec psql): `bot_profiles`=1, `conversations`=0, `jobs`=0.

## Classification
- Harness/timebox failure (background child outlived the killed tool call),
  NOT a product regression. T25-d stays OPEN. No assertion weakened.

## Next task (exact, only on owner go)
1. Pre-flight: `Get-Process -Name bash` MUST be empty + clean counts (1/0/0).
2. Launch ONE detached runner via python DETACHED_PROCESS writing to a fresh
   `race-2026-11-24-run2.log`; record PID; poll the log with short reads only.
3. Never launch a second runner while one is alive. STOP BEFORE P11.
