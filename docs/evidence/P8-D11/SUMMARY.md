# P8-D11 — public configuration contract (A15)

Confirmed pre-existing medium boundary defect: valid PostgREST rows containing
SQL NULL in optional privacy/contact/hours/timezone fields fell back to generic
branding. Widget-only copies of language/E164 validation also rejected valid
shared/SQL values, while invalid hours/timezone/text and language sets escaped
some widget checks.

The widget now parses the canonical browser-safe publicBotConfigSchema and
maps the validated result to its internal camelCase shape. Contact links use
the same shared email/phone rules. Required fields and at least one contact
channel remain mandatory. Raw validation errors are caught without logging
or showing submitted values. No Node/provider/config imports enter the bundle.

Main verification, root p8/d11@aa6425a plus dirty overlay, Node26.13.1:

- New 16 contract cases: red13 failed/3 controls; final full widget suite73
  passed/9files, exit0 (unit.log).
- Root build exit0 (build.log); full offline browser matrix36 passed, exit0
  (browser.log). These use fake backend/provider/challenge routes.
- Bootstrap fixture updated to include actual PostgREST-shaped null fields:
  all9 bootstrap modes passed separately, exit0 (nullable-browser.log).
- Root lint initially caught an unused helper and control-regex lint in the
  restore checker. Helper removed; equivalent character-code check substituted.
  Final lint and typecheck exit0 (lint-final.log/typecheck.log).
- Two independent static reviewers found no functional/security blocker after
  cleanup. Reports are self-reported; main inspected code and ran checks.

Tradeoff: canonical Zod schema import increases the raw widget artifact from
30,117 to496,989 bytes. No repository size ceiling exists; loading performance
has not been measured. Keep this explicit for P11 evaluation, not a claimed
performance pass. Final integrated full-system acceptance remains open.
No migration, hosted action, provider call, deployment, commit or push.
