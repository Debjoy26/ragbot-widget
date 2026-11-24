# ADR 0020 — Chat default moves to `gemini-3.5-flash-lite` (2.5 retired)

- **Decision:** revises the chat-model default of ADR 0014 · **Status:** Accepted · **Date:** 2026-11-24 · **Approved by:** owner (P11 "follow your way", 2026-11-24)
- **Supersedes in part:** ADR 0014 §3 (chat/moderation/analysis model only)
- **Blocks:** P11 eval (already running on 3.5), P12 go-live defaults

## Decision
1. Default chat, moderation-classifier and analysis model is now
   `gemini-3.5-flash-lite`. `gemini-2.5-flash-lite` returns HTTP 404 for new
   keys ("no longer available to new users", verified 2026-11-24 with the
   owner's paid-tier key) and names 3.5-flash-lite as the successor.
2. Same API shape (`v1beta` `streamGenerateContent`, header key auth, SSE):
   no adapter change. Verified live: classifier `ALLOW` round-trip and the
   P11 eval (23/24, `docs/reports/checkpoints/P11-T03-liverun-2026-11-24.md`).
3. Paid-tier prices change materially (Google price list, checked 2026-11-24):
   3.5-flash-lite is **$0.30 in / $2.50 out** per 1M tokens (2.5 was $0.10 /
   $0.40). Embeddings unchanged (`gemini-embedding-001`, $0.15/1M).
   Daily budget caps (ADR 0007) and estimate constants must use the new prices.
4. `gemini-3.1-flash-lite` also answers 200 on this key and is cheaper
   ($0.25 / $1.50), but Google's retirement message names 3.5, so 3.5 is the
   default; 3.1 stays an explicitly verified fallback candidate, not the default.

## Consequences and limits
- Chat-model switch is a config change per ADR 0014 (no reindex: embeddings
  untouched, invariant 9 unaffected).
- The models-list endpoint still *lists* 2.5-flash-lite while generate rejects
  it: list ≠ callable. Never adopt a model without a generate round-trip.
- Free-tier data-use rule (ADR 0014 §21) is unchanged; paid tier confirmed by
  owner 2026-11-24 ("Used to improve our products: No" on paid tier).
- Re-check model IDs and prices again before each client go-live (ADR 0014 §22).
