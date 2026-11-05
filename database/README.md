# Database

Everything needed to recreate the ragbot database. Run all commands from the repository root.

## What is here

| Path | Contents |
|---|---|
| `migrations/` | The schema, in order: `001` to the latest |
| `seed.dev.sql` | Placeholder bot for local development. **Never apply it to a client database** |
| `tests/` | pgTAP database tests |

These are symlinks into `supabase/`, where the Supabase CLI reads them. Each file exists once, so this folder cannot drift from what the CLI applies. On Windows, use WSL, or enable symlinks when cloning.

**To change the schema, add a new numbered file.** Never edit a migration that has been applied to a remote project: `db push` will not re-run it, so that project would silently differ from the repository. This repository holds the only migration history; the admin panel repository must not add its own.

## Prerequisites

- Node at the version in `.nvmrc`: run `nvm use`
- Docker running (local database only)
- For a remote project: run `npx supabase login` once, and have access to the project

```bash
nvm use
make install
```

## Create a local database

```bash
make db-start    # first time, or after a restart
make db-local    # wipes local data, then applies migrations and the dev seed
make db-test     # optional: run the database tests
```

`make db-start` prints the local URLs and keys.

## Create a client database

1. Create an empty project in the Supabase dashboard, one per client. Copy its 20-letter project ref from the project URL.
2. Preview what will be applied. This changes nothing:

   ```bash
   make db-plan PROJECT_REF=<ref>
   ```

3. Check that the target name in the output is the right client, then apply:

   ```bash
   make db-create PROJECT_REF=<ref>
   ```

   The CLI asks you to confirm. Changes take effect immediately. The seed is not applied.

4. Check the result:

   ```bash
   make db-status PROJECT_REF=<ref>
   make db-advisors PROJECT_REF=<ref>
   ```

If the CLI asks for the database password, set `SUPABASE_DB_PASSWORD` in your shell for that command. Never commit it or paste it into chat or tickets.

## After creating a client database

The migrations create the schema, grants, RLS and the private `knowledge` storage bucket. These steps are not automated:

- Enable TOTP MFA in Supabase Auth. Admins cannot read private data until they have enrolled.
- Create the first admin and their active membership (`README.md`, "Deployment order per client").
- Add the client's rows to `bot_profiles`, `public_bot_config` and `client_settings`. Missing limits fail closed, so the bot will not serve until they are set.

## Expected advisor results

- `rls_enabled_no_policy`: expected. Ordinary client access to those tables is denied.
- `authenticated_security_definer_function_executable`: five functions, granted on purpose in migration `003`.
- `unused_index`: expected on a new database.
- `unindexed_foreign_keys` on `request_runs_session_fk`: false positive. `request_runs_idempotency_key` already serves this lookup.

Treat anything else as a finding and report it.
