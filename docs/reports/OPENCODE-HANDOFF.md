# OpenCode handoff - current pre-P11 repairs

Updated2026-11-19: owner authorized continuation; T16 COMPLETE.
Work continues one small task at a time from completedT16 (T03 COMPLETE
with carried limits). This document and LATEST-CHECKPOINT.md give
current execution state; older dated checkpoints/audits preserve history
and do not override this handoff. Read AGENTS.md/rules.md before resuming.

## Scope and stop rules

Owner authorized LOCAL repairs through P10, one small task at a time, with a
checkpoint after EVERY task, including failure/interruption. STOP BEFORE P11.
The latest usage reading is owner-reported10% remaining (12:35:47 UTC checkpoint),
not a newly measured value. Wait for owner continuation before more work. On
resume the owner monitors the account allowance; do not repeatedly block solely
because tools lack a meter. Stop immediately on owner signal or an authoritative
reading<=5% remaining. Five-hour account usage is not elapsed time or context.
No automatic meter or reset is claimed. Owner continuation is the permission
to run authorized LOCAL tasks only; it is not permission for hosted writes,
releases, or real provider calls.

No CI as evidence. Main performs all verification on the integrated root tree.
Do not infer permission to commit/merge/push, install dependencies, write hosted
Supabase, deploy, call real providers, or use client data. Follow AGENTS/rules
for bounded debug cycles, reviews, assignment packets and explicit approvals.

## Actual Git and local environment

- Root D:/Projects1/Text_AI/ragbot-widget, branch p7.5/d4-integration.
- HEAD/base aa6425a; all current repairs are UNCOMMITTED in a large dirty overlay.
- Node26.13.1 pinned, npm workspaces/committed lockfile, Supabase CLI3.0.0 pinned.
- Preserve ALL tracked/untracked work and owner edits, especially integration
  admin-real-session/first-admin/helper, widget/public/index.html, convo.md and
  tempreport.md. Never clean/reset/stash/discard this checkout to get a baseline.
- LOCAL127.0.0.1:54322 was cleanly reset through001-027 + DEVseed, exit0.
  Post-reset: schema27,27 migration rows001..027,1seedbot after reset.
- Hosted dev rbejeqwxyxtklehuzibv is LAST RECORDED017. No hosted query/write was
  made this run;018-027 are local-only. Never present LOCAL027 as hosted.
- No task commands/workers remain running. Local containers restarted for
  T03c-3b (Docker Desktop was down; relaunched, db healthy, vector unhealthy).
- Database was healthy at T03c-3b; immediate post-reset pg_meta/realtime/vector/analytics
  containers were unhealthy. No restart attempted then; overall stack health unproved.
- Two preserved temp worktrees at aa6425a:
  C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p75-d4 (branch p7.5/d4)
  C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p10-d3 (branch p10/d3).

## Completed in the current task series

