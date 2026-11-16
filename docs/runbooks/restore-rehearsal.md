# Runbook: backup/restore rehearsal (P10)

Per-client Supabase project (Postgres + `knowledge` Storage bucket). Rehearse
on a throwaway project, never on the live client project.

## Backup (Supabase dashboard, per client)

1. Confirm daily Postgres backups are enabled and the retention window covers
   the client's retention policy (ADR 0006).
2. Confirm Storage (`knowledge` bucket) is included in the backup plan; the
   database alone is not a restore: chunks without originals cannot reindex.
3. Record backup time, size and project ref in the client handover.

## Rehearsal

1. Create a throwaway Supabase project in the same region.
2. Apply the pinned migration history: `make db-create PROJECT_REF=<ref>
   CONFIRM_REF=<ref>` from the release SHA (type the ref twice; no seed).
3. Restore the backup into the throwaway project (dashboard restore flow).
4. Verify, read-only first: migration history matches (`make db-status`
   shows nothing pending), advisors show no new finding, anon probes show
   only `public_bot_config` readable.
5. Point a local API at the throwaway project (loopback `.env`, never
   committed) and run `node scripts/smoke-test.mjs` plus the pgTAP suite.
6. Destroy the throwaway project afterwards: it holds client data.

## Cadence

Rehearse before first go-live per client and after any Storage layout change.
A rehearsal that was not recorded did not happen: file the evidence under
`docs/evidence/<phase>/` with the backup time and the verification commands.
