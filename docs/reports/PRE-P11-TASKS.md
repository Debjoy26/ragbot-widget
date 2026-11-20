# Pre-P11 tasks and mandatory checkpoints

## Current execution state

PUSHED to `origin/main` @ `8a38455` (via `9c35306`), 2026-11-19; P7-P10
accepted with host-bound carries T25-d/T26-a OPEN. STOPPED — next-work packet
recorded in LATEST-CHECKPOINT.md (healthy-host re-runs, hosted 018-027
decision, remaining carries, P11 start conditions). Do anything there ONLY on
explicit owner go-ahead. No active checks/workers. No further
commit/push/install/deploy/hosted/provider action is approved.

2026-11-20: owner approved hosted 018-027 apply (DONE, hosted now 027 —
checkpoints/PRE-P11-hosted-018-027-2026-11-20.md) and GNU make install
(pending); gates T25-d/T26-a/T26-b WAIT for healthy host, no commit yet.

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
| T19 | P3/tooling: Windows database and Make gates | Make/race/guard commands work through documented supported execution path; preserve real concurrency and assertion coverage; record exact platform limitations | complete (db-lint --local dropped; 2026-11-20 owner-approved GNU Make 3.81 install via winget — choco blocked on permissions, user PATH updated; guards 116/116 via script AND make test-make exit 0; make db-lint exit 0 "No schema errors found" with Git-Bash-first PATH recipe; make install/npm-ci not run; race via Git Bash direct path in T25; checkpoints/PRE-P11-T19-make-2026-11-20.md) |
| T20 | P4/P10: API smoke shutdown behavior | Diagnose draining/SIGTERM failures on Windows; fix confirmed behavior/harness cause; existing smoke assertions pass | complete (root cause: child.kill signal uncatchable on Windows/TerminateProcess; POSIX-only harness guards, assertions intact: smoke 33/0/2 skipped, ingestion-process 6/4 skipped; checkpoints/PRE-P11-T20.md) |
| T21 | P10: guards and secret scanner | Verify scanner/self-test/Make guards and classify owner-kept demo hit without printing value; fix real issues without concealing secrets or discarding owner edits | complete (self-test 27/27; tracked scan 1 known owner-kept demo hit; untracked 14 classified by location only, 3 restore-URL hits carried to T23, 8 codex-transcript hits for owner triage; guards 111/116 per T19; checkpoints/PRE-P11-T21.md) |
| T22 | P9: combined scheduling/accounting regression | Run all18 analysis cases together on current schema; preserve the conservative spend floor and successor-generation checks; report exact results | complete (clean reset 001-027; combined 18/18 PASS; checkpoints/PRE-P11-T22.md) |
| T23 | P10/P8: repaired-boundary regression | Current restore-checker and URL/widget boundary checks pass; record bundle-size tradeoff; actual restore and live performance evaluation remain P11 | complete (restore 18/18, widget 73/73, shared+policy 1140/1140; restore URLs confirmed runtime fakes; bundle raw 497021/gzip 106721, perf unmeasured/P11; checkpoints/PRE-P11-T23.md) |
| T24 | Integrated build/static gates | Root build, lint, format and typecheck all pass; checkpoint each command/result | complete (build/lint/format/typecheck all exit 0; fixed TEMP profiler lint + 7-file prettier style incl. T20/T18a lineage; semantics re-proven 52/52 + smoke 33/0/2; checkpoints/PRE-P11-T24.md) |
| T25 | Integrated local DB gates | Clean local replay, full pgTAP, lint, real races and local advisors pass; checkpoint each command/result; no hosted writes | needs-fix (replay/pgTAP 37/3671/lint/advisors PASS; race OPEN: npipe guard fixed, 4 runs 14/4/8/10 — confirmed 3.5-7s docker-exec overhead vs sub-second harness margins, zero data violations in 204 orderings; 2026-11-20 healthy-host re-run: 3x51 orderings all CONSISTENT, same 4 fast-UNEXPECTED-BLOCK artifacts as RAM fell 839MB->247MB, exit 1; checkpoints/PRE-P11-T25.md + PRE-P11-T25d-rerun-2026-11-20.md, logs docs/evidence/T25/race-rerun-2026-11-20.log + race-rerun2-2026-11-20.log) |
| T26 | Integrated unit/integration gates | Full unit and full local integration pass; diagnose every failure, preserve tests; checkpoint each suite and any interrupted run | partial (T26-b re-prove OPEN: 2026-11-20 single-command on clean DB exit 1 — 3 failed/783 passed/66 skipped; 4 hook-timeout whole-file skips + 2 seed-spawn 5s timeouts + 1 analysis-budget assertion; isolation analysis-budget 8/8 alone = load cross-talk, 4 hook files unclassifiable alone at 0.1GB, admin-real 242/244; prior --maxWorkers=4 CLOSED basis (848 passed) stands on unchanged tree. T26-a still OPEN: 2026-11-20 single-command exit 1 — 45 failed/3456 passed incl 23x 5s timeouts; all 6 failing files green alone; checkpoints/PRE-P11-T26.md + PRE-P11-T26a-rerun-2026-11-20.md + PRE-P11-T26b-rerun-2026-11-20.md + PRE-P11-T26b-isolation-2026-11-20.md (2026-11-20 isolation: 5/5 green alone — api-wiring 10/10, db-boundary 24/24, first-admin 21/21, worker-runtime 7/7, admin-real 244/244 — plus analysis-budget 8/8: 6/6 failures classified contention, zero product assertions open; single-command re-proves stay OPEN), logs docs/evidence/T26/unit-rerun-2026-11-20.log + integration-rerun-2026-11-20.log) |
| T27 | Integrated running-system/guard gates | API smoke, compiled worker, Make guards, secret self-test and untracked-inclusive scan pass; checkpoint each command/result | complete (smoke 33/0/2; dist-check PASS; guards 111/116 per T19; self-test 27/27; untracked scan same 14 classified, no new hits; checkpoints/PRE-P11-T27.md) |
| T28 | P7–P10: final documentation and handoff | Synchronize affected current docs and evidence; cross-check actual Git/schema truth; list manual/hosted/phase gates; STOP BEFORE P11 | complete (checkpoints/PRE-P11-T18b.md..T28.md, evidence T18f/T25/T26, continuity synced; race + single-command gates carried OPEN; checkpoints/PRE-P11-T28.md) |
| T29 | Documentation-only: align backend plan with admin-panel proposal | Record cross-repo ownership and proposed provider, widget-key, subscription, reviewed-answer, and AWS-hosting contracts; no code/migrations/phase progression; checkpoint and preserve pre-existing work | complete (PRD/architecture/technical/database/plan + ADR 0019, status/handover/tracker sync; checkpoint `checkpoints/PRE-P11-T29-admin-panel-contract.md`; no commit/push to this repo) |

