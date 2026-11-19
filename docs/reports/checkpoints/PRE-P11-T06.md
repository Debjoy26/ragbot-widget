# T06 - validated warming configuration

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; no migration/hosted/provider/release action.

Gap: worker/src/lib/warming-config.ts held an INTERFACE ONLY with no loader, so
no validated opt-in/default-off path existed and the api.ai-typed `ai` field
was unwirable on the worker (which holds no chat or moderation keys).

Changes (config + tests + env docs; no migration, unrelated code untouched):
- worker/src/lib/warming-config.ts: new loadWarmingConfig(env, ai) returning
  WarmingConfig | null. Missing/false WARM_ENABLED returns null (default-off,
  other vars ignored); garbage flag or enabled-but-misconfigured throws
  ConfigError naming vars only. All WARM_* explicit: limits (context/output/
  topK/similarity/deadline/TTL/moderation chars, API-mirrored bounds), prices
  above zero, chat/moderation identities (kind + model ID, fallback pair
  both-or-neither, explicit moderation mode), reserve TTL outliving deadline +
  60 s margin. chatModelKey/moderationModelKey built EXACTLY like api/src/app.ts
  so warmed keys match live lookups. `ai` narrowed to WorkerAiConfig and passed
  through by reference (hiding/freezing stays loadWorkerConfig's job); generation
  credentials wiring stays T13. Returns frozen config (nested prices frozen).
- tests/unit/worker/warming-config.test.ts: 10 tests — default-off paths,
  garbage flag, full valid config with exact keys, fallback key format,
  half-pair/bad provider/bad model/bad mode/out-of-range/zero-price/TTL-margin
  negatives, names-only errors, frozen + keys-out-of-JSON.
- worker/.env.example: WARM_* block with matching-identity warning.
- README.md: worker env line documents WARM_* opt-in and identity matching.

Verification (main-run, root):
- npx vitest run warming-config: 10 tests PASS.
- npm run typecheck: exit 0.

Next T07 reservation schema and reserve RPC; T03 stays COMPLETE with carried limits.
