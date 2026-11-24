# P11 live-provider evaluation

Owner-authorized live runs only (paid-tier Gemini, primary provider, 2026-11-24).
Fallback-provider runs are an explicit open carry. Corpus and questions are
synthetic Acme fixtures; never client data.

## Run

```powershell
$env:EVAL_LIVE='1'; npm run test:evaluation
```

Optional: `$env:EVAL_MAX_USD='2'` (default `5`) — the harness refuses to start a
new turn past the cap and reports exact spend (`EVAL SPEND ...` line + per-turn
usage rows) from the same `usage_events` ledger production uses.

Without `EVAL_LIVE=1` every case skips: CI, `npm test`, and `test:integration`
never spend. A skipped run proves only the gate, not model quality.

## What it covers (TECH_SPECS §9 Evaluation)

- `gemini-primary.test.ts` — known answers (K1–K8, grounded + cited chunk IDs
  restricted to the inserted corpus), unanswerable → handoff with no invented
  contacts (U1–U6), multilingual incl. cross-language retrieval (M1–M4),
  injection in corpus directives (I1–I2) and in user messages (I3–I6, no
  compliance, no secret/JWT leak).
- Retrieval runs at `RETRIEVAL_TOP_K=5` / `RETRIEVAL_MIN_SIMILARITY=0.3`;
  threshold calibration is recorded with the run evidence, not hardcoded here.

## Requirements

- Local Supabase stack up with migrations `001`–`027` (`npx supabase status`).
- Built API (`npm run build`; the harness boots `api/dist/main.js`).
- Real key in repo-local `api/.env` (`GEMINI_API_KEY`, gitignored, paid tier).
- Fallback is disabled for these runs (`CHAT_FALLBACK_*` unset by construction).
