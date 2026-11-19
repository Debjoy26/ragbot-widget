# T13 - production registry wiring

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; no hosted/provider/release/commit action.
No DB migration (fence T03-T11 frozen; no schema change in T13).

Gap: the T12-integrated H1 handler existed but nothing registered it: the
production worker claimed no warm_answer_cache jobs and any enabled warming
would have warmed nothing.

Changes (worker-owned files only; shared contracts and migrations untouched):
- worker/src/handlers.ts: buildHandlers takes an optional validated
  WarmingConfig; absent/null keeps the three base handlers (existing tests
  unchanged). When present it registers warm_answer_cache, building chat and
  moderation adapters from the warming identities and reusing the worker's
  existing embedding/analysis vendor key — no separate warming keys exist by
  design. An unresolvable vendor key throws ConfigError naming
  WARM_CHAT_PROVIDER/WARM_MODERATION_PROVIDER at startup (visible fail-closed,
  never silent no-op warming).
- worker/src/lib/warming-config.ts: split identity fields (chatProvider,
  chatModel, moderationProvider, moderationModel) alongside the key strings,
  which stay the source of truth for cache pins (model IDs may contain '/').
- worker/src/worker.ts: loads the warming config, passes it to buildHandlers,
  logs warming_enabled at worker_started.
- tests/unit/worker/handlers.test.ts: 6 new T13 cases (unregistered without
  config; registered with injected labelled fakes; adapters built from worker
  keys without provider calls; real adapters built call-free; fail closed on
  keyless chat vendor; fail closed on keyless endpoint moderation).

Verification (main-run, root):
- vitest worker warming scope: 13 handlers + 16 warm + 11 config PASS.
- npm run build exit 0; node scripts/worker-dist-check.mjs exit 0;
  compiled worker/dist/handlers.js contains the warm wiring and loads with
  the 3 base handlers when no warming config is given.
- npm run typecheck exit 0; npm run lint exit 0; prettier on touched files.

Next T14 real local DB round trip with labelled fakes; T03 stays COMPLETE
with carried limits.
