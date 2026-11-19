# T18b - admin/bootstrap setup family (first-admin)

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T18b (enumeration only).

Scope: G-23 first-admin setup family (`scripts/create-first-admin.mjs` against
the LOCAL stack: invite + membership, idempotent rerun, unsafe-input refusal,
new owner at `aal1` reads nothing). Single-file run on the clean post-T18a DB
(no reset in T18b; no migration applied; local schema still 027, hosted-last
017 unchanged).

Environment note: Docker Desktop daemon was down at task start (same symptom as
T03c-3b: `supabase status` failed, npipe missing). Relaunched Docker Desktop
locally (no install/reconfig); containers recovered, `supabase_db_ragbot-widget`
healthy before the run. Vector container was still starting; the test does not
depend on it.

Verification (main-run, root):
- `npx vitest run tests/integration/first-admin.test.ts` exit 0, 1 file,
  21/21 tests PASS, 45.06s.

Triage: no defect in this family. Remaining T18 enumeration still open:
admin-real-session, settings-parity/helper, api-wiring under load (setup-tax
flake carried from T18a), ingestion-e2e/process, chat-e2e, limits,
visitor-auth, full worker-runtime.

Next: T18c continues the next single setup family (admin-real-session or
settings-parity), then the remaining enumeration; T22 combined analysis rerun
must still start from a clean DB. T03 stays COMPLETE with carried limits.
Local DB clean at 027 (post-T18a reset, untouched by T18b); hosted-last 017
unchanged.
