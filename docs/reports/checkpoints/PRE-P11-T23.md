# T23 - repaired-boundary regression (restore-checker + URL/widget boundaries)

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T23. Local schema 027 (post-T22 reset; T23 runs added no
migrations), hosted-last 017 unchanged.

Verification (main-run, root):
- Restore-checker: `restore-project-check.test.ts` (unit, 13) +
  `restore-catalog.test.ts` + `restore-collector.test.ts` (integration):
  3 files, 18/18 PASS (76.61s).
- Widget boundary: `tests/unit/widget` (config-contract, contact-render,
  public-config, session-cancellation, stream-completion, session,
  transitions, entry, api): 9 files, 73/73 PASS (28.00s).
- Shared contracts + cache policy: `chat-cache-policy.test.ts` +
  `tests/unit/shared`: 18 files, 1140/1140 PASS (44.89s).

T21-carry RESOLVED (restore-test postgres URLs): the flagged lines build URLs
from `randomBytes(...).toString('hex')` at runtime against the placeholder ref
`abcdefghijklmnopqrst` (`restore-project-check.test.ts:20-23,93`,
`restore-collector.test.ts:15` context). Runtime-generated fakes, no real
secrets, nothing committed. No codex-file values were read; that untracked
transcript stays owner-triage per T21.

Bundle-size tradeoff (recorded, not gated): `widget/dist/v1.0.0/widget.js`
raw 497,021 bytes / gzip 106,721 bytes (vs historical 496,989/107,761 —
overlay drift only). Loading performance UNMEASURED; actual restore and live
performance evaluation remain P11, NOT DONE here.

Next: T24 integrated build/static gates, T25 local DB gates, T26 full
unit/integration, T27 running-system/guards, T28 sync + STOP BEFORE P11.
