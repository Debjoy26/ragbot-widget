# Architecture — ragbot_widget

> Current checkpoint (2026-11-20): P7–P10 accepted; P11 not started. Local/hosted migration histories are recorded at 027; T25-d/T26 single-command gates remain open. The provider-admin design in §10 is proposed and does not alter the current per-client topology. See [status.md](status.md) and [LATEST-CHECKPOINT.md](docs/reports/LATEST-CHECKPOINT.md).

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

Vercel admin panel -> Supabase Auth / authorised direct reads / admin RPCs / Storage
                  -> no connection to Render: jobs queued in Postgres reach the worker
```
The API initiates a search RPC; pgvector executes the vector computation inside Supabase. Routing this request through Render does not move database storage or index computation onto Render.

## 2. Ownership and deployment
- One shared core codebase, configured and deployed separately for each client.
- Per client: two Vercel projects, one Render web service, one Render background worker, one Supabase project.
- Render holds backend credentials; Vercel frontend configuration contains only public values.
- No Supabase Edge Functions are required in this version.
- The admin panel talks only to Supabase. Its RPCs queue indexing and cleanup jobs, which the worker claims (ADR 0017).
- Keep widget and dashboard versioned independently while maintaining a compatible API contract.

## 3. Chat sequence
1. Widget reads `public_bot_config` directly from Supabase REST with the publishable key (anon may read only this relation); it then creates/reuses a short-lived visitor session through the Render API.
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
- Ingestion validates actual file size, type and content first, because no API checks the upload, then extracts text, rejects unsupported scans, batches embeddings, then activates versions atomically.
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

## 10. Managed administration extension (proposed)

The existing runtime remains per-client: one tenant Supabase project, API,
worker, widget deployment, and client-admin deployment. The new
[`ragbot-admin-panel`](https://github.com/Debjoy26/ragbot-admin-panel)
specifies a client experience plus a proposed provider experience. This
proposal does not replace or silently change the current deployment model.

### Client mode

- The client-admin browser authenticates to that client's Supabase Auth and
  uses active membership, `aal2`, RLS, reviewed RPCs, and Storage policies.
- Ordinary admin operations do not go through the visitor API.
- It receives no service-role or provider credentials.
- Any new tenant schema or browser-callable RPC is designed and migrated only
  in this repository's `supabase/migrations` history.

### Provider mode

```text
Provider-admin browser
  -> provider identity/MFA
  -> provider control API
  -> provider client/deployment registry and audit
  -> explicitly scoped tenant operation, if authorized
```

The provider API and registry are proposed separate control-plane components;
neither is currently part of this repository. Provider browser code must never
connect to arbitrary tenant projects with service-role keys. Provider access
to client conversations or document bodies requires a separately approved
purpose, permission, and audit policy. The exact delegation/proxy model remains
an open decision.

### Widget identifier and service state

The current embed contract (public bot slug plus configured public project/API
values) remains in force. A future dedicated widget key is public
identification only; it is not authentication. Bootstrap, key rotation,
revocation, and hostname policy need a reviewed contract. Subscription status
and provider suspension must be enforced by an authoritative backend check on
runtime operations; hiding the widget or disabling only its UI is insufficient.
Whether that state is stored in each tenant database or obtained through a
central control plane is undecided.

### Hosting change under consideration

The current deployment remains Render API/worker and the existing widget
hosting arrangement. The owner has also discussed Docker deployment on AWS.
That is a proposed hosting change, not an implemented migration: choose EC2
versus ECS/Fargate, per-client versus shared services, secrets/observability,
and static widget delivery (for example S3/CloudFront) in a separate approved
architecture decision. The browser widget remains a static JavaScript bundle;
Docker is for server processes, not the plugin itself.

### Reviewed knowledge-gap answers

The existing `knowledge_gaps` RPC is reporting, not a publish-answer workflow.
The proposed flow is admin-authored/approved content through the existing
validated tenant ingestion path, followed by worker indexing and atomic
activation. It becomes retrievable only when active. Automatically promoting
visitor or model text to trusted knowledge is prohibited. Markdown versus a
dedicated FAQ entity is undecided.
