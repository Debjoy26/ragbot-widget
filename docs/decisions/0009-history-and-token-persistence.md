# ADR 0009 — History endpoint and visitor token persistence

- **Decision:** D8 + D9 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P7, P8

## Decision
- Visitor token stored in **`sessionStorage`** (tab-scoped), short-lived (~30 min), bound to {bot, session, expiry}.
- **`GET /v1/conversations/:id` enabled in MVP**, same-session only, bounded, never returns `system` messages.

## Rationale
Target hosts are multi-page HTML sites; memory-only tokens would lose the conversation on every navigation. The token only grants the visitor's own conversation, and host-page XSS could drive the widget regardless.

## Consequences
Changes the UI_SCHEMA §7 default (memory-only) — spec doc to be updated. Reset clears sessionStorage.
