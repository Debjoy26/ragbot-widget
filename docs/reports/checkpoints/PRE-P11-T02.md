# T02 checkpoint - explicit warming retry limit

Date2026-11-18. State COMPLETE for the bounded retry-policy task.
Root p7.5/d4-integration@aa6425a+preserved dirty overlay, Node26.13.1.
Actual local019 remains;020UNAPPLIED. Hosted last verified017, not queried.
Owner explicitly authorized continuation while owner monitors five-hour usage;
no agent counter/reset/percentage claimed. Stop on owner signal.

## Change and evidence

020 queue_warm_job now requires cache_policy.warm_max_attempts as an explicit
JSON integer1..10 when enabled warming can enqueue. It validates before casting
and supplies jobs.max_attempts; no default invented. Disabled/off/kill paths
return before requiring retries. DATABASE_SCHEMA documents this pending contract.

Added tests/integration/cache-warming-policy.test.ts: actual Docker Postgres,
pending020 replayed INSIDE a transaction on019, all fixtures and DDL ROLLED BACK.
On020+ it exercises applied functions directly. Cases valid1/3/10; missing,
null,0,-1,11,fraction,string,bool; disabled bot/off/global kill. Invalid policy
retains original corpus version; valid policy must enqueue with configured limit.
Before/after schema_version is checked equal. No real provider calls.

Main root commands/evidence docs/evidence/P7.5-D4/T02/:
- prettier --write new test and targeted eslint --max-warnings0: exit0,
  format.log/lint.log.
- Vitest integration newpolicy test --maxWorkers=1: red exit1,11FAIL/3PASS;
  SQL23502 occurred even with valid retries, originating corpus delta0.
  red-policy.log. This is real defect evidence, not setup failure.
- Same Vitest command after SQL fix: exit0,14PASS,8.28s,policy-final.log.
  Assertions/expected cases were not changed for green.
- prettier --check both warming integration files: exit0,format-check.log.
- npm run typecheck: exit0,typecheck.log.
- git diff --check scoped files: exit0; existing CRLF warning retained.
Full build/system suite not run as T02; final acceptance still open.

## Reviews and remaining finding

Existing Sol reviewers0and9 ran read-only static reviews (unverified until main
inspection). Retry fix has no bounded blocker. One initial harness claim was
withdrawn after checking UPDATE OF semantics; no fix/expectation change made
on that withdrawn claim.

Both identified a separate settings-trigger gap:020 AFTER UPDATE OF version
columns misses settings_version changes made by008 BEFORE trigger on tone/enable
updates. Main checked008 and official PostgreSQL CREATE TRIGGER documentation.
Runtime reproduction/fix belongs toT03a, BEFORE any persistent020 application.
Also adapt policy fixture so a later all-UPDATE trigger does not enqueue during
unguarded enabled setup. Preserve all14 policy assertions.

## Exact next steps / approvals

T03 split into T03a(reproduce/fix derived version dispatch), T03b(local replay
plus real queue/context/fence checks), T03c(grants/full database checks).
No workers or checks from T02 remain running. No source copied from H1worktree.
No commit/push/install/hosted change/deploy/provider call.020has never reached
hosted and remains mutable locally. Census/helper expect20 pending local replay.
STOP BEFORE P11.
