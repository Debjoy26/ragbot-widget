# T18a - extraction/confinement subtask

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. Worker-lib
change only (no migration; `worker/src/lib/extract.ts` is not a frozen
contract and T18 authorizes the fix).

Gap: `tests/unit/worker/extract-confinement.test.ts` 2 FAIL in full worker
unit scope (10/12), both reproduced isolated:
1. `file://` URL with `%20` CHILD escaped to literal `%2520` path
   (`.../my%2520file.txt` instead of `.../my file.txt`), so the CHILD read
   missed and the test fell through to the PARENT read returning 'parent'.
2. `/proc/<pid>/environ` block threw `ENOENT` instead of returning empty —
   the Linux-only read guard ran on Windows where `/proc` does not exist,
   and the `err.code === 'ENOENT'` check compared a grubbed/undefined code.

Fixes (both exact-behavior-preserving; no assertion dropped or weakened):
1. CHILD branch now decodes with `fileURLToPath` (single canonical
   file-URL-to-path conversion, same allowlist gate), so `%20` resolves to
   a real space and the CHILD allowlist hit returns 'child'.
2. Proc-ENVIRON block now shared-guards `process.platform === 'linux'`
   before attempting the read (any platform without `/proc` returns empty),
   and treats any read failure as empty (fail-closed, same as the existing
   SELF_ENVIRON behavior).

Verification (main-run, root):
- `tests/unit/worker/extract-confinement.test.ts` 12/12 (was 10/12).
- `tests/unit/worker/extract.test.ts` 32/32 (no regression in sibling).
- Full worker unit scope rerun pending T18 completion (carried below).

Triage findings recorded for the owning tasks (no product/test change in T18a):
- `tests/integration/analysis-budget.test.ts` shutdown-handback FAIL under
  a polluted local DB was cross-run pollution, NOT a product defect:
  stale `analyze_conversation` jobs from killed earlier runs sorted before
  the test's own job under oldest-first `claim_jobs`, so the reclaim
  returned the wrong row (different id, attempts 2, generation 1). After
  `supabase db reset` (027 migrations re-applied clean): 8/8 PASS.
  Mechanism (verified in SQL): `release_job_lease` refunds attempts-1 and
  re-queues immediately; `claim_jobs` takes oldest available +1 attempt
  with generation bump. Carry to T22: combined rerun must start from a
  clean DB (or equivalent queue hygiene).
- `tests/integration/analysis-scheduling.test.ts` 10/10 PASS on the clean
  DB (no change needed; T22 owns the combined 18-case rerun).
- `tests/integration/api-wiring.test.ts` setup `Hook timed out in 10000ms`
  reproduces only under parallel load (`supabase status` spawn 5.6-10s);
  passes alone. Load-flake, carried in T18 (setup-tax family).

Next: T18 remainder (admin/bootstrap setup families + remaining
enumeration: ingestion-e2e/process, chat-e2e, limits, visitor-auth,
worker-runtime full, api-wiring under load); then T22 combined analysis
rerun on a clean DB. T03 stays COMPLETE with carried limits. Local DB is
now clean at 027 (post-reset); hosted-last 017 unchanged.
