# P8-D8 — Turnstile session integration (audit A05)

2026-11-17. Branch `p8/d8`, base `aa6425a` plus all preserved uncommitted
work from earlier repairs. Owner's latest “Approved” accepts the local A04
repair and continues the already-authorized sequential repairs. It does not
approve phase acceptance, merge, push, hosted writes or deployment.

## Bounded assignment

Task P8-D8/A05: integrate the existing optional session challenge supplier
into the production widget. Main owns `widget/src/{challenge,session,widget,
ui,types,public-config}.ts`, challenge/cancellation/config regressions,
`UI_SCHEMA.md`, the session paragraph in `TECH_SPECS.md`, the Turnstile
paragraph in `README.md`, and this evidence/continuity record. Frozen:
shared contracts/schemas, API verification/policy, all migrations and root
dependency/build configuration. References: ADR 0010, plan P5/P8,
UI_SCHEMA §2/4/7 and handover §4. Local shell/build/test commands only;
browser network is fully intercepted. No dependencies, live provider calls,
database operations or hosted actions. Stop after verification/review and
checkpoint, before A06. Worker reports list scope, commands, findings and
limitations and are unverified until inspected by main.

## Defect and repair

The session helper accepted a challenge supplier, but widget boot never
provided one. A challenge-required bot therefore could not start a session.
The browser regression against the A04 bundle reproduced the missing UI
(`red-browser.log`, exit 1, one failed).

The embed now accepts a validated public `data-turnstile-site-key`. A new
session lazily loads the official Turnstile script and renders the shared
`TURNSTILE_SESSION_ACTION`. Each successful callback supplies one token
immediately to the session POST. Live stored sessions bypass acquisition;
new attempts render a fresh challenge. Empty/oversized callbacks, expiry,
errors, unsupported browsers, script failures and a two-minute watchdog
fail closed and leave the composer retryable. Vendor DOM is removed on
settlement and projected through a slot while present. Invisible mode is
provisioned in Cloudflare per ADR 0010; managed keys can expose their UI.
No secret key belongs in the embed. The API remains authoritative and is
unchanged. Missing keys do not bypass required verification. Session refusal
is reported generically rather than as an expired session.

Security review found a cancellation gap after challenge success: the
pending session POST could finish and persist after Stop/close. Reproduced
by one held-response browser failure (`red-post-cancel.log`, exit 1) and
three unit failures (`red-session-cancel.log`, exit 1). The latter originally
printed a runtime-generated synthetic session UUID in the assertion diff;
that value was redacted in the retained log. No real secret was involved.

The helper now forwards an optional abort signal and checks cancellation
before acquisition, before POST, after response and after JSON, before
storage. Widget close aborts session creation; cancelled stale attempts
cannot reset a newer attempt's shared controller/state. Held-POST Stop and
close tests assert no stored session and a successful subsequent send.

## Review and verification

Main inspected the integrated source/diff and runs every check itself.
Existing read-only Sol reviewers (`gpt-6.1-sol`, previously recorded
substitution for unavailable Claude reviewer roles) received P8-D8-R1/R2
packets. Security R1 found the cancellation defect above. Both final static
reviews reported no remaining blocker; their reports are self-reported,
not runtime evidence. No worker edited files or ran tests. Optional additional
coverage: synchronous vendor callbacks, cancellation while the vendor script
loads, and forcing an old response after a newer attempt starts.

Environment: repository-root cwd, Windows PowerShell, Node 26.13.1,
`p8/d8@aa6425a` plus dirty tree. Browser: installed Chromium headless shell,
one worker, built IIFE, fake vendor/config/API only. No live verification.

- Initial widget build: exit 0 (`widget-build.log`). Initial challenge suite:
  exit 0, 10 passed (`challenge-browser.log`), before the additional
  cancellation/oversized/watchdog regressions.
- Rebuilt final artifact: exit 0 (`widget-build-final.log`).
- Widget units: exit 0, 46 passed / 7 files, no failed/skipped
  (`widget-unit.log`). Includes three new cancellation cases, embed-key
  validation and DOM-free imports.
- Final browser suites: exit 0, 28 passed, no failed/skipped
  (`e2e-final.log`): 14 new challenge cases, 9 bootstrap cases and 5 original
  widget cases. Both held-session POST cancellation regressions passed.
- Root build, lint, typecheck and format: exit 0 (`build-final.log`,
  `lint-final.log`, `typecheck-final.log`, `format-check-final.log`).
- Secret scan including untracked: exit 1, only the pre-existing
  `widget/public/index.html:14` hit (`secret-scan.log`). Owner-kept demo value
  was preserved; scanner rules/assertions were not weakened.
- Secret scanner self-test: exit 0, 27 passed / 0 failed
  (`secret-scan-self-test.log`).

All implementation checks finished. Continuity formatting and final diff
checks are captured in `format-continuity-final.log` and `diff-check-final.log`.
No commit, push, hosted write, deployment or real provider call was made.
Browser cancellation cannot undo work already received by the server; its
verified guarantees are aborting the request locally and preventing storage
of a cancelled response.

## Limits and next repair

This is a local widget repair, not complete P8/system acceptance. Full-system
gates remain open as recorded in P9-D3 and the session checkpoint: broad
unit/integration failures, Windows make/race limitations, two API smoke
failures and the demo scan hit. Those known failures were not retried as an
attempt to obtain a green result. Database/worker gates were not rerun for
this widget-only change; earlier results do not prove the final full tree.
No commit is permitted while the required full suite is not green.

Live Turnstile keys, allowed hostnames, Siteverify action/hostname behavior
and production CSP remain P12 checks requiring the appropriate owner
authorization. See official [client rendering documentation](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
and [CSP guidance](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

Next bounded repair: A06, premature successful SSE EOF without `done`/`error`.
Do not start it before this checkpoint is complete and reported to the owner.
