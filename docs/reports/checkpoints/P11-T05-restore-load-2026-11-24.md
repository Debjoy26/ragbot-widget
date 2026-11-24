# P11-T05 restore drill + load probe — 2026-11-24 (indicative, gates stay OPEN)

## Restore rehearsal (local drill; full rehearsal needs a throwaway project)
- Checker green on current tree: `restore-catalog` + `restore-collector` 5/5,
  unit `restore-project-check` 13/13 (18/18 total, matches T23).
- `npx supabase db dump` exit 0 → `docs/evidence/P11/local-027-dump-2026-11-24.sql`
  (335,419 bytes schema). Live DB verified at 27 migration rows. Seed/dev only,
  no secrets in dump.
- Full rehearsal (manifest capture → throwaway-project restore → checker) is
  owner-gated per the runbook: needs a provisioned throwaway Supabase project +
  `psql` + `RESTORE_*` credentials. Recorded as P11 carry, not runnable today.

## Load probe (indicative only — NOT a p95 gate)
- Method: real API + real Gemini 3.5 on local stack, 3 sequential + 3 parallel
  first-turn chats, time-to-first-delta + total. Two runs.
- Run A seq: first 3392–4719ms, total 3476–4931ms. Run A par3: first
  2291–2547ms, total 2418–2689ms. Run B seq: first 2121–3061ms, total
  2227–3389ms. Run B par3: first 1738–1953ms, total 1836–2156ms.
- Targets (plan.md: first ≤5s, full ≤20s) met indicatively on n=12 turns.
- NOT a gate pass: n too small, no p95, host-bound box (~1GB free), no
  contention sweep for the `bot_profiles` FOR SHARE / 55P03 checks. Load gate
  stays OPEN for a healthy host. Spend ≈ $0.002 (6+6 questions).

## State / next
- P11 remaining: fallback eval (needs 2nd provider key — owner), healthy-host
  load p95, throwaway-project restore rehearsal (owner infra).
- Next: P12 prep — deploy readiness + owner punch-list.
