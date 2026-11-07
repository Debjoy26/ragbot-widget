# Remote apply of migration 011 — 2026-11-07

Owner-approved. Project `rbejeqwxyxtklehuzibv`. `make db-plan` listed only `011_visitor_sessions_runs.sql`; then `supabase db push --remote=<ref> --yes`. No seed applied, so the dev bot's Turnstile flag in `seed.sql` does not reach this project.

| Check | Result |
|---|---|
| `db push` | Exit 0, one migration applied (`db-push.txt`) |
| `make db-status` | Remote history 001–011 (`db-status.txt`) |
| Local and remote catalog md5 | Identical for table grants, column privileges, policies, functions, triggers, constraints, indexes and columns: 32 grant rows, 11 policies, 68 functions, 15 triggers, 137 constraints, 72 indexes, 208 columns (`fp-local.txt`) |
| `schema_version()` on the remote | 11 |
| Rows | 0 users, 0 bots |
| Security advisors | Unchanged: 19 WARN, the intended set in `database/README.md`; 13 INFO `rls_enabled_no_policy` |

Not checked on the remote: pgTAP, race tests, the API against the hosted database. Public signup is still on and TOTP is unknown (dashboard).
