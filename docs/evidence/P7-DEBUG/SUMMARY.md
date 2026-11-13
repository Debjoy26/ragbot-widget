# P7/P7.5 debug cycle — answer & moderation cache safety (P7-D1/D2/D3)

> Branch `phase/p8`, base `af3c1c3`. Uncommitted. Updated 2026-11-13.
> Method: test-first. Each defect has a failing-then-passing regression test in
> `tests/unit/api/chat-answer-cache-d2.test.ts` (+ harness support in
> `tests/unit/api/chat-harness.ts`). No hosted change, no migration.

## P7-D1 (High): answer-cache hits served documents that were deleted

- **Defect.** `createChatService` passed `areDocsActive: async () => true` into
  `AnswerCache.get` (`api/src/services/chat.ts`). The cache module itself
  honors the recheck on L1 and L2 (purge on failure), but the only production
  call site stubbed it — with a comment claiming the L2 path "handles" the
  purge (it cannot: the callback it receives returns `true` unconditionally).
  Any cached answer stayed servable after its cited documents were deleted,
  violating invariant §4.15 / C7 rule 5.
- **Red.** New tests failed as designed: `get_chunks_by_ids` never called on
  the hit path (expected >0, got 0).
- **Fix.** ChatDeps gains required `db: Pick<Db, 'rpc'>` (wired in
  `api/src/app.ts`; only 3 `createChatService` call sites exist, all updated).
  The read path now checks every cited chunk through the service-role
  `get_chunks_by_ids` RPC — which returns only ready, non-deleted, public
  chunks — and treats any gap or RPC error as a miss (fail closed; the fresh
  pipeline then fails normally if the DB is truly down).
- **Correction during fix.** The first version passed
  `document_version_id`s into the chunk-id filter and the hit-path test still
  failed. The recheck now uses cited **chunk ids** (corpus_version in the key
  already guards version supersession); `answer-cache.ts` L1+L2 docstrings
  updated to match.

## P7-D2 (Medium): answer-cache key did not pin the chat model

- **Defect.** Both the read and the write passed the literal `'chat'` as
  `chatModel` (with a `placeholder model` comment). Self-consistent today, but
  a provider/model change via env would keep serving stale answers —
  violating the "every key includes model" rule (invariant §4.15).
- **Red (established by construction).** With the literal on both sides the
  new cross-model test would hit; the ChatDeps plumbing (`chatModelKey`,
  required) made it miss before the app wiring landed. The test pins the
  behavior: model-b never served from a model-a entry.
- **Fix.** `ChatDeps.chatModelKey` (required), computed in `api/src/app.ts`
  from the real providers (`provider/model`, plus `|fallback...` when a
  fallback is configured). Old L2 rows keyed `'chat'` fail the record check
  and are treated as misses — safe, self-cleaning, no migration.

## P7-D3 (Medium): moderation-cache key did not pin model or mode

- **Defect.** Same placeholder class: `moderationCache.get/set` used the
  literal `('moderation', 'v1')`. A moderation model or mode change would keep
  serving verdicts from the old setup.
- **Fix.** `ChatDeps.moderationModelKey` (required):
  `provider/model/mode` from `ai.moderation` + `config.ai.moderation.mode`,
  used in both `get` and `set`. C4 (embedding cache) was verified sound — it
  already keys on the real model + dimensions. Regression test: same shared
  cache, different keys → input re-moderated; same key → input served from
  cache (asserted on the input text, since output moderation also consults the
  provider).

## Gates for this cycle

- New: `tests/unit/api/chat-answer-cache-d2.test.ts` (4 tests) — red before,
  green after (D1a purge, D1b hit-with-recheck, D2 cross-model, D3 re-moderation).
- `tests/unit/api` full: 41 files, 1494 passed (Windows fork-pool EPERM noise
  on teardown only; same as baseline).
- `npm run typecheck` exit 0, `npm run lint` exit 0 (`--max-warnings 0`),
  `prettier --check` green on touched files.
- Not run here: full suite on the pinned Linux toolchain, `make db-*`,
  E2E/browser for these paths (service-level, covered by unit tests).
