# ADR 0015 — MFA enforced in the database for admin reads

- **Decision:** security finding M1 (P3-R1) · **Status:** Accepted · **Date:** 2026-11-04 · **Approved by:** owner (debug cycle P3-D1 approved; recommended option applied)
- **Blocks:** P3, P9, admin panel

## Decision
Every authenticated read of private data (documents, versions, conversations, messages, sources, analysis, data entries, audit logs) and the admin aggregate RPCs require an active membership **and** an `aal2` (MFA) session, checked in Postgres via `is_active_member_mfa(roles)`. `public_bot_config` stays public. `is_active_member(roles)` remains for the UI to probe role without data access.

## Rationale
The admin panel can read the database directly with the publishable key. API-only MFA checks would be bypassed by direct PostgREST reads (handover §4.3–4.4).

## Consequences
Admin users must enrol TOTP before seeing any data; Supabase Auth MFA must be enabled per client project (config, P12). An aal1 session sees nothing.