| Task | Actual result | Evidence/checkpoint |
|---|---|---|
| T01 | Valid enabled/C7/version queue fixture on019;1expectedFAIL/1PASS/1filtered | checkpoints/PRE-P11-T01.md |
| T02 | Explicit warm_max_attempts JSON integer1..10, no default; red11/3 to14PASS | checkpoints/PRE-P11-T02.md |
| T03a | Final-row version trigger observes008 BEFORE-derived changes; red5/21 to26PASS; typecheck/lint/format0 | checkpoints/PRE-P11-T03a.md |
| T03b | Applied020 LOCAL; isolated fence fixture repaired;34integrationPASS/3files | checkpoints/PRE-P11-T03b.md |
| T03c-1 | Standalone local advisors0/results[] and strict public lint0; diagnostic scope only | checkpoints/PRE-P11-T03c-1.md |
| T03c-2 | Actual service/browser roles, claim/reclaim/refund generations1/2/3, stale owner and terminal dedup;69pgTAP PASS | checkpoints/PRE-P11-T03c-2.md |
| T03c-3a | Clean LOCAL reset001-020+seed exit0; schema/history20 verified | checkpoints/PRE-P11-T03c-3a.md |
| T03c-3b | Full LOCAL pgTAP 31 files/3496 PASS exit0; log T03c-3/full-pgtap.log | checkpoints/PRE-P11-T03c-3b.md |
| T03c-3c-1 | Strict public lint exit0 "No schema errors found"; log T03c-3/public-lint.log | checkpoints/PRE-P11-T03c-3c-1.md |
| T03c-3c-2 | Local advisors exit0 "No issues found"; log T03c-3/advisors.log | checkpoints/PRE-P11-T03c-3c-2.md |
| T04 | Warm payload requires settings_version; 80 unit PASS, typecheck 0 | checkpoints/PRE-P11-T04.md |
| T05 | warmGeneration parse/propagate/require; 83 unit PASS, typecheck 0 | checkpoints/PRE-P11-T05.md |
| T06 | Validated warming loader; 10 unit PASS, typecheck 0; env docs updated | checkpoints/PRE-P11-T06.md |
| T07 | reserve_warm_budget (021); 320 pgTAP 30 PASS; full 32 files/3526 PASS | checkpoints/PRE-P11-T07.md |
| T08 | record_warm_usage (022); 321 pgTAP 27 PASS; full 33 files/3553 PASS | checkpoints/PRE-P11-T08.md |
| T09 | settle_warm_budget + orphan sweep (023); 322 pgTAP 32 PASS; full 34 files/3585 PASS | checkpoints/PRE-P11-T09.md |
| T10 | Fenced C4-C6 publish (024); 323 pgTAP 38 PASS; full 35 files/3623 PASS | checkpoints/PRE-P11-T10.md |
| T11 | Fenced C7 publish (025); 324 pgTAP 38 PASS; full 36 files/3661 PASS | checkpoints/PRE-P11-T11.md |
| T12 | H1 handler integrated; 16 worker unit PASS; typecheck/lint 0 | checkpoints/PRE-P11-T12.md |
| T13 | Registry wired (vendor-key reuse, fail-closed); 13 handler tests; build + dist 0 | checkpoints/PRE-P11-T13.md |
| T14 | Real-DB round trip (key-pinned first-turn hit, zero live chat); 026 C5-anchor fix | checkpoints/PRE-P11-T14.md |
| T15 | Independent reviews; tenant blocker fixed by 027; full 37/3671 PASS; re-review cleared | checkpoints/PRE-P11-T15.md |
| T16 | First-HTTP setup tax fixed (single-spawn status cache); hook combo 23/23 | checkpoints/PRE-P11-T16.md |
| T17 | Citation timing fixed (bare-host skip, orphan precheck, bulk copy); 198/198 | checkpoints/PRE-P11-T17.md |
| T18a | Extraction/confinement fixed (fileURLToPath CHILD + proc-guard); 12/12, sibling 32/32; budget 8/8 + scheduling 10/10 on clean DB | checkpoints/PRE-P11-T18a.md |
| T18b | First-admin setup family 21/21 PASS (Docker relaunched locally; no defect, no product change) | checkpoints/PRE-P11-T18b.md |
| T18c | Settings-parity 264/264 + local-stack helper 8/8 (no defect) | checkpoints/PRE-P11-T18c.md |
| T18d | Admin-real-session 244/244 real aal1/aal2 (no defect) | checkpoints/PRE-P11-T18d.md |
| T18e | Api-wiring 10/10 + limits/visitor-auth 40/40 (parallel-load flake carried, not a defect) | checkpoints/PRE-P11-T18e.md |
| T18f | Chat-e2e 82/82 + worker-runtime 7/7 + ingestion-e2e; 4 drain cases confirmed Windows-harness, routed to T20 | checkpoints/PRE-P11-T18f.md |
| T19 | db-lint --local dropped (lint clean); guards 111/116, 5 fail only on absent make (install needs approval) | checkpoints/PRE-P11-T19.md |
| T20 | POSIX-only signal guards (root cause TerminateProcess); smoke 33/0/2 skipped, ingestion-process 6/4 skipped | checkpoints/PRE-P11-T20.md |
| T21 | Self-test 27/27; tracked scan 1 owner-kept demo; untracked 14 classified, values never printed | checkpoints/PRE-P11-T21.md |
| T22 | Clean reset 001-027 + combined analysis 18/18 PASS | checkpoints/PRE-P11-T22.md |
| T23 | Restore-checker 18/18, widget 73/73, shared+policy 1140/1140; bundle raw 497021/gzip 106721 | checkpoints/PRE-P11-T23.md |
| T24 | Build/lint/format/typecheck all exit 0 (profiler lint + 7-file prettier; semantics re-proven) | checkpoints/PRE-P11-T24.md |
| T25 | Replay/pgTAP 37/3671/lint/advisors PASS; race OPEN (npipe guard fixed; 3.5-7s exec overhead, 0 data violations) | checkpoints/PRE-P11-T25.md |
| T26 | Single-command gates host-OOM-blocked; all failing unit files green alone; integration file-by-file green | checkpoints/PRE-P11-T26.md |
| T27 | Smoke 33/0/2, dist-check PASS, guards 111/116, self-test 27/27, scans unchanged | checkpoints/PRE-P11-T27.md |
| T28 | Docs/evidence sync; STOP BEFORE P11 (race + single-command gates carried OPEN) | checkpoints/PRE-P11-T28.md |

