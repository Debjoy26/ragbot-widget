# Phase audit — 2026-11-17

> Historical audit baseline. Resolution status is now tracked in [PRE-P11-REPAIR-TRACKER.md](PRE-P11-REPAIR-TRACKER.md) and [OpenCode handoff](OPENCODE-HANDOFF.md); do not treat original findings as still unfixed without checking those records.

## Scope, agents and evidence

Baseline: `fix/d2@aa6425a`, including the pre-existing dirty working tree.
The owner requested a detailed review using Sol. The main session assigned
three read-only `gpt-6.1-sol` reviewers, substituting for the unavailable Claude
reviewer/security-reviewer models. Packets P3-D6, P7-D4 and P9-D2 contained
the baseline, exclusive inspection scope, frozen contracts, specifications,
test expectations, command restrictions, stop conditions and report format.
Their initial reports were unverified; the findings retained below were
checked by the main session against the relevant source. No worker ran tests,
changed files, accessed hosted Supabase, or called providers.

This is a bounded static audit plus targeted local checks. It is **not an
exhaustive reading of every repository file**, a full system verification,
an independent penetration test, or phase acceptance. Some broad document
reads were truncated; selected critical paths were then read separately.
No claim is made about the current hosted catalog or deployed services.

Main-session checks, repository-root cwd, Node 26.13.1:

- `npm run typecheck`: exit 0.
- `npx vitest run --project unit tests/unit/worker/analyze-conversation.test.ts tests/unit/api/answer-cache.test.ts`:
  exit 0; 2 files, 51 passed. These tests use labelled fakes and do not prove
  the real analysis budget RPC works.
- Earlier in this conversation, the actual local SQL reservation call using
  the worker's amount/TTL arguments failed with “function does not exist”.
  Catalog inspection confirmed the required job/worker/version arguments.
  This report does not claim that earlier reproduction was rerun for this audit.
- An offline actual-widget browser probe is retained under
  `docs/evidence/AUDIT-2026-11-17/widget-bootstrap-probe.mjs`.
  Its initial launch using the Chromium channel failed because the full browser
  was absent; the installed headless-shell path is used by the revised probe.
  Revised run: exit 0. Without defer: zero config requests, host present,
  no shadow root. With defer: one config request and an initialized shadow
  root. The ordinary script startup failure is runtime-reproduced.

No full suite, database reset, hosted probe, provider evaluation, load test,
restore rehearsal or CI inspection was performed for this audit.

## Priority findings

### A01 — High — P9: analysis cannot reserve its budget

**Locations:** `worker/src/jobs/analyze-conversation.ts:154`,
`supabase/migrations/012_ingestion.sql:812`, `:837`, `:68`.

The handler calls `reserve_index_budget` with amount and TTL only. The real
function requires a job, worker and document version as well. The runtime
passes the plain DB client (`worker/src/runtime.ts:277`); it does not inject
those arguments. The request fails before any analysis generation. Repeated
attempts eventually dead-letter the job. This is a confirmed contract defect,
also reproduced locally earlier in the conversation.

**Solution:** add a forward migration containing an analysis-specific or
carefully scoped generic job-budget API. Fence it to a running job, current
worker and unexpired lease, derive bot ownership from the job, and validate
the referenced conversation belongs to that bot. Preserve settings-row
locking and the shared daily cap. Update the worker to pass the explicit
job/worker arguments. Adding arguments to the current indexing RPC alone
cannot work: its fence admits only indexing jobs with document versions.

**Verification:** claim an actual analysis job and run the handler through
PostgREST using a fake provider; require saved analysis and settled usage.
Reject wrong worker, expired lease, wrong type, foreign conversation, missing
policy and exceeded daily cap before any provider call.

### A02 — High, latent behind A01 — P9/P6: analysis recovery would erase spend

**Locations:** `012_ingestion.sql:866`, `:943`, `:992`, `:1297`;
`analyze-conversation.ts:185`, `:200`, `:205`.

The existing reserve/retry, settle, release and orphan-reconciliation paths
filter usage to `embedding_index`. Analysis writes `analysis`. Moreover,
settle and release calls omit job and worker arguments. Reusing these paths
after fixing reservation would either fail or reconcile analysis spend to
zero. This is a confirmed incompatibility; production undercount is latent
because A01 currently prevents normal analysis generation.

