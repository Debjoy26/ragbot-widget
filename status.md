# Status — ragbot_widget

> Last updated: **2026-11-03**
> Overall: **🟡 Planning complete — implementation not started**
> Docs baseline: v1.0 (`PRD.md`). Plan: `plan.md`. Context: `handover.md`.

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked

---

## 1. Phase tracker

| # | Phase | State | Blocker / note |
|---|---|---|---|
| P0 | Decisions & prerequisites | 🟡 | Open decisions listed in §3; doc inconsistencies in `handover.md §6` |
| P1 | Monorepo scaffold & tooling | ⬜ | Needs pinned Node LTS version (P0) |
| P2 | Shared contracts | ⬜ | Waits on doc-inconsistency fixes |
| P3 | Database & storage migrations | ⛔ | `002_vectors.sql` blocked on embedding dimension |
| P4 | API foundation | ⬜ | |
| P5 | Visitor sessions & abuse controls | ⬜ | Needs rate/budget limits (P0) |
| P6 | Ingestion pipeline (worker) | ⬜ | Needs OCR decision + file limits (P0) |
| P7 | Retrieval & chat | ⬜ | Needs chat/fallback/moderation providers (P0) |
| P7.5 | Caching & latency | ⬜ | Needs D13 (answer-cache policy); schema additions go into P3 |
| P8 | Widget | ⬜ | Needs Markdown + token-persistence decisions (P0) |
| P9 | Analysis, entries, settings, retention | ⬜ | Needs retention policy (P0) |
| P10 | Observability & ops | ⬜ | |
| P11 | Evaluation, security, load | ⬜ | |
| P12 | First client deployment | ⬜ | |

## 2. Done so far
- [x] Planning docs written: `PRD.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `TECH_SPECS.md`, `UI_SCHEMA.md`, `README.md`
- [x] Docs reviewed end-to-end; 10 inconsistencies/gaps logged (`handover.md §6`)
- [x] `plan.md`, `handover.md`, `status.md` created
- [x] Caching & latency phase (P7.5) added to plan and TECH_SPECS
- [x] Contact routing (W-16) added to PRD, plan, DATABASE_SCHEMA, UI_SCHEMA, TECH_SPECS
- [x] Planning docs committed and pushed to `main`
- [x] Supabase MCP connected to dev project `rbejeqwxyxtklehuzibv` (verified 2026-11-03: empty `public` schema, no migrations)
- [x] `CLAUDE.md` dev contract v0.1 + sub-agents in `.claude/agents/` (`sonnet-implementer`, `haiku-docs`, `reviewer`, `security-reviewer`). None spawned yet, so model resolution is unverified. Committed to `main`.

## 3. Open decisions (P0)

| # | Decision | Blocks | Owner | State |
|---|---|---|---|---|
| D1 | Embedding provider/model + vector dimension | P3, P6, P7 | TBD | ⬜ |
| D2 | Primary + fallback chat providers | P7 | TBD | ⬜ |
| D3 | Moderation provider + streaming policy | P7 | TBD | ⬜ |
| D4 | OCR scope/provider | P6 | TBD | ⬜ |
| D5 | Retention, jurisdiction, provider DPA | P3 (005), P9 | TBD | ⬜ |
| D6 | File limits, rate limits, budget caps | P5, P6 | TBD | ⬜ |
| D7 | Markdown rendering + sanitiser | P8 | TBD | ⬜ |
| D8 | History endpoint in MVP | P7, P8 | TBD | ⬜ |
| D9 | Visitor token persistence | P8 | TBD | ⬜ |
| D10 | Bot challenge on `/v1/sessions` | P5 | TBD | ⬜ |
| D11 | Node LTS + dependency pins | P1 | TBD | ⬜ |
| D12 | Feedback buttons: defer or add endpoint | P8 | TBD | ⬜ |
| D14 | Per-client contact channels, hours, localised escalation messages, repeated-miss threshold | P3, P7, P8 | TBD | ⬜ |
| D13 | Answer cache: enable per client? TTL? Which provider prompt caching? | P7.5 | TBD | ⬜ |

## 4. Doc fixes pending (from `handover.md §6`)
- [x] Add `escalation_label` to `public_bot_config`
- [x] Resolve `data-bot-id` (slug) vs `bot_slug` vs UUID `bot_id` naming
- [x] Add `OCR_REQUIRED` to TECH_SPECS §5 error list
- [ ] Decide on feedback buttons (D12)
- [x] Document Stop → server abort on client disconnect
- [x] Rename `request_runs.session_id` → `visitor_session_id`
- [ ] Clarify public-config fetch path (Supabase REST direct)
- [x] Add `routes/conversations.ts` to README layout
- [x] Mark `analysing` as background metadata, not a UI state
- [ ] Enforce exclusion of `system` messages in history query spec

## 5. Requirements coverage

| Req | Description | Implemented | Tested |
|---|---|---|---|
| W-01 | One-script installation | ⬜ | ⬜ |
| W-02 | Encapsulated UI | ⬜ | ⬜ |
| W-03 | Streaming chat | ⬜ | ⬜ |
| W-04 | Grounded retrieval | ⬜ | ⬜ |
| W-05 | Missing knowledge refusal | ⬜ | ⬜ |
| W-06 | Identity | ⬜ | ⬜ |
| W-07 | Citations | ⬜ | ⬜ |
| W-08 | Fallback | ⬜ | ⬜ |
| W-09 | Moderation | ⬜ | ⬜ |
| W-10 | Async analysis | ⬜ | ⬜ |
| W-11 | Conversation log integrity | ⬜ | ⬜ |
| W-12 | Limits | ⬜ | ⬜ |
| W-13 | Data entries | ⬜ | ⬜ |
| W-14 | Safe presentation | ⬜ | ⬜ |
| W-15 | Indexing | ⬜ | ⬜ |
| W-16 | Contact routing | ⬜ | ⬜ |

## 6. Release gates (PRD §8)

| Gate | State | Recorded result |
|---|---|---|
| Evaluation sets (languages, unanswerable, fallback, injection) | ⬜ | — |
| p95 first meaningful event ≤ 5 s (target) | ⬜ | — |
| p95 ordinary response ≤ 20 s (target) | ⬜ | — |
| Limits/retention/caps configured (fail closed) | ⬜ | — |
| Rollback rehearsed (widget + API) | ⬜ | — |
| Backup/restore rehearsed incl. Storage | ⬜ | — |
| Security test matrix executed | ⬜ | — |

## 7. Next actions
1. Hold P0 decision session; fill owners for D1–D12.
2. Apply the remaining doc fixes in §4.
3. Start P1 scaffold once D11 is decided.

## 8. Change log
| Date | Change |
|---|---|
| 2026-11-03 | Created status tracker; project in planning, no code. |
| 2026-11-03 | Added W-16 contact routing across docs; resolved 7 doc inconsistencies; decision D14. |
| 2026-11-03 | Added P7.5 caching & latency phase and decision D13. |
