# P11-D01 multi-ID citation markers — 2026-11-24 (fixed, unit-green)

## Defect (confirmed, from P11-T03 live runs)
- The live model intermittently emits comma-separated multi-ID markers
  (`[[id1, id2]]`, observed K7: `[[dc2145cf-…, 71b7bf54-…]]`). Both the citation
  extractor (`extractCitedChunkIds`) and the visitor-text stripper
  (`stripCitationMarkers`) only recognised single `[[id]]` markers, so a
  multi-marker was never parsed AND never stripped: sources `[]`, raw `[[…]]`
  leaked into visitor-visible text.

## Fix (test-first, red→green, no spec change)
- `shared/src/prompts.ts` `extractCitedChunkIds`: one combined pattern also
  matching `[[id(, id)*]]`; each token validated against the evidence set,
  first-appearance order. Singles behave byte-identically; `[[not a marker]]`
  still ignored (no comma, non-ID words).
- `shared/src/server/citations.ts` `MARKER`: same multi shape (comma required,
  so `[[not a marker]]` stays text). Streaming `SafeTextStream` needed no
  change: `safeCut` already holds comma tails (`isTailChar` covers `,`).
- `tests/integration/helpers/chat-fixtures.ts`: boot failure now includes the
  captured API output (diagnosed the `CHAT_PRIMARY_BASE_URL` merge bug in the
  eval harness; no assertion touched).

## Verification (this task)
- RED: 2 new tests failed, 171 passed (nothing else red).
- GREEN: `prompts.test.ts` + `chat-citations.test.ts` 173/173; related chat
  files (`chat-request`, `chat-citations-d2`, `chat-llm`, `chat-output`,
  `chat-sse`) 311/311 total across 7 files.
- `prettier --check` clean (after --write), `eslint` 0 warnings,
  `tsc -p tests --noEmit` exit 0. Real-provider behaviour re-proven in T3 rerun
  cycle, not re-spent here.

## Residual (NOT fixed — owner/product decision required)
- F2a: when the model cites ONLY invented IDs, the turn still completes with
  `"sources":[]`. Parser hardening recovers the mixed case; the invented-only
  case needs a product call: downgrade to partial/handoff, stronger prompt, or
  accept-and-log. No turn-semantics change was made here.
- F1: repo defaults still name retired `gemini-2.5-flash-lite` (ADR 0014,
  `.env.example` files). Eval runs 3.5-flash-lite. Awaiting owner revision call.
