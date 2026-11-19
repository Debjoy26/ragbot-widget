# Post-push verification - main @ 9c35306 (2026-11-19)

Commit `9c35306` "Pre-P11 local program T18-T28 + P7-P10 owner acceptance"
(fast-forward of `main` from `aa6425a`), pushed `aa6425a..9c35306` to
`origin/main` on explicit owner instruction ("complete the parts... accept
it and push it to the main"). No CI run was used as evidence (rules.md §11);
local gates below mirror what CI checks.

Curated commit (197 files): full repair overlay product (migrations 018-027,
pgTAP 290-325, unit/integration/e2e tests, shared server extraction,
warming lib, challenge widget, check-restored-project scripts, cache-hit SQL,
Makefile/race/smoke/process harnesses, spec + runbook + tracker updates,
T18b-T28 checkpoints, T18f/T25/T26 evidence logs, P7-P10 acceptance record).
Deliberately NOT committed (preserved worktree-only): codex session
transcript (secret-scan hits), `convo.md`/`tempreport.md` (owner scratch),
`widget/public/index.html` demo-page edit (real dev publishable key stays out
of git), older untracked evidence scratch dirs.

Post-push gates on `main` (main-run, root, all exit 0):
- `npm run build`, `lint`, `format:check`, `typecheck`: PASS.
- `supabase db reset` (001-027 + seed) + `supabase test db`: 37 files, 3671
  tests, PASS.
- Unit/integration/smoke evidence stands from the identical product tree
  (T24 52/52 + smoke 33/0/2; T26-b full integration 23/848/4-skipped exit 0;
  T27 dist-check + guards + scans). No product code changed after those runs
  (only docs/continuity edits). T25-d races + T26-a full unit stay OPEN on
  measured host bounds (see T25/T26 checkpoints).
- Hosted read-only `db push --remote=<ref> --dry-run`: works, lists exactly
  018-027 pending (hosted-last 017 as recorded). NOTHING APPLIED — hosted
  migration decision stays with the owner. No anon-probe/catalog-fingerprint
  run (not re-proven here; last full post-push set was P10-era).

Acceptance recorded: P7/P7.5/P8/P9/P10 ✅ by owner 2026-11-19 with the two
host-bound carries. STOP BEFORE P11.
