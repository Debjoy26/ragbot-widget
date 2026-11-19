# Latest pre-P11 checkpoint

**STOPPED at completed pre-P11 local program (T18b-T28)**, 2026-11-19.
No automatic quota monitor/reset is claimed. Do not start another
implementation/check without owner resumption; strict stop at known5%
remaining or less. P11 remains out of scope.

Last complete: **T28 - docs/evidence sync (STOP BEFORE P11)**.
Open carries: **T25-d real races + T26 single-command full gates** (measured
host bounds: 3.5-7s docker-exec, 0.5/7.7GB free). Everything else in T18-T28
complete. See checkpoints PRE-P11-T18b.md through PRE-P11-T28.md.

Read [T18b checkpoint](checkpoints/PRE-P11-T18b.md),
[T18a checkpoint](checkpoints/PRE-P11-T18a.md),
[T17 checkpoint](checkpoints/PRE-P11-T17.md),
[T16 checkpoint](checkpoints/PRE-P11-T16.md),
[task plan](PRE-P11-TASKS.md), and
[technical checkpoint](SESSION-CHECKPOINT-2026-11-17.md).

Read [OPENCODE-HANDOFF.md](OPENCODE-HANDOFF.md) for the complete done/pending
summary, current risks, draft file ownership and OpenCode resume prompt.

## Exact resume action

T18 continues the remaining admin/bootstrap setup families and enumeration
(api-wiring under load, ingestion-e2e/process, chat-e2e, limits,
visitor-auth, full worker-runtime), splits confirmed defects into subtask
checkpoints, and fixes them without weakening negatives. T18a
extraction/confinement is COMPLETE (see above). Main runs checks; save the
next subtask checkpoint and update continuity docs before another task. Never
advance through a failed prerequisite. Local DB is clean at 027 after reset
(hosted-last 017 unchanged); T22 combined analysis rerun must start clean.

## Preserved state and limitations

- Root p7.5/d4-integration@aa6425a plus the entire dirty overlay; no commits.
- Actual LOCAL027,27 migration records001..027,1seedbot after reset.
- Hosted last recorded017; 018-027 are LOCAL ONLY. No hosted query/write/deploy/provider call this run.
- No task commands or workers running. Local containers remain running.
- Database healthy at post-reset snapshot; pg_meta/realtime/vector/analytics
  unhealthy in that snapshot. Full-stack health is unproved; track separately.
- Original advisor timeout root cause unproven(T16); standalone recovery passed.
- Managed Storage static-lint findings and exact Make CLI3 compatibility(T19)
  remain open. No exact Make/full-suite acceptance is claimed.
- C8 COMPLETE in root: H1 handler integrated (19 unit PASS), production
  registry wired with vendor-key reuse + startup fail-closed, real-DB round
  trip proven (key-pinned first-turn hit, zero live chat calls), independent
  reviews done with the tenant blocker fixed at the DB (027). The temp warm
  worktree H1 draft is SUPERSEDED; never copy its older unrelated files.
- Worktrees: C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p75-d4 (H1draft);
  C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p10-d3 (STALE checker draft).
  Never copy their older unrelated files over the corrected root.
- No install/merge/push/hosted write/deployment/real-provider approval inferred.
