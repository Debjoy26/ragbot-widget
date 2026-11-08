# P6 acceptance test plan (main session)

Prepared by Opus before wave 2. Each case runs against the local stack with real jobs, real Storage objects and real database functions. The embedding provider is a labelled fake: no real provider call is made in P6 tests. Cases marked **E2E** go in `tests/integration/ingestion-e2e.test.ts`. The main session runs them, plus the rest of the system suite (`rules.md` §3), after each wave and after every debug cycle.

## A. Queue (TECH_SPECS §9 "Queue")
| ID | Case | Pass condition |
|---|---|---|
| A1 | Duplicate delivery: the same `index_document` job claimed twice, by two runtimes or after lease expiry | One activation; chunks written once; `corpus_version` bumps once |
| A2 | Lease expiry: a worker stops heartbeating mid-job | Another runtime claims it after `locked_until`; the first worker's later writes are refused (RB013) |
| A3 | `kill -9` mid-job, then restart | The job is retried; the version ends `ready` or `failed`, never stuck; no duplicate chunks |
| A4 | Retry exhaustion: the provider fails transiently every time | The job dead-letters after `max_attempts`; the version is `failed` with `INDEXING_FAILED`; backoff delays grow and stay in bounds |
| A5 | Incomplete embeddings never activate: a batch fails after some chunks are written | The version is not `ready`; the previous active version still serves |
| A6 | Atomic replacement: a new version indexes successfully | `active_version_id` switches in one step; the old version is `superseded`; retrieval sees only the new chunks |
| A7 | Delete: delete a document during and after indexing | Immediately excluded from retrieval; cleanup removes its chunks and objects; an in-flight job's writes are refused or cleaned up |
| A8 | Spoofed file types: a PDF declared as text, text declared as PDF, an executable renamed `.pdf` | `FILE_UNSUPPORTED`; no provider call |

## B. P6 plan cases
| ID | Case | Pass condition |
|---|---|---|
| B1 | A failed replacement keeps the old version active | `active_version_id` unchanged; document stays `ready` |
| B2 | Progress and failure codes readable per document | `admin_document_status` shows `batches_done`/`batches_total` during indexing and the failure code after; never `last_error` |
| B3 | A job over the daily cap fails safely | `BUDGET_EXCEEDED`; the fake provider received no call; no reservation left `reserved` |
| B4 | An older version finishing late | Marked `failed` with `SUPERSEDED`; the newer active version untouched |
| B5 | Scanned PDF (no text layer) | `OCR_REQUIRED`; never `ready` (ADR 0005) |
| B6 | Encrypted or corrupt PDF, too many pages, oversize file | `FILE_UNSUPPORTED` |
| B7 | eTag missing or changed between upload completion and indexing | Fails closed with `FILE_UNSUPPORTED`; no provider call |
| B8 | Size or checksum: object size differs from the registered size | Fails closed; checksum stored on success |
| B9 | Reindex sharing a `storage_path`: delete the old document's version after a reindex | The shared object is not deleted while any live version references it |
| B10 | Abandoned `pending_upload` past the limit | Version `failed`; object removed by maintenance |
| B11 | Usage: every embedding batch records a `usage_events` row with `embedding_index` | Rows match batches; the reservation settles to the recorded cost |
| B12 | Model mismatch: the bot's embedding model changed after the version started | Activation refused (RB011); version `failed` |

## C. Worker process and maintenance
| ID | Case | Pass condition |
|---|---|---|
| C1 | Config refuses `VISITOR_TOKEN_SECRET`, a missing limit, or `STUCK_RUN_THRESHOLD_SECONDS` below the chat deadline plus margin | Exit 1 naming the variable, never the value |
| C2 | Graceful shutdown on SIGTERM during a job | Stops claiming; finishes or aborts within the bound; exits 0 |
| C3 | Maintenance: one task raises an error | The other tasks still run; counts logged |
| C4 | No document text, keys or tokens in any log line | Captured logs contain none of the fixture text or keys |
| C5 | Extraction child exceeds the time or memory limit | Child killed; `FILE_UNSUPPORTED`; parent unaffected |

## D. Database (pgTAP and race)
- 250 covers every 012 function, its fence and grants.
- `race-db.sh` covers two workers writing chunks for one job, and retry racing heartbeat.

## Not covered in P6
- Real embedding provider calls (needs owner approval; P11 evaluation).
- Retrieval quality on real documents (status §3a c).
- Throughput and memory under load (P11).
