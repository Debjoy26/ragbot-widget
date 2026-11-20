# PRE-P11-T29 — Admin panel backend contract alignment

- **Date:** 2026-11-20
- **Task:** Documentation-only response to owner request to make
  `ragbot-widget` aware of the new `ragbot-admin-panel` repository.
- **State:** Complete for documentation scope; proposed product decisions remain
  open.

## Git and environment truth

- Repository: `D:/Projects1/Text_AI/ragbot-widget`
- Branch/HEAD at task start: `main` @ `8a38455`
- Existing worktree state: dirty before this task. Pre-existing modified files
  included `docs/reports/LATEST-CHECKPOINT.md`,
  `docs/reports/OPENCODE-HANDOFF.md`, `docs/reports/PRE-P11-TASKS.md`, and
  `widget/public/index.html`; untracked transcripts, evidence, checkpoint
  reports, and `widget/public/preview.html` were also present. All were
  preserved.
- Worktrees at task start: root `main` and the two temporary worktrees recorded
  by `git worktree list` under `C:/Users/DEBJOY/AppData/Local/Temp/`.
- Hosted state: owner-approved migrations 018–027 were applied and verified on
  2026-11-20; local/hosted histories are recorded at 027. Evidence:
  `PRE-P11-hosted-018-027-2026-11-20.md`. No database query or write was made
  for T29.
- Usage reading: no authoritative meter available in this task; no value
  inferred. Owner monitors the allowance.

## Changes made

Updated current backend documentation:

- `PRD.md`: separate client/provider admin extension, public widget
  identification, subscription enforcement gap, and human-approved
  knowledge-gap answer flow; records the discussed AWS hosting target as an
  undecided deployment change.
- `ARCHITECTURE.md`: preserves existing per-client topology and records the
  proposed provider control-plane trust boundary.
- `TECH_SPECS.md`: distinguishes existing backend capabilities from proposed
  widget-key, subscription, provider, and knowledge-publishing contracts.
- `DATABASE_SCHEMA.md`: adds a proposed-only gap register; no schema was
  designed or changed.
- `plan.md`: records the extension outside P0–P12 and makes no phase/hosted
  authorization.
- `README.md`, `status.md`, `handover.md`: identify the companion panel and
  current proposal.
- `docs/decisions/0019-managed-admin-platform.md`: proposed boundary ADR.
- `docs/reports/PRE-P11-TASKS.md`, `PRE-P11-REPAIR-TRACKER.md`,
  `LATEST-CHECKPOINT.md`, and `OPENCODE-HANDOFF.md`: record T29 and preserve
  current continuity.

The separate admin-panel docs were pushed at
`Debjoy26/ragbot-admin-panel` commit `4894d2b`.

## Contracts captured

- Client admin remains a separate frontend using tenant Supabase Auth,
  membership, `aal2`, RLS, reviewed RPCs, and Storage under ADR 0017.
- Provider administration is a separate proposed trust domain; no provider
  service, registry, tenant impersonation, or cross-client credential path is
  claimed to exist.
- The current widget embed contract remains unchanged. A future widget key is
  public identification, never authentication.
- `bot_profiles.enabled` is not a full subscription lifecycle.
- `knowledge_gaps` reports gaps; publishing an answer is not currently
  specified. Admin-authored content must pass the approved tenant knowledge
  ingestion/indexing flow and become retrievable only after successful
  activation. Visitor/model text is not automatically trusted.
- `UI_SCHEMA.md` was reviewed and left unchanged; no widget embed behavior was
  altered.

## Validation and scope

- Documentation review: completed for the edited sections.
- `git diff --check` on the T29-owned tracked documentation: exit 0.
- PowerShell trailing-whitespace scan across tracked and newly created T29 docs:
  no findings.
- Build, unit, integration, database, race, hosted, and provider checks: not
  run; no source or migration changed.
- No dependencies installed, no code or migrations changed, no hosted write,
  no deployment, no commit, and no push to `ragbot-widget`.

## Remaining decisions and next action

Owner review is required for provider identity/MFA/roles, provider API and
registry ownership, provider access to private content, widget-key lifecycle,
subscription semantics/enforcement, and Markdown-versus-FAQ knowledge
representation. AWS versus the current Render deployment and its target
topology (EC2/ECS, isolation, static widget hosting) also remain undecided.
These are not approved implementation tasks.

T25-d and T26 single-command gates remain open. P11 remains not started. The
next action is owner review of ADR 0019 and the companion panel specification;
do not infer phase progression from this documentation task.
