# UI Schema — ragbot_widget

## 1. Boundary
The widget is browser-delivered JavaScript, not a trusted execution environment. It uses an encapsulated custom element/Shadow DOM. Shadow DOM isolates styles, not secrets or malicious host scripts. A compromised host page can observe visitor activity.

## 2. Embed contract
```html
<script
  src="https://client-a-widget.example.com/v1.0.0/widget.js"
  data-bot-id="website-support"
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
          FeedbackButtons
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
| analysing | No blocking indicator required | Background only |
| limited | Retry-after or daily-limit message | Retry/reset |
| blocked | Policy message, safe escalation | New allowed request |
| unavailable | Service error and bounded retry | User retry |
```
Only one active generation per conversation in the first release. Prevent duplicate sends. Stop aborts the browser request and requests upstream cancellation; usage already incurred is still recorded.

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
  "escalation_url": "https://client.example.com/contact"
}
```
Validate colour/URL values; do not permit arbitrary HTML, script, CSS, or backend instructions in public configuration.

## 6. Rendering and accessibility
- Use `textContent` for plain text. Sanitise optional Markdown with a maintained library.
- Reject `javascript:` URLs and raw HTML; disable remote images and embedded frames.
- Citation links come from server-validated references, never free-form model text.
- Private-document citations show title/section/excerpt, not a public download URL.
- Keyboard navigation, visible focus, Escape to close, focus restoration, reduced motion, labelled buttons.
- Set message direction from language where appropriate; test long and right-to-left content if supported.
- On mobile, constrain to viewport height and preserve composer visibility with the on-screen keyboard.
- Do not aggressively announce every token to screen readers; batch updates.

## 7. Visitor session policy
Keep the short-lived session token in memory by default. Optional sessionStorage persistence requires an explicit policy. Never store provider credentials or admin tokens in widget state. Session reset should clear locally held context and start a new authorised conversation.

## 8. Failure behaviour
No raw stack traces or provider errors. Show stable user messages and an opaque request ID. Do not automatically resend after partial output. A retry after connection loss reconciles the idempotency key with server state before generating again.