**Solution:** update the new migration's accounting path and orphan sweep
together. Derive allowed operations from the job type, preserve attempt
windows, and never reduce settlement below recorded spend. Keep the existing
indexing behavior covered by its regression tests.

**Verification:** paid partial attempt, crash, lease takeover, new reservation,
and orphan sweep; each attempt's cost must survive exactly once. Include
release-after-usage, stale settlement, expiry and indexing non-regression.

### A03 — High — P7.5: C4/C6 kill switches are not passed to the caches

**Locations:** `api/src/services/chat.ts:549`, `:578`, `:636`, `:655`;
`embedding-cache.ts:223`, `:259`; `moderation-cache.ts:189`, `:223`.

Chat omits the optional cache-policy argument for embedding and moderation
reads and writes. Undefined policy means enabled in those implementations.
Consequently global or C4/C6 disable settings do not bypass these layers.
Standalone cache tests do not prove the production call sites honor policy.
This is confirmed statically and contradicts the cache bypass invariant.

**Solution:** obtain the current context's policy once and pass it to all
four calls. Apply the same rule to the eventual warmer. Preserve the defined
defaults where a policy is genuinely absent.

**Verification:** populate both L1 and L2; issue chat with global disable,
C4 disable and C6 disable. Assert fresh provider execution for disabled
layers and zero disabled-layer reads/writes; verify re-enabling separately.

### A04 — High — P8: ordinary parser-loaded script loses embed attributes

**Locations:** `widget/src/widget.ts:76`, `:337`, `:378`;
`widget/src/public-config.ts:47`.

While the document is loading, boot is deferred until DOMContentLoaded.
The delayed callback then reads `document.currentScript`, which is no longer
the executing widget script. Required attributes disappear, parsing fails,
and the widget cannot initialize. Existing E2E markup includes `defer`, which
  does not cover the ordinary parser-blocking script path. Confirmed by source
inspection and the actual-source browser probe described above.

**Solution:** capture and validate the script attributes synchronously during
bundle evaluation and pass that snapshot into deferred initialization and
custom-element upgrade. Define how author-supplied hosts receive options.

**Verification:** actual document navigation with head/body script placement,
with and without defer, dynamic insertion, author-supplied host and duplicate
tags. Require one initialized shadow root and the expected config request.

### A05 — High for challenge-required bots — P5/P8: no widget challenge path

**Locations:** `widget/src/widget.ts:131`, `widget/src/session.ts:107`.

The session helper accepts a challenge-token supplier, but the production
widget never supplies one. There is no challenge renderer elsewhere in
`widget/src`. Bots requiring Turnstile therefore cannot create sessions
through the shipped widget. The backend's fail-closed default makes this a
release blocker for that configuration, not an auth bypass.

**Solution:** establish the public site-key/config contract, render the
challenge using the shared session action, pass its token into session
creation, and handle expiration, rejection and retry. Keep the secret key
server-only. Do not resolve this by switching the requirement off silently.

**Verification:** require a token in backend-connected widget tests; test
valid, missing, expired and rejected tokens. Real Turnstile verification
remains a separately authorized P12 deployment check.

### A06 — Medium — P8: successful EOF without a terminal event wedges the UI

**Locations:** `widget/src/api.ts:277`, `widget/src/widget.ts:230`.

The SSE reader accepts EOF even if no done/error event arrived. The send
handler recovers on an abort or thrown error, but normal premature EOF can
leave it connecting/streaming indefinitely. Confirmed statically.

**Solution:** track the stream's terminal state and throw a controlled
interruption on EOF without a valid terminal outcome. Keep received text,
mark it partial and restore sending. Avoid generating a new request under
the same idempotency key during reconciliation.

**Verification:** empty successful response, EOF after meta, EOF after
multiple deltas, full terminal response and intentional user cancellation.

### A07 — Medium — P8: refreshed sessions retain the old conversation

**Locations:** `widget/src/widget.ts:131`, `:149`, `:249`.

On session expiry the widget clears the token but preserves the conversation
ID in memory/storage. The next token belongs to a new session and cannot
access the old conversation. Natural token refresh has the same identity
transition problem. The backend correctly refuses the foreign session;
the widget provides no working recovery for the retained conversation.

**Solution:** clear the conversation binding whenever the session identity
changes. Define whether the old transcript is retained as a labelled local
history or reset, and submit null for the new conversation.

