# T11 - fenced C7 publication

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only (reset + pgTAP on 127.0.0.1:54322);
no hosted/provider/release action.

Gap: T10 fenced C4-C6 publication, but no fenced path existed to persist warmed
C7 answer L2 records: the shared `cache_set_answer` RPC accepts any
service_role call with a well-formed record.

Changes (migration + tests + spec; no app/worker code — wiring is T13):
- supabase/migrations/025_warm_publish_answer.sql: warm_layer_enabled gains an
  explicit-opt-in c7 branch (c7/answer_cache/answer/enabled true; default off);
  publish_warm_answer (lease/version/bot/policy/c7 checks + current corpus/
  settings + completed/moderated/non-truncated/non-blocked-handoff eligibility
  + PII/contact refusal + active cited-doc recheck + rag-v2 template; stale or
  ineligible returns false, cross-bot/foreign-lease refused RB004/RB013,
  malformed 22023). Delegates upserts to cache_set_answer. Service-role
  grants; schema version 24 -> 25.
- supabase/tests/database/324_warm_publish_answer.test.sql: 38 tests (catalog 6:
  exists/grants/invoker/lock; C7 32 incl. live/handoff/republish true, stale/
  disabled/policy-off/unopted/template/PII/contact/blocked/partial/
  unmoderated/truncated/uncited/blocked-handoff/deleted/excluded negatives,
  cross-bot/lease/malformed loud errors).
- Census bumps 24 -> 25: 220 (x7 + label), 250, 260, 290,
  tests/integration/helpers/local-stack.ts EXPECTED_SCHEMA_VERSION.
- DATABASE_SCHEMA.md: warm fenced C7 publication subsection.

Verification (main-run, root):
- db reset --yes exit0 (001-025 + seed).
- Targeted 324: 38 PASS (one red-green iteration: storage_path must be
  {bot}/{doc}/{version}/{file} per G-8, fixed to dynamic uuid paths).
- Full pgTAP: 36 files, 3661 PASS, exit0 (3623 + 38).
- npm run typecheck exit0.

Next T12 inspect and integrate H1 draft; T03 stays COMPLETE with carried limits.
