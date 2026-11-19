# T08 - per-invocation usage ledger

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only (reset + pgTAP on 127.0.0.1:54322);
no hosted/provider/release action.

Gap: T07 reservations had no ledger: no pending charge before the call, no
idempotent final usage, no late-report binding. T08 mirrors
record_analysis_usage for warm, per invocation.

Changes (migration + tests + spec; no app/worker code yet):
- supabase/migrations/022_warm_usage_ledger.sql: usage_events gains
  warm_reservation_id (FK, set null), warm_invocation_id, pending/final state
  (existing rows final), analysis/warm mutual-exclusion CHECK, partial unique
  key on (reservation, invocation); record_warm_usage (service_role only, empty
  search_path, 2 s lock timeout): 22023 on bad inputs (incl. unknown operation),
  RB003 on foreign binding, RB002 on missing policy, settings lock for
  serialization; pending registration allowed with zero counts; final upsert
  merges with greatest() (never shrinks, never duplicates); no lease check so
  post-takeover money still lands home. schema_version 21 -> 22.
- supabase/tests/database/321_warm_usage.test.sql: 27 tests (catalog 9, roles 2,
  invalid 5, binding 3, pending 1, final-upsert 2, retry-merge 1, late 1, orphan
  1, zero-cost 1, policy 1; generic settle used only to exercise the settled path).
- Census bumps 21 -> 22: 220 (x7 + label), 250, 260, 290,
  tests/integration/helpers/local-stack.ts EXPECTED_SCHEMA_VERSION.
- DATABASE_SCHEMA.md: warm usage ledger subsection.

Verification (main-run, root):
- db reset --yes exit 0 (001-022 + seed). Evidence log T08/full-pgtap.log.
- Full pgTAP: 33 files, 3553 passed, exit 0.
- Two red-green iterations: UNION-typed jsonb literals (VALUES like 310 fixes
  it); bare PERFORM outside plpgsql (wrapped in DO).

Next T09 settlement and recovery; T03 stays COMPLETE with carried limits.
