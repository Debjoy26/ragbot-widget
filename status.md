# Status — ragbot_widget

> Last updated: **2026-11-03**
> Overall: **🟡 P0 decisions approved — P1 awaiting owner go-ahead**
> Docs baseline: v1.0 (`PRD.md`). Plan: `plan.md`. Context: `handover.md`. Decisions: `docs/decisions/` (ADRs 0001–0013).

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked

---

## 1. Phase tracker

| # | Phase | State | Blocker / note |
|---|---|---|---|
| P0 | Decisions & prerequisites | ✅ | D1–D14 approved and phase accepted by owner 2026-11-03 (ADRs 0001–0013). Open items carried forward: §3a |
| P1 | Monorepo scaffold & tooling | ⬜ | Unblocked (D11, ADR 0001); awaits owner approval |
| P2 | Shared contracts | ⬜ | Waits on remaining doc fixes (§4); UI_SCHEMA edits pending |
| P3 | Database & storage migrations | ⬜ | D1 (ADR 0002) and D5 (ADR 0006) decided; `002_vectors.sql` unblocked. D1 validation check pending (§3a c); `005_retention.sql` jurisdiction per client open (§3a b) |
| P4 | API foundation | ⬜ | |
| P5 | Visitor sessions & abuse controls | ⬜ | Limits (ADR 0007) and Turnstile (ADR 0010) decided; production daily cap open, fails closed (§3a a) |
| P6 | Ingestion pipeline (worker) | ⬜ | OCR out of scope (ADR 0005); file limits set (ADR 0007) |
| P7 | Retrieval & chat | ⬜ | Providers decided (ADRs 0003, 0004); OpenAI fallback model ID pinned at P7; D1 validation pending (§3a c) |
| P7.5 | Caching & latency | ⬜ | D13 decided (ADR 0012); C7 answer cache off by default; schema additions go into P3 |
| P8 | Widget | ⬜ | Markdown off (ADR 0008), sessionStorage + history endpoint (ADR 0009), feedback deferred (ADR 0011); UI_SCHEMA §3/§7 edits pending |
| P9 | Analysis, entries, settings, retention | ⬜ | Retention periods set (ADR 0006); jurisdiction per client and DPAs open (§3a b) |
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
- [x] `CLAUDE.md` dev contract v0.1 + sub-agents in `.claude/agents/` (`sonnet-implementer`, `haiku-docs`, `reviewer`, `security-reviewer`). Committed to `main`. Model record: §9.
- [x] P0 decisions D1–D14 approved by owner 2026-11-03 as recommended; ADRs 0001–0013 written in `docs/decisions/` (**uncommitted**)

## 3. Open decisions (P0)

All 14 decisions were approved by the owner on 2026-11-03 as recommended. Each decision's ADR is the authoritative record.

| # | Decision | Blocks | Owner | State |
|---|---|---|---|---|
| D1 | Embedding provider/model + vector dimension | P3, P6, P7 | Owner (approved 2026-11-03) | ✅ ADR 0002 (open: validation check, §3a c) |
| D2 | Primary + fallback chat providers | P7 | Owner (approved 2026-11-03) | ✅ ADR 0003 (fallback model ID pinned at P7) |
| D3 | Moderation provider + streaming policy | P7 | Owner (approved 2026-11-03) | ✅ ADR 0004 |
| D4 | OCR scope/provider | P6 | Owner (approved 2026-11-03) | ✅ ADR 0005 |
| D5 | Retention, jurisdiction, provider DPA | P3 (005), P9 | Owner (approved 2026-11-03) | ✅ ADR 0006 (open: jurisdiction per client, DPAs, §3a b) |
| D6 | File limits, rate limits, budget caps | P5, P6 | Owner (approved 2026-11-03) | ✅ ADR 0007 (open: production daily cap, §3a a) |
| D7 | Markdown rendering + sanitiser | P8 | Owner (approved 2026-11-03) | ✅ ADR 0008 (off for v1) |
| D8 | History endpoint in MVP | P7, P8 | Owner (approved 2026-11-03) | ✅ ADR 0009 (enabled in MVP) |
| D9 | Visitor token persistence | P8 | Owner (approved 2026-11-03) | ✅ ADR 0009 (sessionStorage) |
| D10 | Bot challenge on `/v1/sessions` | P5 | Owner (approved 2026-11-03) | ✅ ADR 0010 (Turnstile; Cloudflare details unverified, §3a e) |
| D11 | Node LTS + dependency pins | P1 | Owner (approved 2026-11-03) | ✅ ADR 0001 (Node 24 LTS; Supabase CLI install pending, §3a d) |
| D12 | Feedback buttons: defer or add endpoint | P8 | Owner (approved 2026-11-03) | ✅ ADR 0011 (defer; UI_SCHEMA §3 edit pending) |
| D14 | Per-client contact channels, hours, localised escalation messages, repeated-miss threshold | P3, P7, P8 | Owner (approved 2026-11-03) | ✅ ADR 0013 (threshold 2; per-client details at P12) |
| D13 | Answer cache: enable per client? TTL? Which provider prompt caching? | P7.5 | Owner (approved 2026-11-03) | ✅ ADR 0012 (C7 off by default; TTL 24 h) |

