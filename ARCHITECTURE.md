# Architecture — ragbot_widget

## 1. Topology
```text
Client website -> Vercel widget -> Render API -> external embedding/chat APIs
                         |              |
                         |              +-> Supabase Postgres + pgvector
                         |              +-> durable jobs table
                         |                            |
                         +-> public config      Render worker
                                                     |
                                      private Storage + Postgres + AI APIs

Vercel admin panel -> Supabase Auth / authorised direct reads / signed upload
                  -> Render API for privileged lifecycle operations
```
The API initiates a search RPC; pgvector executes the vector computation inside Supabase. Routing this request through Render does not move database storage or index computation onto Render.

## 2. Ownership and deployment
- One shared core codebase, configured and deployed separately for each client.
- Per client: two Vercel projects, one Render web service, one Render background worker, one Supabase project.
- Render holds backend credentials; Vercel frontend configuration contains only public values.
- No Supabase Edge Functions are required in this version.
- Keep widget and dashboard versioned independently while maintaining a compatible API contract.

## 3. Chat sequence
1. Read minimal public configuration; create/reuse a short-lived visitor session through API.
2. Submit question plus idempotency key with visitor token.
3. API verifies token, bot scope, payload limits, and allowed state; applies atomic rate/budget checks.
4. Moderate input; obtain embedding using the configured query embedding model.
5. Call bounded vector search; consider language, active version, disclosure, and calibrated relevance thresholds.
6. Build prompt from private identity settings, bounded server-owned history, and delimited evidence.
7. Call configured chat provider; stream approved output under the moderation policy.
8. Validate citation references, persist messages/attempt usage, settle reservations, enqueue analysis.
9. Return done event. Record partial/failed output accurately on interruption.

## 4. Worker sequence
- Durable queue in Postgres with leased claims; at-least-once delivery, not an exactly-once claim.
- Idempotent steps and unique chunk/job constraints prevent duplicate effects.
- Ingestion validates files, extracts text, rejects unsupported scans, batches embeddings, then activates versions atomically.
- Worker recovers expired leases after restart and dead-letters exhausted jobs.
- Summaries/sentiment/intent run after turn completion using debounced dedupe keys.
- Cleanup jobs enforce deletion/retention and remove abandoned uploads.
- Backoff with jitter and bounded retry counts; transient and permanent errors are distinguished.

## 5. Fallback and streaming
Different keys in the same provider/project may share quotas; key rotation is not guaranteed failover. Configure independent quota/provider availability when needed. Never use keys to evade provider restrictions.
Retry eligible timeouts, rate limits, or transient failures with a bounded total deadline. Invalid keys, permission failures, or billing issues require alerting and explicit policy. Do not switch providers silently after tokens are emitted: terminate as partial and offer explicit retry. Provider fallback never changes embedding models implicitly.

## 6. Trust boundaries
The host page, visitor messages, documents, retrieved text, and model outputs are untrusted. Prompt instructions are defence-in-depth, not an authorization boundary. Only retrieval-eligible approved knowledge reaches public responses. No tools/connectors execute in v1. Server validation controls writes, source references, and data disclosure.

## 7. Moderation strategy
Immediate token streaming and strict whole-answer moderation cannot both be guaranteed. Select per-client policy: fully buffer before release for stricter screening, or moderate rolling text batches with residual-risk disclosure. Avoid sending unreviewed tokens when full pre-release moderation is promised. Sentiment/intent labels remain internal metadata.

## 8. Operations
Use request/job IDs; metrics for latency, usage, queue age, errors, rate denials, fallback frequency, and indexing failures. Redact credentials, tokens, document bodies, and sensitive chat content from infrastructure logs. Keep API/worker close to database region. Maintain provider-side spending controls in addition to estimates.

## 9. Availability and limits
Paid API and worker services are the production baseline. Free Render web services are only for demos; sleeping/cold starts remain even if data storage is offloaded. Render does not eliminate finite memory, CPU, bandwidth, database quotas, or provider rate limits. Large/OCR workloads may require a larger or specialised worker.
