# Working rules — ragbot_widget

Set by the owner on 2026-11-08. These rules apply to every phase and every session. They add to `CLAUDE.md`. Where the two differ on CI, testing or starting debug cycles, this file wins.

## 1. Roles
- **Main session (Opus):** orchestrates, integrates, tests, reviews findings and runs every debug cycle. It does not hand testing or verification to a worker.
- **Workers:** `sonnet-implementer` builds on its own branch and worktree, from an assignment packet (`CLAUDE.md`). Read-only `reviewer` and `security-reviewer` review. `haiku-docs` updates `status.md` and `handover.md`.
- A worker's report is a claim, not evidence. The main session reruns everything that matters.

## 2. No CI
- Never check, watch, wait on or report CI runs. Never use a CI result as evidence.
- Editing a workflow file is allowed when a task needs it. Its result is never a gate.
- All testing happens on this system, as below.

## 3. System test suite
"The suite" means all of these, run by the main session from the repository root on the integrated tree:

| Area | Commands |
|---|---|
| Build and static checks | `npm run build`, `npm run lint`, `npm run format:check`, `npm run typecheck` |
| Database | `make db-local`, `make db-test`, `make db-lint`, `make db-race` |
| Unit and integration | `npm test`, `npm run test:integration` |
| Running system | `node scripts/api-smoke.mjs` against the local stack; `node scripts/worker-dist-check.mjs` after the build |
| Guards and secrets | `make test-make`, `npm run secret-scan:self-test`, `bash scripts/secret-scan.sh --include-untracked` |
| Advisors | `npx supabase db advisors --type all --level warn` (local) |

- Record each command's exit code and counts in `docs/evidence/<phase>/`.
- A commit is made only when every command in the suite exits 0. Chain the commit after the checks so a failure stops it.
- A flaky result is a defect. Find the cause; never retry until green.

## 4. During a phase
1. Work on `phase/<phase>`, with workers on their own branches and worktrees. Nothing reaches `main` without owner approval.
2. After integrating each round, run the suite on this system.
3. Run independent reviews: `security-reviewer` and `reviewer`, read-only.
4. Test review claims on the system wherever possible: reproduce a reported bug, or prove a reported fix with a test that fails without it. Record which findings were confirmed by running and which by reading only.
5. Fix confirmed findings in a debug cycle (§6), then rerun the suite and get the fixes re-reviewed.
6. Write `docs/evidence/<phase>/SUMMARY.md`, have `haiku-docs` update `status.md` and `handover.md`, and check its diff.
7. Stop and report to the owner. Wait for approval to merge and push.

## 5. After a phase is pushed
Once the owner approves and the phase is merged to `main` and pushed:
1. **Local:** on `main`, run the full suite again.
2. **Hosted dev project, read-only:**
   - `make db-plan` shows nothing pending.
   - Local and hosted catalog fingerprints match: grants, column privileges, policies, functions, triggers, constraints, indexes, columns.
   - Security and performance advisors show no new finding.
   - Anonymous HTTP probes with the publishable key: only `public_bot_config` is readable; tables, admin functions and Storage are refused.
3. Record the results in `docs/evidence/<phase>/post-push.md`.
4. Any error, regression, drift or vulnerability found here starts a debug cycle (§6).

## 6. Debug cycles
The main session is responsible for starting and running a debug cycle whenever testing or review finds an error or vulnerability, during a phase or after a push. It does not wait to be asked.
1. **Confirm:** reproduce the problem on the system, or record why it can't be reproduced. Classify severity, and separate confirmed defects from hypotheses.
2. **Branch:** `<phase>/d<n>` from the affected commit. Write an assignment packet with a bounded fix and owned files.
3. **Fix test-first:** a regression test that fails before the fix and passes after.
4. **Verify:** rerun the full suite. For a security fix, get it re-reviewed by `security-reviewer`.
5. **Record:** add the defect, the fix and the evidence to the phase's evidence file and `status.md`.
6. **Report:** tell the owner what was found and fixed, and what is still open.
- Two unsuccessful cycles on the same defect: stop, write a revised diagnosis and ask the owner.
- A vulnerability that is reachable on the hosted project: report it to the owner at once, before or alongside the fix.
- Fixes reach `main`, and migrations reach the hosted project, only with owner approval (§7).

## 7. Still needs owner approval
- Merging to `main` and pushing.
- Any write to the hosted Supabase project: migrations, SQL writes, Auth or Storage settings, branches, secrets.
- Starting a new phase.
- Dependency installs, real provider API calls, client data, deployments, destructive operations.

## 8. Always
- Never weaken an assertion or delete a test to get green. Report every test expectation changed, and why.
- Fake secrets are generated at run time. No keys, tokens, chat text or document bodies in code, logs, evidence or prompts.
- Migrations that reached the hosted project are never edited; fixes go in a new migration.
- Report results exactly, including what was not run and what is unproven.
