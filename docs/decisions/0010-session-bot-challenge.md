# ADR 0010 — Bot challenge on session creation

- **Decision:** D10 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P5

## Decision
Cloudflare Turnstile (invisible mode) on `POST /v1/sessions`, behind a per-client flag: **on by default in production**, off in dev. Server-side token verification; failure fails closed.

## Open
Cloudflare terms/pricing not verified in this session. Turnstile does not replace rate limits or budgets.
