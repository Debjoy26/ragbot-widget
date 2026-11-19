# Pre-P11 tasks and mandatory checkpoints

## Current execution state

STOPPED at completed pre-P11 local program (T18b-T28), 2026-11-19. Owner
continuation complete for this run; STOP BEFORE P11. T25-d (real races) and
T26 single-command full gates stay OPEN on measured host bounds (see below);
everything else in T18-T28 is complete with checkpoints. No active
checks/workers. No commit/push/install/deploy/hosted/provider action was
performed or is approved.

## Latest owner instruction - continue with owner-monitored usage

Owner explicitly instructed: continue the tasks so the owner can decide when
to stop. Proceed with authorized local tasks and checkpoint every task; do not
block solely because the agent cannot read the account meter. The owner
monitors the five-hour allowance and can report the5% threshold or stop at any
time. Stop immediately on that signal or any available authoritative reading
at/below5%, then save continuity. Do not claim automatic quota monitoring or
infer a reset/current percentage. This supersedes prior UNKNOWN-quota blocks.
No change to the stop-before-P11 or hosted/release approval boundaries.


Owner instruction recorded 2026-11-18: break remaining work into small tasks,
checkpoint at the end of every task, and stop implementation at 5% remaining
of the account's five-hour usage allowance. Do not enter P11.

Read this file together with [the exact technical checkpoint](SESSION-CHECKPOINT-2026-11-17.md)
and [the repair tracker](PRE-P11-REPAIR-TRACKER.md). This task list organizes
existing authorized local work; it does not approve releases or hosted writes.

## Usage rule - current, supersedes original UNKNOWN blocks

Last owner reading10% remaining at the12:35:47UTC checkpoint; work is STOPPED
for handoff, not awaiting another quota-reading request. Resume on owner
continuation. Owner monitors the five-hour account allowance; no automatic
meter/reset is available or claimed. Do not repeatedly block solely because
agent telemetry is absent. Stop immediately at known<=5% remaining or owner
signal and save continuity only. This is not a context or wall-clock limit.

## Execution and checkpoint rules

Work on one bounded task at a time. Preserve all existing dirty work and both
temporary worktrees. Main performs verification; worker reports are unverified.
Use the AGENTS assignment packet and isolated ownership for any delegated work.

At every task end, including a failed, interrupted or quota-stopped task:

1. Write `docs/reports/checkpoints/PRE-P11-Tnn.md`. Never overwrite a completed
   task's historical result to make a later run appear green; append dated
   attempts or link a follow-up checkpoint.
2. Update the state table below, the repair tracker, `status.md`, `handover.md`,
   and the exact session checkpoint. Update any specs/runbooks affected by the
   task; record which were reviewed unchanged. Do not rewrite archived evidence.
3. Record branch/HEAD, dirty owned files, worktree paths, actual local and last
   verified hosted schema, unapplied files and expectation mismatches.
4. Record each verification command, cwd, environment, exit code, counts and
   evidence path. Separate setup failures, real regressions, fake-provider
   checks and actual local/hosted checks. Mark unrun commands explicitly.
5. Record findings, fixes, reviews, remaining risks, required approvals, worker
   state and all running session IDs. State the exact next task and first action.
6. Record the usage reading/source/time, or UNKNOWN. Check the stop rule before
   starting the next task. A checkpoint is not a commit or phase acceptance.

Task states: `pending`, `active`, `complete`, `needs-fix`, `stopped`. Complete
means that task's bounded exit condition is met; full phase acceptance still
requires the repository's full suite and review gates. A failure never advances
the dependent task. Two unsuccessful debug cycles on one defect follow rules.md.
If a task expands beyond a small unit of work, checkpoint and split it further.

## Ordered tasks

