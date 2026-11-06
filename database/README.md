# Database

Everything needed to recreate the ragbot database. Run all commands from the repository root.

## What is here

| Path | Contents |
|---|---|
| `migrations/` | The schema, in order: `001` to the latest |
| `seed.dev.sql` | Link to `supabase/seed.sql`. Placeholder bot for local development. **Never apply it to a client database** |
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

3. Check the `Target project:` line that make prints before it does anything. It must show the right client's ref. Then apply, typing the ref twice:

   ```bash
   make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref>
   ```

   `CONFIRM_REF` must equal `PROJECT_REF`, or make stops before calling the CLI. The CLI then asks you to confirm. Changes take effect immediately. The seed is not applied.

4. Check the result:

   ```bash
   make db-status PROJECT_REF=<ref>
   make db-advisors PROJECT_REF=<ref>
   ```

`PROJECT_REF` and `CONFIRM_REF` must be written on the `make` command line. Values set with `export`, or picked up by `make -e`, are refused, so a stale value in your shell cannot select a project.

If the CLI asks for the database password, set it for this shell without typing it into a command, then unset it afterwards:

```bash
read -s SUPABASE_DB_PASSWORD && export SUPABASE_DB_PASSWORD
# ... run the make commands ...
unset SUPABASE_DB_PASSWORD
```

Never put the password inline in a command, commit it, or paste it into chat or tickets.

## After creating a client database

The migrations create the schema, grants, RLS and the private `knowledge` storage bucket. These steps are not automated:

- Set these in Supabase Auth, because `db push` doesn't change Auth settings:
  - Turn off public signup. Otherwise anyone can create a signed-in account.
  - Enable TOTP MFA, and leave phone MFA off. Admins cannot read private data until they have enrolled.
  - Set a minimum password length of at least 12.
  - Turn on secure password change.
  - Add the admin panel's domain to the site URL and redirect list.
- With public signup off, create the first admin with `make first-admin PROJECT_REF=<ref> CONFIRM_REF=<ref> EMAIL=<address>`, which sends a short-lived invite link and adds their active membership. `SUPABASE_URL` and `SUPABASE_SECRET_KEY` must be in the environment. An account that has already signed in is refused unless you pass `--adopt-existing` to the script. Never set a password for them: a password that leaks before TOTP enrolment gives full access.
- Add the client's rows to `bot_profiles`, `public_bot_config` and `client_settings`. Missing limits fail closed, so the bot will not serve until they are set. `client_settings.upload_policy` also needs `index_max_attempts`, `cleanup_max_attempts` and `quotas` for `register`, `upload`, `reindex` and `write`, and a bot can't be enabled without a contact channel and an escalation message for every supported language.

## Expected advisor results

- `rls_enabled_no_policy`: expected. Ordinary client access to those tables is denied.
- `authenticated_security_definer_function_executable`: the five functions from migration `003` plus the 14 admin RPCs in `DATABASE_SCHEMA.md`, granted on purpose. Each is reviewed and checks its caller first.
- `unused_index`: expected on a new database.
- `unindexed_foreign_keys` on `request_runs_session_fk`: false positive. `request_runs_idempotency_key` already serves this lookup.

Treat anything else as a finding and report it.
