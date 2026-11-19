# Exact technical checkpoint - pre-P11

> CHECKPOINT STOP - 2026-11-18 12:35:47 UTC: owner reported10% of the five-hour usage allowance remaining and requested checkpoint updates. Work stopped at completedT03c-3a: clean LOCAL replay001-020+seed exit0, schema/history20. T03c-2:69pgTAP passes. Full pgTAP(T03c-3b) NOT STARTED; next action after owner resumes is the pinned local test-db command in LATEST-CHECKPOINT.md. No checks/workers running; local containers remain. Hosted-last017 unchanged. Preserve all dirty files/worktrees. STOP BEFORE P11. This supersedes older current/pause/next-task notes below.


> T03c-3a COMPLETE: clean LOCAL replay001-020+development seed exit0; schema/history20,1seedbot,0warmingjobs. Database healthy; ancillary pg_meta/realtime/vector/analytics unhealthy in immediate snapshot, tracked as local-stack limitation. NextT03c-3b full pgTAP; parentT03/full acceptance OPEN. T03c-2 had69PASS. Hosted-last017 unchanged. Owner monitors usage; checkpoint each task and STOP BEFORE P11.


> T03c-2 COMPLETE: actual LOCAL020 pgTAP69PASS/exit0; real claim/reclaim/refund generations1/2/3, browser denials and service trigger-call denials verified. Initial65PASS/2FAIL was an incorrect service-trigger ACL expectation, corrected transparently; no schema defect/fix claimed. NextT03c-3: clean local replay/fullDBsuite. ParentT03/full acceptance OPEN. Hosted-last017 unchanged. Owner monitors usage; checkpoint every task and STOP BEFORE P11. No release/provider/hosted actions. Prior pause/next-task paragraphs below are historical.


> T03c-1 DIAGNOSTIC COMPLETE: standalone local advisors0/results[] and strict public lint0/results[]. Original connection timeout retained, root cause unproven; carry toT16. Managed Storage static-lint findings and Makefile legacy flag remain tracked. NextT03c-2: grants/actualclaim RPC; parentT03/full acceptance OPEN. Local020/hosted-last017 unchanged. Owner resumed and monitors quota; stop on owner signal. No release/provider/hosted actions.


> OWNER RESUMED - T03c-1: owner said continue after meal. Resume the saved local CLI connection diagnosis; last completeT03b, local schema020, hosted-last017 unchanged. Next command is the standalone local db-lint comparison. Owner monitors quota; checkpoint each task and STOP BEFORE P11. Prior meal-pause paragraphs are historical.


> OWNER PAUSE FOR MEAL - 2026-11-18. STOPPED at 2026-11-18 11:11:44 UTC. Last completedT03b (34integrationPASS, local020 verified). T03c-1 is incomplete; advisor timeout remains open. Resume from docs/reports/checkpoints/PRE-P11-T03c-1.md only when owner says continue; next operation is the standalone local db-lint comparison, not an advisor retry. All checks/workers finished; no pending implementation process. Hosted-last017 unchanged. STOP BEFORE P11. Earlier continue/task paragraphs are historical.


Updated 2026-11-18 after T03b. Last completed: T03b. Next: T03c.
Read AGENTS.md, rules.md, status.md, handover.md, the task plan and Git truth.

## Authorization and usage

Complete the authorized LOCAL repairs through P10, checkpoint every task, and
STOP BEFORE P11. The owner's latest instruction is to continue while the owner
monitors the five-hour usage allowance. Do not block solely on a missing agent
usage counter or repeatedly request a reading. No percentage/reset is claimed.
Stop on an owner stop/5% signal or an authoritative reading <=5%, then save
continuity only. No commit/merge/push, hosted writes, dependency installs,
deployments or real provider calls are authorized by this local repair scope.

## Actual workspace and database state

Root: D:/Projects1/Text_AI/ragbot-widget.
Branch: p7.5/d4-integration. HEAD/base: aa6425a. Node:26.13.1.
All work is UNCOMMITTED. Preserve every dirty/untracked/owner file; never reset,
clean, stash or discard this checkout. Actual LOCAL schema and migration history
are now020, verified after the pinned CLI applied only020 at127.0.0.1:54322.
Hosted remains last verified017, unchanged and not queried in this run.
018/019/020 are LOCAL ONLY. Expected schema20 now matches the local stack.

## Recent completed tasks and evidence

