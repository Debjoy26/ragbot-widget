# ADR 0012 — Caching policy

- **Decision:** D13 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P7.5

> Provider details below predate ADR 0014 (Gemini default). The cache layers and defaults stand. Gemini prompt-caching behaviour is unverified and is checked at P7.5.

## Decision
- Anthropic prompt caching **on** for the stable system/identity prefix. Minimum cacheable prefix on Haiku 5.5 is 512 tokens (per current Claude API reference); verify via `cache_read_input_tokens`.
- C2–C6 caches **on** by default.
- C7 answer cache **off by default**; enable per client only after that client's P11 evaluation passes. Default TTL 24 h.
- Kill switch in `client_settings.cache_policy` (invariant 15).
