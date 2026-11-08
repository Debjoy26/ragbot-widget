# Phase P6: Ingestion pipeline (worker), 2026-11-08

Owner-approved. Branch `phase/p6`, not on `main` and not pushed until the owner approves. Base `main` @ `4f99666`.
Environment: Node 24.22.2, Supabase CLI 3.0.0, local stack at migration 012.
- **Workers:** `sonnet-implementer`, self-reported: wave 1, wave 2, P6-D1, P6-D2 (three workers), P6-D3 (two), P6-D4, P6-D5 (two). They coordinated through `docs/evidence/P6/board.md`.
- **Reviews:** P6-R1, R3, R4, R5 and R6 (`security-reviewer`) and P6-R2 (`reviewer`). All were static and self-reported.
- **Opus:** wrote the test plan (`test-plan.md`), merged every round, reproduced the review findings it could, wrote the P6-D6 fix and its tests, and ran every gate below.
- **Dependency:** one, owner-approved: `pdfjs-dist` 6.4.299, pinned, in the worker workspace only.
- **Hosted project:** migration 012 is not on the hosted dev project (it is still at 011).

## Gates on the final tree
Run by Opus at 19:55–20:01 on `9790630` plus the working tree, which became commit `6a805e6`. Exit codes are in `suite-exit.txt`.

| Check | Exit | Result | Evidence |
|---|---|---|---|
| `npm run build`, `lint`, `format:check`, `typecheck` | 0 | Passed | `npm_*.txt` |
| `make db-local`, `make db-test` | 0 | 25 files, 3065 passed | `db-test.txt` |
| `make db-lint` | 0 | No schema errors | `db-lint.txt` |
| `make db-race` | 0 | 47 orderings, 0 problems, 0 warnings | `db-race.txt` |
| `npm test` | 0 | 47 files, 2155 passed | `npm_test.txt` |
| `npm run test:integration` | 0 | 13 files, 684 passed (real worker processes, local stack, fake provider) | `integration.txt` |
| `node scripts/api-smoke.mjs` | 0 | 35 passed | `api-smoke.txt` |
| `make test-make` | 0 | 116 passed | `test-make.txt` |
| Secret scan with self-test | 0 | No hits | `secret-*.txt` |
| Local advisors (`--level warn`) | 0 | No issues | `advisors-local.txt` |
| Compiled PDF child (`scripts/worker-dist-check.mjs`, moved there for CI after P6) | 0 | 2 pages extracted from `dist` | `dist-extract-check.txt` |
| Chunking timing probe | 0 | 32,000-char adversarial inputs in 1–3 ms (2753 ms before P6-D3) | `regex-dos-probe*.txt` |

## Delivered
- **Migration 012 (local only):**
  - Every index-job function is fenced on the job lease (`index_job_fence`): context, progress, chunk writes, activation, version failure, `reset_version_chunks`.
  - `retry_job_later` with backoff; `record_usage_event`.
  - Index budget: `reserve_index_budget`, `settle_index_budget` and `release_index_budget`. `reserve_job_budget` is dropped. Chat's `reserve_request_budget` counts index reservations.
  - Maintenance and cleanup: `settle_orphaned_index_reservations`, `fail_orphaned_index_versions`, `release_job_lease`, `prune_superseded_chunks`, `cleanup_document`, `cleanup_storage_targets`, `expire_abandoned_uploads`.
  - Reindex keeps the upload eTag and checksum.
  - Replaces 005's `purge_expired_data_entries` with a bounded body. `schema_version()` is 12.
- **Worker:**
  - **Extraction:**
    - Text, Markdown and PDF, with content sniffing.
    - PDF runs in a child process with a time limit, a memory limit, Node's permission model (reads only its script and the pdfjs directory) and code generation from strings disabled.
  - **Chunking:** deterministic and linear-time, with version strings for chunking and extraction and a golden test.
  - **Embedding adapters:** gemini, openai and openai_compatible, using fetch. Response size, vector shape and magnitude bounds; `billed` on errors after a 2xx.
  - **`index_document` job:** checks size, eTag, type and checksum. Then extract, chunk, reserve, embed in batches, record usage, write fenced chunks, settle, activate. Resumes from written chunks, and starts again when the chunking, extraction or model version differs.
  - **Other jobs and runtime:**
    - A `cleanup` job.
    - A runtime with leases, heartbeats, bounded concurrency, backoff and graceful shutdown that returns the lease.
    - Maintenance for every retention, purge and orphan task.
    - Fail-closed config.

Plan acceptance, proven on the local stack with the labelled fake provider:
- Duplicate delivery, lease expiry, `kill -9` and retry exhaustion: A1–A4.
- Incomplete embeddings never activate, and replacement is atomic: A5, A6.
- Delete during indexing (A7) and spoofed types (A8).
- B1–B12 from the plan and C1–C5 for the worker process.
- D1–D10 from P6-D2.

