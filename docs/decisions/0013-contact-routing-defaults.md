# ADR 0013 — Contact routing defaults

- **Decision:** D14 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P3, P7, P8

## Decision
- Repeated-miss threshold: **2** `no_knowledge` hits per conversation → `repeated_no_knowledge`, `prominent: true`.
- All six handoff triggers enabled by default.
- Go-live requires ≥1 contact channel and an escalation message for **every** supported language; otherwise the release gate fails.
- Actual contact details, hours and messages are collected per client at onboarding (P12).
