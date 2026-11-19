# T18c - settings-parity + local-stack helper families

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T18c (enumeration only, both green).

Scope: field-level settings RPC parity + local-stack helper (single-spawn
status cache) families, each run alone on the clean post-T18a DB (no reset in
T18c; no migration applied; local schema still 027, hosted-last 017 unchanged).

Verification (main-run, root):
- `npx vitest run tests/integration/settings-parity.test.ts` exit 0, 264/264 PASS (3.84s).
- `npx vitest run tests/unit/local-stack-helper.test.ts` exit 0, 8/8 PASS (1.95s).

Triage: no defect in either family.

Next: T18d admin-real-session; then api-wiring under load, ingestion-e2e/process,
chat-e2e, limits, visitor-auth, full worker-runtime; T22 combined analysis rerun
must still start from a clean DB. Local DB at 027 (untouched by T18c);
hosted-last 017 unchanged.
