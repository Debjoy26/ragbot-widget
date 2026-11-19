# T00 checkpoint — small-task plan and quota policy

Date: 2026-11-18. State: complete (documentation task only).
Next: T01; do not begin implementation until current usage headroom is known.

## Request and result

Owner requested smaller tasks, a checkpoint at every task end and a strict
stop at5% remaining of the five-hour account allowance. Saved the ordered
T00–T28 task plan, checkpoint format and stop policy in
[PRE-P11-TASKS.md](../PRE-P11-TASKS.md), with resume pointers in repo instructions
and continuity files. No new phase or implementation work started.

## Usage

Current reading: UNKNOWN. Last historical owner report:1% remaining.
Current reading requested asynchronously; no reset inferred. No available tool
exposes the account's five-hour remaining percentage. Exact automatic monitoring
is unavailable; do not promise it. Authoritative guidance:
[OpenAI usage documentation](https://learn.chatgpt.com/docs/pricing#where-can-i-see-my-current-usage-limits).
User-visible dashboard or CLI `/status` can supply a reading. Wall-clock time,
context tokens and goal-tool budgets are not account usage percentages.
At an observed reading at/below5%, stop implementation and save continuity only.
With unknown remaining usage, do not start another implementation task.

## Preserved technical state

- Root: D:/Projects1/Text_AI/ragbot-widget.
- Branch: p7.5/d4-integration; HEAD aa6425a. Existing dirty overlay preserved;
  no commit, stash, reset, merge or push.
- Worktrees: C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p75-d4 and ragbot-p10-d3,
  both based on aa6425a. H1 handler+14UNRUN tests only in p75 worktree; restore
  worktree draft is stale and must not overwrite root corrections.
- Actual local schema last recorded019; hosted last recorded017. Not queried
  anew in this documentation task.018/019 local only;020UNAPPLIED/BLOCKED.
- Census/helper expected20 while actual local schema last recorded19. Pending
  mismatch remains explicit. Do not apply020 before its blockers are fixed.
- Known blockers: queue INSERT lacks required max_attempts; queue fixture bot
  defaults disabled; unrecognized answer_cache_enabled flag; settings-version
  assumption; C8 accounting/publication/config/runtime still incomplete.
- Existing timing/full-suite failures remain; prior pass counts are historical
  evidence, not results from T00. No implementation workers started in T00.

## Verification and scope

Repository-root read-only commands: Git status/log/worktree inventory, relevant
continuity/plan/instructions reads; exit0. Official usage documentation searched
and fetched. Documentation files written and their diff/links checked separately
at task completion. Product build/tests/DB/provider/hosted checks: NOT RUN.
Only documentation changed. No dependency install, deployment or hosted write.

## Exact first action after usage gate clears

Read the technical checkpoint and T01 task. Correct the synthetic queue
fixture to enabled:true, use recognized C7 policy and an explicit proposed
bounded retry limit, compare actual settings_version and add a disabled-bot
negative. Reproduce missing enqueue on actual019 before fixing/applying020.
Do not copy the H1 worker draft or apply migrations as the first resume action.


## Completed documentation verification

Main ran a repository-root Node validator: exit0; all11 continuity/instruction
documents exist, all29 task IDs(T00-T28) are in order,28 remaining tasks and
all6 relative Markdown handoff links resolve. Checked protocol pointers in
AGENTS/CLAUDE/rules/plan and current handoff markers in status/handover/tracker/
exact resume. Reviewed documentation diff statistics; existing CRLF warnings
were reported, not hidden. No product tests or implementation commands run.

Product specs/runbooks left unchanged for this planning-only task: PRD.md,
ARCHITECTURE.md, DATABASE_SCHEMA.md, TECH_SPECS.md, UI_SCHEMA.md, README.md and
operational runbooks. Their technical contents were not reverified in T00;
the final affected-document audit remains T28.
Historical evidence and existing owner edits retained. No implementation worker
or verification process remains running from T00. Current quota stillUNKNOWN;
nextT01 is not started.


## Owner clarification - five-hour usage allowance

The5% stop refers specifically to the remaining usage allowance in the
five-hour session window: stop at5% remaining or less (95% used or more).
It does not refer to context/token capacity or to elapsed wall-clock time.
It is not a timer to stop after4hours45minutes. The remaining-usage reading
must come from an authoritative account/app status or the owner. Current
reading is stillUNKNOWN; this clarification is not a new reading or reset.
