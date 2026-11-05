# Debug cycle P3-D4 and review P3-R5 — 2026-11-05 to 2026-11-06

Owner-approved scope: complete the P3-R4 findings and the open R3 notes, finishing P3. Base: `main` @ `0059991`.
Workers: `sonnet-implementer` ×2 in worktrees (T1 Makefile and FDE docs; T2 migration 007, pgTAP 190, race script), self-reported. Opus integrated them, wired Makefile and CI, updated `DATABASE_SCHEMA.md`, applied the P3-R5 fixes and ran every check below. Worktrees and their branches removed.
Environment: Node 24.22.2, Supabase CLI 3.0.0, GNU Make 4.4.1, local stack unless marked remote.

**Migration 007 is not applied to the remote dev project.** That needs separate owner approval.

## Outcome by finding
| ID | Outcome |
|---|---|
| R4-1 | Residual fixed: `db-create` needs a matching `CONFIRM_REF`. `db push` with a non-linked ref still not run |
| R4-2 | Overshoot and UTC-day behaviour pinned in 190. Hard request deadline stays a P5/P9 obligation (Opus recommendation; owner did not choose separately) |
| R4-3 | Fixed, took two attempts: shell injection (T1), then make-function expansion (R5-2). Refs reach recipes only through the environment |
| R4-4 | Fixed: 14 orderings including UPDATE and DELETE paths, now in CI through `scripts/race-db.sh`; stricter lock assertion in 180 |
| R4-5 | Still a hypothesis. Recorded as a P5 obligation |
| R4-6 | Fixed: catalog test limits INSERT and UPDATE on `messages` |
| R4-7 | Fixed: the CHECK is exercised directly in 190 with the trigger disabled |
| R4-8 | Fixed in 007: a new reservation needs a live run. Reaper comment corrected |
| R4-9 | Password guidance fixed; `db-advisors` run. `--local` rejected: the CLI lists no such flag for `db reset` or `test db` |
| R3-4 | Fixed: comment on the function and schema doc |
| R3-6 | Tested; defect below stays open |
| R3-7 | Lock order reviewed by P3-R5: no cycle in existing functions; documented; future API rule added |
| R3-8 | Closed as by design: documented at `003:234-236`. Owner may still want a policy |
| R3-9 | Fixed in 007: `request_runs.state` moves forward only |
| R5-1 | Fixed: unconfirmed overlap now fails after one retry, verdicts must be CONSISTENT, ordering count asserted |
| R5-2 | Confirmed by execution, fixed: `$` refused at parse time. The `MAKEFLAGS` part is not fixable in make; see gaps |
| R5-3 | Fixed in 007: the bot is part of the locking query |
| R5-4 | Fixed: comment-stripped matcher in 190 |
| R5-5 | Fixed: remote recipes tested with `make -i` and a stubbed CLI |
| R5-6, R5-7 | Docs updated. P5 obligation added: reserve in its own transaction, update the run after it commits |
| R5-8 | `LC_ALL=C` set, `DOCKER_HOST` guard added. SHA pinning stays open (§3a j) |

## Changes
New: `supabase/migrations/007_run_state_guard.sql`, `supabase/tests/database/190_p3d4_fixes.test.sql`, `scripts/race-db.sh`, `scripts/test-make-guards.sh`.
Changed: `Makefile`, `README.md`, `database/README.md`, `DATABASE_SCHEMA.md`, `.github/workflows/ci.yml` (race and guard steps), tests 130, 170, 180.

Test changes to existing files:
- 130 line 80: fixture now updates only active runs, because 007 rightly rejects `failed` to `succeeded`. Assertion unchanged.
- 170 line 214: description only.
- 180 line 75: stricter.

## Results (Opus, integrated checkout)
| Check | Exit | Result | Evidence |
|---|---|---|---|
| `make db-local` | 0 | 001–007 and dev seed | `db-local.txt` |
| `make db-test` | 0 | 19 files, 1601 passed | `db-test.txt` |
| `make db-lint` | 0 | No schema errors | `db-lint.txt` |
| `make db-race` | 0 | 14 orderings, 0 problems, 0 warnings | `db-race.txt` |
| `RACE_DELAY=3.2 bash scripts/race-db.sh` | 1 | Negative check: no overlap fails (12 warnings, 1 problem) | `db-race-negative-no-overlap.txt` |
| `bash scripts/race-db.sh` with 007 removed | 1 | Negative check: 1 VIOLATION | `db-race-negative-no-007.txt` |
| `make test-make` | 0 | 80 passed, 0 failed | `test-make.txt` |
| `npm run lint`, `format:check`, `typecheck`, `build` | 0 | Passed | `npm_*.txt` |
| `npm test` | 0 | 157 passed | `npm_test.txt` |
| `supabase db advisors --type all --level warn` (local) | not captured | No issues found | `advisors-local.txt` |
| `make db-status PROJECT_REF=<dev ref>` (remote, read-only) | 0 | History 001–006, 007 pending | `db-status-remote.txt` |
| `make db-advisors PROJECT_REF=<dev ref>` (remote, read-only) | 0 | 5 WARN security, the known `SECURITY DEFINER` set | `db-advisors-remote.txt` |

T2 reported 30 of 116 tests in 190 fail without 007. Opus did not rerun that. The Opus race-without-007 check above is the independent equivalent for R4-8 only.

`npm run lint` first failed because ESLint saw the two worker worktrees as extra tsconfig roots. It passed once they were removed.

## Known gaps
- **`MAKEFLAGS` route:** `MAKEFLAGS='-- PROJECT_REF=<valid>'` in the environment counts as a command-line value, so the "exported value is refused" rule doesn't apply. Confirmed by execution. Make can't distinguish it, and the attempted guard did nothing, so it was removed. The value must still pass the format check, cannot contain `$`, and is printed as the target.
- **`knowledge_gaps` (R3-6):** after a question is deleted, an answer with no `request_id` pairs with an earlier question it did not answer. Report accuracy only, same conversation. No migration deletes single messages today. Pinned by a test, not fixed.
- **Reserve retry past TTL (reviewer note, not verified):** the early return hands back a `reserved` reservation past its TTL, which no longer counts toward the cap.
- **Race script:** timing-based, single-run cases. Multi-run batches, purge cascades and 40P01 under load not tested. The script runs the global reaper on the local DB.
- **P3-R5 fixes not re-reviewed:** verified by the tests above and by Opus only. P3-R5 itself was static.
- **Not run:** `make install`, `db-create`, `db-start`, `db-stop`; `db push` with a non-linked ref; 007 on any remote; pgTAP against a remote.
- CI for the new race and guard steps not yet observed at time of writing.