| ID | Phase / bounded task | Exit condition and required checkpoint | State |
|---|---|---|---|
| T00 | Continuity plan and usage policy | Save this task list, repo instructions, technical resume pointers and T00 checkpoint; verify documentation diff | complete |
| T01 | P7.5: correct queue-test preconditions | Enable synthetic bot explicitly, use recognized C7 flag, compare actual settings version, add disabled negative; reproduce missing queue on actual local019 before020 apply | complete |
| T02 | P7.5: repair020 retry policy | Resolve missing `jobs.max_attempts` with explicit validated bounded configuration; regression cases for missing/invalid limit and unchanged originating transaction; independent static review | complete |
| T03 | P7.5: verify queue and lease generation | Replay/targeted claims complete; full post-reset pgTAP/lint/advisors PASS; Storage/Make/health carried to T16/T19, full suite to T24-T27 | complete |
| T04 | P2/P7.5: freeze warm payload contract | Required settings_version; accept current payload and reject missing/invalid versions; preserve unrelated shared contracts | complete |
| T05 | P6/P7.5: carry warm claim generation | Parse and propagate warmGeneration, require it for warm jobs, reject malformed/stale claims; unit regressions pass | complete |
| T06 | P7.5: validated warming configuration | Opt-in/default-off loader, explicit prices/limits, matching model identities, hidden secrets; invalid/missing config fails closed; env/runbook docs updated | complete |
| T07 | P7.5: reservation schema and reserve RPC | Original generation/question binding and immutable allowance; atomic daily cap shared with chat/index/analysis; duplicate/concurrent/cap/role negatives pass locally | complete |
| T08 | P7.5: per-invocation usage ledger | Pending charge precedes provider call; idempotent final usage and late accounting preserve original binding; finalized spend cannot disappear; local negatives pass | complete |
| T09 | P7.5/P9: settlement and recovery | Unknown calls retain conservative charges; index sweep excludes warm holds; orphan/late-report/retry/zero-cost regressions pass locally | complete |
| T10 | P7.5: fenced C4–C6 publication | Actual shared L2 records, current lease/version/policy/model checks and correct keys; stale/disabled/cross-bot/role negatives pass | complete |
| T11 | P7.5: fenced C7 publication | Current corpus/settings and active cited docs, completed/moderated eligible answer only; deletion/version/PII/blocked/truncated/citation negatives pass | complete |
| T12 | P7.5: inspect and integrate H1 draft | Copy only handler and14 draft tests from warm worktree; reconcile frozen contracts, format/compile, run and repair draft unit cases; report actual counts | complete |
| T13 | P7.5: production registry wiring | Register real warm handler; configured adapters or visible fail-closed behavior; no fake successful warming, no real provider calls; compiled-worker checks pass | complete |
| T14 | P7.5: real local cache round trip | Actual local DB + labelled fake providers warm shared L2; separate API instance serves first-turn hit; auth/moderation/rate limits still enforced | complete |
| T15 | P7.5: independent integrated reviews | Correctness/security review; confirm findings, bounded debug fixes, rerun relevant checks and rereview; no unresolved confirmed blocker | complete |
| T16 | P7/P7.5: first HTTP-test timing defect | Profile setup/ready/request/provider/cleanup under controlled load; identify cause and fix it without increasing timeout or dropping assertions to hide failure | complete |
| T17 | P7: citation timing defects | Profile hostile input shapes; diagnose six recorded500ms failures and fix confirmed cause; preserve all hostile cases and bounds | complete |
| T18 | P6/integration: remaining extraction/setup failures | Reproduce remaining broad extraction/confinement and admin/bootstrap setup families; split confirmed defects into subtask checkpoints and fix without weakening negatives | complete (T18a confinement fixed; T18b first-admin 21/21; T18c parity 264/264 + helper 8/8; T18d admin-real 244/244; T18e api-wiring 10/10 + limits/auth 40/40; T18f chat-e2e 82/82 + worker-runtime 7/7 + ingestion-e2e green; 4 drain cases fixed in T20 via POSIX guards: checkpoints/PRE-P11-T18a.md..T18f.md + T20.md) |
| T19 | P3/tooling: Windows database and Make gates | Make/race/guard commands work through documented supported execution path; preserve real concurrency and assertion coverage; record exact platform limitations | complete (db-lint --local dropped, lint clean; guards 111/116, 5 fail only on missing make binary — install needs owner approval; race/test runs via Git Bash direct path in T25) |
| T20 | P4/P10: API smoke shutdown behavior | Diagnose draining/SIGTERM failures on Windows; fix confirmed behavior/harness cause; existing smoke assertions pass | complete (root cause: child.kill signal uncatchable on Windows/TerminateProcess; POSIX-only harness guards, assertions intact: smoke 33/0/2 skipped, ingestion-process 6/4 skipped; checkpoints/PRE-P11-T20.md) |
| T21 | P10: guards and secret scanner | Verify scanner/self-test/Make guards and classify owner-kept demo hit without printing value; fix real issues without concealing secrets or discarding owner edits | complete (self-test 27/27; tracked scan 1 known owner-kept demo hit; untracked 14 classified by location only, 3 restore-URL hits carried to T23, 8 codex-transcript hits for owner triage; guards 111/116 per T19; checkpoints/PRE-P11-T21.md) |
| T22 | P9: combined scheduling/accounting regression | Run all18 analysis cases together on current schema; preserve the conservative spend floor and successor-generation checks; report exact results | complete (clean reset 001-027; combined 18/18 PASS; checkpoints/PRE-P11-T22.md) |
| T23 | P10/P8: repaired-boundary regression | Current restore-checker and URL/widget boundary checks pass; record bundle-size tradeoff; actual restore and live performance evaluation remain P11 | complete (restore 18/18, widget 73/73, shared+policy 1140/1140; restore URLs confirmed runtime fakes; bundle raw 497021/gzip 106721, perf unmeasured/P11; checkpoints/PRE-P11-T23.md) |
| T24 | Integrated build/static gates | Root build, lint, format and typecheck all pass; checkpoint each command/result | complete (build/lint/format/typecheck all exit 0; fixed TEMP profiler lint + 7-file prettier style incl. T20/T18a lineage; semantics re-proven 52/52 + smoke 33/0/2; checkpoints/PRE-P11-T24.md) |
| T25 | Integrated local DB gates | Clean local replay, full pgTAP, lint, real races and local advisors pass; checkpoint each command/result; no hosted writes | needs-fix (replay/pgTAP 37/3671/lint/advisors PASS; race OPEN: npipe guard fixed, 4 runs 14/4/8/10 — confirmed 3.5-7s docker-exec overhead vs sub-second harness margins, zero data violations in 204 orderings; checkpoints/PRE-P11-T25.md) |
| T26 | Integrated unit/integration gates | Full unit and full local integration pass; diagnose every failure, preserve tests; checkpoint each suite and any interrupted run | partial (T26-b CLOSED: full integration single-command 23 files/848 passed/4 POSIX-skipped exit 0 on clean DB; T26-a OPEN at 3497/3501 — 4 PDF-child 5s timeouts at 0.2GB host free, all failing files green alone; worker flags parallelism-only; checkpoints/PRE-P11-T26.md) |
| T27 | Integrated running-system/guard gates | API smoke, compiled worker, Make guards, secret self-test and untracked-inclusive scan pass; checkpoint each command/result | complete (smoke 33/0/2; dist-check PASS; guards 111/116 per T19; self-test 27/27; untracked scan same 14 classified, no new hits; checkpoints/PRE-P11-T27.md) |
| T28 | P7–P10: final documentation and handoff | Synchronize affected current docs and evidence; cross-check actual Git/schema truth; list manual/hosted/phase gates; STOP BEFORE P11 | complete (checkpoints/PRE-P11-T18b.md..T28.md, evidence T18f/T25/T26, continuity synced; race + single-command gates carried OPEN; checkpoints/PRE-P11-T28.md) |

