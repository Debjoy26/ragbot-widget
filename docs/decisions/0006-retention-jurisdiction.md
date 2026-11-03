# ADR 0006 — Retention, jurisdiction and provider data processing

- **Decision:** D5 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P3 (`005_retention.sql`), P9

## Decision
- **Assumed jurisdiction: India (DPDP Act 2023)** — inferred from spec examples; **owner to confirm per client** before production.
- Supabase region `ap-south-1` (Mumbai); Render API/worker in the nearest available region.
- Conversations and messages: **90 days**, then deleted by the cleanup job.
- Usage/billing records: **13 months**, with no message content.
- Knowledge-gap records follow conversation retention.
- Obtain DPAs from each provider (Anthropic, OpenAI, Supabase, Render, Vercel, Cloudflare); use zero-data-retention options where offered.

## Open
Jurisdiction confirmation and DPAs are release-gate items (PRD §7/§8); missing retention config fails closed.
