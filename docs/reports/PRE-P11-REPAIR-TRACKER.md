# Pre-P11 repair tracker - current state

## 2026-11-20 update

Current root Git truth was `main` @ `8a38455` with a pre-existing dirty
worktree and two preserved temporary worktrees. Hosted migrations 018–027
were applied with owner approval; local and hosted histories are recorded at
027. T25-d races and T26 single-command full gates remain open. P11 remains
stopped.

T29 records a documentation-only SaaS/admin proposal in ADR 0019 and the
backend specs. The proposed provider control plane, widget-key lifecycle,
subscription enforcement, and admin-authored knowledge-gap publishing are
not repairs, not implemented, and not authorized for implementation by this
tracker update. Existing repair records below are retained. Later the same
day, the owner-ordered commit task verified the tree and committed the
docs/evidence overlay to `main` locally (no push); see
`checkpoints/PRE-P11-commit-2026-11-20.md`. T25-d/T26 carries unchanged.

Stopped at completed pre-P11 local program T18b-T28 (2026-11-19), STOP BEFORE
P11. T18 enumeration complete (4 worker-drain cases POSIX-guarded in T20);
T19 db-lint flag fixed; T20 shutdown-harness fixed; T21 secrets classified;
T22 combined 18/18; T23 boundaries green; T24 static gates green; T25
replay/pgTAP-37/3671/lint/advisors green with race OPEN (host exec-speed
bound); T26 single-command gates OPEN (host OOM bound, file-by-file green);
T27 system/guards green; T28 synced. Evidence: checkpoints PRE-P11-T18b.md..
T28.md; logs T18f/T25/T26. Root p7.5/d4-integration@aa6425a+dirty; LOCAL027
after resets, hosted-last 017 unchanged. No running checks/workers. Preserve
all dirty work and both temp worktrees.
See [OpenCode handoff](OPENCODE-HANDOFF.md) and
[latest checkpoint](LATEST-CHECKPOINT.md) for exact commands, limits and evidence.
Root p7.5/d4-integration@aa6425a+dirty; LOCAL027 after reset, hosted-last017 unchanged.
No running task checks/workers. Preserve all dirty work and both temp worktrees.

| Audit | Phase | Current bounded state / remaining work |
|---|---|---|
| A01/A02/A10/A11 | P9 | Analysis budget/generation/usage repair retained; final gates OPEN |
| A03 | P7.5 | Kill-switch repair retained,180related checks recorded; final gates OPEN |
| A04-A07 | P8 | Bootstrap/challenge/EOF/session repairs retained;36browser matrix recorded |
| A08/C8 | P7.5 | COMPLETE (T13 registry wired + T14 real-DB round trip + T15 reviews, tenant blocker fixed; 37 pgTAP/3671 PASS; T16-T23 pending) |
| A09 | P9 | Migration019LOCAL;3427pgTAP recorded,17integration+1separate lateusage pass;combined18 pendingT22 |
| A12 | P10 | Canonical actual metrics SQL4PASS recorded |
| A13 | P10 | Checker13units/4catalog/1collectorSQL PASS; actual restore is P11, NOT DONE |
| A14 | P2/P3.5 |1179related units+264actual SQL PASS recorded; two static reviews clear |
| A15 | P8 |73widget units,36browser+9nullable-bootstrap PASS recorded; raw496989/gzip107761 bytes; performance unmeasured |

## Historical repair-program next tasks

The repaired sequence and current remaining gates are in PRE-P11-TASKS.md and
LATEST-CHECKPOINT.md. Do not treat this historical paragraph as the live next
task. STOP BEFORE P11.

## Historical records

Earlier tracker snapshots had LOCAL019/020unapplied and missing-max_attempts
blocks. Those were fixed inT02/T03a/T03b and are NOT current blockers. Full old
tracker preserved in checkpoints/PRE-P11-TRACKER-BEFORE-DOC-SYNC-2026-11-18.md.
Original audit remains phase-audit-2026-11-17.md; it is an initial finding record,
not the live resolution table. Task checkpoints preserve red/green evidence.
