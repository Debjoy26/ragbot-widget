# Pre-P11 tasks and mandatory checkpoints

## Current execution state

Stopped at completedT03c-3a after owner reported10% remaining and requested
checkpoint updates (2026-11-18 12:35:47 UTC). NextT03c-3b full pgTAP is NOT STARTED.
Resume only on owner continuation. Strict known<=5% stop and STOP BEFORE P11.
No active checks/workers. Latest checkpoint contains exact first command.

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

## Usage gate — no invented percentage

- Hard stop condition: an authoritative reading shows **5% remaining or less**
  (equivalently at least 95% used), or the owner says that threshold is reached.
  Stop implementation, new delegations, builds, tests and migrations. Request
  active workers stop; record their partial work and any running commands.
  Use the remaining allowance only to save and verify continuity documents.
- Five-hour allowance is account usage, not five hours of wall-clock work.
  Context tokens, elapsed time and goal-tool budgets are not substitutes.
- This environment currently exposes no tool for the account's remaining
  five-hour percentage. A precise automatic cutoff therefore cannot be
  guaranteed. Never claim a monitor or a 5% reading exists when it does not.
  Official guidance identifies the usage dashboard and CLI `/status` as user
  interfaces for viewing limits; it does not make those readings available
  to the tools in this thread. [Official OpenAI documentation](https://learn.chatgpt.com/docs/pricing#where-can-i-see-my-current-usage-limits)
- Obtain a current reading before implementation resumes and check again at
  each task boundary and before a long operation. Use live authoritative
  telemetry if a future environment provides it. If that signal is unavailable,
  ask the owner for the displayed reading; this is missing usage information,
  not a request to reapprove already authorized local work.
- With unknown remaining usage, save the checkpoint and do not start another
  implementation task. A past reset time or a stale reading does not establish
  current headroom. Save early if headroom is uncertain; do not wait for 1%.
- Current state: **UNKNOWN**. Last historical owner report was **1% remaining**;
  no reset or newer percentage has been confirmed. This planning turn changes
  documentation only. Do not infer that the implementation session restarted.

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
| T03 | P7.5: verify queue and lease generation | After T01/T02, replay020 locally; queue/context/grants/version-dedup/refundable-attempt/stale-owner tests pass; record actual schema and align census expectations | pending |
| T04 | P2/P7.5: freeze warm payload contract | Required settings_version; accept current payload and reject missing/invalid versions; preserve unrelated shared contracts | pending |
| T05 | P6/P7.5: carry warm claim generation | Parse and propagate warmGeneration, require it for warm jobs, reject malformed/stale claims; unit regressions pass | pending |
| T06 | P7.5: validated warming configuration | Opt-in/default-off loader, explicit prices/limits, matching model identities, hidden secrets; invalid/missing config fails closed; env/runbook docs updated | pending |
| T07 | P7.5: reservation schema and reserve RPC | Original generation/question binding and immutable allowance; atomic daily cap shared with chat/index/analysis; duplicate/concurrent/cap/role negatives pass locally | pending |
| T08 | P7.5: per-invocation usage ledger | Pending charge precedes provider call; idempotent final usage and late accounting preserve original binding; finalized spend cannot disappear; local negatives pass | pending |
| T09 | P7.5/P9: settlement and recovery | Unknown calls retain conservative charges; index sweep excludes warm holds; orphan/late-report/retry/zero-cost regressions pass locally | pending |
| T10 | P7.5: fenced C4–C6 publication | Actual shared L2 records, current lease/version/policy/model checks and correct keys; stale/disabled/cross-bot/role negatives pass | pending |
| T11 | P7.5: fenced C7 publication | Current corpus/settings and active cited docs, completed/moderated eligible answer only; deletion/version/PII/blocked/truncated/citation negatives pass | pending |
| T12 | P7.5: inspect and integrate H1 draft | Copy only handler and14 draft tests from warm worktree; reconcile frozen contracts, format/compile, run and repair draft unit cases; report actual counts | pending |
| T13 | P7.5: production registry wiring | Register real warm handler; configured adapters or visible fail-closed behavior; no fake successful warming, no real provider calls; compiled-worker checks pass | pending |
| T14 | P7.5: real local cache round trip | Actual local DB + labelled fake providers warm shared L2; separate API instance serves first-turn hit; auth/moderation/rate/idempotency still enforced | pending |
| T15 | P7.5: independent integrated reviews | Correctness/security review; confirm findings, bounded debug fixes, rerun relevant checks and rereview; no unresolved confirmed blocker | pending |
| T16 | P7/P7.5: first HTTP-test timing defect | Profile setup/ready/request/provider/cleanup under controlled load; identify cause and fix it without increasing timeout or dropping assertions to hide failure | pending |
| T17 | P7: citation timing defects | Profile hostile input shapes; diagnose six recorded500ms failures and fix confirmed cause; preserve all hostile cases and bounds | pending |
| T18 | P6/integration: remaining extraction/setup failures | Reproduce remaining broad extraction/confinement and admin/bootstrap setup families; split confirmed defects into subtask checkpoints and fix without weakening negatives | pending |
| T19 | P3/tooling: Windows database and Make gates | Make/race/guard commands work through documented supported execution path; preserve real concurrency and assertion coverage; record exact platform limitations | pending |
| T20 | P4/P10: API smoke shutdown behavior | Diagnose draining/SIGTERM failures on Windows; fix confirmed behavior/harness cause; existing smoke assertions pass | pending |
| T21 | P10: guards and secret scanner | Verify scanner/self-test/Make guards and classify owner-kept demo hit without printing value; fix real issues without concealing secrets or discarding owner edits | pending |
| T22 | P9: combined scheduling/accounting regression | Run all18 analysis cases together on current schema; preserve the conservative spend floor and successor-generation checks; report exact results | pending |
| T23 | P10/P8: repaired-boundary regression | Current restore-checker and URL/widget boundary checks pass; record bundle-size tradeoff; actual restore and live performance evaluation remain P11 | pending |
| T24 | Integrated build/static gates | Root build, lint, format and typecheck all pass; checkpoint each command/result | pending |
| T25 | Integrated local DB gates | Clean local replay, full pgTAP, lint, real races and local advisors pass; checkpoint each command/result; no hosted writes | pending |
| T26 | Integrated unit/integration gates | Full unit and full local integration pass; diagnose every failure, preserve tests; checkpoint each suite and any interrupted run | pending |
| T27 | Integrated running-system/guard gates | API smoke, compiled worker, Make guards, secret self-test and untracked-inclusive scan pass; checkpoint each command/result | pending |
| T28 | P7–P10: final documentation and handoff | Synchronize affected current docs and evidence; cross-check actual Git/schema truth; list manual/hosted/phase gates; STOP BEFORE P11 | pending |

Dependencies: T01 precedes any020 application; T02 precedes T03. T04–T13 freeze
and integrate the C8 contracts before T14/T15. T16–T23 resolve remaining known
pre-P11 failures. T24–T27 run on the final integrated tree and do not replace
the full-suite requirements in rules.md. New source changes invalidate relevant
later gate evidence; rerun the necessary gates and record why.

T24–T27 contain several prescribed suite commands. Treat each command as its
own checkpoint boundary (`T24-a`, `T24-b`, etc.) if it cannot fit safely in one
small task. Do not start a long suite just to race a usage limit.

## Historical T00 handoff (superseded by current execution state)

T00 is documentation-only. T01 is next, but implementation is stopped pending
a current usage reading above5%. Root remains `p7.5/d4-integration@aa6425a`
plus preserved dirty work. Actual local019 and hosted-last017 are historical
recorded state, not newly queried in T00.020 remains unapplied/blocked. The
H1 draft and14 unrun tests remain only in the warm worktree. No product code,
SQL, tests or environment was changed or executed as part of T00.


## Owner clarification - five-hour usage allowance

The5% stop refers specifically to the remaining usage allowance in the
five-hour session window: stop at5% remaining or less (95% used or more).
It does not refer to context/token capacity or to elapsed wall-clock time.
It is not a timer to stop after4hours45minutes. The remaining-usage reading
must come from an authoritative account/app status or the owner. Current
reading is stillUNKNOWN; this clarification is not a new reading or reset.


## T03 subtask boundaries

T02 review found a derived settings-version dispatch bug. Split T03 before
persistent020application; each child has its own checkpoint:

|ID|Bounded work|Exit|State|
|---|---|---|---|
|T03a|Reproduce tone/enable BEFORE-derived settings version gap; fix dispatch and prepare fixtures|Real local rolled-back source regression red->green; policy14assertions preserved; reviews clear|complete|
|T03b|Persistently replay corrected020 on LOCAL only and run real queue/context/fence/version-dedup cases|Actual schema20, corrected census expectation match, targeted integration pass; no hosted writes|complete|
|T03c|Database grants/negative matrix and full clean pgTAP/lint/advisors|Record actual local commands/counts; resolve new findings; parentT03 complete only when all children pass|pending|


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
| T03c-3 | Clean local replay, full pgTAP, lint/advisors and parent acceptance | pending |


T03c-1 follow-up: retain the original advisor timeout for T16 reliability work.
The standalone command now passes, but its original cause was not established.
T19 must verify/remove the Makefile legacy --local flag and prove exact Make
gates. Managed Storage dynamic-SQL lint findings are retained separately.

## T03c-3 small boundaries

- T03c-3a: COMPLETE, clean LOCAL reset exit0 and schema/history20 verified.
- T03c-3b: full actual local pgTAP suite, after3a passes.
- T03c-3c: strict public lint/advisors and explicit unresolved-gate accounting.

Checkpoint each command; do not claim exact Make or managed Storage gates
pass from a direct CLI public-only result.

T03c-3a complete: clean replay exit0, actual schema/history20. See checkpoint.