Task evidence is docs/evidence/P7.5-D4/T01,T02,T03a,T03b,T03c-1,T03c-2,T03c-3/.
T03c-2 initially had65PASS/2FAIL because its test invented service-trigger EXECUTE
denials. All18 ACL cells remain; those two expectations were corrected to platform
service defaults, with TWO additional actual0A000 direct-trigger denials. Browser
roles stay denied42501. No migration/security behavior was weakened. Final two
static reviews clear; main ran the actual69-pass test. Full acceptance is open.
Post-reset full pgTAP is COMPLETE (T03c-3b: 31 files/3496 PASS exit0).

Earlier bounded repairs remain in the overlay: A01/A02/A10/A11 analysis accounting,
A03 cache kill-switch, A04-A07 widget bootstrap/challenge/EOF/session lifecycle,
A09 successor scheduling, A12 canonical metrics, A13 restore-checker preparation,
A14 URL parity and A15 canonical widget config. See repair tracker for counts.
These results do not replace final full-system gates. P0-P6 accepted; P7-P10
implementation history is on main, acceptance remains open; P11/P12 not started.

## Exact NEXT task - STOPPED, awaiting owner

T28 is COMPLETE. The pre-P11 local program (T18b-T28) is done; STOP BEFORE
P11. Do not start P11, merges, pushes, hosted writes, releases, installs,
or real provider calls. On owner resumption: read AGENTS.md, rules.md,
LATEST-CHECKPOINT.md, this handoff and PRE-P11-TASKS.md; inspect git status,
git log -5, git worktree list; preserve the overlay. First re-runs on a
healthy host: T25-d races (51/0) and T26 single-command full gates.

1. Read AGENTS.md, rules.md, LATEST-CHECKPOINT.md, this handoff and PRE-P11-TASKS.md.
   Inspect git status, git log -5, git worktree list. Preserve the overlay.
2. No task is active. Saved checkpoints run PRE-P11-T18b.md through
   PRE-P11-T28.md; evidence logs in docs/evidence/T18f, T25, T26.
   No hosted/provider/release action. Never advance through a failed
   prerequisite: T25-d races and T26 single-command full gates stay OPEN
   until re-run green on a healthy host.
3. Save a checkpoint for every future task and update continuity docs BEFORE
   another task. On failure diagnose in a bounded debug cycle, preserving
   assertions. Known-open items are listed below; historical evidence below
   this handoff is not current-state.

## Known unresolved checks and findings

- Original advisor DbConnectError timeout cause UNPROVEN. Standalone recovery
  passed; carry reliability diagnosis toT16. Do not claim a transport fix.
- public+storage lint connected but exit1: managed Storage dynamic-record/static
  findings in list_objects_with_delimiter/search/search_by_timestamp. No runtime
  Storage defect established, no vendor functions edited or findings suppressed.
