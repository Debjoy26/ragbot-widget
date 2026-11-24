# PRE-P11-T31 stack-up + race attempt — 2026-11-24 (interrupted, no code change)

## Git truth
- Root `D:/Projects1/Text_AI/ragbot-widget`, branch `main`, HEAD `495db6f`.
- Dirty overlay preserved (`codex-session-*.md`, `convo.md`, `tempreport.md`,
  `widget/public/index.html`). Worktrees `ragbot-p10-d3`, `ragbot-p75-d4` kept.
- No commit/push/hosted write/phase change.

## Authorization
- Owner "approved" on 2026-11-24 → continued authorized LOCAL work only,
  one small task at a time, STOP BEFORE P11.

## What was done
1. Docker was DOWN at resume (`npipe` missing, 1.0 GB free). By attempt time
   Docker Desktop processes were running and `docker ps` showed the stack UP:
   `supabase_db` healthy, 8/9 containers healthy, `supabase_vector` unhealthy
   (known carry, full-stack health unproved).
2. `npx supabase status` + `migration list`: local 001–027 == DB 001–027.
   `docker exec ... true` exit 0 (timing not captured; prior 1.4–7s overhead).
3. `npx supabase db reset --yes` exit 0: 001–027 applied + seed, containers
   restarted ("Finished supabase db reset on branch main").
4. Race attempt: `Git\bin\bash.exe scripts/race-db.sh` with 7-min tool timebox
   → INTERRUPTED, no output captured (tool timeout kills the wrapper;
   51 orderings × ~8s exec overhead does not fit 7 min on this host).
5. Residue found after kill (local only, via docker exec psql):
   `bot_profiles`=2 (1 seed + synthetic ac100000…001), synthetic conversations=2.
   Cause: script cleanup on exit never ran (wrapper killed).
6. Cleanup: second `npx supabase db reset --yes` exit 0. Verified clean:
   `bot_profiles`=1, `conversations`=0.

## Classification
- Host/timebox interruption, NOT a product failure. Zero data violations
  observed (no ordering completed). T25-d stays OPEN.

## Next task (exact)
- Re-run races CHUNKED with log files (as 2026-11-21 did 2×51), never through
  a single tool call with `Select-Object -Last`:
  `Start-Process Git bash with redirect to docs/evidence/T25/race-2026-11-24.log`,
  poll the log, then classify CONSISTENT / UNEXPECTED-BLOCK / VIOLATION.
- Only on healthy host (free RAM + exec timing checked first). STOP BEFORE P11.
