# T04 - freeze warm payload contract

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; no migration/hosted/provider/release action.

Gap: DB 020 requires settings_version in the warm payload (unique index and
queue_warm_job build bot_id/corpus_version/settings_version; integration tests
already assert it), but shared warmAnswerCachePayloadSchema accepted only
{bot_id, corpus_version}. A version-less payload could pass shared validation
while never matching a queued DB row.

Changes (contract + tests/comments only; unrelated contracts untouched):
- shared/src/schemas.ts: warmAnswerCachePayloadSchema gains required
  settings_version: z.int().min(1) (matches bot_profiles convention).
- worker/src/jobs/warm-answer-cache.ts: payload comment updated; handler
  already rejects invalid payloads via safeParse (warm_payload_invalid).
- tests/unit/shared/token-jobs-settings.test.ts: valid warm fixture gains
  settings_version; new test rejects missing/0/negative/fractional/string
  settings_version. Red-on-old by construction: old strictObject rejects the
  new key, new schema rejects its absence.
- tests/unit/api/answer-cache.test.ts: three warm handler job payloads gain
  settings_version (handler safeParse would otherwise early-return and fail
  the fetcher/embed expectations).

Verification (main-run, root):
- npx vitest run token-jobs-settings + answer-cache: 2 files, 80 tests PASS.
- Verbose: new "rejects warm payloads with missing or invalid
  settings_version" PASS; mismatch suite intact.
- npm run typecheck: exit 0.

Next T05 carry warm claim generation; T03 stays COMPLETE with carried limits.
