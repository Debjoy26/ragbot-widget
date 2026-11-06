# ADR 0001 — Node LTS and dependency pins

- **Decision:** D11 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P1

## Decision
- Node **24 LTS**, exact patch pinned in `.nvmrc` and `engines` at P1 (local machine has v24.18.0; use it unless a newer 24.x patch is current at P1 start).
- Fastify **5.x**, Zod **4.x**; exact versions resolved from the registry during P1. No `^`/`~` ranges, no `latest`; committed `package-lock.json`.

## Rationale
Node 26 only just entered LTS and Render support is unverified; Node 24 is mature and supported until 2028.

## Consequences
- Supabase CLI was not installed at the time. It is now pinned as a dev dependency (3.0.0). The Node pin is 24.22.2.
- Exact versions are recorded in the P1 report, not here.
