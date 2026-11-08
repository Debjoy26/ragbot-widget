# ragbot_widget

Client-branded website RAG widget, the Render API and worker behind it, and the Supabase schema it shares with the admin panel. The admin panel talks only to Supabase (ADR 0017). Code exists through P6: shared contracts, migrations and tests, the API foundation and visitor sessions (P4, P5), and the ingestion worker (P6). Chat routes and the widget arrive in P7 and P8.

## Project structure
```text
ragbot_widget/
├── widget/
│   ├── src/
│   │   ├── widget.ts
│   │   ├── ui.ts
│   │   ├── api.ts
│   │   ├── public-config.ts
│   │   ├── session.ts
│   │   ├── render.ts
│   │   └── widget.css
│   ├── public/index.html
│   ├── clients/client-a/theme.css
│   ├── scripts/build.mjs
│   ├── package.json
│   └── vercel.json
├── api/
│   ├── src/
│   │   ├── main.ts
│   │   ├── app.ts
│   │   ├── server.ts
│   │   ├── routes/{chat,sessions,conversations,entries,health}.ts
│   │   ├── services/{auth,retrieval,llm,moderation,limits,conversations,handoff,cache}.ts
│   │   └── lib/{supabase,config,logger,errors,client-ip}.ts
│   ├── package.json
│   └── .env.example
├── worker/
│   ├── src/
│   │   ├── worker.ts
│   │   ├── jobs/{index-document,analyze-conversation,cleanup}.ts
│   │   └── lib/{extract,chunk,embeddings}.ts
│   └── package.json
├── shared/
│   ├── src/{contracts,schemas,errors,providers,prompts,index}.ts
│   └── package.json
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 001_core.sql
│   │   ├── 002_vectors.sql
│   │   ├── 003_grants_rls_storage.sql
│   │   ├── 004_jobs_limits_budgets.sql
│   │   ├── 005_retention.sql
│   │   ├── 006_reaper_settle_reply_lock.sql
│   │   ├── 007_run_state_guard.sql
│   │   ├── 008_p3d5_fixes.sql
│   │   ├── 009_admin_documents.sql
│   │   └── 010_admin_settings.sql
│   ├── tests/database/      # pgTAP
│   └── seed.sql
├── database/                # FDE entry point: symlinks to supabase/ SQL, runbook
├── clients/client-a/deployment.example.json
├── scripts/{deploy-client,smoke-test}.mjs
├── scripts/{race-db,test-make-guards,secret-scan}.sh
├── tests/{unit,integration,evaluation,e2e}/
├── docs/
├── Makefile                 # make help: install, create local or client database
├── .github/workflows/ci.yml
├── package.json
├── package-lock.json
├── render.yaml
├── tsconfig.json, tsconfig.base.json
├── eslint.config.mjs, vitest.config.ts, playwright.config.ts
├── .nvmrc, .npmrc, .gitignore
└── README.md
```
The tree is cumulative: it shows the finished layout, and files appear in the phase that builds them. Not there yet: API routes and services other than health and auth (P5, P7), worker jobs and libs (P6, P9), widget modules, `theme.css` and `vercel.json` (P8), `render.yaml` and `scripts/*.mjs` (P10), `clients/` (P12). Brace notation abbreviates multiple files. Use npm workspaces and one committed root lockfile. Widget TypeScript is built into ordinary browser JavaScript. The deployment manifest contains public project identifiers only, never keys that confer privileged access.

## Documentation
- `PRD.md`: scope and acceptance criteria.
- `UI_SCHEMA.md`: embed contract and interface states.
- `DATABASE_SCHEMA.md`: authoritative shared data contract.
- `ARCHITECTURE.md`: runtime flows and security boundaries.
- `TECH_SPECS.md`: APIs, dependencies, limits, and tests.
- `plan.md`: phased implementation plan.
- `status.md`: progress tracker.
- `handover.md`: context and invariants for whoever picks up the work.

## Local setup contract
Install the Node version in `.nvmrc` and run `nvm use`. Exact dependency versions are pinned in `package-lock.json`.
Main scripts (some start placeholders until their phase):
```bash
npm ci
npm run db:migrate:dev
npm run dev:api
npm run dev:worker
npm run dev:widget
npm test
npm run build
```
Database work goes through `make` (`make help`). `npm run test:integration` needs the local stack running. `npm run test:e2e` is not a gate until P8.

## CI
One job, `.github/workflows/ci.yml`, runs on every push to `main` and on pull requests (about 10 minutes):
1. Secret scan and its self-test, then `npm ci`, lint, format check, typecheck and unit tests.
2. Local Supabase stack: migrations and pgTAP tests, database lint, race checks, Makefile guard tests.
3. Integration tests, including the P6 ingestion end-to-end tests with real worker processes and a fake embedding provider.
4. Build, the API smoke test, and the P6 check that the built worker can extract a PDF in its sandboxed child process.

CI makes no provider calls and never touches a hosted project. It mirrors the system suite in `rules.md` §3, which stays the gate for commits; a CI result is never a gate (`rules.md` §2).

