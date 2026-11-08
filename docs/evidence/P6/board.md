# P6 coordination board

Owner: Opus (main session). Workers append; nobody edits or deletes another entry. Recreated on 2026-11-08 for debug cycle P6-D2 after the first board, kept in a session scratch folder, was lost. Earlier interfaces are not repeated: the committed code at the base commit is the reference.

## How to use this board
- **Read it** before you touch anything outside your owned files, and before you rely on another worker's interface.
- **Append** with a single `cat >> /home/kali/Desktop/rag-bot/ragbot-widget/docs/evidence/P6/board.md` so writes don't interleave. Always use that absolute path, not your worktree's copy. Entry format: `### [<task id>] <YYYY-MM-DD HH:MM> <KIND>: <title>` then short lines. KIND is `CLAIM`, `INTERFACE`, `QUESTION`, `ANSWER`, `CONFLICT` or `DONE`.
- **Claim before you take.** Never edit another worker's files. Ask with a `QUESTION`; message them too if `SendMessage` is available to you.
- **Contract changes** go through Opus: post a `CONFLICT`. Don't work around it.
- Never paste keys, tokens, document text or chat text here.

## Base
`phase/p6` @ a428b00763d4f1a2c030597536e9cc1c9b95570a. Migration 012 (`supabase/migrations/012_ingestion.sql`) is local only and may be edited in place. The local stack is at 012.

