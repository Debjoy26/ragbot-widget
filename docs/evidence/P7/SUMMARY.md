# Phase P7: Retrieval and chat (`POST /v1/chat`), 2026-11-10 to 2026-11-11

Owner-approved. Branch `phase/p7`, not on `main` and not pushed until the owner approves. Base `main` @ `890e535`.
Environment: Node 24.22.2, Supabase CLI 3.0.0, local stack at migration 013.

- **Workers:** `sonnet-implementer`, self-reported: P7-DB, P7-AI, P7-API, P7-E2E, P7-D1-A, P7-D1-B and P7-D2. Several runs stopped on usage limits and were resumed from their saved work.
- **Reviews:** P7-R1, R3 and R4 (`security-reviewer`) and P7-R2 (`reviewer`). All static and self-reported.
- **Opus:**
  - **Groundwork and contracts:** the wave 0 adapter move, the `rag-v2` prompt headers, the test plan, the board and the frozen interfaces.
  - **Merging and checking:** merged every round, reproduced the review findings it could, and ran every gate below.
  - **Own fixes:**
    - the 013 change that marks a blocked question;
    - removing the `stream_options` resend;
    - the `host.tld/path` rule;
    - the three P7-R4 fixes.
- **No dependency added.**
- **No real provider was called.** Every chat, moderation and embedding call in tests is a labelled fake.
- **Hosted project:** migration 013 is not on the hosted dev project (still at 012).

## Gates on the final tree
Run by Opus at 09:23 on `ea67013` plus the working tree, which became `4b65a6d`. Exit codes are in `final/suite-exit.txt`.

| Check | Exit | Result |
|---|---|---|
| `npm run build`, `lint`, `format:check`, `typecheck` | 0 | Passed |
| `make db-local`, `make db-test` | 0 | 26 files, 3348 passed |
| `make db-lint` | 0 | No schema errors |
| `make db-race` | 0 | 51 orderings, 0 problems |
| `npm test` | 0 | 69 files, 3133 passed |
| `npm run test:integration` | 0 | 14 files, 766 passed, including 82 chat end-to-end tests against the built API |
| `node scripts/api-smoke.mjs` | 0 | 35 passed |
| `node scripts/worker-dist-check.mjs` | 0 | Passed |
| `make test-make` | 0 | 116 passed |
| Secret scan with self-test | 0 | No hits |
| Local advisors | 0 | No issues |

The end-to-end file passed 81 of 81 twice after P7-D1. It had failed 14 of 81 on wave 1 (`e2e-before-d1.txt`). Case A5c was added in P7-D2.

## Delivered
- **Migration 013 (local only):**
  - The functions `get_chat_context`, `start_chat_turn`, `finish_chat_turn`, `record_request_usage` and `get_conversation_history`.
  - `page_number` and `section` snapshots in `message_sources`.
  - A blocked question is marked `blocked`.
  - `schema_version()` is 13.
  - Tested by pgTAP 260 and four race orderings.
- **`@ragbot/shared/ai`:**
  - Streaming chat adapters for Gemini, OpenAI, openai_compatible and Anthropic, with error kinds, `billed`, abort, timeout, byte caps and `truncated`.
  - Moderation by endpoint or by LLM classifier, failing closed.
  - Pricing.
  - The P6 embedding adapter moved here, so the API embeds queries with the worker's code.
- **`shared/src/prompts.ts` (`rag-v2`):** the first-line headers now include `SCOPE: OUT` and `CONTACT: REQUESTED`.
- **API:**
  - **Request checks:** a strict body, the bot slug checked first, then rate limit, idempotent runs, the embedding model guard and a worst-case reservation.
  - **Before any spend:** a missing contact or escalation config is refused (ADR 0013).
  - **Retrieval and routing:**
    - Input moderation runs in parallel with the query embedding.
    - All six handoff reasons are implemented, with contact details from config only.
    - Server-side history (blocked and incomplete turns excluded).
  - **Generation and output:**
    - Retry and fallback happen only while nothing has been released.
    - Output moderation in buffer or rolling mode.
    - Citations mapped to retrieved chunks, with linear-time contact de-linking.
  - **Accounting:** usage is recorded for every provider call, the budget is settled, and runs end in a terminal state.
  - **Routes:** `POST /v1/chat` (SSE) and `GET /v1/conversations/:id`, which is paged and rate-limited per session.
  - **Config:** new required environment variables, failing closed (README, `api/.env.example`).
- **Docs:** a DATABASE_SCHEMA chat section, the README API environment, and `scripts/system-suite.sh`.

