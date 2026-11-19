# T14 - real local DB round trip with labelled fakes

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only (real local stack 127.0.0.1:54322 + built API
child process); no hosted/provider/release/commit action. No real provider key
or call anywhere: worker side uses labelled in-process fakes, API side uses the
loopback FakeLlmServer.

Gap: the H1 handler was proven only against mocked RPCs and the DB fence only
by pgTAP; no proof existed that warming writes servable shared L2 that a real
API serves as a first-turn hit.

Changes:
- tests/integration/cache-warming-roundtrip.test.ts (new, 1 test): on the real
  LOCAL stack — bot + warm policy (c7 opt-in, warm_questions) + ready public
  document via the ChatHarness; real queue_warm_job enqueue + lease claim;
  createWarmAnswerCacheHandler with labelled fakes (embedding = fake-server
  vector for the chunk topic, moderation allow, chat streaming an
  EVIDENCE: SUFFICIENT answer citing the real chunk id); asserts shared
  answer_cache rows for the bot and C4 rows; then a separate built API instance
  serves the same question first-turn and the test asserts 200 + warmed text,
  ZERO new chat calls on the fake server, and a provider='cache' usage row.
  Normal session/auth/input-moderation/rate-limit path enforced throughout.
- supabase/migrations/026_fix_warm_retrieval_anchor.sql (new): T10's C5 anchor
  required query_embedding_cache.key_hash = p_embedding_hash, but C4 keys hash
  model|dims|question while C5 embedding hashes hash the vector — equality can
  never hold on the real path, so every fenced C5 publish failed RB003 (found
  by this round trip; C4/C6/C7 unaffected). Replacement anchor, same
  signature: a live unexpired C4 row for the bot's current model/dims must
  exist (the same variant always publishes it first; handler pins the model).
  Schema 25 -> 26.
- supabase/tests/database/323_warm_publish.test.sql: the unbound-RB003 case
  encoded the flawed assumption; replaced with a model-without-live-cache bot
  (b6, model fake6) expecting RB003. Still 38 tests.
- Census 25 -> 26: 220 (x7 + label), 250, 260, 290, local-stack helper.
- DATABASE_SCHEMA.md: C5 anchor sentence corrected.
- worker/src/jobs/warm-answer-cache.ts: one real-RPC-shape fix found by the
  round trip — get_warm_job_context always includes "" in languages, which the
  draft's membership check rejected. "" is now the allowed default variant;
  bound raised to 21 (matching 020). Plus a unit pin for the ["","en"] shape.

Verification (main-run, root):
- db reset --yes exit0 (001-026 + seed). Full pgTAP: 36 files, 3661 PASS.
- T14 integration: 1/1 PASS (116 s: API boot + warming + live hit).
- T12 unit scope re-run after the language fix: 17/17 warm + handlers/config
  suites green; npm run typecheck exit 0; npm run lint exit 0; prettier on
  touched files.
- Pre-existing failures elsewhere (PDF child env, timing bounds) untouched and
  unrelated; carried to T16-T18.

Next T15 independent reviews; T03 stays COMPLETE with carried limits.
