# P7.5 — Caching & latency — evidence (in progress, phase/p7.5@2e2d62b)

> Base `7febe1d` (`main` after P0-D1), branch `phase/p7.5` @ `2e2d62b` (standalone cache services, 140 tests). Not yet integrated L2 Postgres nor answer-cache chat wiring. Updated 2026-11-12.

## Scope (plan.md P7.5)

- C1 provider prompt caching — prefix byte-identical via `PROMPT_TEMPLATE_VERSION='rag-v2'` `shared/src/prompts.ts:19` — provider-side, no code.
- C2 bot config LRU 45s `api/src/services/config-cache.ts:1` — `bot_id+settings_version` key, TTL 30-60s clamped, immediate bust on version, kill switch `cache_policy.enabled/c2` false => bypass, `corpus_version` ignored, LRU 200, wired into `api/src/services/conversations.ts:160` `loadContext` (TTL-only get, sets after DB fetch). Fail closed on missing version.
- C4 query embedding `api/src/services/embedding-cache.ts:1` — `sha256(model\x1fdims\x1fnorm(NFKC lower+collapse))` `embeddingCacheKey:63`, L1 7d (7-30d) + `EmbeddingL2` `query_embedding_cache` (hash only, raw text never stored `embedding-cache.ts:93`), kill switch `c4/embedding` false => bypass, wired into `api/src/services/chat.ts:520` `embedQuery` L1 get/set (hit skips provider + usage row).
- C6 moderation `api/src/services/moderation-cache.ts:1` — `sha256(model\x1fpolicy_version\x1fnorm)` 24h, verdict allow/block, L1+L2.
- C5 retrieval `api/src/services/retrieval-cache.ts:1` — `bot_id‖corpus_version‖embedding_hash‖k‖threshold‖language` hash, ordered IDs only, `≤10min`, `getHydrated()` re-reads by ID and purges on deleted chunk leak, kill switch `c5/retrieval`.
- C7 answer `api/src/services/answer-cache.ts:1` — opt-in `isAnswerCacheEnabled:121` default OFF, key `bot_id‖corpus‖settings‖prompt‖chat_model‖lang‖sha256(norm)` `answerCacheKeyHash:72`, NFKC lower+collapse, 9 safety rules `answer-cache.ts:212` (first-turn only `getL1:338`, exact match, completed+moderated+citations, version/model/lang in key, `areDocsActive:385` purge, moderation/rate limits outside, PII `containsPII:55` never written, `answer_cache_hit` usage, `chunkForSse:565` SSE replay), contact never cached, `hit_count`/`last_hit_at` bump, TTL 24h (30d max), L1 1000 + `AnswerL2` `answer_cache`.
- C8 warm `worker/src/jobs/warm-answer-cache.ts:1` — `warm_answer_cache` job, payload `warmAnswerCachePayloadSchema`, fetches `suggested_questions` via `fetcher.getSuggestedQuestions` (or `get_chat_context`), dedupes caps 6, best-effort warms C4/C5/C6/C7 per question, heartbeat per question.

## Tests (new, unit, L1 only)

- `tests/unit/api/config-cache.test.ts:1` — 26 tests: TTL clamp/expiry, `isC2Enabled` missing=>enabled, `enabled:false`/`c2:false` bypass, isolation A/B, stale version miss, `corpus_version` not bust, LRU, missing version fail closed.
- `tests/unit/api/embedding-cache.test.ts:1` — 24 tests: NFKC+ligature, key includes model/dims, TTL 7-30d clamp, model/dims invalidation, isolation, raw text never stored (keys are hashes), kill switch.
- `tests/unit/api/moderation-cache.test.ts:1` — 25 tests: same canonicalisation, key includes model+policy_version, 24h TTL, isolation, kill switch.
- `tests/unit/api/retrieval-cache.test.ts:1` — 25 tests: TTL ≤10min clamp, isolation by all 6 parts, ordered IDs not text, `getHydrated` purge, kill switch.
- `tests/unit/api/answer-cache.test.ts:1` — 40 tests + 3 warm: opt-in default off, bot isolation, rule 1 first-turn, rule 2 NFKC, rule 3 completed/moderated/citations, rule 4 version/model/lang miss, rule 5 cited-docs purge L1+L2, rules 6/8/9, rule 7 PII email/phone/ID filter, contact not cached, TTL 24h, warm dedupes/caps.

`npx vitest run --project unit` on the 5 files: 140 passed (2.76s, see above). Full `npm test` on this branch: 140 passed for new files; 91 pre-existing failures unrelated (extract child `EXIT_9` on Windows Node v23, chunk perf `>2000ms` — need `24.22.2` per `.nvmrc:1`, same as P7 3133 passed).

## Static checks (phase/p7.5@2e2d62b, Node v23.0.0 with --ignore-engines for suite)

- `npx tsc --noEmit --project api/tsconfig.json` exit 0
- `npx tsc --noEmit --project worker/tsconfig.json` exit 0
- `npm run lint` exit 0 (`--max-warnings 0`)
- `npx prettier --check` on owned files pass (after --write); full `npm run format:check` on Windows shows CRLF warnings (LF expected on Linux, same as P7)

## Integration so far (phase/p7.5)

- `api/src/services/chat.ts:520` — `embedQuery` checks `embeddingCache.getL1` before `retrieval.embedQuery`, populates on success, hit returns `{vector, inputTokens:null}` with no usage row (cost 0).
- `api/src/services/conversations.ts:160` — `loadContext` checks `configCache.get(botId)` before `get_chat_context` RPC, sets after fetch (TTL-only, no cheap version fetch yet).
- Remaining wiring pending: L2 Postgres adapters for C4 (`query_embedding_cache` vector column `002_vectors.sql:10`), C6 (`moderation_cache`), C7 (`answer_cache`), C5 (no table yet — L2 abstract), moderation/retrieval/answer cache chat integration (answer check after input moderation, before retrieval, with `areDocsActive` re-check, `answer_cache_hit` usage, SSE replay), `C3` widget `localStorage` + `Cache-Control`, provider prompt cache already byte-identical, keep-alive pooling, SSE `meta` flush, `get_chat_context` `cache_policy` return (currently missing from settings jsonb — needs migration 014).

## Invariants

- Every cache key includes `bot_id`+version where spec requires it (`answer_cache` `bot_id‖corpus‖settings‖prompt‖chat_model‖lang`, `retrieval` `bot_id‖corpus‖hash‖k‖threshold‖lang`, `embedding` model+dimensions, `moderation` model+policy). Cross-bot leak covered by bot isolation tests.
- Caches never outrank `handover.md §4.15`: input moderation/auth/rate limits/budget run on every request incl. cache hits (answer cache hit still runs `inputStage` moderation, rate limits outside cache).
- `answer_cache` opt-in, first-turn only, PII never written, contact re-read from `public_bot_config` at serve time, cited `document_version_id` re-checked active on read + purge.
- Secrets never in cache keys/values (hashes only).

## Next

- Migration `014` for L2 RPCs + `cache_policy` in `get_chat_context` settings jsonb.
- Wire `moderationCache`, `retrievalCache`, `answerCache` into `chat.ts` pipeline + `conversations` versionFetcher for C2 immediate bust.
- `C3` widget edge, `C1` provider `cache_control`, pooling, measurement `p50/p95 TTFT` (P11).
- Full suite on Node `24.22.2` Linux with local Supabase stack (`make db-local`, `db-test` 26 files, `db-race` 51 orderings) — same as P7 gates.
