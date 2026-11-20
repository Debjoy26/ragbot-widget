# P8-D9 — premature SSE EOF (A06)

Main-session local repair on `p8/d9@aa6425a` plus preserved dirty work,
subsequently carried into `p8/d10`. Repository-root cwd, Windows, Node 26.13.1.
No commit/push/hosted action/provider call. Owner authorized sequential
pre-P11 repairs and stopping before P11; continue to A07 after this repair.

Owned scope: `widget/src/{api,widget}.ts`, stream-completion unit tests and
widget-stream-lifecycle browser tests, UI failure policy and evidence.
Frozen shared contracts, API wire contract, DB and root configuration.
References: audit A06, UI_SCHEMA §4/8, TECH_SPECS §4/9 and plan P8.

The reader used to accept EOF without a terminal event. It now tracks parsed
done/error outcomes and throws STREAM_INTERRUPTED for an unexpected EOF.
Done status must match shared MESSAGE_STATUSES. Explicit abort is preserved.
Widget recovery marks the existing node partial, retains its received text,
adds a stable notice and restores sending without automatic replay.

Main-session evidence:

- `red-unit.log`: exit 1, 5 failed / 2 valid-terminal/abort controls passed.
- `red-browser.log`: exit 1, partial-response scenario stayed unfinished.
- `widget-build.log`: exit 0, rebuilt actual widget IIFE.
- `widget-unit.log`: exit 0, 53 passed / 8 files, no skipped/failed.
- `browser.log`: exit 0, 3 passed (empty, meta-only and multiple-delta EOF),
  each recovers and permits an explicit independent next send.

Browsers use synthetic intercepted config/API responses. No real provider
or DB gate is implied. Read-only correctness reviewer reported no blocker;
main inspected the integrated code and owns the tests. Combined security
review and final static/full-system checks follow A07 integration. Existing
full-system blockers remain open; no commit/full-phase acceptance claimed.