Dependencies: T01 precedes any020 application; T02 precedes T03. T04–T13 freeze
and integrate the C8 contracts before T14/T15. T16–T23 resolve remaining known
pre-P11 failures. T24–T27 run on the final integrated tree and do not replace
the full-suite requirements in rules.md. New source changes invalidate relevant
later gate evidence; rerun the necessary gates and record why.

T24–T27 contain several prescribed suite commands. Treat each command as its
own checkpoint boundary (`T24-a`, `T24-b`, etc.) if it cannot fit safely in one
small task. Do not start a long suite just to race a usage limit.

## Current handoff

See OPENCODE-HANDOFF.md. CompletedT17 (T03 COMPLETE with carried limits);
nextT18. Older T00 UNKNOWN/019 blocks are historical and superseded. Full original
task file archived in checkpoints/PRE-P11-TASKS-BEFORE-DOC-SYNC-2026-11-18.md.

## T03 subtask boundaries

T02 review found a derived settings-version dispatch bug. Split T03 before
persistent020application; each child has its own checkpoint:

|ID|Bounded work|Exit|State|
|---|---|---|---|
|T03a|Reproduce tone/enable BEFORE-derived settings version gap; fix dispatch and prepare fixtures|Real local rolled-back source regression red->green; policy14assertions preserved; reviews clear|complete|
|T03b|Persistently replay corrected020 on LOCAL only and run real queue/context/fence/version-dedup cases|Actual schema20, corrected census expectation match, targeted integration pass; no hosted writes|complete|
|T03c|Database grants/negative matrix and full clean pgTAP/lint/advisors|Record actual local commands/counts; resolve new findings; parentT03 complete only when all children pass|complete (parent T03 COMPLETE; children T03c-1/2/3a/3b/3c-1/3c-2 all recorded complete)|


