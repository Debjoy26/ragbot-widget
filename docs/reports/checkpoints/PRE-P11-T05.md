# T05 - carry warm claim generation

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; no migration/hosted/provider/release action.

Gap: DB 020 versions every warm claim (warm_generation + bump trigger + fence),
but runtime parseClaimedJob dropped the column: a malformed warm row (missing /
zero / fractional / string generation) reached dispatch, and handlers never
received the generation the fence protocol needs.

Changes (runtime + handler guard + tests; no migration, unrelated code untouched):
- worker/src/runtime.ts: ClaimedJob gains readonly warmGeneration; parseClaimedJob
  requires integer warm_generation >= 1 for warm_answer_cache rows (row rejected
  as claim_row_invalid otherwise, mirroring analysisGeneration); propagates the
  value for all row types when numeric.
- worker/src/jobs/warm-answer-cache.ts: fail-closed guard requires
  job.warmGeneration >= 1 (warm_generation_missing + return). Staleness against
  the live row stays enforced by the fence (T10); this guards the claim boundary.
- tests/unit/worker/runtime.test.ts: new test proves propagation (generation 4
  reaches handler) and rejection (missing/0/1.5/'4' skipped, claim_row_invalid
  logged). Unknown-type fixture gains warm_generation 1 so it still reaches
  dispatch (intent preserved: no-handler path unchanged).
- tests/unit/api/answer-cache.test.ts: three warm jobs carry warmGeneration;
  new test proves missing generation fails closed without warming.

Verification (main-run, root):
- npx vitest run runtime + answer-cache: 2 files, 83 tests PASS (was 82+1 fail
  mid-task from the unknown-type fixture; fixed by giving the fixture a valid
  generation, not by touching the dispatch path).
- Verbose: both new tests PASS by name.
- npm run typecheck: exit 0.

Next T06 validated warming configuration; T03 stays COMPLETE with carried limits.
