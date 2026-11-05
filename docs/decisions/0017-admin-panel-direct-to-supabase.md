# ADR 0017 — Admin panel talks only to Supabase

- **Decision:** owner direction · **Status:** Accepted · **Date:** 2026-11-06 · **Approved by:** owner ("I want the admin panel least dependent on the render api")
- **Revises:** `TECH_SPECS §3` (administrative API), `ARCHITECTURE` admin flows, `plan.md` P4, P6, P9. Admin repo: `handover.md §4` rule 5
- **Blocks:** P3.5, admin AP4, AP5

## Decision
The admin panel never calls the Render API. It uses the publishable key plus the signed-in user's session, and does everything through Supabase:

1. **Reads:** unchanged. Direct, under RLS.
2. **Writes:** database functions (RPCs) callable by `authenticated`. There are still no direct table writes from the browser.
3. **Files:** uploads and downloads go through Supabase Storage, under policies on `storage.objects`.
4. **Ingestion:** an RPC adds a job to `jobs`. The Render worker claims it as before, so the panel has no connection to the worker.

The publishable key grants nothing by itself. Access comes from the user's session, membership, `aal2`, grants, RLS and these RPCs.

## Rules for every browser-callable RPC
- Checks `is_active_member_mfa(roles)` first. A published table lists the roles for each RPC.
- Fixed `search_path`. `EXECUTE` granted to `authenticated` only, never `anon` or `PUBLIC`.
- `SECURITY DEFINER` only where the function needs it, and each one is reviewed by `security-reviewer` before any remote apply.
- Validates its own input. Browser checks are convenience only.
- Writes `audit_logs` in the same transaction, with `auth.uid()` as the actor.
- Takes no role, actor or storage path from the browser.

## What stays on Render
The API still serves the widget: sessions, chat, retrieval and all AI keys. The worker still runs ingestion, analysis and cleanup. No AI key or secret key ever enters a frontend. Render stays for the widget backend and ingestion: the owner ruled out moving them to Edge Functions on 2026-11-06.

## Consequences
- **Gains:** the panel keeps working while Render is down or cold-starting, needs no API CORS, and settings no longer wait for P9.
- **Costs:** validation moves into SQL, so the settings whitelist exists in both SQL and `shared/src/schemas.ts`. A value SQL accepts but Zod rejects could break the widget's config load, so a shared-fixture parity test is required. More privileged functions are reachable from browsers, and advisor warnings will rise accordingly.
- **Worker takes on more:** the actual content, size and type checks happen when it claims a job, because no API checks the upload first.
- **Errors:** the panel handles SQLSTATEs from RPCs, including stable `RB0xx` codes, instead of the API envelope.
- **Retired:** the `/v1/admin/*` routes, admin JWT verification in the API, admin CORS and `VITE_API_URL`. Admin route shapes in `shared/src` are removed when P3.5 replaces them.

## To confirm when built
Exact Storage permissions for signed URLs and upload progress; reading `storage.objects` from an RPC to confirm an upload exists.
