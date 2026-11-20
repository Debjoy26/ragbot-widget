# P10-D3 — restore checker preparation (A13)

Base aa6425a, preserved dirty root tree, Node 26.13.1. Worker draft from
isolated p10/d3 worktree was inspected and corrected by main. The root files
are authoritative; do not overwrite them with the older worktree draft.

The checker uses fixed SELECT-only psql queries, validates project identity,
refuses the shared development project, captures bounded catalog/count and
private knowledge-object checksums, and compares source/target manifests.
Catalog fingerprints include RLS flags, view definitions, default privileges,
trigger state, grants, policies, functions and other structural records.
Storage must remain private; modern opaque keys are sent only as apikey.
Output is bounded and scrubbed. The runbook separates backup preparation,
restore actions, checker limitations and later manual gates.

Main-session checks from repository root:

- Unit regressions: red 4 failed/9 controls, final 13 passed, exit 0 (helpers.log).
- Real local catalog-drift tests: red 4 failed, final 4 passed, exit 0
  (catalog-final.log), rollback leaves no persistent schema changes.
- Actual local collector SQL/count queries: 1 passed, exit 0 (collector-sql.log).
  HTTP is explicitly FAKE in that case; this does not prove live Storage,
  checksums, anonymous denial or a restored target.
- npm run typecheck: exit 0 (typecheck.log).

Two final independent static reviews reported no blocker after corrections;
their reports are self-reported and main inspected the integrated code.
No actual backup/restore, remote project, Auth/Storage write, known-answer
provider call or deployment was performed. Executing the restore rehearsal
belongs to P11 and is outside this authorized repair run. Full-suite acceptance
remains open.
