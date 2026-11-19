# T18e - api-wiring + limits + visitor-auth families

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T18e (enumeration only, all green).

Scope: three integration families run on the clean post-T18a DB (no reset in
T18e; no migration applied; local schema still 027, hosted-last 017 unchanged):
- api-wiring (setup-tax family from T18a: `supabase status` spawn hook timed out
  only under parallel load; passes alone — confirmed again here).
- limits (rate/budget enforcement family).
- visitor-auth (session/token family).

Verification (main-run, root):
- `npx vitest run tests/integration/api-wiring.test.ts` exit 0, 10/10 PASS (14.14s).
- `npx vitest run tests/integration/limits.test.ts tests/integration/visitor-auth.test.ts`
  exit 0, 2 files, 40/40 PASS (29.02s).

Triage: no defect in these families. The api-wiring parallel-load setup flake
remains a load-only observation (carried, not a product defect; parallel-scope
timing stays T16/T17 territory).

Next: T18f ingestion-e2e/process + chat-e2e + full worker-runtime; then T22
combined analysis rerun must still start from a clean DB. Local DB at 027
(untouched by T18e); hosted-last 017 unchanged.
