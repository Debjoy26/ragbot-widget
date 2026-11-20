# P8-D7 — bootstrap attribute snapshot (audit A04)

2026-11-17. Branch `p8/d7`, base `aa6425a` plus the preserved dirty working
tree, including earlier P9-D3 and P7.5-D3 repairs. Main session implemented
and verified this bounded widget change. No commit, push, dependency install,
database change, hosted action, deployment or real provider call.

## Defect and fix

Parser-loaded scripts defer initialization until DOMContentLoaded, when
document.currentScript no longer identifies the embed script. Reading its
attributes then loses the required configuration and leaves an empty host.
The same late read occurred in the custom-element callback.

`widget/src/widget.ts` now copies attributes synchronously during bundle
execution, passes the snapshot into initFromScript, and closes over it in
defineWidgetElement. Delayed initialization and later connected callbacks
use that snapshot. Validation, singleton guards, per-host boot markers,
configuration fetching, rendering and request/session logic are preserved.

## Regression evidence

`tests/e2e/widget-bootstrap.spec.ts` loads the actual built IIFE through HTML
navigation, with fake public configuration and all network requests intercepted.
It covers head/body parser scripts, head/body defer, async, dynamic insertion,
author hosts before/after the tag, duplicate parser tags, and a second script
after initialization. It checks exactly one host/launcher/config request,
the configured greeting, and no page errors. These are offline browser tests,
not deployed backend, Turnstile or real-provider evidence.

Initial fixture used a fake public key shorter than the existing 16-character
minimum, invalidating the control cases. That run was stopped and is not
bootstrap evidence. Both the new fixture and the audit diagnostic now use the
same valid fake public-key pattern as existing E2E tests. Validation was not
weakened. New tests allow 90 seconds for Windows browser startup; the launcher
assertion remains 4 seconds. No existing test timeout or assertion was changed.

Meaningful baseline against the unchanged pre-fix bundle:
`red-focused.log`, exit 1, one parser-loaded head failure (0 launchers), with
deferred and dynamic controls passing (2 passed). The source change was not
rebuilt into that artifact until this baseline finished. Earlier full-matrix
attempts and their fixture/setup limitations are retained in the other red logs.

Post-fix browser/unit/static results are in the completion record below.

## Review

Read-only correctness and security reviews used existing configured
`gpt-6.1-sol` agents under P8-D7 packets, substituting for unavailable Claude
models per the owner's direction. Both reported no confirmed blocker in the
bounded change. Reports were self-reported; main inspected the diff and owns
all runtime verification. No worker ran tests or changed files.

## Completion record

Main-session results, repo-root cwd, Node 26.13.1, Windows, on the dirty branch
above:

- Widget build: exit 0, `build.log`.
- Rebuilt browser suites: exit 0, **14 passed** (9 new bootstrap scenarios and
  5 existing widget E2E cases), `e2e.log`. Chromium headless shell, one worker,
  fake HTTP config/API only.
- Widget units: exit 0, **42 passed across 6 files**, `widget-unit.log`;
  selected `tests/unit/widget` with one worker, including DOM-free Node import.
- Final root build, lint, typecheck and format check: all exit 0,
  `build-final.log`, `lint-final.log`, `typecheck-final.log`,
  `format-check-final.log`.
- `git diff --check`: exit 0 (line-ending notices only).
- Secret scan including untracked: exit 1, only the pre-existing owner-kept
  `widget/public/index.html:14` hit; `secret-scan.log`. No new fixture hit,
  no scan assertion/exception changed, and no value printed.

No checks remain running. A04 is repaired and verified locally; these results
do not establish complete phase acceptance or live/deployed behavior.

Full-system acceptance remains open. Existing broader unit/integration
failures/setup limits, missing make/Windows npipe race support, API smoke
33/2, and the owner-kept demo scan hit are recorded in P9-D3. This widget-only
repair does not imply those gates passed. No CI inspected or used as evidence.

Resume details: `docs/reports/SESSION-CHECKPOINT-2026-11-17.md`. After A04,
next bounded work is P8 challenge integration A05, then EOF/session recovery
A06/A07. Those changes are not included here.
