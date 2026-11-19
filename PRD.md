# Product Requirements Document — ragbot_widget

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](docs/reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

## 1. Status and purpose
- Version: 1.0 planning baseline.
- This document specifies intended behaviour; it is not evidence of an implemented system.
- Product: an embeddable, client-branded, retrieval-augmented website chatbot.
- Deployment model: one Supabase project, Render API, and Render worker per client; a Vercel deployment serves the widget.
- The companion `ragbot_adminpanel` manages the same backend. It is not a second backend, and it talks only to Supabase (ADR 0017).
- FDE means the deployment engineering team responsible for client configuration, migrations, branding, and operations.

## 2. Goals
1. Install through one script tag on an existing HTML/CSS/JavaScript website.
2. Answer from approved PDF, Markdown, and TXT knowledge with verified source references.
3. Give each client a configured identity, tone, scope, supported languages, and escalation message.
4. When the knowledge base cannot answer, route the visitor to the client's configured human contact details instead of leaving them at a dead end.
5. Store conversations and usage securely for authorised client administrators.
6. Support moderation, multilingual retrieval, sentiment, intent, and conversation summaries.
7. Support tested primary/fallback chat providers without exposing credentials.
8. Bound public-endpoint abuse and spending.

## 3. Non-goals
- Agentic tools, arbitrary connectors, autonomous actions, refunds, orders, or bookings.
- Live human-agent chat takeover, ticket creation, or callback scheduling. v1 routing means **showing** the client's configured contact details; it does not transfer the conversation or contact anyone on the visitor's behalf.
- Email, SMS, social media, or voice adapters.
- End-user BYOK, provider-key management in the dashboard, or model training.
- Autonomous extraction of arbitrary personal data from chat.
- Universal PDF/OCR support. Scanned documents require an explicitly configured OCR pipeline.
- A hosted model inside Render: the default uses external chat and embedding APIs.

## 4. Users and journeys
### Visitor
Load website → open widget → see AI/privacy notice → ask question → receive streamed answer and sources → ask follow-up → end conversation.

Unanswerable path: ask question the knowledge base cannot answer → receive a short, honest "I don't have that information" reply in the conversation language → see a contact card with the client's configured contact details (for example email, phone, hours, contact page) → tap to email, call, or open the contact page.
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
| W-05 | Missing knowledge | No suitable evidence produces a scoped "not available" reply plus contact routing (W-16) rather than an invented answer. |
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
| W-16 | Contact routing | Missing knowledge, out-of-scope questions, explicit requests for a human, blocked input, and service unavailability all show a contact card built from server configuration. The model never writes contact details itself. |

### 5.1 Contact routing (W-16) details
- **Triggers** (each is recorded as a `handoff_reason`):
  - `no_knowledge`: retrieval found nothing above the calibrated threshold.
  - `out_of_scope`: the question falls outside the configured business scope.
  - `human_requested`: the visitor asks for a person, agent, or contact.
  - `blocked`: input moderation blocked the message.
  - `unavailable`: providers failed after retries and fallback.
  - `repeated_no_knowledge`: the same conversation hit `no_knowledge` N times, where N is configurable (default 2). The contact card is pinned more prominently.
- **Contact details are client configuration**, set in the admin panel and stored in public config, because they are meant for visitors anyway. They include:
  - display label and short escalation message (localised per supported language)
  - email
  - phone in E.164 format
  - WhatsApp link (optional)
  - contact-page URL
  - business hours and time zone
- **Validation:** email format, E.164 phone, `https:` URLs only, plain text with no HTML. At least one contact channel is required before go-live; missing contact configuration fails the release gate.
- **Trust:** contact details reach the widget as a structured server event and are rendered by the widget from configuration. Model-generated phone numbers, emails, or URLs are never turned into links.
- **Tone:** the reply admits the gap plainly, does not guess, and does not pretend a human has been notified.
- **Analytics:** handoff reason and the unanswered question are recorded so admins can see knowledge gaps and add missing content. These records follow the conversation retention policy.
- **Availability:** the contact card also shows when the API is unreachable, using the last known public config or bundled branding.

## 6. Knowledge lifecycle
1. Dashboard registers the document through a database function, which validates the request.
2. Browser uploads directly to an authorised staging path in private Storage.
3. Dashboard completes the upload through a database function, which confirms the object exists and queues the indexing job.
4. Worker validates actual size, type and content, extracts text, chunks, embeds in batches, and persists inactive chunks.
5. A transaction activates a complete new version. The previous version remains active on failure.
6. A delete request immediately removes retrieval eligibility, then queues idempotent cleanup.

## 7. Security and privacy requirements
- The publishable key and bot ID are public configuration, not visitor authentication.
- Visitor sessions use short-lived server-issued signed tokens; IDs alone do not authorise history access.
- A public chatbot receives only material approved for anonymous disclosure. RAG is not a confidentiality boundary.
- Admin access is enforced in Postgres and Storage policies: a valid session, active membership and `aal2` on every private read and admin action (ADR 0015, ADR 0017).
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

## 9. Decisions before implementation
These are settled in `docs/decisions/` unless marked open. ADR 0014 revises the provider choices.
- Supported initial chat/embedding providers and embedding dimensions.
- OCR provider, if scanned PDFs are in scope.
- Prompt/output moderation policy and latency trade-off.
- Retention period, disclosure rules, provider data processing terms, and client jurisdiction.
- Hosting resources and per-client commercial limits (open: no ADR yet).
- Feedback buttons (deferred, ADR 0011) and the answer cache (off by default, ADR 0012).
- Per-client contact channels, business hours, localised escalation messages, and the repeated-miss threshold for contact routing.
