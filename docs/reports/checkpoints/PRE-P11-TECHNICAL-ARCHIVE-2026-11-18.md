# Exact resume checkpoint - pre-P11 task handoff

> T02 COMPLETE - explicit retry policy verified: real local rollback regression11FAIL/3PASS to14PASS; targeted lint/format and root typecheck0. Checkpoint `docs/reports/checkpoints/PRE-P11-T02.md`.020remains unapplied; actual local019/hosted-last017. NextT03a confirms/fixes derived settings-version dispatch BEFORE any persistent replay; T03b/T03c follow. Owner monitors quota; continue unless owner signals stop. H1draft unintegrated. No release/hosted/provider actions. Earlier task paragraphs historical.


> T01 COMPLETE - valid local019 baseline: corrected fixture/recognized C7 flag/dynamic versions; main run1 expected queue failure,1 disabled-control pass,1 filtered fence case; targeted lint0. Evidence `docs/evidence/P7.5-D4/T01/`, checkpoint `docs/reports/checkpoints/PRE-P11-T01.md`. NextT02: missing max_attempts.020 remains unapplied; local019, hosted-last017; census expects20 pending. Owner now monitors quota and authorized continuation without an agent counter; stop on owner signal. No commit/hosted/provider/deploy actions. Earlier preflight/UNKNOWN blocks below are historical and superseded.


> T01 PREFLIGHT 2026-11-18: owner authorized continuation; current five-hour usage reading is still UNKNOWN and requested. T01 implementation has NOT started. Source preconditions inspected only; no source/test/SQL changes or verification runs. See `docs/reports/checkpoints/PRE-P11-T01.md`. Last completeT00; resumeT01 when the usage gate clears.020 remains unapplied/blocked; stop at5% remaining or less and beforeP11.


> SMALL-TASK CHECKPOINT 2026-11-18: T00 (documentation plan) complete. Follow `docs/reports/PRE-P11-TASKS.md` and `docs/reports/LATEST-CHECKPOINT.md`. Next task T01 corrects queue-test preconditions on local019 before any020 application. Current five-hour quota UNKNOWN; last historical report1%, no reset confirmed. At an authoritative reading of5% remaining or less, stop implementation and save continuity only. No implementation task starts with unknown headroom. Every task ends with a saved checkpoint and affected-doc updates. Technical branch/schema/worktrees/blockers below remain unchanged; no code, SQL, tests or hosted actions in T00. STOP BEFORE P11.


Updated2026-11-18. Owner explicitly stopped work at reported1% remaining and
requested documentation only. Resume this checkpoint after quota reset.
Authorized scope: complete LOCAL repairs throughP10, STOP BEFORE P11.
No permission to merge/push, deploy, install dependencies, call real providers
or write hosted Supabase is implied. No such action was performed.

## Exact current state

- Root D:/Projects1/Text_AI/ragbot-widget; branch p7.5/d4-integration,
  HEAD/base aa6425a. All repairs remain UNCOMMITTED. Preserve every dirty and
  untracked file; never reset/clean/stash/discard this tree.
- Node26.13.1. Actual LOCAL Supabase019; hosted last recorded017.
  018/019 local only. New020_cache_warming_queue.sql is UNAPPLIED and BLOCKED.
- IMPORTANT temporary mismatch: expected-schema census tests220/250/260/290
  and tests/integration/helpers/local-stack.ts now expect20, while actual DB
  remains19. Finish/review020 before local reset/apply; do not mistake this
  pending mismatch for hosted drift or a passing database gate.
- Root worker/src/jobs/warm-answer-cache.ts is STILL the old stub. H1 draft
  and14 UNRUN tests exist ONLY in the isolated worktree below. Do NOT claim
  C8 implemented or verified.
- Existing agents stopped/completed. Sol substitution gpt-6.1-sol and
  unverified reports recorded in status.md. Main runs ALL verification.

## Worktrees — do not lose these

C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p75-d4, branch p7.5/d4@aa6425a:
- E1 extraction was already copied into root and main formatted it.
- H1 NEW DRAFT NOT INTEGRATED: worker/src/jobs/warm-answer-cache.ts and
  tests/unit/worker/warm-answer-cache.test.ts. Worker finished14 synthetic
  cases, ran NO tests/build/network/DB/install/commit. Inspect/copy ONLY
  those two files when ready. Do not overwrite other newer root edits.
