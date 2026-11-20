# P9-D3 — analysis budget and claim fencing

Date: 2026-11-17. Base `aa6425a`; branch `p9/d3`, including the pre-existing
dirty tree carried from `fix/d2`. Node 26.13.1, Windows, local Supabase only.
Hosted remains at migration 017 according to the prior tracker; no hosted
read/write or deployment was performed in this debug cycle. Nothing committed.

## Defect and bounded change

The worker called indexing-only reservation functions with an incomplete
argument list. Earlier local reproduction returned “function does not exist”.
Indexing fences and recovery also could not account for analysis operations.
New real-PostgREST regression tests failed before migration 018 with HTTP 404.
The first test attempt failed in setup because its cache_policy field was
missing; that fixture error was corrected before the meaningful red run.

Migration `018_p9_analysis_budget.sql` adds service-only analysis context,
reservation, settlement, usage, result/failure and orphan-recovery APIs.
Fences derive bot/conversation ownership from the claimed job and check its
worker, generation and live lease. Cap checks serialize on client_settings,
sharing the existing daily budget with chat and ingestion. Existing migrations
001–017 are unchanged.

Every analysis claim has a monotonic generation independent of retry attempts,
which shutdown can refund. Reservations are unique to that generation; usage
links to its original reservation and is idempotent for one invocation.
Unknown orphan spend keeps its conservative estimate. Delayed usage can raise
recovered spend without writing a stale result. The indexing sweep explicitly
excludes analysis reservations. Analysis recovery precedes retention/job purges.

The worker passes the new fences, records complete input/output usage and
conservative partial-stream spend, closes provider streams on early exit, and
treats returned truncated output as permanently unusable while retaining known
usage. The earlier local analysis-version save fix is included. A deleted
conversation cannot be written, but its provider spend remains recoverable.

The enqueue-during-running-analysis race (audit A09) is outside this repair.
No C8 warming, cache policy, widget, provider configuration or deployment change
is included, except correcting the audit probe's own lint/scan fixture issues.

## Assignment and review record

Owner authorized sequential repairs. P9-D3 ownership: migration 018,
worker analysis/runtime/maintenance, their tests, schema-version expectations,
DATABASE_SCHEMA and continuity/evidence. Frozen: existing migrations, shared
contracts and unrelated dirty work. References: plan P9, TECH_SPECS sections
8/9, DATABASE_SCHEMA budget contracts, handover invariants. Main performed
implementation and all verification; reviewers were read-only.

The existing reviewer/security-reviewer agents used configured
`model: gpt-6.1-sol` per the owner's Sol direction, substituting for the
unavailable Claude models. Worker reports were initially self-reported and
unverified. Main inspected each retained finding and added regression coverage.

- Security review found that refunded attempt counts could merge two provider
  invocations. Main verified release_job_lease decrements attempts and replaced
  that identity with the monotonic claim generation. An actual release/reclaim
  test now verifies separate reservations, summed spend and stale rejection.
- Correctness review found missing iterator cleanup and lost final usage for
  truncated output. Both were fixed and covered by named unit regressions.
- Both read-only re-reviews reported no remaining confirmed blocker in this
  bounded scope. These static reports do not establish hosted behavior.

## Verification

All commands below ran from `D:\Projects1\Text_AI\ragbot-widget` on the dirty
integrated branch above. Providers in the tests are explicitly fake; database
integration and pgTAP use the actual local stack. No real provider calls.

| Check | Result / evidence |
| --- | --- |
| Local migration up, then clean `supabase db reset` | Exit 0, migrations 001–018 + dev seed. CLI run via the pinned local package; no remote flag. Equivalent underlying operation to make db-local; make itself is absent. |
| `supabase test db` after clean reset | Exit 0, 29 files / 3409 passed, `db-test.log`. Includes service-only grants and invoker/search-path/lock checks. |
| New real-DB analysis tests | Exit 0, 8 passed, `analysis-integration-final.log`. Lifecycle, usage/version, cap, idempotence, late usage/reclaim, index-sweep exclusion, actual shutdown handback, concurrent final-balance competition, expired lease/ownership/policy refusal and conversation deletion. |
| Changed worker/runtime unit tests | Exit 0, 3 files / 79 passed, `worker-targeted.log`. Includes truncated usage, iterator cleanup, partial billed lease loss and usage-write failure. |
| Build | Initial and final builds exit 0, `build.log`, `build-final.log`. |
| Typecheck | Final run exit 0, `typecheck-final.log`. |
| Lint | Initial run caught an unused initialization and browser globals in the audit probe; fixed. Final lint exit 0, `lint-final.log`. |
| Format check | Exit 0 on the integrated tree, `format-check.log`; final new test edits were formatted afterward. |
| DB lint | Exit 0, no schema errors, `db-lint.log`. |
| Local advisors | Exit 0, no findings, `advisors.log`. |
| Secret self-test, Git Bash | Exit 0, 27 passed / 0 failed, `secret-self-test.log`. |
| Secret scan including untracked | Initial scan found the audit probe synthetic expression and the pre-existing owner-kept demo value. Probe fixture corrected; final result recorded separately below. Values were not printed. |
| Makefile guards, Git Bash | Exit 1, 111 passed / 5 failed because make is absent (rc127), `test-make.log`. No assertion changed. |
| Race script, Git Bash | Exit 2: explicitly refuses Docker's Windows npipe endpoint, `db-race.log`. Guard preserved. New cap-concurrency regression is not a replacement for this suite. |
| Full unit suite | Started default and one-worker runs. Both showed failures in pre-existing extraction/confinement/worker-indexing/timing-sensitive families; both were stopped, so no complete pass/fail total is claimed. Logs `unit.log`, `unit-serial.log`. Not a green gate; no assertion weakened. |
| Full integration | Started `npm run test:integration`; first-admin setup failed with 21 skipped. Stopped the broad run without claiming complete suite totals; `integration-full.log`. New analysis integration passed separately as above. |
| API smoke | Exit 1: 33 passed / 2 failed, draining-readiness and SIGTERM checks; `api-smoke.log`. These Windows signal limitations remain unresolved gates. |
| Compiled worker check | Exit 0; real sandboxed PDF extraction succeeded, `worker-dist.log`. |

Final secret scan: exit 1, only the pre-existing owner-kept value at
`widget/public/index.html:14` remains (`secret-scan-final.log`). The audit
probe now uses an obviously fake public-config fixture and no longer trips
the scanner. The demo value was preserved; no blanket scan exception was added.

An initial broad pgTAP run was made on a dirty local database and failed
baseline-count/order assertions involving old smoke rows. It is superseded by
the clean-reset 3409-pass run, not by changed expectations. DB and application
fixture suites are run sequentially for the final results.

Another targeted integration attempt timed out during its CLI setup while the
broad unit run was active (8 skipped, no assertion results). After stopping
the broad run, the sequential final attempt passed all eight tests. Its setup
allowance now covers three bounded CLI status calls, and HTTP fixture calls
have explicit timeouts. The test expectations were not weakened.

Expectation changes: schema-version assertions move 17→18 to match the new
migration; the maintenance allowlist adds analysis orphan settlement; worker
unit expectations use the new fenced RPCs and output-token accounting. Existing
negative cases remain. No provider fake satisfies P11 evaluation gates.

## Remaining gate and approval boundaries

This is not full-suite acceptance. The broader unit failures, unavailable
make/race runner, demo scan exception and any final integration/smoke failure
must remain visible. No merge, push, hosted migration or deployment is made.
The next planned repair is A03 (cache kill switches), after reporting this
bounded result. P7–P10 acceptance and P11/P12 release evidence remain open.
