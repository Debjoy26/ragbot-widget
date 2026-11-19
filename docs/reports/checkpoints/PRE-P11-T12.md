# T12 - inspect and integrate H1 draft

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; no hosted/provider/release/commit action.
No DB migration (DB fence T03-T11 unchanged and frozen).

Gap: root worker/src/jobs/warm-answer-cache.ts was still the T00-era stub
(fetcher/no-op success); the real fenced H1 handler and its 14 synthetic cases
existed ONLY in the isolated ragbot-p75-d4 worktree and had never been
compiled or run.

Changes (worker-owned files only; shared contracts and migrations untouched;
registry NOT wired — that is T13):
- worker/src/jobs/warm-answer-cache.ts: full H1 handler integrated from the
  worktree draft, reconciled to the frozen contracts:
  (a) assertEmbeddingShape imports from '@ragbot/shared' (the draft's
      '@ragbot/shared/ai' path does not export it — red on first typecheck);
  (b) the draft's combined publish_warm_cache RPC does not exist: publish is
      per-layer through the real fenced T10/T11 RPCs (C4 -> C5 anchor order,
      then C6, C7), mapping each shared cache-class record to RPC params
      (embedding text form, moderation key identity, raw question + complete/
      moderated/non-truncated eligibility for C7);
  (c) reserve/record/settle calls match the real 021/022/023 signatures:
      p_question_hash (sha256 of normalized question + language) instead of the
      draft's p_question_index/p_language; record_warm_usage without p_worker
      and with integer-truncated token counts; settle_warm_budget with the full
      6-arg fence plus tracked actualTotal (unknown spend keeps its
      conservative charge; a null reserve is a quiet skip, not an error);
  (d) model-identity checks use adapter-vs-key pins (embedding adapter +
      T06 worker config; chat key vs chatModelKey incl. fallback suffix;
      moderation key vs moderationModelKey) because WorkerAiConfig has no
      chat/moderation roles — the draft's config.ai.chatPrimary/moderation
      does not exist;
  (e) new WarmingConfig.moderationMode (worker-owned, from validated
      WARM_MODERATION_MODE) for the endpoint-vs-classifier billing branch.
- worker/src/lib/warming-config.ts: moderationMode field + loader line.
- tests/unit/worker/warm-answer-cache.test.ts: 14 draft cases integrated and
  adapted (per-RPC publish mocks incl. C4-before-C5 order pin and C7 fenced
  args) plus 2 new fail-closed pins (missing warmGeneration retries;
  settings_version-less payload resolves without warming, T04). 16 PASS.
- tests/unit/worker/warming-config.test.ts: moderationMode assertion (+1).
- tests/unit/api/answer-cache.test.ts: removed the 4 superseded stub-behavior
  tests (fetcher path, silent success, dedupe-at-6, silent missing generation)
  plus now-unused imports. Their intent is preserved by the new worker file:
  fence-gated quiet skip (disabled/superseded), normalized dedupe, fail-closed
  generation (now a transient retry) and T04 payload pins. C7 cache-class
  coverage in that file is unchanged.

Verification (main-run, root):
- vitest worker warm files: 16/16 PASS (one red-green iteration: moderation
  mock verdict widened to string; one expectation fix: output verdict is not
  C6-cached, only the input verdict is — single c6 entry per variant).
- Broader worker+api unit scope: 63/63 in touched files; full worker+api sweep
  2180 PASS / 48 FAIL in UNRELATED files only (extract/index-document PDF child
  timeouts, chunk/citation timing bounds) — the documented T16/T17/T18
  environment families; none import the changed modules (verified by grep).
  No assertion weakened, no test deleted to get green (superseded stub block
  replaced, mapped above).
- npm run typecheck exit 0; npm run lint exit 0; prettier --write on the 5
  touched files (answer-cache.test.ts already conformant after LF
  normalization of the trim edit).

Next T13 production registry wiring; T03 stays COMPLETE with carried limits.
