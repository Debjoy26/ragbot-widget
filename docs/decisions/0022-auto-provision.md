# ADR 0022 — Full Self-Serve Auto-Provision (Approved for Build)

- **Status:** Accepted (owner-approved 2026-11-24, build now)
- **Date:** 2026-11-24
- **Decision owner:** Product owner
- **Related:** ADR 0019 (boundary), ADR 0017 (tenant admin), ADR 0021 (AWS plan B),
  `plan.md §1b`, `DATABASE_SCHEMA` SaaS gaps, `PRD §10`, `ARCHITECTURE §2/§10`

## Context

Owner approved full auto-provision: client registers on service site →
provider approves in dashboard → system provisions tenant → client panel
shows `<script>` → client pastes → ragbot live. Choices locked:

- Depth: full auto-provision (not assisted-only)
- Registry: separate provider project (not tenant schema)
- Enforcement: fail-closed block on expired/suspended
- Identity: new public widget key (not bot_slug alone)

## Decision

1. **Provider control plane is separate.** New Supabase project
   `provider_registry` + provider API (Render web service, same repo
   `provider/` workspace) + provisioner worker. Tenant DBs never hold the
   registry; provider browser never holds tenant service-role or org tokens.
2. **Widget key is public ID only.** Format `wgk_<32 hex>` (server-generated,
   `sha256` fingerprint stored). Tenant stores fingerprint + `revoked_at` +
   optional `allowed_hosts`. Never auth; visitor sessions still use HMAC
   `{bot, session, expiry}`. Fail-closed on unknown/revoked/host-mismatch.
3. **Subscription is server-authoritative.** Provider is source of truth
   (`active|past_due|suspended|cancelled`, period, quotas). Tenant caches
   `subscription_status + subscription_version` via signed sync; API re-checks
   on `/sessions` + `/chat` + index paths. Expired/suspended → refuse with
   disabled status; widget renders ContactCard. Frontend-only hide is not
   enforcement.
4. **Provisioning is async idempotent.** `provisioning_jobs` with lease/claim,
   per-step idempotency (`supabase project create → db-create 001..027 →
   Auth hardening → first-admin + bot/settings → Render API/worker → Vercel
   widget/admin → Turnstile → DNS → emit script`). Retry with backoff,
   rollback on failure, full audit. Org tokens live only in provider API env.
5. **Hosting stays Render baseline** until ADR 0021 gates pass. Widget stays
   static bundle (Vercel now, S3/CloudFront when 0021 adopted). Docker never
   for widget.

## Consequences

- Tenant migrations: `028_widget_keys` (fingerprint, hosts, revoked),
  `029_subscription_cache` (status/version/synced_at + gate helper).
  No provider tables in tenant schema.
- Provider schema lives in `provider/supabase/migrations/` (separate history).
- New contracts in `shared/src/contracts.ts`: `WIDGET_KEY_PREFIX`,
  `SUBSCRIPTION_STATUSES`, embed `data-widget-key`, error codes
  `SUBSCRIPTION_SUSPENDED | WIDGET_KEY_REVOKED | WIDGET_KEY_HOST_MISMATCH`.
- Portals in `ragbot-admin-panel`: register, approve, script display consume
  provider API only.
- Open for P12 manual path: same gates work with hand-provisioned tenants
  (key + subscription rows inserted by provider job or `make`).

## Approval

Owner approved build now, local-first. Hosted writes, org tokens, real
provider calls, pushes still need per-action approval per AGENTS §10.
