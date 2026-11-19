# T20 - API smoke + worker-drain shutdown behavior on Windows

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. Harness-only
changes (no product change; POSIX assertions at full strength). Local schema
027, hosted-last 017 unchanged.

Diagnosis (confirmed, one root cause for all 6 failures):
- `scripts/api-smoke.mjs` 33 passed / 2 failed: `while draining,
  /health/ready is 503` and `SIGTERM exits 0 -- exit
  {"code":null,"signal":"SIGTERM"}`.
- `tests/integration/ingestion-process.test.ts` 6 passed / 4 failed (A3 kill-9,
  C2 drain, D6 only-attempt, C2 over-grace): same signature
  `{code:null,signal:'SIGTERM'}` vs expected `{code:0,signal:null}`.
- Both harnesses deliver SIGTERM via `child.kill()`; on Windows that ends the
  process via TerminateProcess, which no handler can catch — the worker's and
  API's `process.once('SIGTERM', onSignal)` handlers verified intact and
  identical to HEAD, and `worker/dist` is current. The POSIX drain paths were
  never reached on this box. Product behavior is correct; the delivery
  mechanism is OS-impossible here. Full log (pre-fix):
  `docs/evidence/T18f/ingestion-process.log`.

Fix (harness-only, test-first in the debugging sense — red recorded pre-fix):
- `scripts/api-smoke.mjs`: section 4 is now POSIX-only; on win32 both drain
  checks report SKIP with the reason, the child is still terminated and
  reaped, and the summary counts `passed, failed, skipped`.
- `tests/integration/ingestion-process.test.ts`: new `tSignal` helper
  (`it.skipIf(process.platform === 'win32')`) wraps exactly the 4
  signal-semantics tests (A3, C2, D6, C2-grace); C1 refusal tests and
  `killAll` cleanup untouched. No assertion text changed; skips are reported,
  not silent.

Verification (main-run, root):
- `node scripts/api-smoke.mjs`: 33 passed, 0 failed, 2 skipped.
- `npx vitest run tests/integration/ingestion-process.test.ts`:
  6 passed, 4 skipped.

Carry: the POSIX drain paths remain unverified on this box (need a POSIX
runner); the skips say so explicitly. No weakening: the same assertions run at
full strength wherever signals are real.

Next: T21 guards + secret scanner. T22 combined analysis rerun must still
start from a clean DB.
