# ADR 0016 — Data-entry retention follows its conversation

- **Decision:** security finding M3 (P3-R1); extends ADR 0006 · **Status:** Accepted — **owner to confirm** · **Date:** 2026-11-04 · **Approved by:** owner (debug cycle P3-D1 approved; most-private option applied)
- **Blocks:** P3, P9

## Decision
`data_entries` are deleted with their conversation (FK `ON DELETE CASCADE`), i.e. the 90-day conversation retention (ADR 0006). Entries without a conversation are purged after the same `retention_policy.conversation_days`. Missing policy fails closed.

## Rationale
Form payloads may contain personal data (DPDP Act). Previously they were detached and kept forever, which also made them unfindable for erasure requests.

## Open
If a client needs longer retention for leads (e.g. CRM handover), that requires a new per-client `data_entry_days` setting and an updated ADR.
