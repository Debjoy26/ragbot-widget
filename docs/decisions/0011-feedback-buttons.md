# ADR 0011 — Feedback buttons

- **Decision:** D12 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P8

## Decision
**Deferred.** `FeedbackButtons` are removed from the v1 widget; no feedback endpoint or table. Knowledge-gap analytics (`knowledge_gaps` RPC) cover the main signal.

## Consequences
UI_SCHEMA component tree to be updated to drop/hide `FeedbackButtons`; resolves handover §6 gap.
