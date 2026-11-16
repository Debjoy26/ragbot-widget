# Runbook: rollback (P10)

## Widget (per client)

The widget is an immutable versioned file (`/:version/widget.js`, 1-year
immutable cache). Rollback is a website change, not a redeploy:

1. Point the site's `<script>` tag back at the previous versioned URL
   (e.g. `/v1.0.0/widget.js`). Keep every published version file.
2. The widget reads only `public_bot_config` and the versioned API contract,
   so an older widget keeps working while the API stays on its contract.
3. Never unpublish a version the site may still reference.

## API and worker (per client, from the repo root)

Both services build from the same commit (`render.yaml`).

1. Note the current (bad) and target (last good) commit SHAs from Render.
2. Render dashboard → `ragbot-api` and `ragbot-worker` → redeploy the target
   commit together. The worker must never run a newer schema expectation than
   the API, and the API must never run against migrations it does not know:
   deploy both from the same SHA.
3. Verify: `GET /health/ready` is 200, then `node scripts/smoke-test.mjs`
   against staging (or the local stack for a config-only suspicion).
4. Migrations are forward-only: a rollback never edits or reverts an applied
   migration. If the bad deploy included a new migration, the old code must
   still run against the new schema (additive migrations only), or roll
   forward with a fix. Single history in `supabase/migrations`.

## Admin panel

Separate repo (`ragbot_adminpanel`), separate deploy. It consumes this repo's
schema via `npm run contracts:sync`: after any API rollback, re-sync and
redeploy the panel if the contract changed.