**Verification:** one turn, expiry or revocation, new session, next turn;
require a newly authorized conversation and no repeated rejection loop.

### A08 — Medium scope gap — P7.5: C8 warming is still a stub

**Locations:** `worker/src/handlers.ts:28`,
`worker/src/jobs/warm-answer-cache.ts:82`, `:155`.

The production registry omits the handler; migrations have no warming enqueue
path. The handler tries a nonexistent suggested-question RPC, discards
retrieved chunks and contains no actual C5/C7 writes. It lacks production
chat/moderation configuration and budget reservation. Its unit test name
claims pre-population while checking fake embedding calls only.

**Solution:** implement activation/settings-triggered queueing, version-aware
deduplication, the production registry, bounded question discovery, cache
population using the chat keys, lease fencing and budget accounting. Warm
answers only after completed generation, output moderation, validated
citations and the PII/cache-policy rules. Alternatively an explicit owner
scope decision may defer C8; the current handler is not completion evidence.

**Verification:** activation and settings changes enqueue; duplicate events
do not double-spend; superseded jobs cannot populate current-version keys;
actual API reads hit warmed caches. Test disabled policy and rejected output.

### A09 — Medium, latent — P9: analysis scheduling can lose new turns

**Location:** `supabase/migrations/017_p9_analysis.sql:47`.

When an analysis job is running, enqueue simply returns that job. A message
arriving after its context snapshot is absent from the analysis; no successor
is queued when that job completes. Confirmed static interleaving.

**Solution:** track the analyzed transcript watermark and pending changes,
then transactionally schedule a successor when the watermark is stale. Fit
this around the existing live-job deduplication index; an unconditional
second insertion under the same key will not suffice.

**Verification:** pause after context read, persist another turn, enqueue,
complete the first job, and require the successor to include the new turn.

### A10 — Medium, latent — P9: incurred analysis usage can be dropped

**Locations:** `analyze-conversation.ts:250`, `:256`, `:282`.

Abort/lease-loss returns before recording usage even after streaming began.
Transient failure records only the user-prompt estimate and zero output,
excluding system/identity input and any emitted output. This path is latent
behind A01 but must be fixed before enabling analysis generation.

**Solution:** track conservative incurred usage once billing is possible;
persist spend even after cancellation using bounded cleanup calls, while
forbidding stale result writes. Count the complete input and partial output.
Leave reservation recovery fail-closed when recording fails.

**Verification:** billed partial stream followed by lease loss, shutdown,
transient failure and usage-recording failure; real cost remains counted.

### A11 — Medium, latent — P9: result writes have no lease/freshness fence

**Locations:** `017_p9_analysis.sql:160`, `:214`.

Save/fail RPCs take a conversation and result, but no job/worker identity or
snapshot watermark. A worker that becomes stale after its heartbeat cannot
be rejected transactionally and can overwrite newer analysis or mark it failed.

**Solution:** new fenced save/fail APIs validate the current lease, bot and
conversation ownership, plus the analyzed snapshot's freshness. Do not weaken
the existing function grants. Define the allowed out-of-order result policy.

**Verification:** reclaim the lease and save a newer result; the former
worker's save and fail calls must leave the newer result untouched.

### A12 — Medium — P7.5/P10: cache-hit metrics disagree with emitted usage

**Locations:** `api/src/services/chat.ts:749`,
`docs/runbooks/metrics.md:30`.

The answer-hit path records operation `chat` with cache provider/model markers.
The runbook counts `answer_cache_hit` and counts every `chat` row as generation.
Hits therefore report as zero and inflate generation counts. Confirmed
statically; layer table sizes also do not measure C4–C6 hit ratios.

**Solution:** align the usage operation, ledger type, persistence contract and
runbook, or explicitly query the existing provider/model markers. Add real
hit/miss counters for the other layers if claiming per-layer hit rates.

**Verification:** one generation followed by one cache hit must yield one
of each, with zero provider spend for the hit.

### A13 — Medium operational gap — P10/P11: restore verification is not executable as written

**Locations:** `docs/runbooks/restore-rehearsal.md:23`,
`scripts/smoke-test.mjs:214`.

The runbook points a local API at a remote throwaway restoration and calls
the smoke script. That script creates its own local API and refuses a
non-loopback Supabase URL. It cannot verify that restored project as written.
There is also no executed Storage-object restore evidence in this audit.

