# Debug cycle P3-D3 — 2026-11-05

Owner-approved scope: R3-1, R3-2 and the R3-3 doc fixes from review P3-R3 (`docs/evidence/P3-R3/SUMMARY.md`).
Base: `main` @ `19438c5`, changes uncommitted. Node 24.22.2, Supabase CLI 3.0.0, local stack only. Implemented by Opus, no worker. Not applied to any remote project. Not security-reviewed.

## Changes
- `supabase/migrations/006_reaper_settle_reply_lock.sql` (new)
  - R3-1: `expire_stuck_request_runs` sets reservations to `expired`, not `released`.
  - R3-2: `messages_check_reply_to` locks the target with `FOR SHARE` and rejects a missing or invisible target (was skipped).
- `supabase/tests/database/180_p3d3_fixes.test.sql` (new, 20 tests).
- `supabase/tests/database/170_p3d2_fixes.test.sql`: two assertions changed because behaviour changed on purpose:
  - N2 reaped reservation: `released` becomes `expired`.
  - N3 nonexistent target: still rejected; error 23503 (foreign key) becomes 23514 (trigger).
- `DATABASE_SCHEMA.md` (R3-3): Budget and Request start lines corrected, reaper line updated, P3-D3 section added.

## Differs from the reviewer's proposal for R3-2
Not added: `unique (id, conversation_id)` and the composite foreign key. Not used: `SECURITY DEFINER`. The row lock alone closed all three race orderings below, without two more indexes on `messages`, and the function stays `SECURITY INVOKER`. New requirement: a writer needs `UPDATE` on `messages` for the lock; `service_role` passes (tested).

## Results
| Check | Exit | Result | Evidence |
|---|---|---|---|
| `make db-local` | 0 | 001–006 and dev seed applied | `db-local.txt` |
| `make db-test` | 0 | 18 files, 1485 passed, 0 failed | `db-test.txt` |
| `make db-test` with `006` removed | 2 | 10 failed (2 in file 170, 8 in file 180) | Not archived; run only to show the tests depend on the fix |
| `make db-lint` | 0 | No schema errors | `db-lint.txt` |
| `supabase db advisors --type all --level warn` (local) | not captured | No issues found | Terminal output only |
| `npm run lint`, `format:check`, `typecheck`, `build` | 0 | Passed | `npm_*.txt` |
| `npm test` | 0 | 157 passed | `npm_test.txt` |
| `make db-plan` on `rbejeqwxyxtklehuzibv` (dry run) | not captured | Lists only `006` as pending | Terminal output only |

### Two-connection race, `race_reply_to.sh` (real concurrent connections)
| Ordering | Before fix | After fix |
|---|---|---|
| Reply in flight, question moved | VIOLATION | CONSISTENT, move rejected |
| Reply in flight, role changed | VIOLATION | CONSISTENT, change rejected |
| Question move in flight, reply inserted | VIOLATION | Reply rejected |

Output: `race-before-fix.txt`, `race-after-fix.txt`. The script is manual and is not part of `make db-test` or CI.

### R3-1 reproduction, repeated after the fix
Reservation became `expired`, settle of 0.75 succeeded, 0.75 counted toward the cap (was RB003 and 0).

## Not covered
- `006` not applied to the remote dev project. Remote still has the R3-1 and R3-2 behaviour.
- Other races remain untested: reaper vs settle vs reserve, and `begin_request_run`, `claim_jobs`, rate limits (§3a ac).
- Reviewer notes R3-4, R3-6 to R3-9 not addressed.
- The worker threshold rule cannot be enforced until the worker exists.

## Makefile and `database/` (same session, separate owner request)
Tested: `db-local`, `db-test`, `db-lint`, `db-plan`, `db-status` and the input guards. Not run: `install`, `db-create`, `db-start`, `db-stop`, `db-advisors`. A project this machine is not linked to has not been tried.
