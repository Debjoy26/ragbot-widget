# Handover — ragbot_widget

> For the engineer (or agent) picking up this project. Read this first, then `status.md` for current progress and `plan.md` for the build order.
> Last updated: 2026-11-03.

---

## 1. What this project is
An embeddable, client-branded, retrieval-augmented (RAG) chatbot that a client installs on their website with **one `<script>` tag**. It answers only from approved PDF/MD/TXT knowledge, cites sources, streams responses, and logs conversations for client admins.

This repo also owns the **shared backend** — Render API, Render worker, and the Supabase schema — used by both this widget and the separate `ragbot_adminpanel` repo. The admin panel is a second frontend, **not** a second backend.

## 2. Current state (honest summary)
- **Only planning documents exist.** There is no application code, no `package.json`, no migrations, and no commits yet.
- Documents in the repo root (all untracked in git as of this writing):

| File | What it is authoritative for |
|---|---|
| `PRD.md` | Scope, non-goals, requirements W-01…W-15, release gates, open decisions |
| `ARCHITECTURE.md` | Topology, chat/worker sequences, fallback, trust boundaries, moderation strategy |
| `DATABASE_SCHEMA.md` | Tables, RPCs, grants/RLS matrix, storage, retention — **the shared data contract** |
| `TECH_SPECS.md` | Stack, API routes, chat event contract, errors, file/job rules, test matrix |
| `UI_SCHEMA.md` | Embed contract, component tree, widget states, rendering/a11y rules |
| `README.md` | Target repo layout, required npm scripts, env vars, per-client deployment order |
| `plan.md` | Phased implementation plan (P0–P12) derived from the above |
| `status.md` | Live progress tracker |

## 3. Deployment model (per client)
```
Client website ──<script>──> Vercel (widget.js, immutable versioned)
                                   │
                                   ▼
                       Render API (Fastify, SSE) ──> external chat / embedding / moderation APIs
                                   │
                                   ├─> Supabase Postgres + pgvector (search RPC runs in DB)
                                   └─> jobs table ──> Render worker ──> private Storage + AI APIs

Vercel admin panel ──> Supabase Auth + RLS reads + signed uploads
                   └─> Render API for privileged lifecycle ops
```
Per client: **1 Supabase project, 1 Render web service, 1 Render worker, 2 Vercel projects** (widget + admin). One shared codebase, deployed separately per client. No Supabase Edge Functions.

## 4. Non-negotiable invariants
Break any of these and you've introduced a security or correctness bug:

1. **Browser is untrusted.** Never accept browser-supplied retrieved context, history, system prompt, roles, usage numbers, provider keys, or assistant messages.
2. **Publishable key + bot ID are public config, not auth.** Visitors authenticate with short-lived, server-signed tokens bound to `{bot, session, expiry}`.
3. **Service-role credentials bypass RLS.** Every privileged API route must do its own ownership + role checks.
4. **Admin auth = JWT signature + issuer + audience + expiry + active membership + MFA (for privileged ops).** "Authenticated" ≠ admin.
5. **anon can read only `public_bot_config`.** Nothing else.
6. **Rate limits and budgets are atomic in Postgres**, never process-local.
7. **Idempotency key cannot spend twice.** Completed duplicates return stored status; never regenerate.
8. **No provider switch after the first token is emitted.** Terminate as partial (`STREAM_INTERRUPTED`) and let the user retry.
9. **No silent embedding-model switch.** Query encoder must match the corpus; changing models = explicit reindex.
10. **Document replacement is atomic.** A failed reindex leaves the old version active.
11. **Citations only from retrieved chunk IDs.** Drop anything the model invents.
12. **Widget renders plain text via `textContent`** unless sanitised Markdown is explicitly enabled (no raw HTML, remote images, iframes, `javascript:` URLs).
13. **Fail closed** on missing limits/config.
14. **Secrets live only in Render env.** Never in bundles, git, prompts, or logs.
15. **Caches never outrank invariants.** Every cache key includes `bot_id` and the relevant version (`corpus_version`, `settings_version`, model, prompt template). Answer cache is opt-in, first-turn only, and re-checks that cited documents are still active. Input moderation, auth and rate limits run on every request, including cache hits. See `plan.md` P7.5.
16. **Single migration history** in `supabase/migrations` here; admin repo must not add competing migrations.

## 5. Decisions still open (block specific phases)
From `PRD.md §9` plus items surfaced while planning. Owner: product/FDE lead. Record each as an ADR in `docs/decisions/`.