- Makefile `db-lint` recipe fixed at T19 (deprecated `--local` dropped; local
  is the CLI default; lint clean). The `make` binary itself is absent on this
  Windows box (install needs owner approval); guard/race/test recipes were run
  via Git Bash direct invocation. Managed Storage static-lint findings remain
  open (no runtime Storage defect established). Do not install dependencies
  without approval.
- Current integrated gates (this program, 2026-11-19): build/lint/format/
  typecheck exit 0 (T24); pgTAP 37/3671 PASS, public lint and local advisors
  clean (T25); API smoke 33/0/2 POSIX-skipped (T20/T27); file-by-file
  unit/integration all green (T26); guards 111/116 make-missing-5 (T19/T27);
  secret self-test 27/27, tracked scan 1 owner-kept hit (T21/T27). OPEN:
  T25-d races (host exec-speed bound) and T26 single-command full suites
  (host OOM bound) — re-run on a healthy host, do not claim.
- Earlier extraction/confinement and admin setup families (T18), API
  smoke33PASS/2FAIL (T20), owner-kept demo scan hit remain. The earlier
  six citation500ms cases are FIXED at T17 (exact-behavior perf fixes);
  the earlier first-HTTP 5s setup timeout was FIXED at T16 (single-spawn
  status cache; E1 14.5s attributed to contention on the same cold-start path).
   Preserve negatives/time limits; don't print the demo value or delete owner work.
- Analysis scheduling combined18case rerun remainsT22 (17earlier+1separate).
  Preserve conservative .10 spend floor plus .03 new reservation and .02/.03 usage.
- Widget raw496989/gzip107761 bytes; loading performance UNMEASURED.
- Actual restore, live provider evaluation, load tests and release/rollout are
  P11/P12 and MUST NOT start under this authorization.

## C8 remaining implementation - C8 COMPLETE, do not mistake queue for completion

Root shared server helper extraction is integrated with API compatibility exports.
Worker H1 handler is INTEGRATED (T12), REGISTERED (T13, vendor-key reuse with
startup fail-closed), and PROVEN on the real DB with a key-pinned first-turn
hit served by a separate built API (T14, labelled fakes only, zero live chat
calls). T14 also fixed the C5 anchor (key spaces differ by design) via 026;
T15 reviews found no correctness blockers and one security tenant theme, fixed
in-cycle by 027 (C5/C7 chunk-ownership binding, bot-filtered chunk reads),
re-reviewed clear. Registry IS wired (buildHandlers + worker_started log).
Remaining C8-adjacent work is T16+ only.

The temp ragbot-p75-d4 worktree H1 draft is SUPERSEDED by the T12-integrated
root copy (worker/src/jobs/warm-answer-cache.ts + 16 unit PASS). Never copy
its older unrelated files over the corrected root. The ragbot-p10-d3 checker draft is STALE;
never overwrite the corrected root checker from it. Original pending RPC/locking
protocol is in checkpoints/PRE-P11-TECHNICAL-ARCHIVE-2026-11-18.md; it is a design
starting point, not implemented or verified behavior. Read relevant shared/API/DB
contracts and review the design before implementing it.

Then T16-T23 resolve remaining failures; T24-T27 run ALL prescribed integrated
system gates; T28 synchronizes evidence/docs and STOPS BEFORE P11. Each task ends
with its own checkpoint; failures do not advance dependencies. Two unsuccessful
cycles on one defect require revised diagnosis/owner decision. No blanketgreen
claim, no real provider invocation or release from synthetic/provider-mock tests.

## Resume prompt for OpenCode

Read AGENTS.md and docs/reports/OPENCODE-HANDOFF.md. Continue the existing LOCAL
pre-P11 repair overlay from completedT17, starting T18 extraction/setup.
Do not reset the dirty checkout, overwrite worktrees, apply hosted migrations,
start P11, or treat historical task notes as current. Preserve all assertions;
main runs checks. Save a checkpoint after every task, stop on owner/known5% usage
signal, and leave exact evidence/next commands if interrupted.