## Debug cycle P6-D2: frozen interface (from reviews P6-R1 and P6-R2)
Migration 012 changes:
- `get_index_job_context` gains at the end: `stored_chunking_version text, stored_extraction_version text, stored_embedding_model text` (the version row's values).
- `reset_version_chunks(p_job_id uuid, p_worker text, p_version_id uuid)` fenced: deletes the version's chunks, sets `batches_done` 0 and clears `batches_total`; returns the number deleted.
- `reserve_index_budget(p_job_id uuid, p_worker text, p_version_id uuid, p_amount numeric, p_ttl_seconds integer)` fenced: marks any still-`reserved` row of this job `expired` (it keeps counting toward the cap), checks the cap including it, inserts a new `reserved` row for the job; returns its id. RB001 over the cap, RB039 for a disabled bot.
- `settle_index_budget(p_job_id uuid, p_worker text, p_reservation_id uuid, p_actual numeric)` and `release_index_budget(p_job_id uuid, p_worker text, p_reservation_id uuid)`: fenced; the reservation must belong to the job.
- `reserve_job_budget` from 009 is dropped; nothing may call it.
- `fail_orphaned_index_versions(p_batch integer) returns integer`: versions in `uploaded`, `extracting` or `embedding` whose newest `index_document` job is `failed` or `cancelled` become `failed` with `INDEXING_FAILED`; `documents.status` follows the existing rule.
- `release_job_lease(p_job_id uuid, p_worker text) returns boolean`: a running job held by `p_worker` goes back to `queued`, lease cleared, attempts decremented by one (not below 0), available now.
- `prune_superseded_chunks(p_batch integer) returns integer`: deletes chunks of `superseded` versions.

Worker changes: record usage right after the provider answers, before writing chunks; reserve, settle and release only through the `*_index_budget` functions; on shutdown abort call `release_job_lease`; maintenance calls `fail_orphaned_index_versions` and `prune_superseded_chunks`; reset and restart from 0 when any stored version or model differs from the current one, or chunking yields fewer chunks than `written_chunks`.

## Log

### [P6-D2-DB] 2026-11-08 CLAIM: migration 012, tests 250/210/030, scripts/race-db.sh
Worktree .claude/worktrees/p6-d2db, branch p6/d2db at a428b00. Will post INTERFACE before any stack reset.

### [P6-D2-W] 2026-11-08 CLAIM: worker/src, worker/.env.example, tests/unit/worker, parseBaseUrl
Worktree p6-d2w, branch p6/d2w @ a428b00. Starting.

### [P6-D2-DB] 2026-11-08 ANSWER: ruling from main on supabase/tests/database/230_p35_final_fixes.test.sql
main approved adding 230 to P6-D2-DB's owned files for one change only: the R3-3 section moves to reserve_index_budget and settle_index_budget (document, version, running job and lease for the fence; bot enabled for that section only). No other section of 230 changes. Reported as a moved test.

### [P6-D2-E] 2026-11-08 CLAIM: tests/integration/ingestion-e2e.test.ts, ingestion-process.test.ts, helpers/{fake-embeddings,ingestion-fixtures,ingestion-runtime}.ts
Worktree p6-d2e, branch p6/d2e @ a428b00. Adding D1-D10 end-to-end cases and a stronger C5 memory case. Edits only my owned files.

### [P6-D2-E] 2026-11-08 QUESTION: to P6-D2-W, names and timing my tests rely on
1. Maintenance task names in `MAINTENANCE_TASKS` (the `task` field of `runMaintenance` results): I will look up `fail_orphaned_index_versions` and `prune_superseded_chunks` (same as the SQL functions). Tell me if different.
2. Overspend (D5): I assume that after a batch whose real cost pushes the job's spent amount above its reservation, the job stops BEFORE the next provider call, settles the reservation at the amount spent (usage rows summed), and fails the version `BUDGET_EXCEEDED` (job succeeded). I assert completed provider calls <= 2 and the settled amount equals the sum of usage cost. Correct?
3. Shutdown abort (D6): on abort the handler/runtime calls `release_job_lease` so the job ends `queued`, attempts restored, `locked_by` null, available now. I assert that with `index_max_attempts` 1. Correct?
4. D3/D4 simulate a lost lease by setting `jobs.locked_by` to another id while the provider call is held; I rely on usage being recorded right after the provider answers even when the next fenced write is refused (RB013).
5. D10: the `FILE_UNSUPPORTED` failure for text over `EXTRACT_MAX_CHARS` I test with `EXTRACT_MAX_CHARS` set low in the config; plain text and a text-layer PDF.
Reply with an ANSWER or message P6-D2-E.

### [P6-D2-DB] 2026-11-08 INTERFACE: migration 012 final signatures (written, stack reset follows)
All SECURITY INVOKER, search_path '', lock_timeout 2s, EXECUTE service_role only. Fenced = index_job_fence (RB013 lease not held, RB010 deleted document).
- get_index_job_context(p_job_id, p_worker, p_version_id): previous 16 columns, then stored_chunking_version text, stored_extraction_version text, stored_embedding_model text.
- reset_version_chunks(p_job_id uuid, p_worker text, p_version_id uuid) returns integer (chunks deleted). Fenced. Version must be uploaded/extracting/embedding else RB030. Sets batches_done 0, batches_total null.
- reserve_index_budget(p_job_id uuid, p_worker text, p_version_id uuid, p_amount numeric, p_ttl_seconds integer) returns uuid. Fenced. 22023 bad amount (<=0 or null) / ttl (1..86400); RB039 bot disabled; RB002 no settings or cap; RB001 over cap. Every call is a new attempt: a still-reserved row of the job becomes expired and counts; a refused call changes nothing.
- settle_index_budget(p_job_id uuid, p_worker text, p_reservation_id uuid, p_actual numeric) returns void. Fenced (version taken from the job payload). Reservation must belong to the job and be reserved/expired, else RB003. p_actual >= 0.
- release_index_budget(p_job_id uuid, p_worker text, p_reservation_id uuid) returns void. Fenced the same way. Only a reserved row of this job, else RB003.
- fail_orphaned_index_versions(p_batch integer 1..1000) returns integer (versions failed).
- release_job_lease(p_job_id uuid, p_worker text) returns boolean (true only for the running holder).
- prune_superseded_chunks(p_batch integer 1..1000) returns integer (chunks deleted).
- reserve_job_budget(uuid, uuid, numeric, integer) is DROPPED. Other tests that call it: supabase/tests/database/210 and 230 (mine, being moved). Not mine: tests/unit/worker/index-document.test.ts, tests/integration/admin-real-session.test.ts, worker/src/jobs/index-document.ts (P6-D2-W / P6-D2-E).
- Note for P6-D2-W: a lost lease makes settle/release fail with RB013 (the fence); the reserved row then keeps counting until it is settled or expires into the cap sum.

### [P6-D2-DB] 2026-11-08 NOTICE: resetting the local DB stack now (db reset), expect a short outage

### [P6-D2-DB] 2026-11-08 NOTICE: resetting the local DB stack again (final check), expect a short outage

### [P6-D2-DB] 2026-11-08 DONE: migration 012 and DB tests (self-reported, unverified)
Stack is at the new 012 (final reset done). db reset exit 0; test db PASS (25 files, 2987 tests, 0 failed); db lint no errors; race-db.sh 45 orderings, 0 problems, 0 warnings. Uncommitted in worktree .claude/worktrees/p6-d2db (branch p6/d2db).
Moved tests: 210 sections 13 and 15e and 230 R3-3 now use reserve/settle/release_index_budget (retry-returns-same-reservation and finished-job-returns-active-reservation replaced; job-of-another-bot/payload-names-other-bot became RB013 cases because the bot comes from the version's document); 030: two reserve_job_budget assertions replaced by hasnt_function plus two reserve_index_budget grant assertions.

### [P6-D2-W] 2026-11-08 15:00 INTERFACE: worker behaviour the integration tests depend on
New required worker env (no defaults): `WORKER_MAX_DOWNLOAD_BYTES` (1..2147483647), `MAX_CHUNKS_PER_VERSION` (1..1000000). `ABANDONED_UPLOAD_HOURS` now >= 24. `WORKER_ID` (<= 56 chars) is only a base: the worker id is always `<base>-<6 hex>`. Tests that start a worker must set the two new variables.
- Budget: `reserve_index_budget(p_job_id,p_worker,p_version_id,p_amount,p_ttl_seconds=3600)` once per attempt, only when chunks remain; `settle_index_budget(p_job_id,p_worker,p_reservation_id,p_actual)` / `release_index_budget(p_job_id,p_worker,p_reservation_id)` with exactly those args. RB001 -> version fails BUDGET_EXCEEDED. RB039 -> RetryJobError `bot_disabled` (version not failed; dead-letters after max attempts). RB003 on settle tolerated.
- Estimate: UTF-8 bytes / 3, rounded up (`ESTIMATE_BYTES_PER_TOKEN`). Usage row (`record_usage_event`) is written right after each provider answer, before `write_document_chunks`. Stop and fail BUDGET_EXCEEDED when actual cost > 1.5 x reservation (spend settled, that batch not written).
- Resume: `reset_version_chunks` is called (once, before reserving) only when `written_chunks > 0` and the stored chunking version / extraction version / embedding model differs (null counts as differs) or chunking yields fewer chunks than written. Then start at 0.
- Versions: `extraction_version` = `x1-pdfjs-<installed pdfjs-dist version>`; `chunking_version` = `c1-350-50-<8 hex hash of weights, sizes, patterns>` (currently c1-350-50-63a5402b).
- Download: storage cap = min(byte_size, max_bytes, WORKER_MAX_DOWNLOAD_BYTES); registered eTag is checked on the response headers before the body (mismatch/missing -> FILE_UNSUPPORTED). No registered eTag -> FILE_UNSUPPORTED without download.
- Limits: text over EXTRACT_MAX_CHARS and more than MAX_CHUNKS_PER_VERSION chunks -> FILE_UNSUPPORTED. A PDF child that cannot start (ENOENT/EACCES/exit 2,3,9) -> RetryJobError `extractor_unavailable`; time/memory kills stay FILE_UNSUPPORTED.
- Shutdown: a job aborted for shutdown (not a lost lease) gets `release_job_lease(p_job_id,p_worker)` once, best effort.
- Maintenance order: ..., purge_terminal_jobs, fail_orphaned_index_versions(p_batch=min(RETENTION_BATCH_SIZE,1000)), prune_superseded_chunks(same), expire_abandoned_uploads.
- PDF child runs with `--permission` (read: its script + the pdfjs package dir only), `--disallow-code-generation-from-strings`. The parent passes the pdfjs dir as argv[3]. `isEvalSupported` does not exist in pdfjs-dist 6.4.299 (type error), so it is not passed.
- Log field `resume_offset` replaces `resumed_from_chunk`.
- shared `parseBaseUrl`: query/fragment refused, `[::1]` accepted.

### [P6-D2-W] 2026-11-08 15:00 DONE: worker side of P6-D2 (uncommitted in worktree p6-d2w, branch p6/d2w)
Unit: 47 files, 2045 tests pass; `tsc -b`, `tsc -p tests --noEmit`, ESLint, Prettier clean. Not run: db reset, integration tests, any provider call.

### [P6-D2-E] 2026-11-08 15:10 DONE: D1-D10 end-to-end cases and stronger C5 memory case (self-reported, unverified)
Uncommitted in worktree p6-d2e (branch p6/d2e): tests/integration/ingestion-e2e.test.ts, ingestion-process.test.ts, helpers/{fake-embeddings,ingestion-fixtures}.ts (ingestion-runtime.ts unchanged). Ran against an overlay (my tests + P6-D2-W worker/shared files as of 15:00 + P6-D2-DB 012 on the reset stack): ingestion-e2e + ingestion-process, 66 passed, 0 failed. tsc -p tests, ESLint, Prettier clean on my files.
Helper changes others should know: test bots are now created `enabled: true` (reserve_index_budget refuses a disabled bot, RB039); A2 now expects locked_by to be `<WORKER_ID>-<6 hex>`; the C2 abort test now expects the job `queued` after SIGTERM (was `running`).
Not mine, still calling the DROPPED reserve_job_budget: tests/integration/admin-real-session.test.ts lines 568 and 2168 (needs Opus or another owner).

### [P6-D4] 2026-11-08 CLAIM: worker/src/jobs/index-document.ts, tests/unit/worker/index-document.test.ts, tests/integration/ingestion-e2e.test.ts (failed-after-send usage row)

### [P6-D4] 2026-11-08 DONE: failed-after-send usage row (self-reported, unverified)
Uncommitted in worktree p6-d4 (branch p6/d4). Unit index-document 119 passed; ingestion-e2e 56 passed (A9 included); tsc -b, tsc -p tests, ESLint, Prettier clean.
