# T18f - ingestion-e2e/process + chat-e2e + worker-runtime

MIXED 2026-11-19 (enumeration COMPLETE, one confirmed platform-harness failure
carried to T20). Root p7.5/d4-integration@aa6425a plus preserved dirty overlay,
Node26.13.1. No hosted/provider/release/commit action. No product or test change
in T18f. Local schema 027, hosted-last 017 unchanged (no reset, no migration).

Verification (main-run, root):
- `ingestion-e2e.test.ts` + `ingestion-process.test.ts` together: 62/66 PASS.
  All 4 failures are in `ingestion-process.test.ts` (A3 kill-9, C2 drain,
  D6 only-attempt, C2 over-grace). Full log: `docs/evidence/T18f/ingestion-process.log`.
- Rerun `ingestion-process.test.ts` alone: 6/10 PASS, same 4 fail.
- `chat-e2e.test.ts`: 82/82 PASS (150.63s).
- `worker-runtime.test.ts`: 7/7 PASS (25.71s).

Confirmed diagnosis (platform harness, NOT a product defect):
- Failing assertions expect POSIX semantics: worker exits `code 0` after
  catching SIGTERM and draining (`{code:0,signal:null}`), and A3 expects a
  SIGKILL-reporting exit. Observed on Windows: `{code:null,signal:'SIGTERM'}` —
  `child.kill()` on Windows terminates via TerminateProcess, so the worker's
  `process.once('SIGTERM', onSignal)` handler never runs.
- Worker shutdown code verified intact and identical to HEAD (`worker.ts:86-87`
  installs SIGTERM/SIGINT handlers; overlay diff to `worker.ts`/`runtime.ts` is
  additive warming-config only, no shutdown-path change). `worker/dist` is
  current (built after `worker/src`).
- These 4 cases cannot pass on Windows as written: the OS kills the process
  before any handler runs, so they carry zero product signal on this box. No
  assertion was weakened and no test was deleted or skipped.

Routing: the 4 drain cases move to T20, which owns draining/SIGTERM-on-Windows
diagnosis (fix confirmed behavior/harness cause there; do not weaken the POSIX
assertions — on POSIX they still verify the real drain path). T18 enumeration is
otherwise COMPLETE: first-admin 21/21 (T18b), settings-parity 264/264 + helper
8/8 (T18c), admin-real-session 244/244 (T18d), api-wiring 10/10 + limits/visitor-auth
40/40 (T18e), ingestion-e2e + chat-e2e 82/82 + worker-runtime 7/7 (T18f).

Next: T19 Windows DB + Make gates. T22 combined analysis rerun must still start
from a clean DB.
