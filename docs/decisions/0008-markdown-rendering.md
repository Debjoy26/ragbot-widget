# ADR 0008 — Markdown rendering

- **Decision:** D7 · **Status:** Accepted · **Date:** 2026-11-03 · **Approved by:** owner (P0 session)
- **Blocks:** P8

## Decision
**Off for v1.** Widget renders answers via `textContent` with line breaks preserved; the prompt instructs plain-text output.

## Revisit
Later option: `markdown-it` (`html: false`) + DOMPurify, no remote images/iframes/`javascript:` URLs (invariant 12), behind a per-client flag.
