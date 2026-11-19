# T18d - admin-real-session family

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T18d (enumeration only, green).

Scope: P3.5-T3 (B-13) browser RPCs / RLS reads / Storage policies over HTTP with
REAL sessions (password sign-in aal1, verified TOTP factor aal2; no forged
claims, no mocks). Single-file run on the clean post-T18a DB (no reset in T18d;
no migration applied; local schema still 027, hosted-last 017 unchanged).

Verification (main-run, root):
- `npx vitest run tests/integration/admin-real-session.test.ts` exit 0, 244/244 PASS (50.30s).

Triage: no defect in this family. TOTP is enabled on the local stack (aal2
sessions acquired for real, as the suite requires).

Next: T18e api-wiring under load + limits + visitor-auth; then ingestion-e2e/process,
chat-e2e, full worker-runtime; T22 combined analysis rerun must still start from
a clean DB. Local DB at 027 (untouched by T18d); hosted-last 017 unchanged.