- Frozen WarmingConfig interface copied there from root; no production loader.

C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p10-d3, branch p10/d3@aa6425a:
- OLD restore-checker draft. Root checker has subsequent main corrections.
  NEVER copy this stale draft over root.

## FIRST action on resume — fix confirmed020 blockers BEFORE any DB apply

Independent static review found:
1. HIGH: queue_warm_job inserts only(type,payload), but jobs.max_attempts is
   NOT NULL without default (001_core.sql:406). Enabled warm version updates
   would fail23502 and roll back originating update. Supply a validated bounded
   retry policy/explicit documented count. Main proposed (NOT IMPLEMENTED):
   require cache_policy.warm_max_attempts integer1..10 when warm_enabled:true;
   fixture3, insert max_attempts explicitly. Validate this decision against repo
   fail-closed configuration rules; no P0 decision was changed.
2. Queue integration fixture omits enabled:true; bots default disabled. Its
   red0jobs result is NOT valid reproduction of missing enqueue until corrected.
   Set enabled:true and use cache_policy:{warm_enabled:true,warm_max_attempts:3,
   c7:true}; current answer_cache_enabled flag is not recognized by C7.
   Add disabled-bot negative. Rerun corrected red on actual019 BEFORE applying020.
3. Do not assume initial settings_version=1; assert queued version matches
   actual bot state if fixture triggers alter it. Existing test hardcodes1.

Then review/fix020 queue/generation/context, run local reset/replay and targeted
queue/fence tests plus grants/negative cases. Actual suggested_questions is
jsonb. Migration scaffolding used pinned CLI then renamed to020. First scaffold
failed sandbox EPERM writing ~/.supabase telemetry; approved elevated retry
succeeded. NO migrations applied in this resumed session.

## A08/C8 integration remaining

