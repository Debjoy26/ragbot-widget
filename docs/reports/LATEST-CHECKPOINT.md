# Latest pre-P11 checkpoint

## T29 documentation-only admin integration update — 2026-11-20

Owner requested that this backend repository reflect the separate
[`ragbot-admin-panel`](https://github.com/Debjoy26/ragbot-admin-panel)
specification. T29 updated PRD, architecture, technical specifications,
database gap register, implementation plan, README, status, handover, and
proposed ADR 0019. The admin-panel documentation commit is
[`4894d2b`](https://github.com/Debjoy26/ragbot-admin-panel/commit/4894d2b).
No backend code, migration, test, hosted operation, or deployment was
performed. This repo's doc changes are uncommitted; no push to
`ragbot-widget` was authorized by this task.

At task start the root was `main` @ `8a38455` with pre-existing dirty work;
both temporary worktrees remain preserved. Hosted/local migration histories
are recorded at 027 per
[`PRE-P11-hosted-018-027-2026-11-20.md`](checkpoints/PRE-P11-hosted-018-027-2026-11-20.md).
T25-d and T26 single-command gates remain open. P11 is not started. The
AWS-vs-Render deployment choice also remains open. The proposal does not
authorize implementation, hosted changes, deployment, or P11/P12. For exact task evidence see
[`PRE-P11-T29-admin-panel-contract.md`](checkpoints/PRE-P11-T29-admin-panel-contract.md).

**STOPPED, pushed to `origin/main` @ `8a38455`**, 2026-11-19. P7/P7.5/P8/P9/P10
accepted by owner with two host-bound carries (below). No automatic quota
monitor/reset is claimed; strict stop at known5% remaining or less. P11
remains out of scope until the owner starts it.

## NEXT WORK PACKET (do only when the owner says)

Scope: everything listed here is authorized for the next continuation ONLY on
explicit owner go-ahead, one small task at a time, checkpoint after every
task. No automatic P11 progression.

1. **Healthy-host re-runs** (host had 0.2GB free, 900ms-7s docker-exec):
   a. `npx supabase db reset`, then `bash scripts/race-db.sh` → expect 51/0.
      The 4 `fast`-ordering failures are proven exec-overhead artifacts;
      re-run with defaults, no tuning. Evidence: T25 checkpoint + logs
      `docs/evidence/T25/`.
   b. `npm test` (full unit, defaults) → expect green; then
      `npm run test:integration` on a clean reset DB → expect green.
      Evidence: T26 checkpoint + logs `docs/evidence/T26/`.
   c. If green, mark T25-d/T26-a complete in PRE-P11-TASKS.md + trackers.
2. **Hosted migrations 018-027 decision** (dry-run already shows exactly
   these pending; NOTHING applied): needs explicit owner approval per action,
   then `make db-plan`/`db-create` equivalents, advisors, anon probes per
    rules.md §41. Never present LOCAL027 as hosted.
   DONE 2026-11-20: owner approved apply; CLI equivalents run (dry-run exit
   0, push --yes exit 0 for all 10), migration list 001-027 local==remote;
   remote advisors 19 WARN (pre-existing admin-RPC rule, none from 018-027)
/0 ERROR; anon probes conform (only public_bot_config readable).
   Evidence: checkpoints/PRE-P11-hosted-018-027-2026-11-20.md,
   docs/evidence/hosted-018-027/. Hosted-last is now 027.
3. **Remaining carries** (owner decides each): GNU `make` install; POSIX
   drain-path verification (smoke + worker-process skips say where);
   codex-transcript triage (untracked root file, secret hits); widget bundle
   load performance; actual restore rehearsal (P11).
4. **P11 evaluation/security/load**: NOT started; needs owner phase approval,
   paid-tier billing confirmation, and real-provider rules. Do not start it
   on a "continue" alone.

First commands on resume: `git status --short --branch`, `git log --oneline -3`,
`git worktree list`; confirm `main` tip vs `origin/main`; check host free RAM
and `docker exec` timing BEFORE any race/full-suite run. Preserve the
worktree-only exclusions (`widget/public/index.html` demo key, codex
transcript, scratch notes).

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
