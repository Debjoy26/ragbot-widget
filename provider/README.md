# Provider control plane (ADR 0022, local scaffold)

Separate Supabase project + provider API. Tenant DBs never hold the registry.
Browser never holds service-role or org tokens. Org tokens live only in
provider API env.

Layout (separate history, not tenant `supabase/migrations`):
- `provider/supabase/migrations/001_registry.sql` — clients, deployments,
  subscriptions, widget_keys (fingerprint only), provisioning_jobs, audit.
- `provider/src/widget-keys.mjs` — `wgk_` generation + sha256 fingerprint.
- `provider/src/embed.mjs` — `<script>` snippet builder (public IDs only).
- `provider/src/provision-plan.mjs` — ordered idempotent steps + states.

Runtime enforcement (tenant, this repo):
- `028_widget_keys.sql` + `029_subscription_gate.sql`
- `resolve_widget_key(fingerprint, host)` + `require_active_subscription(bot)`
- fail-closed: unknown/revoked/host-mismatch/suspended → 403, ContactCard.
