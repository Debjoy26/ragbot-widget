# T03c-2 checkpoint - warming permissions and actual claims

2026-11-18. Bounded task COMPLETE. Parent T03 remains open; next T03c-3.
Root p7.5/d4-integration@aa6425a plus preserved dirty overlay; Node26.13.1,
pinned Supabase CLI3.0.0, actual LOCAL020, hosted last recorded017 unchanged.

## Main verification

From repository root, LOCAL target127.0.0.1:54322:

- `node node_modules/supabase/dist/supabase.js test db supabase/tests/database/310_warming_queue.test.sql`
  Initial exit1:65 passed/2 failed/67 assertions. The two failures were incorrect
  test assumptions about service-role trigger-function EXECUTE privileges.
  Evidence: docs/evidence/P7.5-D4/T03c-2/pgtap-initial-expectation.log.
- Corrected test, same command: exit0,69 passed/0 failed/0 skipped,1 file.
  Evidence: docs/evidence/P7.5-D4/T03c-2/pgtap-corrected.log.
- Post-initial-run read-only local SQL returned schema20 and zero active warming
  jobs. Fixtures and role changes are transaction-scoped and rolled back.

All18 role/function matrix cells remain. Two service-trigger cells changed from
false to true: migration020 revokes PUBLIC/anon/authenticated, and the platform
grants service EXECUTE by default. The contract does not require service denial.
This was an expectation correction, NOT a schema defect or security repair.
Two additional real service invocations verify PostgreSQL rejects ordinary
trigger-function calls with0A000. Browser invocations remain denied42501.
No assertion was deleted and no migration changed to make this test pass.

Real claim_jobs acquisition/reclaim/refund tests verify returned identity,
owner, live lease, attempts1/2/refunded1/reclaimed2, generations1/2/3, stale-owner
and zero-generation denial, context access, terminal version deduplication and
anonymous generation-column denial. Invoker/search-path/lock-timeout checks
cover all warming APIs. A2s-bounded SHARE ROW EXCLUSIVE jobs lock prevents other
queue writers between the clean-queue check and claim. The test refuses unrelated
active warming jobs; it does not delete or retime them.

## Reviews and limits

Existing reviewers reused with bounded read-only packets: review_p0_p5 correctness
and review_p9_p12 security. Configured gpt-6.1-sol substitutes unavailable
claude-sonnet-5-5 as previously recorded; worker reports are unverified until
main inspection. Initial reviews confirmed67 count; security identified concurrent
queue-write isolation gap, addressed by the transaction lock. Correctness follow-up
confirmed the initial trigger-ACL expectation was invented. Final review results
are recorded in this task's evidence review file.

No concurrent-claim race, exhaustion, budget, publication or full-system acceptance
is claimed. No provider call, install, commit, push, hosted write or deployment.
The H1 draft remains unintegrated in the warm worktree. Other worktrees and owner
edits preserved. Full build/static/integration/DB suites not run in this task.
Specs reviewed: DATABASE_SCHEMA queue paragraph updated; plan,TECH_SPECS,PRD,
ARCHITECTURE,README and UI contracts unchanged because production behavior did
not change. All continuity docs updated at this boundary.

## Exact next step

T03c-3: inspect reset effects and local seed/provider safety, then clean LOCAL
replay and full pgTAP, serially checkpointing commands. Preserve managed Storage
lint findings, original advisor timeout(T16) and Make CLI3 compatibility(T19).
Only direct CLI passes have been proved, not exact Make gates. Parent T03 remains
open until required child gates are resolved. STOP BEFORE P11.

No task checks remain running after checkpoint completion. Local containers stay
running. Five-hour usage UNKNOWN; owner monitors it and authorized continuation.
Stop immediately on owner signal or authoritative remaining allowance<=5%.
