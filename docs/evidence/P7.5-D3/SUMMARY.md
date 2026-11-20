# P7.5-D3 — backend cache policy enforcement

2026-11-17. Branch `p7.5/d3`, base `aa6425a` plus existing dirty tree,
including the uncommitted P9-D3 repair. No commit, push, dependency installation,
migration, deployment or real provider call in this step.

## Confirmed defects and repair

- Chat omitted cache_policy when reading/writing query embeddings and input
  moderation verdicts, so disabled C4/C6 caches could still serve entries and
  populate L1/L2. The request now supplies one server-loaded policy to all four
  calls, as well as the existing C5/C7 paths.
- The backend policy helpers did not recognize the existing kill_switch flag.
  `kill_switch:true` now overrides enable flags for C2/C4/C5/C6/C7. Existing
  defaults, opt-in behavior and per-layer/legacy aliases remain unchanged.
- Security review found C2 policy extraction omitted production
  `settings.cache_policy`. That shape and its camel-case alias are now read
  after the existing top-level/client_settings paths, preserving precedence.

The scope is backend policy enforcement. Provider-managed caches, widget
public-config caching, C8 warming, metrics and other audit findings are not
implemented by this step. Disabling bypasses entries; re-enabling may reuse
still-valid entries under their existing version/model/TTL checks.

## Test-first evidence

Main session ran all checks from the repository root, Windows, Node 26.13.1,
revision above plus dirty tree. Tests use actual cache/service implementations
with labelled fake providers/database and L2 spies; they are not a live backend
or real-provider gate.

1. New chat-cache-policy suite: 13 failed / 1 passed before the first fix
   (`red.log`), then 14 passed (`green.log`).
2. Three production-shaped C2 service regressions reproduced the review finding:
   3 failed / 14 passed (`c2-red.log`) before the extraction fix.
3. Related cache/conversation suite after both fixes: exit 0, 8 files / 180
   passed (`cache-suite.log`). Includes all 17 new regressions plus existing
   config, embedding, moderation, retrieval, answer, answer-cache call-site and
   conversation-route coverage.

The tests check warm/cold bypass, no disabled L2 access/population, no new
disabled L1 entry, independent C4/C6 controls, re-enabling, enable-flag precedence
for the canonical kill switch, and uncached/refetched production C2 contexts.
No previous assertion or regression was removed or weakened. The chat harness
adds only an optional embedding-cache injection; default behavior is unchanged.

## Review and static verification

Existing Sol agents performed read-only correctness/security reviews under
P7.5-D3 packets, with `model:gpt-6.1-sol` replacing unavailable Claude models
per the owner's request. Reports were self-reported/unverified until main
inspection. Main reproduced the C2 finding and tested its fix. Both final
reviews reported no remaining confirmed blocker in this bounded scope.

Initial build, lint, typecheck and format check exited 0. Final integrated
reruns after the C2 change also all exited 0 (`*-final.log`), and
`git diff --check` exited 0. No SQL or database change requires reapplying
migration 018.

## Gate limitations and handover

Full-system acceptance is still open. This step does not erase P9-D3's broader
unit/integration failures/setup timeouts, unavailable make/Windows npipe race
runner, API smoke 33/2, or the owner-retained demo scan hit. Those checks were
not repeated merely to obtain another result for this source-only cache change.
No CI was inspected or used as evidence.

Resume checkpoint: `docs/reports/SESSION-CHECKPOINT-2026-11-17.md`.
Next bounded repair: P8 parser-loaded bootstrap, audit A04. Read status/handover
and preserve every dirty file before proceeding. Hosted schema remains last
recorded at 017; local is 018. All earlier approval boundaries remain intact.