### 3a. Open items after P0 (not done)
- **a)** Production daily budget cap per client: no value given. Fails closed until set (ADR 0007).
- **b)** Jurisdiction India/DPDP is an assumption. Owner to confirm per client. Provider DPAs outstanding (ADR 0006).
- **c)** D1 embedding validation check on real documents not run. Needs owner approval for real provider API calls (ADR 0002).
- **d)** Supabase CLI not installed locally. Install needs owner approval (ADR 0001).
- **e)** Non-Anthropic provider details (OpenAI, Voyage, Cloudflare) not verified in the P0 session (ADRs 0002, 0003, 0004, 0010).
- **f)** ~~Spec edits~~ done 2026-11-03: UI_SCHEMA §3/§7, ARCHITECTURE §3 (item 7), TECH_SPECS §2 (item 10).
- **g)** Nothing committed. ADRs 0001–0013 and this docs update are uncommitted.

## 4. Doc fixes pending (from `handover.md §6`)
- [x] Add `escalation_label` to `public_bot_config`
- [x] Resolve `data-bot-id` (slug) vs `bot_slug` vs UUID `bot_id` naming
- [x] Add `OCR_REQUIRED` to TECH_SPECS §5 error list
- [x] Decide on feedback buttons (D12): defer, ADR 0011
- [x] Remove `FeedbackButtons` from `UI_SCHEMA §3` (ADR 0011)
- [x] Change `UI_SCHEMA §7` token default from memory-only to sessionStorage (ADR 0009)
- [x] Document Stop → server abort on client disconnect
- [x] Rename `request_runs.session_id` → `visitor_session_id`
- [x] Clarify public-config fetch path (Supabase REST direct) — ARCHITECTURE §3
- [x] Add `routes/conversations.ts` to README layout
- [x] Mark `analysing` as background metadata, not a UI state
- [x] Enforce exclusion of `system` messages in history query spec — TECH_SPECS §2

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
1. Owner provides the production daily cap (§3a a) and confirms jurisdiction per client (§3a b) when available.
2. Owner decides whether to approve the D1 validation calls (§3a c) and the Supabase CLI install (§3a d).
3. Apply the remaining spec doc fixes (§4 unchecked items, §3a f).
4. P1 scaffold on owner go-ahead, using the ADR 0001 pins.

## 8. Change log
| Date | Change |
|---|---|
| 2026-11-03 | Created status tracker; project in planning, no code. |
| 2026-11-03 | Added W-16 contact routing across docs; resolved 7 doc inconsistencies; decision D14. |
| 2026-11-03 | Added P7.5 caching & latency phase and decision D13. |
| 2026-11-03 | P0 decisions D1–D14 approved by owner; ADRs 0001–0013 written in `docs/decisions/` (uncommitted). Status and handover updated (docs-only checkpoint, `haiku-docs`). No code, tests or Supabase changes. |

## 9. Agent model record
- `haiku-docs`: configured `model: claude-haiku-5-5` (`.claude/agents/haiku-docs.md`). First spawn: P0-DOC1, 2026-11-03. The orchestrator cannot observe the actual model resolution. The worker's self-report is **unverified**.
- `sonnet-implementer`, `reviewer`, `security-reviewer`: no spawn is recorded in the P0-DOC1 evidence packet.
