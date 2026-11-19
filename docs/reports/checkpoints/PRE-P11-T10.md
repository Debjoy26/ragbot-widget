# T10 - fenced C4-C6 publication

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only (resets + pgTAP on 127.0.0.1:54322);
no hosted/provider/release action.

Gap: T04-T09 built claims, config, budget and recovery, but no fenced path
existed to persist warmed L2 records: the cache_set_* RPCs accept any
service_role call with a well-formed key.

Changes (migration + tests + spec; no app/worker code — wiring is T13):
- supabase/migrations/024_warm_publish_caches.sql: warm_layer_enabled helper
  (kill switch + enabled + per-layer c4/c5/c6 aliases, service-role granted);
  publish_warm_embedding (lease + settings/bot locks + enabled/warm/layer +
  current versions + bot embedding model/dimensions, else false; malformed
  dims out of range fail loudly);
  publish_warm_moderation (same gates + verdict/model format; model identity
  documented as T06 worker-config responsibility — no per-bot moderation
  model exists in the DB);
  publish_warm_retrieval (same gates + calling-bot match RB004 + current
  corpus + live unexpired C4 embedding binding RB003; chunk refs may be empty).
  All three delegate upserts to cache_set_*; all return boolean (true =
  written). Service-role grants; schema version 23 -> 24.
- supabase/tests/database/323_warm_publish.test.sql: 38 tests (catalog 18,
  C4 10 incl. superseded/disabled/policy-off/layer-off/stale-model/
  stale-dims/malformed/key/lease, C5 6 incl. unbound/cross-bot/stale, C6 3,
  anon 1).
- Census bumps 23 -> 24: 220 (x7 + label), 250, 260, 290,
  tests/integration/helpers/local-stack.ts EXPECTED_SCHEMA_VERSION.
- DATABASE_SCHEMA.md: warm fenced publication subsection.

Verification (main-run, root):
- db reset --yes exit 0 (001-024 + seed). Log T10/full-pgtap.log.
- Full pgTAP: 35 files, 3623 passed, exit 0.
- One red-green iteration: plausible-but-wrong dimensions must skip quietly
  while absurd dimensions fail loudly (range check added + stale-dims negative).

Next T11 fenced C7 publication; T03 stays COMPLETE with carried limits.
