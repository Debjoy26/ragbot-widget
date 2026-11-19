# T22 - combined scheduling/accounting regression

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T22. Local DB reset clean (001-027 + seed) for this task;
hosted-last 017 unchanged.

Scope: all 18 analysis cases TOGETHER on one clean DB (the T18a handback
finding proved cross-run queue pollution breaks the handback case, so the
combined rerun started from `supabase db reset`, exit True).

Verification (main-run, root):
- `npx supabase db reset` exit True (migrations 001-027 + seed reapplied).
- `npx vitest run tests/integration/analysis-budget.test.ts
  tests/integration/analysis-scheduling.test.ts`: 2 files, 18/18 PASS (49.99s).

Triage: conservative spend floor and successor-generation checks preserved
(all assertions unchanged); no defect. The T18a pollution mechanism
(oldest-first `claim_jobs` picking stale jobs from killed earlier runs) did
not recur from the clean start.

Next: T23 restore-checker + URL/widget boundaries (owns the 3 restore-test
postgres-URL classifications carried from T21). Then T24-T27 full gates, T28
sync + STOP BEFORE P11.
