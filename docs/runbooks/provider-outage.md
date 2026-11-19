# Runbook: provider outage (P10)

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](../reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

Scope: chat, embedding or moderation provider returns auth/billing errors or
sustained transient failures. Visitor impact first, diagnosis second.

## Detect

- API logs: `provider_auth`, `provider_refused`, `analysis_provider_refused`,
  `analysis_budget_exceeded` (warn), stream `error` events with code
  `PROVIDER_UNAVAILABLE`.
- Metrics: `docs/runbooks/metrics.md` — error-rate and latency queries.
- Render dashboard: 5xx rate on `ragbot-api`, queue age growth on `ragbot-worker`.

## Respond

1. Confirm it is the provider, not us: `GET /health/ready` is 200 while chat
   turns end in `error` events. Check the provider status page.
2. Auth/billing error (`auth`, `billing` kinds): rotate or top up the key in
   the Render dashboard (`ragbot-api` and `ragbot-worker` env), then restart
   the services. No code or migration change. See `key-rotation.md`.
3. Transient errors: the API already retries before the first token and
   terminates partial streams as `STREAM_INTERRUPTED` with a retry hint; the
   worker retries with backoff and dead-letters after `max_attempts`. No action
   unless the dead-letter queue grows — then see `incident-response.md`.
4. Fallback: if `CHAT_FALLBACK_PROVIDER` is configured, it is tried
   automatically before the first token only. A Gemini-only setup shares one
   quota (`status.md §3a o`): a quota outage needs a second provider key, which
   is a config change in Render env, not a deploy.
5. While degraded, unanswerable and failed turns still emit `handoff` with
   reason `unavailable` and the configured contact card. Verify the contact
   card renders (widget ContactCard) before declaring the incident mitigated.

## After

- Record provider, window, error kinds and dead-letter count in the incident log.
- If the budget reaper expired reservations mid-incident, daily-cap
  accounting stays fail-closed (late settle counts toward the UTC day of the
  reservation). No manual ledger fix.
