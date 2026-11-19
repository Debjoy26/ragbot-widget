# Runbook: key rotation (P10)

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](../reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

Keys: `SUPABASE_SECRET_KEY` (service role), provider API keys
(`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), `VISITOR_TOKEN_SECRET`,
`TURNSTILE_SECRET_KEY`, `RATE_LIMIT_KEY_SECRET`. Never commit a value; never
print one (secret scan runs in CI).

## Visitor signing secret

1. Set `VISITOR_TOKEN_SECRET_PREVIOUS` to the current `VISITOR_TOKEN_SECRET`
   in the Render `ragbot-api` env. Both are accepted for verification; only
   `VISITOR_TOKEN_SECRET` signs.
2. Set `VISITOR_TOKEN_SECRET` to the new random value (32+ bytes, differs from
   every other secret — the API refuses to start on reuse).
3. Redeploy `ragbot-api`. Old tokens keep working until `VISITOR_TOKEN_TTL_SECONDS`
   expires them (at most 24 h).
4. After the TTL has passed everywhere, clear `VISITOR_TOKEN_SECRET_PREVIOUS`
   and redeploy. The API refuses to start if it is set to a placeholder.

## Provider keys

1. Create the new key at the provider (with its own spending cap).
2. Replace `<ROLE>_API_KEY` in the Render env of the services that use that
   role (`ragbot-api`, `ragbot-worker`, or both). Redeploy.
3. Changing a provider key never changes model identity, so caches stay valid.
   Changing the embedding *model* is different: it needs an explicit reindex
   (old chunks are unusable, the API guard refuses to mix them).

## Supabase service-role key

1. Roll the key in the Supabase dashboard (per-client project).
2. Set `SUPABASE_SECRET_KEY` in both Render services and redeploy together.
   Between dashboard roll and redeploy, keep the old key valid if the project
   allows a grace window; otherwise accept a brief 503 on `/health/ready`
   during the switch.
3. `SUPABASE_URL` never changes for a client; if it does, it is a new client.
