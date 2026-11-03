# Product Requirements Document — ragbot_widget

## 1. Status and purpose
- Version: 1.0 planning baseline.
- This document specifies intended behaviour; it is not evidence of an implemented system.
- Product: an embeddable, client-branded, retrieval-augmented website chatbot.
- Deployment model: one Supabase project, Render API, and Render worker per client; a Vercel deployment serves the widget.
- The companion `ragbot_adminpanel` manages the same backend. It is not a second backend.
- FDE means the deployment engineering team responsible for client configuration, migrations, branding, and operations.

## 2. Goals
1. Install through one script tag on an existing HTML/CSS/JavaScript website.
2. Answer from approved PDF, Markdown, and TXT knowledge with verified source references.
3. Give each client a configured identity, tone, scope, supported languages, and escalation message.
4. Store conversations and usage securely for authorised client administrators.
5. Support moderation, multilingual retrieval, sentiment, intent, and conversation summaries.
6. Support tested primary/fallback chat providers without exposing credentials.
7. Bound public-endpoint abuse and spending.

## 3. Non-goals
- Agentic tools, arbitrary connectors, autonomous actions, refunds, orders, or bookings.
- Email, SMS, social media, or voice adapters.
- End-user BYOK, provider-key management in the dashboard, or model training.
- Autonomous extraction of arbitrary personal data from chat.
- Universal PDF/OCR support. Scanned documents require an explicitly configured OCR pipeline.
- A hosted model inside Render: the default uses external chat and embedding APIs.

## 4. Users and journeys
### Visitor
Load website → open widget → see AI/privacy notice → ask question → receive streamed answer and sources → ask follow-up → end conversation.
### Client administrator
Use the separate dashboard to update knowledge, review permitted records, and configure allowed bot settings.
### FDE/operator
Provision isolated services, install branding, configure secrets and limits, run evaluations, deploy releases, and handle incidents.

## 5. Functional requirements
| ID | Requirement | Acceptance condition |
|---|---|---|
| W-01 | One-script installation | Works on the agreed test websites without editing their application code. |
| W-02 | Encapsulated UI | Host CSS does not break the widget; widget styles do not modify host elements. |
| W-03 | Streaming chat | Ordered events render incremental text; aborted and interrupted requests have explicit states. |
| W-04 | Grounded retrieval | Only active, eligible document versions are searched using the configured embedding model. |
| W-05 | Missing knowledge | No suitable evidence produces a scoped refusal/escalation rather than an invented answer. |
| W-06 | Identity | Configured name, greeting, language policy, and business scope apply to every answer. |
| W-07 | Citations | Source IDs resolve to retrieved records; private bucket URLs and arbitrary model URLs are not exposed. |
| W-08 | Fallback | Eligible transient failures trigger bounded retries/fallback before public output begins. |
| W-09 | Moderation | Blocked input never reaches answer generation; output obeys the configured buffering policy. |
| W-10 | Analysis | Summaries, sentiment, and intent are computed asynchronously and never delay answer startup. |
| W-11 | Conversation logs | Only the API/worker writes trusted messages and analysis; browsers cannot forge assistant rows. |
| W-12 | Limits | Input, context, output, concurrent requests, per-session/IP rates, and daily budgets are bounded. |
| W-13 | Data entries | Only approved, explicitly submitted forms create validated entries; no unrestricted LLM writes. |
| W-14 | Safe presentation | Plain text by default; optional Markdown is sanitised, with remote images and raw HTML disabled. |
| W-15 | Indexing | Durable jobs are retried, version activation is atomic, and failed replacements preserve old knowledge. |

## 6. Knowledge lifecycle
1. Dashboard requests a document registration after backend validation.
2. Browser uploads directly to an authorised staging path in private Storage.
3. Dashboard completes the upload; API verifies the object and enqueues extraction.
4. Worker validates actual content, extracts text, chunks, embeds in batches, and persists inactive chunks.
5. A transaction activates a complete new version. The previous version remains active on failure.
6. A delete request immediately removes retrieval eligibility, then queues idempotent cleanup.

## 7. Security and privacy requirements
- The publishable key and bot ID are public configuration, not visitor authentication.
- Visitor sessions use short-lived server-issued signed tokens; IDs alone do not authorise history access.
- A public chatbot receives only material approved for anonymous disclosure. RAG is not a confidentiality boundary.
- Admin JWT verification includes issuer, audience, signature, expiry, and active membership.
- Service credentials bypass RLS: privileged API routes enforce ownership and role checks themselves.
- Rate counters and budget reservations are atomic and shared; process-local counters are insufficient.
- Secrets are in Render environment configuration, never browser bundles, source control, prompts, or logs.
- Do not trust browser-provided context, usage numbers, roles, or claimed message authorship.
- Retention, deletion, provider processing, and source disclosure are agreed before production use.
- Origin/CORS checks are supplementary, not authentication.

## 8. Reliability and release gates
- Agreed evaluation sets cover supported languages, unanswerable questions, fallback models, and injection attempts.
- Suggested initial targets, subject to load tests: first meaningful answer event p95 ≤ 5 seconds, ordinary non-fallback responses p95 ≤ 20 seconds.
- No target is a provider or hosting guarantee; record actual results before launch.
- Approved maximum file size/pages, OCR availability, rate limits, retention, and spending caps must be configured; missing values fail closed.
- Rollback must restore a prior widget release and compatible API; database changes use forward-safe migrations.

## 9. Open decisions before implementation
- Supported initial chat/embedding providers and embedding dimensions.
- OCR provider, if scanned PDFs are in scope.
- Prompt/output moderation policy and latency trade-off.
- Retention period, disclosure rules, provider data processing terms, and client jurisdiction.
- Hosting resources and per-client commercial limits.
