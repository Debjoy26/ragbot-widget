# ADR 0007 — File limits, rate limits and budget caps

- **Decision:** D6 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P5, P6

## Decision (starting values; revisit after P11 load tests)
| Limit | Value |
|---|---|
| Max upload | 20 MB / 300 pages |
| Visitor message | 2,000 characters |
| Answer output | 800 tokens |
| Concurrent chat requests | 1 per session |
| Message rate | 20 per session / 10 min; 60 per IP / hour |
| Session creation | 10 per IP / hour |
| Daily budget cap (dev) | US$5 per bot |
| Daily budget cap (production) | **OPEN — owner to supply per client** |

## Consequences
All limits live in `client_settings`; any missing value (including the production cap) **fails closed** (invariant 13). Counters/reservations are atomic in Postgres (invariant 6).