| Decision | Blocks |
|---|---|
| Embedding provider/model + vector **dimension** | DB migration `002_vectors.sql`, worker, retrieval |
| Primary & fallback chat providers (independent quotas) | Chat fallback |
| Moderation provider + policy (buffer-all vs rolling) | Chat streaming |
| OCR in scope? which provider? | Ingestion |
| Retention periods, jurisdiction, provider DPA terms | Retention migration, cleanup jobs |
| File size/page limits, rate limits, daily budget caps | Sessions, ingestion |
| Markdown rendering on/off + sanitiser | Widget renderer |
| History endpoint in MVP? | `GET /v1/conversations/:id` |
| Token persistence (memory vs sessionStorage) | Widget session |
| Bot challenge on `/v1/sessions` | Session endpoint |
| Exact Node LTS + dependency versions | Scaffold |

## 6. Inconsistencies / gaps found in the docs
Resolve these in P0 before freezing shared contracts. **Resolved 2026-11-03:** items 1, 2 (embed attribute is now `data-bot-slug`), 3, 5, 6, 8, 9. **Still open:** 4 (feedback buttons), 7 (public-config fetch path wording in ARCHITECTURE §3), 10 (system-message exclusion in history query).

1. **`escalation_label` missing from DB.** `UI_SCHEMA §5` public config has `escalation_label`; `DATABASE_SCHEMA` `public_bot_config` does not. → Add column.
2. **`bot_id` vs `bot_slug` naming.** Embed uses `data-bot-id="website-support"` (a slug value), the chat request uses `bot_slug`, and public config returns a UUID `bot_id`. → Suggest renaming the embed attribute to `data-bot-slug` or documenting that `data-bot-id` carries the slug.
3. **`OCR_REQUIRED` error code** is used in `TECH_SPECS §7` but missing from the stable code list in `§5`. → Add to list.
4. **Feedback buttons without a backend.** `UI_SCHEMA §3` has `FeedbackButtons`; no table or endpoint exists. → Defer (hide) for v1.0 or add `message_feedback` + `POST /v1/feedback`.
5. **Stop → "upstream cancellation"** (`UI_SCHEMA §4`) has no explicit cancel endpoint. → Implement as server-side abort on client disconnect of the SSE request; document it.
6. **`request_runs.session_id`** vs `visitor_session_id` elsewhere. → Normalise to `visitor_session_id`.
7. **Public config fetch path.** `UI_SCHEMA` reads it via Supabase (publishable key); `ARCHITECTURE §3` step 1 is ambiguous. → Widget reads `public_bot_config` directly from Supabase REST; sessions go through the API.
8. **Route file mapping.** README lists `routes/{chat,sessions,documents,settings,entries,health}.ts` but no file for `conversations` (history + admin delete). → Add `routes/conversations.ts`.
9. **`analysing` UI state** is listed as a state but is background-only; treat it as non-visible metadata, not a state-machine node.
10. **`messages.role = system`** rows exist but must never be returned to visitors — enforce in the history query, not just docs.

## 7. Where to start
1. Read `PRD.md` then `DATABASE_SCHEMA.md` (the contract everyone depends on).
2. Get decisions in §5 answered — at minimum the embedding dimension and Node version.
3. Fix the doc inconsistencies in §6 directly in the source docs.
4. Execute `plan.md` P1 (scaffold) → P2 (shared contracts) → P3 (migrations + RLS tests).
5. Update `status.md` at the end of every working session.

## 8. Environment & access needed
- Supabase: dev project (or `supabase start` local stack) + per-client production project.
- Render: account for API web service + background worker (paid for production).
- Vercel: projects for widget and admin panel.
- Provider keys: chat (primary + fallback), embeddings, moderation, optional OCR — each with provider-side spending caps.
- Env vars (see `README.md`): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `LLM_PRIMARY_API_KEY`, `LLM_FALLBACK_API_KEY`, `EMBEDDING_API_KEY`, `VISITOR_TOKEN_SECRET`, `ALLOWED_ORIGINS`, `PORT`, `LOG_LEVEL`. Worker does **not** get `VISITOR_TOKEN_SECRET`.

## 9. Related repos
- `ragbot_adminpanel` — dashboard; consumes this repo's schema and admin API. Coordinate any schema/API change with it and bump the schema version.

## 10. Handover log
| Date | From | To | Notes |
|---|---|---|---|
| 2026-11-03 | Planning | Implementation | Docs baseline v1.0 reviewed; plan/status/handover created. No code yet. |
| 2026-11-03 | Planning | Implementation | Added caching (P7.5) and contact routing (W-16); synced all docs. |
