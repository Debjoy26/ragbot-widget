# ADR 0004 — Moderation provider and streaming policy

- **Decision:** D3 · **Status:** Accepted — **provider/model superseded by ADR 0014** · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P7

## Decision
- Provider: OpenAI moderation endpoint (multilingual; same vendor as ADR 0002).
- Input: every visitor message moderated in full before retrieval/generation (blocked → `handoff` reason `blocked`).
- Output: **rolling-batch** moderation by default, with residual-risk disclosure; per-client option **full-buffer** before release.
- Run input moderation and query embedding in parallel (P7.5).

## Open
OpenAI moderation pricing/terms not verified in this session.
