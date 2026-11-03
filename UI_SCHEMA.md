# UI Schema — ragbot_widget

## 1. Boundary
The widget is browser-delivered JavaScript, not a trusted execution environment. It uses an encapsulated custom element/Shadow DOM. Shadow DOM isolates styles, not secrets or malicious host scripts. A compromised host page can observe visitor activity.

## 2. Embed contract
```html
<script
  src="https://client-a-widget.example.com/v1.0.0/widget.js"
  data-bot-slug="website-support"
  data-api-url="https://client-a-api.example.com"
  data-supabase-url="https://PROJECT_REF.supabase.co"
  data-supabase-publishable-key="sb_publishable_REPLACE_ME"
  defer
></script>
```
- Domains are placeholders, not deployed services.
- `data-api-url` is the API base; requests use `/v1/...` routes.
- Public Supabase access is limited to the dedicated public configuration relation.
- Fixed branding may also be bundled for first paint; server safety settings always take precedence.
- `data-bot-slug` carries the bot slug (sent as `bot_slug` to the API); the server returns the UUID `bot_id` in public config.
- Duplicate initialisation must reuse an existing instance rather than attach multiple launchers.

## 3. Component hierarchy
```text
<ragbot-widget>
  ShadowRoot
    LauncherButton
      UnreadIndicator
    ChatPanel
      Header [avatar, bot name, AI label, close]
      Notice [privacy link, data-use summary]
      Transcript [role=log, accessible incremental announcements]
        Greeting
        SuggestedQuestions
        UserMessage
        AssistantMessage
          AnswerBody
          SourceList
          (FeedbackButtons deferred for v1 — ADR 0011; no feedback endpoint/table)
        ContactCard [escalation message, email/phone/WhatsApp/contact-page links, business hours, open-now hint]
        StatusNotice
      OptionalApprovedForm
      Composer [textarea, send/stop]
      Footer [AI disclosure, escalation link]
```

## 4. States and transitions
| State | UI | Exit |
|---|---|---|
| booting | Minimal launcher | Config loads or fallback branding |
| closed | Launcher | Open |
| ready | Greeting/transcript and composer | Send |
| connecting | Request indicator | Stream/error/timeout |
| streaming | Incremental assistant text and Stop | Done/abort/error |
| limited | Retry-after or daily-limit message | Retry/reset |
| blocked | Policy message plus ContactCard | New allowed request |
| unavailable | Service error, bounded retry, plus ContactCard from cached/bundled config | User retry |
```
Conversation analysis is background metadata, not a visible state.
A `handoff` event does not change state: the ContactCard is appended to the transcript and the widget returns to `ready`. When `prominent` is true, the card is also pinned above the composer until dismissed.
Only one active generation per conversation in the first release. Prevent duplicate sends. Stop aborts the browser request; the API treats the client disconnect as a cancellation and aborts the upstream provider call. Usage already incurred is still recorded.

## 5. Public configuration shape
```json
{
  "bot_id": "UUID_FROM_SERVER",
  "bot_slug": "website-support",
  "display_name": "Acme Assistant",
  "greeting": "Ask about our products and services.",
  "suggested_questions": ["What services do you offer?"],
  "primary_color": "#3155D9",
  "position": "bottom-right",
  "privacy_url": "https://client.example.com/privacy",
  "supported_languages": ["en", "hi"],
  "escalation_label": "Contact support",
  "escalation_messages": {
    "en": "I don't have that information. Our team can help:",
    "hi": "मेरे पास यह जानकारी नहीं है। हमारी टीम आपकी मदद कर सकती है:"
  },
  "contact_email": "support@client.example.com",
  "contact_phone": "+911234567890",
  "contact_whatsapp_url": "https://wa.me/911234567890",
  "contact_page_url": "https://client.example.com/contact",
  "business_hours": { "mon-fri": "09:00-18:00", "sat": "10:00-14:00" },
  "timezone": "Asia/Kolkata"
}
```
Validate colour/URL values; do not permit arbitrary HTML, script, CSS, or backend instructions in public configuration.
Contact fields: email format, E.164 phone, `https:` URLs only, plain-text messages. Omitted channels are hidden; at least one channel is required. Public config may be cached in `localStorage` (stale-while-revalidate with ETag) so the launcher, greeting and ContactCard work instantly and when the API is down.

## 6. Rendering and accessibility
- Use `textContent` for plain text. Sanitise optional Markdown with a maintained library.
- Reject `javascript:` URLs and raw HTML; disable remote images and embedded frames.
- Citation links come from server-validated references, never free-form model text.
- Private-document citations show title/section/excerpt, not a public download URL.
- Keyboard navigation, visible focus, Escape to close, focus restoration, reduced motion, labelled buttons.
- Set message direction from language where appropriate; test long and right-to-left content if supported.
- On mobile, constrain to viewport height and preserve composer visibility with the on-screen keyboard.
- Do not aggressively announce every token to screen readers; batch updates.

## 6.1 Contact card rules
- Built only from public config plus the `handoff` event; never from model text.
- Links: `mailto:` from `contact_email`, `tel:` from `contact_phone`, `https:` for WhatsApp and contact page. Each is a labelled button with a visible focus state.
- Show business hours in the configured time zone with an "open now / closed" hint; never claim a human has been notified.
- Phone numbers, emails or URLs that appear in model text are shown as plain text, not links.
- Announced once to screen readers when it appears.

## 7. Visitor session policy
Keep the short-lived session token (~30 min, bound to bot/session/expiry) in tab-scoped `sessionStorage` so the conversation survives page navigation on multi-page host sites (ADR 0009). Restore the transcript through `GET /v1/conversations/:id` (same session only; `system` messages never returned). Never use `localStorage` for the token. Never store provider credentials or admin tokens in widget state. Session reset should clear locally held context and start a new authorised conversation.

## 8. Failure behaviour
No raw stack traces or provider errors. Show stable user messages and an opaque request ID. Do not automatically resend after partial output. A retry after connection loss reconciles the idempotency key with server state before generating again.