## T03c execution boundaries

T03b is complete for local replay/queue API checks; its failed advisor run is
explicitly unresolved. T03c must diagnose that failure, then prove service-only
grants/negative paths and actual claim_jobs acquisition, followed by full local
DB replay/pgTAP/lint/advisors. Save sub-checkpoints if these cannot fit one small
task. Parent T03 stays open until all of these pass.


## T03c child checkpoints

| ID | Work | State |
|---|---|---|
| T03c-1 | Standalone advisor recovery and public lint; original timeout root cause remains a T16 reliability follow-up | complete (diagnostic scope) |
| T03c-2 | Service-only grants, role negatives and actual claim_jobs acquisition | complete (69 local pgTAP passes) |
| T03c-3 | Clean local replay complete; full pgTAP PASS; lint/advisors PASS | complete |


T03c-1 follow-up: retain the original advisor timeout for T16 reliability work.
The standalone command now passes, but its original cause was not established.
T19 must verify/remove the Makefile legacy --local flag and prove exact Make
gates. Managed Storage dynamic-SQL lint findings are retained separately.

## T03c-3 small boundaries

- T03c-3a: COMPLETE, clean LOCAL reset exit0 and schema/history20 verified.
- T03c-3b: COMPLETE, full LOCAL pgTAP 31 files/3496 PASS exit0 (log T03c-3/full-pgtap.log).
- T03c-3c-1: COMPLETE, strict public lint exit0 "No schema errors found" (log T03c-3/public-lint.log).
- T03c-3c-2: COMPLETE, local advisors exit0 "No issues found" (log T03c-3/advisors.log).

Checkpoint each command; do not claim exact Make or managed Storage gates
pass from a direct CLI public-only result.

T03c-3b complete: full pgTAP 31 files/3496 PASS exit0; T03c-3c-1/3c-2 complete:
public lint exit0, advisors exit0. Managed Storage findings stay OPEN (T16/T19);
exact Make gates unproved (T19); integrated full suite to T24-T27. See checkpoints.