## Defects found and fixed
| Found by | Defect | Fixed in |
|---|---|---|
| P7-R2, confirmed by Opus (probe) | Human-request matcher sent ordinary questions ("How do I update my contact information?") to the contact card | P7-D1, then P7-D2 and R4 |
| P7-R1, confirmed by Opus (timing) | De-linker quadratic: 20k chars 352 ms, 200k chars about 35 s | P7-D1 (under 80 ms) |
| P7-R3, confirmed by Opus (timing) | `urlEnd` quadratic on `)`×N: 40k 1.46 s | P7-D2 (200k 30 ms) |
| P7-R1 | De-linking bypasses: entities, markdown links, other schemes, bare hosts, `[at]` emails, fullwidth digits | P7-D1 and P7-D2 |
| P7-R1, R2 | The reservation missed retries, fallback, non-Latin text and the classifier cap. There was no output cap | P7-D1 and P7-D2 |
| P7-R1, R2, R3 | A blocked question was replayed to the model, including when turns interleave | P7-D1, P7-D2 (013) and R4 |
| P7-R2 | Missing contact config gave a blank reply | P7-D1 |
| P7-R2 | Retry and fallback were refused while nothing had been shown | P7-D1 |
| P7-R1 | A disconnect before hijack still called providers. A stalled embedding outlived the deadline. The history route had no rate limit | P7-D1 |
| P7-R2 | Truncated replies were stored `complete`. A heartbeat was written after `error`. The bot slug was checked after spending a rate slot | P7-D1 |
| P7-R3 | An unhandled rejection in `raceAbort` could exit the process | P7-D2 |
| P7-R3 | Split markdown links, `mailto:` with a query, moderation spend gaps | P7-D2 |
| Opus, e2e | The openai_compatible `stream_options` resend turned one 400 into several calls | Removed at integration |
| P7-R4 | The kept adjacency rule dropped a legitimate question. Group contact requests with a channel stopped matching. The markdown scan didn't fail closed on budget exhaustion | Opus, `4b65a6d` |

Fail-before evidence:
- `e2e-before-d1.txt`
- `delink-timing.txt`
- `r4-fail-before.txt`
- each worker's report, self-reported: about 106 API unit tests failed on the wave 1 code, and 47 citation tests on the base

## Existing tests changed
- `tests/unit/shared/prompts.test.ts`: `parseEvidenceHeader` results gain `outcome` (additive, `rag-v2`).
- **Schema version 13:** five 220 lines, 250, `first-admin`, `admin-real-session`.
- **API config tests:** new required variables. A zero price is refused. Context minimum 3339 (from 256). TTL ≥ deadline + 30 s.
- **Chat unit tests:**
  - Missing escalation or contact config is now a 500 refusal (it was an omitted event).
  - The buffered failure before release is now retried.
  - The wrong-slug run is no longer created.
  - Reservation deltas follow the new worst-case formula.
  - Two history fixtures now store the refused question as `blocked`, as 013 does.
  - The disconnect-before-generation test now settles the sent moderation estimate.
- `tests/unit/shared-ai/chat.test.ts`: `truncated` added to two usage expectations. The `stream_options` resend tests were replaced by a never-retry test.

## Not done or not proven
- **Real providers:**
  - No real provider call was made, so the wire formats for Gemini, OpenAI, Anthropic and the moderations API are unverified against live services.
  - The evaluation-set baseline in P7's gate (`plan.md`) needs a real model. It is **not done**: it needs owner approval for real calls and paid-tier Gemini billing (§3a n).
  - The similarity threshold is not calibrated on real data (§3a c).
- **Accepted limits:**
  - A wrong-slug request costs one unmetered DB read (edge rate limiting is P10).
  - Bare hosts with an unlisted or title-case TLD and no path stay as text, and the widget must render plain text with an http(s)-only href allowlist (P8 obligation).
  - `[a][b]` loses `b`.
  - Digit groups of 8 or more get a zero-width space.
  - `name at host dot com` without brackets is not detected.
  - "reach the team via WhatsApp" falls through to the model's `CONTACT: REQUESTED` header.
- **openai_compatible:** a server that refuses `stream_options` cannot be used until a config option exists.
- **Reservation size:** the worst-case reservation is several times a typical request (attempts × providers × full context plus moderation). Check it against each client's daily cap before go-live.
- **Untested orderings:**
  - `finish_chat_turn` against session cleanup (deadlock hypothesis, P7-R1 #9);
  - SIGTERM drain with streams in flight (the reaper ends the run).
- **Deferred:**
  - **P7.5:** the answer cache and Anthropic prompt caching.
  - **P9:** the `analyze_conversation` enqueue.
- **Process slip:** `ea67013` was committed after only pgTAP 260, before the full suite. The final gated run above covers it.
- **Hosted:** migration 013 needs owner approval to apply. Post-push checks follow (rules.md §5).
