# ADR 0018 — Node pin moves to 26.13.1

- **Decision:** D11 (revises ADR 0001) · **Status:** Accepted · **Date:** 2026-11-14 · **Approved by:** owner (acceptance session, formal pin move to available toolchain)
- **Blocks:** P7 acceptance and later gates

## Decision
- Node pin moves from **24.22.2** to **26.13.1** exact (`.nvmrc`, `package.json` `engines`, lockfile root engines).
- CI needs no workflow change: `ci.yml` already uses `node-version-file: .nvmrc` with pinned `setup-node`.
- `@types/node` stays at 24.19.2 for this move (no API use that needs 26 types); revisit if typecheck shows gaps.
- Historical evidence rows that say "Node 24.22.2" stay as-is — they record what ran. New gate runs record 26.13.1.

## Rationale
- Host toolchain is `v26.13.1` / npm `11.20.0`, `.npmrc` has `engine-strict=true`, no `nvm` on this Windows box, Docker daemon down. The 24.22.2 container path is blocked, so gates cannot run on the old pin here.
- Node 26 is LTS (ADR 0001's "just entered LTS" caution is stale as of 2026-11). Exact patch pin keeps reproducibility (`save-exact`, committed lockfile).

## Consequences / risks
- Render support for Node 26 must be verified before P12 (same caution ADR 0001 had for 26). P10/P12 runbook item.
- All P0–P8 evidence gathered on 24.22.2 (or host 23) must be re-run on 26.13.1 before any gate counts. P7 acceptance is the first such run, eval baseline deferred to P11 per owner.
- If `supabase` CLI 3.0.0 or `vitest` 5.1.0 / `typescript` 6.0.3 misbehave on Node 26, fix forward on 26 (no silent fallback to 24).
