# P7.5 — caching & latency — review (P7.5-D1/D2, open items)

> Branch state reviewed on `main` @ `10bf02b` (pushed). Uncommitted: this file + tracker updates only. Updated 2026-11-13.
> Method: static review of the `7febe1d..af3c1c3` diff (migrations, services, wiring, worker job) + Linux gate evidence. No code changed in this cycle — both findings need owner scope decisions first.

## Verified sound (no change)

- **014** (`014_p75_cache_policy.sql`): `get_chat_context` extended with `cache_policy` (service_role-only revoke/grant re-asserted); `retrieval_cache` RLS enabled with no policies (anon/auth denied, service_role bypasses); CHECKs on key/embedding hashes, k 1..50, threshold, array shape; `purge_expired_caches` extended (TTL-only for retrieval rows — safe: corpus_version is in the key); `grant all on all sequences` is service_role-only (no widening).
- **015** (`015_p75_cache_l2.sql`): all 8 cache RPCs validate the 64-hex key, bound model/policy/verdict/expiry inputs, enforce TTL on read, service_role-only. `get_chunks_by_ids` filters ready + non-deleted + public (the predicate P7-D1 reuses).
- **Embedding L2**: model + dimensions checked on L1 and L2 reads; key includes both.
- **Retrieval L2**: all 6 key components rechecked on L1 and L2; rehydration re-reads by ID and purges deleted chunks.
- **Answer L2**: all version/model/lang fields rechecked both layers + purge (P7-D1's fix uses chunk ids; corpus key guards supersession).
- **Config cache**: version-gated reads (`af3c1c3` B8 fix), kill switch bypasses, fail-open-on-DB-error only for reads.
- **Kill switches**: every layer bypasses when its `cache_policy` flag is off (behavior identical to P7).

## P7.5-D1 (Low): moderation L2 never verifies the model

`cache_get_moderation` does not return `moderation_model` (the column exists — `015` writes it — but no getter selects it), so the app rechecks `policy_version` only. Cross-model serving still requires a sha256 collision (the key hashes model + policy + text), and P7-D3 now feeds the real model into the key. No reachable leak. Options for owner: (a) accept as-is (key-pinned is sufficient); (b) a new migration 016 returning `moderation_model` + app-side check. Not implemented: schema changes wait for owner approval.

## P7.5-D2 (Low-Medium): C8 warmer is not production-wired

`worker/src/jobs/warm-answer-cache.ts` is a handler skeleton: with injected fakes it dedupes/caps/heartbeats correctly (unit-tested), but in production (i) nothing ever enqueues `warm_answer_cache` (no trigger in activation or settings update), (ii) question discovery calls a non-existent `get_warm_suggested_questions` RPC (caught → warms nothing), (iii) even with deps, retrieved chunks are discarded (`void chunks` — no RetrievalCache/AnswerCache writes), and (iv) there is no job-budget reservation, which P6 requires before any provider call (`reserve_index_budget`-style; warming would otherwise spend outside caps). An unwired job cannot spend or leak, so this is a scope gap, not a live bug — but `plan.md` says C8 "runs after each activation and settings change", which is not true. Options for owner: wire C8 properly (enqueue points + question RPC + real cache writes + job-based budget reservation) or formally defer it (first-visitor cold miss is correct, just slower).

## Gates for this cycle

- Linux container (`node:24.22.2`): build/lint/format/typecheck exit 0 (after CRLF→LF tree normalization; zero content diff vs HEAD); unit 3274 passed / 45 failed — all wall-clock/timeout flakes in untouched perf/PDF modules, green on host and in isolation.
- DB-backed gates (`db-test/lint/race`, integration, smoke, advisors) and latency measurement (p50/p95 cold vs warm-miss vs answer-hit): not run — Docker backend down, C: 3.4 GB free (same blocker as P7). No owner eval decision needed for these; they need disk + daemon. DB gates have since run — see `docs/evidence/P7-DEBUG/SUMMARY.md` (pgTAP 3348, lint clean, race 51/0, advisors clean; integration env-blocked).
- No code changed; no migration; no hosted change.
