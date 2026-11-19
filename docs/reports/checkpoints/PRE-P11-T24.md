# T24 - integrated build/static gates

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. Small
harness/format fixes only (below); no product change. Local schema 027,
hosted-last 017 unchanged.

Results (main-run, root, each exit 0):
- T24-a `npm run build`: exit 0 (incl. widget v1.0.0 bundle).
- T24-b `npm run lint`: exit 0 — after fixing 3 errors in the untracked TEMP
  profiler `tests/integration/zz-t18-prof.ts` (`stack` unused binding removed
  keeping the status-spawn side effect; last `t0` reassignment unassigned).
  Same console behavior; the file is a manual helper, not a test.
- T24-c `npm run format:check`: exit 0 — after `prettier --write` on 7 LF
  files: `scripts/api-smoke.mjs` (my T20 edit's style),
  `tests/unit/worker/extract-confinement.test.ts` (T18a lineage),
  `tests/unit/shared/token-jobs-settings.test.ts`,
  `tests/integration/restore-collector.test.ts`,
  `tests/integration/zz-t18-jobs.ts`, plus 2 evidence scripts
  (`docs/evidence/P2-D1/generate-url-fixtures.mjs`,
  `docs/evidence/P8-D10/reproduce-a07.mjs`). Whitespace/style only; evidence
  results untouched.
- T24-d `npm run typecheck`: exit 0 (`tsc -b`, widget, tests).

Regression proof the formatting/fixes changed no semantics:
- `extract-confinement.test.ts` + `token-jobs-settings.test.ts`: 52/52 PASS.
- `node scripts/api-smoke.mjs`: 33 passed, 0 failed, 2 skipped (unchanged).

Note: 6 of the 7 format findings pre-date this session (overlay/evidence
style); the gate is green now without touching specs or weakening anything.

Next: T25 local DB gates (clean replay, full pgTAP, lint, real races, local
advisors), T26 full unit/integration, T27 running-system/guards, T28 sync +
STOP BEFORE P11.
