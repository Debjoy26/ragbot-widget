# ADR 0002 — Embedding model and vector dimension

- **Decision:** D1 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P3 (`002_vectors.sql`), P6, P7

## Decision
- OpenAI `text-embedding-3-small`, **1536 dimensions**, cosine distance.
- Persist model, dimension and metric per document version (TECH_SPECS §6).

## Rationale
Low cost, multilingual, widely used. ≤2000 dims keeps a standard pgvector HNSW index on `vector` (no `halfvec` needed).

## Open / conditions
- **Not yet validated.** A short retrieval check on real client documents (incl. Indian-language content) is recommended before `002_vectors.sql` is frozen; it requires real provider API calls and needs separate owner approval. Fallback candidate if quality is poor: a Voyage multilingual model (would require a revised ADR).
- Pricing and model availability were not verified in this session.
- Changing the model later = explicit full reindex (invariant 9).