## Defects found and fixed
| Found by | Defect | Fixed in |
|---|---|---|
| Opus, e2e | Reindex lost the upload eTag (B9); an aborted job was completed as succeeded (C2); integration files collided when run in parallel | P6-D1 |
| P6-R1, R2 | Budget escapes across attempts; versions stuck after a dead-lettered job; resume mixing chunker versions; PDF child not confined; unbounded download and extraction; usage recorded after chunk writes | P6-D2 |
| P6-R3, confirmed by Opus (timing probe) | Quadratic chunking on adversarial text (R-1); reservations of past attempts not counted; chat reservations ignored index reservations | P6-D3 |
| Opus, e2e A9 | Settled spend above the usage ledger: a failed-after-send batch had no usage row | P6-D4 |
| P6-R4, confirmed by reading | Errors after a 2xx (bad shape, oversized body) were not counted as spend; a failed usage write hid the provider error; orphaned reservations counted in full until midnight; separator cost recomputed in a loop; heading limits missing from the chunking version | P6-D5 |
| P6-D5 worker, confirmed by Opus (fail-before runs) | `cleanup_document`, `prune_superseded_chunks` and 005's `purge_expired_data_entries` could overrun their batch limit under a nested-loop plan. The old purge deleted 8 rows for a batch of 3 | P6-D5 |
| P6-R5, confirmed by reading `claim_jobs` and by fail-before runs | A crashed attempt's whole reservation counted beside its retry, so the retry could fail with `BUDGET_EXCEEDED` permanently; settle and release could drop a stale worker's recorded usage | P6-D6 (Opus) |
| Opus (spec error) | `reserve_index_budget` refused a disabled bot, blocking pre-launch indexing | P6-D3 |

Fail-before evidence for the last two cycles: `purge-batch-fail-before.txt` and `budget-r5-fail-before.txt`. For the 012 batch tests, the old bodies fail 10 of 411, and Opus reran this.

## Existing tests changed
- **210 §13 and §15e, 230 R3-3, 250 index-budget section:** a retry of the same job now settles its earlier reservation at the usage recorded for it before the cap check (P6-R5 #1). The old expectations encoded the defect. Other jobs' expired rows are still shown to count, and refusals are still shown to roll back.
- **e2e D3:** a cap of 1.5 reservations now indexes, where it used to fail. A cap of exactly one reservation is still refused.
- **Earlier P6 rounds:**
  - Budget tests moved from `reserve_job_budget` to the index functions.
  - The worker-runtime test follows the new shutdown and worker-id behaviour.
  - Test bots are created enabled.
  - Chunk golden version updated (output unchanged).
  - Schema version 12.
  - `vitest` integration files run one at a time.

## Not done or not proven
- **Real provider calls:** none were made. Every embedding test uses the labelled fake. Retrieval quality on real documents is still open (§3a c, P11).
- **Network from the PDF child:** the child can still open network connections, because Node's permission model doesn't block them (`confinement-probe.txt`). This needs egress control at deployment (P10). WebAssembly is not blocked.
- **Known bounded under-counts, owner to accept:** each case is at most one batch.
  - A stale worker's usage written after the next attempt settled (P6-R6 #1).
  - A failed usage write later settled by the sweep (P6-R5 #3).
  - A billed batch whose process died before recording it (P6-R6 #2).
  - An aborted multi-part Gemini call; the current batch size makes this unreachable (P6-R5 #4).
  - The same worker id re-claiming its own lease in-process (P6-R6 #3, hypothesis).
- **Known over-counts, which fail closed:**
  - A network failure before sending counts its estimate (P6-R4 F5).
  - Recorded usage can count in two windows when timestamps overlap.
- **Untested orderings:**
  - The orphan sweep against a reserve that settles the same row. Reasoned safe: reserve waits on the row lock and then re-checks state.
  - A reserve with two or more unsettled earlier rows of one job.
  - A sweep-expired row settled by its own job's next reserve.
- **Disabled bots:** indexing spend is allowed by design (knowledge goes in before launch). The owner may confirm.
- **`release_job_lease`:** gives back an attempt without a counter. Bounded by `max_attempts`.
- **Code layout:** the embedding adapter lives in `worker/`, but P7 needs query embeddings and will have to share it.
- **F7 performance test:** it guards against regressions but did not fail on the old code (0.44 s old, 0.1 s new). The output is unchanged.
- **Run order:** `make db-test` after `make db-race` without a reset fails one 210 test, because race-db leaves audit rows behind. The suite runs reset, test, lint, then race.
- **Hosted:** migration 012 needs owner approval to apply. Post-push checks (rules.md §5) follow it.