Root E1: shared/src/server/{embedding-cache,moderation-cache,retrieval-cache,
answer-cache,citations,prompt,context,retrieval-types}.ts; API old paths retain
compatibility exports. shared/package.json adds ./server/* exports.
vitest.config.ts now aliases server imports to SOURCE (earlier extraction checks
used freshly built dist; rerun after current source alias). Browser index never
exports server modules. Static extraction review clear; full gates NOT clear.

Root worker/src/lib/warming-config.ts contains INTERFACE ONLY. Still needed:
- Validated opt-in loader (defaultoff), hidden provider secrets, matching API
  chat/moderation model keys, bounds/prices/env docs, production buildHandlers
  registration. No real provider calls authorized.
- shared warm payload REQUIRED settings_version and its fixtures/negativecases.
- runtime ClaimedJob.warmGeneration and parsing/claim checks/tests.
- Integrate/inspect H1 handler and14 tests from worktree; fix compile/contracts.
- Budget/invocation RPCs, fenced cache publication, recovery/maintenance and
  actual local integration proving API reads warm SHARED L2 entries safely.
- Keep input moderation/auth/rate/idempotency on visitor cache hits. No fake
  visitor/session/run IDs to reuse chat service. No C7 for PII/blocked/partial/
  truncated/malformed/uncited/contact output. No stale lease/version/doc writes.

H1 RPC protocol (draft; SQL NOT IMPLEMENTED except context):
get_warm_job_context(job_id,worker,generation)->{state,context,questions,languages}
reserve_warm_budget(fence,question_index,language,amount,ttl_seconds)->uuid
record_warm_usage(fence,reservation_id,invocation_id,provider,model,operation,
 input_tokens,output_tokens,estimated_cost,latency_ms,final)->void
publish_warm_cache(fence,question_index,language,reservation_id,
 entries:[{layer:c4|c5|c6|c7,record:actualL2record}])->{published_layers:string[]}
settle_warm_budget(job_id,generation,reservation_id)->void
settle_orphaned_warm_reservations(batch)->integer (future maintenance).
All argument names use p_ prefix. Pending conservative usage registered BEFORE
provider invocation. Final usage may arrive after lease loss bound to original
reservation; it can never publish results. Do not clamp actual overages.

Accounting design proposed, NOT implemented: warm generation/question hash/
immutable allowance on budget_reservations; separate warm_reservation_id and
warm_invocation_id + pending state on usage_events (existing analysis unique
budget_reservation_id supports onlyone invocation; preserve it). Registration
checks live lease/policy/version and original allowance; finalized usage cannot
be erased. Recovery retains pending unknown charges. Existing index sweep MUST
exclude warm reservations. Serialize reserve on client_settings before bot;
publication client_settings SHARE then bot SHARE, recheck current snapshot.
Do not lock docs/publicconfig in reverse activation order. Providers outside DB
transactions. Reuse shared actual cache classes/keys, moderation policyv1 and
requested language'' (not'en').

## Results established this session

A14/P2-D1:23new URL fixtures, initial shared7failed/257controls and widget2failed/
2controls. Final1179shared+widget units/25filesPASS, build0, actualSQL264PASS.
SQL fixture argv overflow fixed with base64 stdin transport. Two reviews clear.

A15/P8-D11: canonical shared public config schema fixes nullable SQL fields,
language/phone mismatch and invalid text/hours/timezone gaps. New16cases red13/
3controls; fullwidget73PASS/9files. Full offlinebrowser36PASS and separate9
nullable bootstrapPASS. Build/lint/typecheck0 on stated P8tree. Two reviews
clear. Widget bundle grew30117->496989bytes, gzip107761; performance UNMEASURED.
Docs/evidence/P8-D11/SUMMARY.md. No raw validation error display/logging.

A08/E1 extraction: rootbuild0; first cache-related run130PASS/1FAIL(timeout first
HTTPturn14508ms vs5000ms). Additional prompt/citation/conversation checks246PASS/
6FAIL, all existing500ms citation timing assertions (measured~564–1476ms).
DO NOT raise bounds/delete tests/retry untilgreen. Static comparison found
cache/citation source unchanged by move; cause not proven. Source alias added
AFTER these runs. Profile setup/app.ready/request/provider/cleanup timing and
CPU/event-loop delay; distinguish cold Fastify from resource contention before
fixing. Worker diagnosis read-only, no runtime proof.

C8 queue first red failed SETUP(npxstatus60s timeout), not defect proof. Docker
healthy; standalone scrubbed npxstatus25.25s. Local helper now runs pinned
node_modules/supabase/dist/supabase.js via process.execPath, fixed args/no shell;
all6helper unit testsPASS. Its initial new-test failure was Vitest treating an
implicitly returned mock from beforeEach as cleanup; braces fixed it, assertions
unchanged. DirectCLI queue run reached assertion0jobs but disabled fixture makes
it INVALID bug evidence until corrected (above). Logs P7.5-D4.

## Earlier bounded repairs carried forward

A01/A02/A10/A11 P9-D3:3409pgTAP,79units,8localDB integration on earlier tree.
A03 P7.5-D3:180related tests. A04 P8-D7:14browser/42units(ownerapprovedlocal).
A05 P8-D8:28browser/46units. A06 P8-D9:53units/3EOFbrowser.
A07 P8-D10:36browser. A09 P9-D4:local019,3427pgTAP/30files,17analysis integration
plus separate late-usage1PASS/9filtered; combined18rerunpending. Preserve
unknown-spend .10 floor plus new .03 while usage .02/.03; SQL not weakened.
A12 P10-D2:actual canonical metrics SQL4PASS after red2fail/2controls.
A13 P10-D3:rootchecker13unit,4realcatalogdrift,1collectorSQLPASS;typecheck0;
two final reviews clear. Collector HTTP FAKE; no real restore/checksum gate.

## Final gates/docs still open

No full-system acceptance. Broad extraction/timing/setup failures, Windows
make/race support, APIsmoke33PASS/2FAIL(draining/SIGTERM), owner-kept demo scan
hit remain. Never use CI as evidence. No commit until required suite all0.
Restore rehearsal/real provider eval/load belong toP11; DO NOT START.
Affected current docs updated or pointed here; historical evidence retained.
Review PRD/ARCHITECTURE/CLAUDE/README/TECH/UI/plan and other current runbooks
again at finalintegration, preserving owner edits. Do not rewrite old results.
Read AGENTS,status,handover,active plan and Git truth first onresume.
