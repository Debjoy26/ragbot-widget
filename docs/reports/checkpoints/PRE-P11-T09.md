# T09 - settlement and recovery

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only (resets + pgTAP on 127.0.0.1:54322);
no hosted/provider/release action.

Gap: T07/T08 reservations and usage had no settle path and no orphan recovery;
the indexing orphan sweep would have interpreted warm reservations as index
spend.

Changes (migration + worker schedule + tests + spec):
- supabase/migrations/023_warm_settlement_recovery.sql: settle_warm_budget
  (fenced settle: RB004/22023/RB013/RB002/RB003; zero-actual-no-usage releases,
  else settles at greatest(actual, usage)); settle_orphaned_warm_reservations
  (batch 1..1000; keeps reservation estimate when unrecorded); create-or-replace
  settle_orphaned_index_reservations excluding warm rows (also collapsed 018's
  duplicated analysis predicate, same semantics). Service-role grants; schema
  version 22 -> 23.
- worker/src/maintenance.ts: warm orphan sweep scheduled after the analysis
  sweep; tests/unit/worker/maintenance.test.ts EXPECTED + batch assertion.
- supabase/tests/database/322_warm_settlement.test.sql: 32 tests (catalog 12,
  roles 2, invalid 3, fence 1, settle/double/unknown 4, zero-cost 2, expired 1,
  orphan sweep 4 incl. estimate retention, batch bound 1, index-sweep exclusion 2).
- Census bumps 22 -> 23: 220 (x7 + label), 250, 260, 290,
  tests/integration/helpers/local-stack.ts EXPECTED_SCHEMA_VERSION.
- DATABASE_SCHEMA.md: warm settlement and recovery subsection.

Verification (main-run, root):
- db reset --yes exit 0 (001-023 + seed) twice (second after the fence-call fix).
  Evidence log T09/full-pgtap.log.
- Full pgTAP: 34 files, 3585 passed, exit 0.
- One red-green iteration: settle called warm_job_fence as table-returning;
  fence returns scalar uuid (like 020's own caller) — fixed, suite green.
- npx vitest run maintenance.test.ts: 22 passed. npm run typecheck: exit 0.

Next T10 fenced C4-C6 publication; T03 stays COMPLETE with carried limits.
