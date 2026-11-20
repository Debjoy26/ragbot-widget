# P9-D4 — analysis scheduling (A09)

Updated 2026-11-18. Main-session repair, base `aa6425a` plus preserved dirty
tree, implemented on `p9/d4` and carried into `p10/d2`. Repo-root cwd,
Windows, Node 26.13.1. Owner authorized local pre-P11 repairs, stopping before
P11. No commit, push, hosted write, deployment or real provider call.

Migration 019 adds requested/claim/context revision watermarks to jobs. Each
enqueue advances requested revision, including while running. Context capture
takes the job update lock before the conversation fence. Terminal work with
uncovered requests atomically reuses its live row, resets the successor retry
budget and preserves generation. Covered failures stay terminal; reclaim
refreshes coverage. Deleted conversations do not receive successor work.
Accounting stays attached to original generation/reservation. ACLs/search
paths remain restricted. Hosted migration 017 and local 018 were not edited.

## Main-session results

- `red-scheduling.log`: schema 018, exit 1, 1 failed / 5 filtered cases;
  completion lost an enqueue arriving after context capture.
- `migration-preview.log`: exit 0, only 019 pending, explicit local target
  127.0.0.1. `migration-local.log`: exit 0, applied locally only.
- Initial `pgtap.log` failed on residual fixtures from earlier interrupted
  runs: 5 bots, 12 jobs, 13 Storage metadata rows. It is not success evidence.
  Prescribed local reset then replayed migrations through 019.
- `reset-local.log`: exit 0. `pgtap-clean.log`: exit 0, **3427 passed / 30
  files**, including 18 new scheduling/role checks.
- `integration.log`: exit 0, **17 passed / 2 files** (9 scheduling, 8 existing
  budget tests), real local DB with labelled fake AI only.
- `db-lint.log`: exit 0, no schema errors. `advisors.log`: exit 0,
  security/performance warn-level results empty.

Two read-only reviewers found no migration blocker. One test fixture expected
fail_job at attempt 1/5 to dead-letter. It was corrected to max_attempts 1
before the passing run; production retry policy was unchanged. Main inspected
and ran verification. Worker reports are static/self-reported.

## Added late-usage case — targeted rerun passed

After the 17-case run, a successor-plus-late-usage regression was added.
`late-usage.log` failed on an incorrect new expected reservation total .05.
Migration 018 intentionally retains the .10 unknown-spend floor after a
smaller late .02 report; the next reservation settles at .03. Correct
reservation total is .13, while usage records .02 + .03.

The test now asserts each reservation amount and both original usage bindings
and amounts. This corrects an expectation against the existing fail-closed
rule; SQL/spend protection was not weakened. That corrected extra case has
passed its targeted rerun: 1 passed, 9 filtered (`late-usage-final.log`).
The full 18-case combined run has not yet been repeated; the earlier 17-case
result and this targeted result are separate evidence.

Final integrated/full-system gates and other repairs remain open. Local
schema is 019; hosted last recorded 017. See the exact session checkpoint.
