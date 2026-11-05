# ragbot_widget

Client-branded website RAG widget plus the shared Render API/worker and Supabase schema used by both frontends. This is the proposed implementation layout, not a claim that the code already exists.

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
│   │   ├── server.ts
│   │   ├── routes/{chat,sessions,conversations,documents,settings,entries,health}.ts
│   │   ├── services/{auth,retrieval,llm,moderation,limits,conversations,handoff,cache}.ts
│   │   └── lib/{supabase,config,logger}.ts
│   ├── package.json
│   └── .env.example
├── worker/
│   ├── src/
│   │   ├── worker.ts
│   │   ├── jobs/{index-document,analyze-conversation,cleanup}.ts
│   │   └── lib/{extract,chunk,embeddings}.ts
│   └── package.json
├── shared/
│   ├── src/{contracts,schemas,providers,prompts}.ts
│   └── package.json
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 001_core.sql
│   │   ├── 002_vectors.sql
│   │   ├── 003_grants_rls_storage.sql
│   │   ├── 004_jobs_limits_budgets.sql
│   │   └── 005_retention.sql
│   └── seed.sql
├── database/                # FDE entry point: symlinks to supabase/ SQL, runbook
├── clients/client-a/deployment.example.json
├── scripts/{deploy-client,smoke-test}.mjs
├── tests/{unit,integration,evaluation,e2e}/
├── docs/
├── Makefile                 # make help: install, create local or client database
├── package.json
├── package-lock.json
├── render.yaml
├── tsconfig.json
├── .gitignore
└── README.md
```
Brace notation abbreviates multiple files. Use npm workspaces and one committed root lockfile. Widget TypeScript is built into ordinary browser JavaScript. The deployment manifest contains public project identifiers only, never keys that confer privileged access.

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
Install a supported Node.js LTS release; pin its exact version and compatible dependency versions during implementation. Provision a development Supabase project or local stack and test provider credentials.
Proposed scripts to implement:
```bash
npm ci
npm run db:migrate:dev
npm run dev:api
npm run dev:worker
npm run dev:widget
npm test
npm run build
```
These commands are a required script interface for the future codebase; this documentation bundle does not contain runnable application code. Run the three development processes in separate terminals.

## Environment variables
API: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VISITOR_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`, `PORT`, `LOG_LEVEL`, plus AI roles `CHAT_PRIMARY_*`, optional `CHAT_FALLBACK_*`, `EMBEDDING_*` (incl. `EMBEDDING_DIMENSIONS=1536`), `MODERATION_*`.
Worker: database/storage credentials plus `EMBEDDING_*` and `ANALYSIS_*`. Never give the worker the visitor-signing key.
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

5. Finish the manual steps in [`database/README.md`](database/README.md): enable TOTP, create the first admin, and add the client's bot and settings rows.

To recreate a local database instead, run `make db-start`, then `make db-local`. This wipes local data.

**Publishable key:** copy it from the client's Supabase project into the widget `<script>` tag on the client's website (`data-supabase-publishable-key`, see `UI_SCHEMA.md`). It is public and is not stored in this repository. Never put the secret key there.

## Deployment order per client
1. Provision Supabase; choose embedding dimensions; apply migrations and create private bucket (`make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref>`, see `database/README.md`).
2. Provision the first admin and active membership through trusted operator tooling; configure Auth site/redirect URLs for the admin domain and require MFA for privileged operations.
3. Test grants/RLS as anon, nonmember, analyst, admin, and privileged backend.
4. Deploy Render API and worker from the repository root using their workspace build/start commands. Provision secrets separately for each client and configure the queue and retention settings.
5. Set API health path `/health/ready`; configure CORS for actual website/admin origins. Verify signed admin sessions and visitor sessions.
6. Deploy the widget Vercel project with repository root as project root and a workspace-specific build; publish only `widget/dist`.
7. Publish immutable `/v1.0.0/widget.js` output with JS content type and immutable caching. Keep demonstration assets separate from sensitive source/configuration.
8. Deploy companion admin panel; configure public Supabase/API variables and DNS/HTTPS.
9. Upload and index approved knowledge; run evaluation and end-to-end tests; validate primary and fallback providers.
10. Deliver embed and dashboard login, record schema/API/widget versions, and enable alerts.

## Production baseline
Paid Render API and background worker, explicit provider caps, durable jobs, backups with tested restores, and agreed privacy/retention settings. Free hosting is a demo option, not a production availability strategy. One database per client still requires admin authorization and visitor isolation inside that client.
