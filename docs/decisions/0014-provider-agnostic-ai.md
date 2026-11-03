# ADR 0014 — Provider-agnostic AI configuration (Gemini default)

- **Decision:** revises D1/D2/D3 · **Status:** Accepted · **Date:** 2026-11-04 · **Approved by:** owner ("versatile enough to handle Gemini, OpenAI, Anthropic or any API … just update the env file")
- **Supersedes in part:** ADR 0002 (embedding *provider/model*; dimension 1536 retained), ADR 0003 (chat providers), ADR 0004 (moderation provider)
- **Blocks:** P2 (contract `shared/src/providers.ts`), P6, P7

## Decision
1. Every AI role — `chat_primary`, `chat_fallback` (optional), `embedding`, `moderation`, `analysis` — is selected from environment variables only: `<ROLE>_PROVIDER`, `<ROLE>_MODEL`, optional `<ROLE>_API_KEY`, and `<ROLE>_BASE_URL` for `openai_compatible`.
2. Provider kinds: `gemini`, `openai`, `anthropic`, `openai_compatible` (any OpenAI-style API: hosted or local). Capability matrix in `shared/src/providers.ts`; Anthropic is chat-only (no embeddings API).
3. **Default (owner: "lowest and cheapest"):** all roles on Gemini.
   - Chat, moderation classifier, analysis: `gemini-2.5-flash-lite` — cheapest Flash-Lite on Google's official price list ($0.10 in / $0.40 out per 1M tokens, checked 2026-11-04).
   - Embeddings: `gemini-embedding-001` at `outputDimensionality` 1536 ($0.15 per 1M tokens). Verified 2026-11-04: returns 1536-dim vectors.
4. Vector column stays **1536** (`VECTOR_DIMENSIONS`); `EMBEDDING_DIMENSIONS` must equal it or startup fails. Any embedding provider usable must emit 1536 dims (Gemini and OpenAI `text-embedding-3-*` do, via MRL/`dimensions`).
5. Moderation: `endpoint` mode (OpenAI moderation API) or `llm_classifier` mode (classify with a chat model). Gemini default uses `llm_classifier` plus Gemini's built-in safety settings.
6. Fail closed: no default models, missing/invalid values throw `ProviderConfigError`; errors name variables, never values; base URLs only for `openai_compatible`, https only (http only for localhost), no embedded credentials.

## Consequences and limits (not "just change env")
- **Embedding switch = full reindex.** Vectors from different models are incompatible even at equal dimension (invariant 9). Changing `EMBEDDING_*` without reindexing must be refused at runtime by comparing with the stored `bot_profiles.embedding_model` (to be enforced in P3/P7).
- **No independent fallback by default.** A second Gemini model shares the same key/quota; the loader flags `sharesQuotaWithPrimary`. Real failover needs a second provider key (e.g. OpenAI or Anthropic).
- **LLM-classifier moderation** is weaker and slower than a dedicated moderation endpoint; recorded as residual risk, covered by the P11 evaluation set.
- **Data protection:** on Google's free tier, submitted content may be used to improve Google products. Client or visitor data must only go through a **paid-tier** Gemini project (ADR 0006). Owner to confirm billing is enabled before any client data is processed.
- Model IDs and prices change; re-check at P11 and before each client go-live.
- Adapters (actual API calls, streaming, retries) are implemented in P6/P7 behind this config; this ADR adds only the configuration contract.
