# T15 - independent integrated reviews

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; read-only reviews + bounded local fixes;
no hosted/provider/release/commit action. No new migration in T15 itself
(the T14-cycle 026 and the review-cycle 027 below are the DB changes).

Two independent read-only reviews ran on the integrated tree (fenced handler,
T13 registry, T14 round trip, migrations 020-026):
- Correctness: NO BLOCKING items. All real-path RPC names/types/bounds match
  002/015/020-026; question-hash binding stable per (question, language);
  per-layer publish mapping uses the live key derivations and text forms;
  accounting pending-before/final-after with conservative settle; C7 guards
  mirror-or-exceed the DB. Six non-blocking notes (a-f), all addressed below.
- Security: 1 BLOCKING theme (shared-L2 cross-bot contamination enforceable
  only by worker correctness, not the database) + 4 non-blocking notes.
  Blocker FIXED in this cycle (migration 027); re-review confirms
  BLOCKER CLEARED, no new blocking items.

Bounded fixes from the reviews (one debug cycle):
- DB tenant binding (security blocker): migration
  027_warm_tenant_binding.sql — publish_warm_answer + publish_warm_retrieval
  require every cited chunk to belong to the calling bot (ready, non-deleted,
  public_answer, exact version, d.bot_id bound); C5 validates ref shapes
  loudly (22023); get_chunks_by_ids gains optional p_bot_id (old single-arg
  calls keep working); both live read paths pass the calling bot
  (chat.ts areDocsActive, retrieval.ts hydrate botId now required).
  Schema 26 -> 27; census 26 -> 27 (220 x7 + label, 250, 260, 290, helper).
- pgTAP: 323 +1 (foreign chunk publishes nothing, b6 tenant fixture),
  324 +1 (foreign bot chunk publishes nothing, b6 fixture) + row-absence pins;
  new 325_warm_tenant_reads (6 tests: signature, service-role-only grants,
  anon denied, same-bot hit, cross-bot miss, unfiltered compat).
  Full pgTAP: 37 files, 3671 PASS.
- Correctness (b): C7 publish already forwarded record.language (verified).
- Correctness (d): round-trip test now asserts cache_key_hash ===
  answerKeyHash(bot, corpus, settings, rag-v2, chatModelKey, '', question).
- Correctness (e): 2 new unit pins — null-reserve quiet skip (no settle, no
  publish) and publish-false (no throw, spend still settled). 19/19 warm unit.
- Correctness (a): DATABASE_SCHEMA documents the C5 anchor as model-liveness,
  not per-vector binding, and the ignored-false continuation.
- Correctness (c): p_chat_model 128-char cap documented (per-variant
  fail-closed; realistic names fit; no code change).
- Correctness (f): questionHash delimiter confirmed 0x1F (matches cache keys).
- Security (3): stale "holds no keys" comments corrected (warming-config
  header + worker/.env.example now describe vendor-key reuse + startup
  fail-closed).
- Security (4): handler bound documented as DB-authoritative (no code change).
- Residuals (documented, non-blocking): cache_set_* still shape-only (read-time
  bot filters + bot-scoped keys mitigate; pollution-at-worst, no disclosure);
  p_bot_id default-NULL preserves an unfiltered capability for future callers
  (all current call sites pass the bot; hydrate botId now required at TS level).

Verification (main-run, root):
- db reset --yes exit0 (001-027 + seed). Full pgTAP 37/3671 PASS.
- Unit: worker 19 warm + 13 handlers + config PASS; api cache/retrieval/chat
  suites PASS (58 in scope); typecheck 0; lint 0; format clean on touched files
  (4 remaining flags are pre-existing overlay files outside scope).
- T14 round trip 1/1 PASS on the final tree (rebuilt API + 027).
- npm run build 0; worker-dist-check 0.
- Pre-existing failures elsewhere (PDF child env, timing bounds) untouched,
  carried to T16-T18.

C8 COMPLETE (T13 wiring + T14 round trip + T15 reviews/fixes). Next T16 first
HTTP-timing defect; T03 stays COMPLETE with carried limits.
