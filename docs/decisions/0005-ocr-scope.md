# ADR 0005 — OCR scope

- **Decision:** D4 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P6

## Decision
OCR is **out of scope for v1**. Documents without an extractable text layer are rejected with `OCR_REQUIRED`; never marked ready with empty content.

## Revisit
When a client contractually needs scanned documents; would need an isolated OCR worker/service and a new ADR.
