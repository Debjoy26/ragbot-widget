# ADR 0003 — Primary and fallback chat providers

- **Decision:** D2 · **Status:** Accepted — **provider/model superseded by ADR 0014** · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P7

## Decision
- **Primary:** Anthropic Claude Haiku 5.5 (`claude-haiku-5-5`), low effort.
- **Fallback:** a small OpenAI chat model on a separate account (independent quota, ARCHITECTURE §5); exact model ID pinned at P7.
- Per-client upgrade to Claude Sonnet 5.5 only if the P11 evaluation shows Haiku is insufficient.

## Implementation notes (from current Claude API reference)
- Haiku 5.5 rejects non-default sampling params (`temperature` etc.); thinking cannot be disabled at higher effort — use effort to control.
- `stop_reason: refusal` has no server-side fallback on Haiku 5.5; the API must treat it as a fallback-eligible outcome before first token, or a scoped refusal + `handoff`.
- No provider switch after first token (invariant 8).
- OpenAI model details not verified in this session.
