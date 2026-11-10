# P7 acceptance test plan (main session)

Prepared by Opus before wave 1.
- **Where:** the local stack, with real visitor sessions, runs, budget rows and database functions. **E** cases go in `tests/integration/chat-e2e.test.ts` and run against the built API.
- **Providers:** chat, embedding and moderation are labelled **fakes**. No real provider is called in P7 tests, and a fake never satisfies the evaluation gate (CLAUDE.md).
- **When:** Opus runs these and the rest of the system suite (`rules.md` §3) after each wave and each debug cycle.

## A. Pipeline and SSE contract (TECH_SPECS §4)
| ID | Case | Pass condition |
|---|---|---|
| A1 | Answerable question | Events in order: `meta` → `delta`+ → `sources` → `done`(complete). `meta` ids match the database rows. User and assistant messages are stored, and the assistant row has `reply_to` set to the user row |
| A2 | The first-line header is never streamed | No `delta` contains `EVIDENCE:`, `SCOPE:` or `CONTACT:` |
| A3 | Citations | `sources` lists only cited chunk ids that were retrieved for this bot. An invented `[[id]]` is dropped. `message_sources` rows match, with page and section kept |
| A4 | Contact details in model text | An email, phone or URL that matches neither the configured contact nor a validated source is de-linked (W-16) |
| A5 | Follow-up turn | Same conversation. History comes from the server, has at most the bound number of messages, and never includes `system` rows |
| A6 | Browser-supplied context rejected | Extra body keys (`history`, `system`, `context`, `api_key` …) give 400 before any spend |
| A7 | Idempotent replay | The same key and body after completion returns JSON with the stored status (no SSE, no spend). While running: 409 with a retry hint. A different body: 400 |
| A8 | Message limits | Empty or over-limit message gives 400. Unknown `preferred_language` is ignored, not trusted |

## B. Contact routing (TECH_SPECS §6.1, W-05, W-16)
| ID | Case | Pass condition |
|---|---|---|
| B1 | `no_knowledge` | Nothing above the threshold: generation is skipped (fake chat not called). The localised config message is sent with `handoff` `no_knowledge` and `done`. Assistant row `handoff_reason = no_knowledge` |
| B2 | `repeated_no_knowledge` | At the policy threshold (default 2), `prominent: true` and reason `repeated_no_knowledge` |
| B3 | `human_requested` | A clear request for a person or contact gets `handoff` straight away. No retrieval, no generation |
| B4 | `blocked` | Input moderation blocks: the policy message plus `handoff` `blocked`. No retrieval, no generation. Message status `blocked` |
| B5 | `out_of_scope` | Model header `SCOPE: OUT` gives `handoff` `out_of_scope`. No answer text is streamed beyond one sentence |
| B6 | Model hedges | Header `EVIDENCE: INSUFFICIENT`, or a missing or garbled header, gives `handoff` |
| B7 | `unavailable` | Primary fails before the first token and the fallback fails, or there is no fallback: `error` (`PROVIDER_UNAVAILABLE`), then `handoff` `unavailable` |
| B8 | Contact values | Every `handoff.contact` value comes from current `public_bot_config`, never from model text. Unset fields are omitted |

## C. Providers, fallback and streaming (W-08)
| ID | Case | Pass condition |
|---|---|---|
| C1 | Fallback eligibility matrix | Before the first token: retry or fallback only on `transient` and `rate_limited`. `auth`, `billing` and `permanent` never retry, and never fall back unless the policy allows it |
| C2 | Failure after the first token | No provider switch: the stream ends `error` `STREAM_INTERRUPTED` with a retry hint. Message stored `partial` with the text sent so far |
| C3 | Total deadline | `CHAT_DEADLINE_MS` bounds the whole request, retries included |
| C4 | Client disconnect | The upstream fetch is aborted, usage is still recorded, the reservation is settled and the run is not left `running` |
| C5 | Output moderation | `buffer` mode: nothing is released until the whole answer passes; a block releases nothing and gives `handoff` `blocked`. `rolling` mode: released in batches; a later block stops the stream (status `partial`) |
| C6 | Adapters (unit, fake HTTP) | Gemini, OpenAI, openai_compatible and Anthropic streaming parse, usage, error kinds, `billed`, abort, timeout. No key, URL or body appears in errors |

## D. Spend and persistence
| ID | Case | Pass condition |
|---|---|---|
| D1 | Budget | Reserved before any provider call. Over the cap: 429 `BUDGET_EXCEEDED` before SSE, no provider call |
| D2 | Usage ledger | One `usage_events` row per provider call (moderation, query embedding, each chat attempt including failed and fallback ones), linked to the run. The settled amount equals the usage sum |
| D3 | Run states | Ends `succeeded`, `partial` or `failed`. Never left `reserved` or `running` after the response ends |
| D4 | Embedding model guard | The query embedding model must equal `bot_profiles.embedding_model`, otherwise `INTERNAL_ERROR` with no silent switch |

## E. Security and isolation
| ID | Case | Pass condition |
|---|---|---|
| E1 | Cross-session conversation | Using another session's or bot's `conversation_id` gives 400 (RB037), with no oracle |
| E2 | History route | `GET /v1/conversations/:id`: same session only, bounded and paged with `before`, no `system` rows. Disabled by the `history_enabled` flag |
| E3 | Prompt injection in documents | An instruction inside a document doesn't change the headers' meaning, the contact handling or the citation rules (unit level with the fake model; real-model evaluation is P11) |
| E4 | Forged, expired or wrong-bot token; `bot_slug` mismatch | 401/403 before any spend |
| E5 | Logs | No message text, document text, keys or tokens in any log line |

## F. Database (pgTAP and race)
- 260 covers every 013 function: grants (service_role only), fences and ownership, argument bounds, history paging, `system` exclusion, and source snapshot validation (chunk of another bot refused).
- `race-db.sh`: two `finish_chat_turn` calls on one run; `start_chat_turn` against conversation deletion.

## Not covered in P7
- Real provider calls and the evaluation-set baseline (owner approval and paid-tier billing, §3a n).
- Calibrated similarity threshold on real data (§3a c).
- Caching (P7.5), the analysis job (P9), load (P11).
