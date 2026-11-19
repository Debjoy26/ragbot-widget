# T03a checkpoint - final-version trigger dispatch

Date2026-11-18. State COMPLETE. NextT03b local020replay; T03c grants/fullDB checks.
Root p7.5/d4-integration@aa6425a+all dirtywork preserved. Node26.13.1.
Actual local019 unchanged;020UNAPPLIED. Hosted-last017, notqueried.

## Defect, source change and tests

Confirmed medium queue bug:020 UPDATE OF versioncolumns did not observe008
BEFORE-derived settingsversion changes from tone/identity/scope/languages/enable.
Replaced with AFTER UPDATE plus WHEN actual final corpus/settingsversions differ.
Function still checks versiondifference. Unchanged rows do not enqueue.

New tests/integration/cache-warming-version.test.ts covers12cases: five formerly
missedchanges,explicitcorpus/settingsversions,no-op,disabled,kill,clientsettings
andpublicquestions. Actual queuedpayload must match currentversions.
New helpers/warming-sql.ts fixes localcontainer, replays020on019 INSIDE ROLLBACK
andchecksactualschema restored. Policytest now places enable+corpus inone guarded
mutation; all14 policy expectations retained, avoiding unguarded setup enqueue
under corrected trigger. No original assertions/cases removed or bounds changed.

## Main verification (repo root)

Evidence docs/evidence/P7.5-D4/T03a/:
- Formatter --write three TSfiles: exit0,format.log.
- Targeted ESLint three TSfiles --max-warnings0: exit0,lint.log.
- Vitest integration version+policy files --maxWorkers=1, before SQLfix:
  exit1,5FAIL/21PASS,37.22s,red-version.log. Real missedversiondispatch, notsetup.
- Same command afterfix: exit0,26PASS/2files,23.60s,version-final.log.
- Formatter --check threefiles: exit0,format-check.log.
- npm run typecheck: exit0,typecheck.log; session86276completed.
- Scopedgit diffcheck: exit0; untrackedSQL is actually parsed/exercised bySQLtests.
Unneeded read-only compilerprocess diagnostic was accessdenied; typecheck then
finished0. That failed diagnostic is not a product failure or a passing check.

Both independent read-only correctness/security reviewers found no blocker;
reports self-reported, main inspected008and020andran tests. PostgreSQL primary
CREATE TRIGGER notes confirm UPDATE OF uses originaltargetlist.
https://www.postgresql.org/docs/current/sql-createtrigger.html
No fullsystemacceptance implied. No checks/workers fromT03a remain running.

## Resume

020 retryandversiondispatch nowverified in rolled-back local SQL, but never
persistentlyapplied. T03b: discover pinned CLI local migration options, apply
020LOCALonly, record actual20/history, run real queue/context/fence integration.
T03c: service-only privileges/negative matrix and fulllocalDBgates. Expected
census/helper20mismatch stays pending until replay. H1draft unintegrated,
budget/publication/runtime/config incomplete. Owner monitorsfivehourusage;
continueauthorizedtasks, stoponownersignal. STOP BEFORE P11. No hostedwrite,
commit/push/deploy/install/realprovider call.
