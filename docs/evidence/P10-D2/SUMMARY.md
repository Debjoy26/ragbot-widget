# P10-D2 — cache-hit metrics (A12)

Main-session verification on the dirty integrated tree, base aa6425a,
Node 26.13.1, repository root, actual LOCAL Docker Postgres 019.
No hosted or provider activity.

`scripts/sql/cache-hit-metrics.sql` is the canonical runbook query. It counts
canonical answer_cache_hit and deployed chat/cache/answer_cache ledger rows
as hits; generation counts exclude that legacy marker using NULL-safe
predicates. API ledger behavior was preserved because record_request_usage
does not accept the newer operation name. Spend includes every recorded cost;
cache inventory is not mislabeled as a hit ratio.

`tests/integration/cache-metrics.test.ts` executes the actual canonical SQL
against four synthetic ledger categories in a rolled-back local transaction.
Main ran Vitest integration with --maxWorkers=1: corrected harness red result
2 failed/2 controls; final 4 passed, exit 0 (`metrics-final.log`). The earlier
pgTAP harness failed setup because the CLI mount cannot include root scripts;
it was replaced by the real integration harness retaining all assertions.
That setup failure is not defect evidence.

Final integrated full-suite verification remains open. This is P10 preparation,
not a P11 latency measurement or real traffic result.