- T01: fixed enabled fixture, C7 flag and dynamic version assertions; added
  disabled control. Actual019 baseline:1 expected queue FAIL/1PASS/1filtered.
- T02: explicit JSON integer warm_max_attempts1..10, no default; INSERT supplies
  jobs.max_attempts. Real rollback regression11FAIL/3PASS ->14PASS.
- T03a: AFTER UPDATE plus actual-version WHEN now catches008 BEFORE-derived
  settings changes. Real rollback5FAIL/21PASS ->26PASS. Root typecheck0;
  targeted lint/format0; both static reviews clear.
- T03b: applied020 locally; fixed order-dependent fence test using per-case
  fixtures/explicit enqueue. Isolated red1FAIL/2filtered ->1PASS/7filtered.
  Combined real API/SQL integration:34PASS/3files. Targeted lint/format0.
  Full current-root typecheck not repeated after T03b's test additions; last
  root typecheck0 is T03a. Full system acceptance remains open.

Detailed checkpoints: docs/reports/checkpoints/PRE-P11-T01.md, T02.md,
T03a.md and T03b.md. Logs: docs/evidence/P7.5-D4/T01,T02,T03a,T03b/.
No checks/workers from completed tasks are running.

## EXACT next task - T03c-3b (not started)

Stopped at completed3a; owner reported10% remaining. After owner resumes,
run pinned CLI test db against LOCAL only, logT03c-3/full-pgtap.log; checkpoint
exit/counts as3b. See LATEST-CHECKPOINT.md for exact command and sandbox needs.
Reset6446 finished exit0, schema/history20 and development seed verified. No
reset repeat required. No task check/worker running. Ancillary container health
limitations remain. Then3c strict public lint/advisors serially. Managed Storage
static findings, Make CLI3 compatibility(T19), original timeout(T16) still open.
T03c-2 covers actual claims/reclaims/refunds and role denials,69passes. Parent
T03/full acceptance OPEN. Hosted-last017 unchanged. STOP BEFORE P11.

## Remaining C8 work and worktrees

Shared server cache/prompt/citation/context extraction is integrated; API paths
retain compatibility exports. Package exports and Vitest SOURCE alias exist.
Root warm handler is STILL the old stub. warming-config.ts is INTERFACE ONLY.

C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p75-d4, branch p7.5/d4@aa6425a:
NEW H1 DRAFT NOT INTEGRATED: worker/src/jobs/warm-answer-cache.ts and
 tests/unit/worker/warm-answer-cache.test.ts (14UNRUN synthetic cases).
Inspect/copy ONLY those two files; do not overwrite newer root/E1 changes.
C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p10-d3, branch p10/d3@aa6425a:
OLD restore-checker draft. NEVER copy it over corrected root files.

T04: required payload settings_version. T05: runtime warmGeneration parsing.
T06: validated opt-in config/prices/model keys/hidden secrets. T07-09: budget,
per-invocation usage, settlement and recovery. T10-11: fenced C4-C7 publication.
T12: H1 integration. T13: registry. T14: actual local warm-to-separate-API cache
round trip with labelled fake providers. T15: integrated reviews. No real calls.
Pending RPC/accounting/lock-order design remains in the technical archive below.

## Earlier repairs and final gates

A01/A02/A10/A11 analysis budget; A03 kill-switch; A04-A07 widget bootstrap,
challenge, EOF and sessions; A09 analysis scheduling; A12 metrics; A13 restore
checker preparation; A14 URL parity; A15 public config validation carry their
recorded bounded checks. None establishes final full-suite acceptance.

A09 combined18-case rerun remains pending. Preserve the conservative .10 floor
plus .03 new reservation, with .02/.03 recorded usage. A15 widget raw496989 /
gzip107761 bytes; performance UNMEASURED. Existing first HTTP5000ms timeout and
six citation500ms failures were not weakened. Broad extraction/confinement/admin
setup, Windows Make/race, API smoke33PASS/2FAIL, owner-kept demo scan remain.
T16-T28 address these and final integrated gates/docs. No CI as evidence.
Actual restore, live provider evaluation and load belong to P11: DO NOT START.

## Historical design

[Archived technical snapshot](checkpoints/PRE-P11-TECHNICAL-ARCHIVE-2026-11-18.md)
retains draft RPC signatures, pending-usage accounting/locking design and older
counts. Its old max_attempts/disabled-fixture blocks and UNKNOWN-quota gating
are superseded by completed tasks and the latest owner instruction.
