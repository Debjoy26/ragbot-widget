# Remote apply of migrations 007–010 — 2026-11-06

Owner-approved. Project `rbejeqwxyxtklehuzibv`. `supabase db push --remote=<ref>`, after `make db-plan` listed only 007–010. No seed applied. Public signup was still on at apply time, which is not a blocker: the project has no members, and every admin function refuses non-members.

| Check | Result |
|---|---|
| `db push --remote=<ref> --yes` | Exit 0, four migrations applied (`db-push.txt`) |
| `make db-status` | Remote history 001–010 (`db-status.txt`) |
| Local and remote catalog md5 | Identical for table grants, column privileges, policies, functions, triggers, constraints, indexes, columns. 32 grant rows, 11 policies, 63 functions, 15 triggers, 137 constraints, 72 indexes, 208 columns |
| Rows | 0 users, 0 bots |
| Security advisors | 19 WARN `authenticated_security_definer_function_executable`, the set in `database/README.md`; 13 INFO `rls_enabled_no_policy`, unchanged |
| Performance advisors | 35 INFO unused indexes (empty database), 1 INFO `request_runs_session_fk`, a known false positive |
| Anonymous HTTP | See `anon-http.txt` |

Not checked: pgTAP against the remote; a real signed-in session against the remote, which needs a test user; remote TOTP.

Still open: public signup is on, and TOTP is unknown. Both need the Supabase dashboard.
