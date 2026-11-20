# P8-D10 — session/conversation identity (A07)

Main-session repair on `p8/d10@aa6425a` plus preserved dirty work, subsequently
carried into `p9/d4`. Repo-root cwd, Windows, Node 26.13.1. Owner authorizes
continuing local repairs through P10, stopping before P11. No commit, push,
hosted migration, deployment or live provider call.

Owned implementation: `widget/src/widget.ts`, session-lifecycle E2E and
UI_SCHEMA §7/8. Shared/API/DB contracts are frozen. References: audit A07,
ADR 0009, handover session-scope invariants and plan P8.

Session identity is now bound to the current token. A newly issued token
clears conversation state in memory/storage before chat. Revocation/refusal
and reset clear both session and conversation binding. Displayed prior
messages remain labelled local history and are not submitted as context.
Boot history restoration rechecks live/stored identity, conversation and
active operation after its await, so stale responses cannot rebind context.

Evidence:

- `red-browser.log`: initial anchored grep matched no tests (exit 1); this
  setup attempt is not defect evidence.
- `reproduce-a07.mjs` builds a controlled variant that omits only the new
  identity-transition block, without editing source files. In
  `red-identity-variant.log`, expired-session regression fails and live-session
  reload control passes (1 failed / 1 passed, exit 1). The normal widget was
  rebuilt immediately afterward (`widget-build-final.log`, exit 0).
- `browser-final.log`: exit 0, 36 passed / no failed/skipped, using the normal
  built IIFE: 5 session lifecycle cases, 3 EOF cases, 14 challenge cases,
  9 bootstrap cases and 5 existing widget cases. API, config and ownership
  checks are intercepted synthetic fixtures, not real-backend evidence.
- `build-final.log`, `lint-final.log`, `typecheck-final.log`: exit 0.
- A06's unit run was 53 passed / 8 files before the A07 source edit; this is
  recorded in P8-D9 and must not be represented as a post-A07 run.

Main inspected the integrated code and ran the tests. Read-only security
review of A06/A07 reported no blocker; final correctness review requested.
Worker reports are static/unverified, not runtime evidence. Final formatting,
full-system gates and other pre-P11 repairs remain tracked separately.