Dependencies: T01 precedes any020 application; T02 precedes T03. T04–T13 freeze
and integrate the C8 contracts before T14/T15. T16–T23 resolve remaining known
pre-P11 failures. T24–T27 run on the final integrated tree and do not replace
the full-suite requirements in rules.md. New source changes invalidate relevant
later gate evidence; rerun the necessary gates and record why.

T24–T27 contain several prescribed suite commands. Treat each command as its
own checkpoint boundary (`T24-a`, `T24-b`, etc.) if it cannot fit safely in one
small task. Do not start a long suite just to race a usage limit.

## Current handoff

T29 is complete as a documentation-only proposal. The main worktree was
`main` @ `8a38455` at task start; preserve its pre-existing dirty changes and
both temporary worktrees. Hosted migrations 018–027 were applied with owner
approval on 2026-11-20; local/hosted history is recorded at 027. T25-d and
T26 single-command gates remain open; STOP BEFORE P11. Read
`LATEST-CHECKPOINT.md` and `OPENCODE-HANDOFF.md` for current next actions.
T29 does not authorize implementation, a hosted write, P11/P12, or a commit or
push to `ragbot-widget`. Full original task file archived in
checkpoints/PRE-P11-TASKS-BEFORE-DOC-SYNC-2026-11-18.md.

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