## Environment variables
API: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VISITOR_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`, `PORT`, `LOG_LEVEL`, `TRUSTED_PROXY_HOPS`, `BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`, `CONNECTION_TIMEOUT_MS`, `READY_TIMEOUT_MS`, `DB_TIMEOUT_MS`, `VISITOR_TOKEN_TTL_SECONDS`, `CHAT_DEADLINE_MS`, `PROVIDER_MAX_ATTEMPTS`, optional `VISITOR_TOKEN_SECRET_PREVIOUS` for rotation, `RATE_LIMIT_KEY_SECRET`, `TURNSTILE_TIMEOUT_MS`, `SESSION_PREFLIGHT_PER_IP_LIMIT`, `SESSION_PREFLIGHT_WINDOW_SECONDS`, plus AI roles `CHAT_PRIMARY_*`, optional `CHAT_FALLBACK_*`, `EMBEDDING_*` (incl. `EMBEDDING_DIMENSIONS=1536`), `MODERATION_*`.
Worker: database/storage credentials plus `EMBEDDING_*` and `ANALYSIS_*`. Never give the worker the visitor-signing key.
Worker (P6): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, queue settings (`WORKER_CONCURRENCY`, `JOB_LEASE_SECONDS`, `JOB_HEARTBEAT_INTERVAL_SECONDS`, `JOB_POLL_INTERVAL_MS`, `JOB_BACKOFF_BASE_SECONDS`, `JOB_BACKOFF_MAX_SECONDS`, `SHUTDOWN_GRACE_MS`), maintenance and retention settings, extraction limits, `EMBEDDING_BATCH_SIZE`, `EMBEDDING_PRICE_PER_MILLION_TOKENS` and `CHAT_DEADLINE_MS` (must match the API's, so the stuck-run threshold stays above it). The full list with comments is in `worker/.env.example`. PDF text comes from `pdfjs-dist` (pinned), run in a separate process with time, memory and file-access limits; scanned PDFs are refused (ADR 0005).
AI roles are provider-agnostic (ADR 0014): `<ROLE>_PROVIDER` (`gemini` | `openai` | `anthropic` | `openai_compatible`), `<ROLE>_MODEL`, optional `<ROLE>_API_KEY` (else `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`), and `<ROLE>_BASE_URL` for `openai_compatible`. Missing values fail closed. Changing the embedding model requires a full reindex. See `api/.env.example` and `worker/.env.example`.
Do not log full environment values. `.env` is local-only and ignored by Git. Production secrets are configured in Render.

## FDE: set up a client database
Run these from the repository root. You need Node from `.nvmrc`, plus Docker for the local steps. `make help` lists every command.

```bash
nvm use
make install
npx supabase login                     # once per machine
```

1. Create an empty Supabase project for the client and copy its 20-letter project ref.
2. Preview the change. `PROJECT_REF` must be on the command line; an exported value is refused. Check the `Target project:` line that make prints: it must be the right client's ref.

   ```bash
   make db-plan PROJECT_REF=<ref>
   ```

3. Apply the schema. Type the ref twice (`CONFIRM_REF` must equal `PROJECT_REF`). The CLI then asks you to confirm, and the change is immediate:

   ```bash
   make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref>
   ```

   If the CLI needs the database password, use `read -s SUPABASE_DB_PASSWORD && export SUPABASE_DB_PASSWORD`, then `unset SUPABASE_DB_PASSWORD` afterwards. Never type it inline. See `database/README.md`.

4. Check the result:

   ```bash
   make db-status PROJECT_REF=<ref>
   make db-advisors PROJECT_REF=<ref>
   ```

5. Finish the manual steps in [`database/README.md`](database/README.md): set the Auth options (public signup off, TOTP on, phone MFA off, password length at least 12, secure password change on), create the first admin with `make first-admin`, and add the client's bot and settings rows.

To recreate a local database instead, run `make db-start`, then `make db-local`. This wipes local data.

**Publishable key:** copy it from the client's Supabase project into the widget `<script>` tag on the client's website (`data-supabase-publishable-key`, see `UI_SCHEMA.md`). It is public and is not stored in this repository. Never put the secret key there.

## Deployment order per client
1. Provision Supabase; choose embedding dimensions; apply migrations and create private bucket (`make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref>`, see `database/README.md`).
2. Provision the first admin and active membership with `make first-admin`, after turning public signup off; configure Auth site/redirect URLs for the admin domain and enable TOTP, because every private read and admin action needs `aal2` (ADR 0015).
3. Test grants/RLS as anon, nonmember, analyst, admin, and privileged backend.
4. Deploy Render API and worker from the repository root using their workspace build/start commands. Provision secrets separately for each client and configure the queue and retention settings.
5. Set API health path `/health/ready`; configure CORS for actual website origins. Verify visitor sessions.
6. Deploy the widget Vercel project with repository root as project root and a workspace-specific build; publish only `widget/dist`.
7. Publish immutable `/v1.0.0/widget.js` output with JS content type and immutable caching. Keep demonstration assets separate from sensitive source/configuration.
8. Deploy companion admin panel; configure public Supabase variables and DNS/HTTPS.
9. Upload and index approved knowledge; run evaluation and end-to-end tests; validate primary and fallback providers.
10. Deliver embed and dashboard login, record schema/API/widget versions, and enable alerts.

## Production baseline
Paid Render API and background worker, explicit provider caps, durable jobs, backups with tested restores, and agreed privacy/retention settings. Free hosting is a demo option, not a production availability strategy. One database per client still requires admin authorization and visitor isolation inside that client.
