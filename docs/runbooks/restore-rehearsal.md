# Runbook: backup/restore rehearsal

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](../reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

P10 supplies the checker and this procedure. Executing a rehearsal is P11 work
and needs owner phase approval. This document records no completed rehearsal.
Restore only to an approved throwaway project, never over the live client.

## Prepare backup evidence

1. Record release SHA and backup time. Confirm backup retention covers the
   client's policy (ADR 0006). Quiesce writes, workers, retention and cache warming
   throughout manifest capture and backup. Separate read-only queries do not
   constitute a cross-service snapshot.
2. Back up Postgres and the actual bytes of every `knowledge` object. Database
   Storage metadata alone is not a backup of original files.
3. Install `psql` through the owner's approved process. Supply credentials through
   secure environment variables: `RESTORE_DATABASE_URL`, `RESTORE_SERVICE_KEY`,
   `RESTORE_PUBLISHABLE_KEY`. Never put them in arguments, reports or Git.
   Database URLs must use `/postgres`, either `db.<ref>.supabase.co` with user
   `postgres`, or an official pooler hostname with user `postgres.<ref>`. TLS is
   required; target/ref mismatch and redirects are refused.
4. Capture the manifest against the quiescent backup source:

   ```text
   node scripts/check-restored-project.mjs --ref <source-ref> --url https://<source-ref>.supabase.co --confirm <source-ref> --capture <private-absolute-manifest-path>
   ```

   Capture performs only read-only SQL and HTTP GETs; it creates the local file
   exclusively, refusing overwrite. The shared development project is always
   refused, including capture. Use a separately approved backup source. Keep the
   manifest outside Git: object keys and counts are private metadata. It contains
   no document bodies. Apply restrictive local ACLs, particularly on Windows.
5. Keep the source quiescent until its matching database and Storage backups
   finish. Associate this manifest with that exact backup before resuming writes.

## Execute only after P11 approval

1. Provision an approved throwaway project. Restore the database backup and
   Storage bytes through the reviewed platform procedure. Do not blindly apply
   migrations before restoring a full database backup. Match history against the
   release SHA; pending migrations require a separately reviewed action.
2. Keep the restored target quiescent. Replace all three environment credentials
   with the restored project's values; never reuse source keys.
3. Run the checker against the explicit restored target:

   ```text
   node scripts/check-restored-project.mjs --ref <restored-ref> --url https://<restored-ref>.supabase.co --confirm <restored-ref> --manifest <private-absolute-manifest-path>
   ```

   Nonzero exit means failure. The output contains only a safe outcome and
   aggregate counts. Archive sanitized command names, timestamp, release SHA and
   exit code as evidence, never credentials or the private manifest. It compares
   migration versions, public/Storage catalog definitions, grants/default ACLs,
   relation ownership/RLS flags, view definitions/options, trigger enabled state
   and index usability. It also checks exact public table/view counts, private
   `knowledge` bucket configuration, inventory and streamed SHA-256 checksums. A
   source project reference in the manifest must differ from the restored target.
   Anonymous
   GET must read `public_bot_config` and must be refused on every other discovered
   public relation, and must not download any inventoried original through either
   Storage's public or authenticated endpoint. No session/chat/provider requests
   are made. Modern keys use `apikey`; Bearer is added only for legacy JWT keys.
4. Obtain read-only advisors separately. The checker is not an advisor or an
   exhaustive Auth/RLS matrix. Run pgTAP only on an authorized disposable copy:
   its fixtures may mutate data and are not read-only verification.
5. Any restored API/worker or known-answer provider check is a separate authorized
   P11 step. `scripts/smoke-test.mjs` discovers the local loopback stack; it cannot
   verify this remote restored target and must not be weakened to do so. Real
   provider calls and client data need owner authorization.
6. Record results and remaining gaps. Obtain authorization to destroy the
   throwaway project and securely dispose of manifests/backups under retention policy.

## Bounds and interpretation

The checker refuses over 200 public relations, 10,000 `knowledge` objects, 100 MiB
per object or 1 GiB of downloaded bytes. SQL output is capped at 16 MiB; queries
and downloads have deadlines. Anonymous configuration JSON is capped at 64 KiB
before parsing. SQL inventory uses a limit sentinel; exceeding it
fails rather than silently truncating. Larger projects need a reviewed update.
Writes during capture/comparison and catalog drift can cause real mismatches;
investigate rather than altering the manifest to obtain a pass. Other buckets,
Auth contents, row-by-row database checksums, complete RPC exposure and actual
restore mechanics remain outside this checker.

## Cadence

Rehearse before first go-live and after Storage layout changes, after obtaining
the applicable approval. Record evidence under `docs/evidence/<phase>/`; a
checker implementation or offline helper test is not proof of a completed restore.