**Solution:** provide a specifically targeted restored-project checker with
explicit project identity, safe test-data lifecycle and a real known-answer
path. Independently inventory/checksum restored Storage objects. Record the
rehearsal and recovery objective measurements before release.

**Verification:** execute the documented procedure on an approved disposable
target, including originals, chunks, grants/RLS and a known-answer request.

### A14 — Low contract gap — P2/P3.5: shared and SQL URL policies differ

**Locations:** `shared/src/schemas.ts:215`,
`supabase/migrations/010_admin_settings.sql:121`, `:142`.

Shared validation uses a URL parser; SQL intentionally accepts a narrower
ASCII hostname syntax. Valid HTTPS IP literals and internationalized hosts
can pass client validation and fail SQL with RB035. The SQL comment admits
the difference; this is a parity/UX gap, not an identified exploit.

**Solution:** choose and document one accepted host policy, then align shared
and SQL validation. Any SQL change must be a new migration. Add parity cases
for IPv4/IPv6, Unicode/punycode, trailing dots, empty ports and normal hosts.

## Phase map and acceptance gaps

| Phase | Audit outcome / remaining work |
| --- | --- |
| P0 | Production cap, jurisdiction/DPAs, paid-tier data processing and independent fallback remain owner/client decisions in `status.md:105`. No values were inferred. |
| P1 | No new scaffold defect established. `plan.md:106` still names CI success as acceptance, conflicting with the overriding local-only `rules.md:11`; align the text. |
| P2 | URL parity gap A14. Audit did not establish that every shared contract is free of defects. |
| P3/P3.5 | A14; hosted Auth/dashboard configuration and effective grants were not rechecked. Preserve forward-only migration history. |
| P4/P5 | No new high-confidence backend auth defect established in the inspected paths. Real proxy hops and challenge deployment remain unproven; A05 is the widget integration gap. |
| P6 | No new high-confidence ingestion defect established in the bounded review. A02 must preserve ingestion accounting. Full extraction/race coverage was not re-audited. |
| P7 | Real-provider wire formats, retrieval calibration and primary/fallback behavior remain P11 evidence gaps. |
| P7.5 | A03, A08, A12; real cold/warm/hit latency and per-layer hit rates are unproven. |
| P8 | A04–A07; current mocked E2E evidence does not close these integration paths. |
| P9 | A01/A02 and A09–A11 block reliable analysis; the new local analysis-version argument fixes only the save-signature omission. |
| P10 | A12/A13; live smoke, Render proxy-hop measurement and exercised operational procedures remain outstanding. |
| P11 | `tests/evaluation/README.md:1` is a placeholder. Real quality/injection/multilingual/fallback evaluation, load/p95 measurements and restore rehearsal remain to be performed. |
| P12 | First-client rollout remains unstarted; depends on P11, admin rollout, real Auth/Turnstile configuration, alerts, caps and signed handover. |

Continuity also needs reconciliation: `README.md:3` still says implementation
ends at P6; `AGENTS.md:13` describes only through P7; phase summaries retain
historical pre-merge headers; the requirements checklist in `status.md:304`
is entirely blank despite implemented features. Preserve historical evidence
and add clearly dated current-state annotations rather than rewriting history.
P7–P10 being merged is not owner acceptance or release readiness.

## Repair order and limits

1. Repair A01/A02/A10/A11 as one bounded analysis-budget migration and worker
   change, with actual DB integration and concurrency tests. Include the
   existing local save-version fix. Avoid editing migrations already hosted.
2. Repair A03 and verify production cache integration, then A04–A07 with real
   browser navigation and challenge/session lifecycle tests.
3. Repair analysis scheduling A09, metrics A12, restore procedure A13 and URL
   parity A14. Implement the authorized C8 work only against the corrected
   budget and cache contracts.
4. Run the complete local suite on the integrated tree, fix flakes as defects,
   and obtain independent correctness/security re-review. Archive results with
   revision, environment, counts and exit codes. Do not substitute these 51
   unit tests or typecheck for the suite.
5. Complete authorized P11 evidence, then seek explicit phase acceptance and
   each required hosted/deployment approval. No phase acceptance, migration,
   deployment, commit or push is made by this report.

Reviewers did not exhaustively read every extraction/chunking module, every
superseded SQL function, all pgTAP assertions, provider adapters or the admin
repository. A separate deployed/hosted audit is needed before claims about
current external exposure. No reachable hosted exploit was established here.
