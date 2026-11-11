# P7 post-push checks (rules.md §5), 2026-11-11

Owner-approved.
- **Git:** `phase/p7` was fast-forwarded into `main` and pushed (`41997a9`).
- **Hosted:** migration 013 was applied to the hosted dev project `rbejeqwxyxtklehuzibv`.
  - `make db-plan` listed only `013_chat.sql`.
  - It was applied with `supabase db push --remote=<ref> --yes`. No seed was applied.
- **Evidence:** `docs/evidence/P7-remote/`.

## 1. Local suite on `main`
Run at 09:35 on `41997a9` (`suite-main/`). Every command exited 0:

| Check | Result |
|---|---|
| `db-test` | 26 files, 3348 passed |
| `db-race` | 51 orderings, 0 problems |
| `npm test` | 3133 passed |
| Integration | 766 passed, including 82 chat end-to-end tests |
| API smoke | 35 passed |
| Worker extraction check | Passed |
| `test-make` | 116 passed |
| Secret scan | No hits |
| Local advisors | No issues |

## 2. Hosted dev project (read-only)
| Check | Result |
|---|---|
| `make db-plan` after the push | Up to date, nothing pending (`db-plan-after.txt`) |
| Migration history and `schema_version()` | 13 migrations, version 13. 0 users, 0 bots |
| Catalog fingerprint, local vs hosted | Identical in all 8 parts (table grants, column privileges, policies, functions, triggers, constraints, indexes, columns). Counts 32, 113, 11, 91, 15, 138, 74, 210 (`fingerprint.sql`, `fp-local.txt`) |
| Security advisors | Unchanged: 19 WARN (the intended SECURITY DEFINER admin functions) and 13 INFO `rls_enabled_no_policy` |
| Performance advisors | INFO only, unchanged from P6: one unindexed foreign key from 001, and unused indexes expected on an empty database |
| Anonymous HTTP, publishable key (`anon-http.txt`) | `public_bot_config` 200. The other 9 tables give 401, including `conversations`, `messages` and `message_sources` |
| Anonymous RPC | 401 (42501) for all five new 013 functions, `schema_version` and `admin_list_bots` |
| `match_document_chunks` | The probe omitted the vector argument (404). The catalog check confirms EXECUTE for `service_role` only |
| Function grants (catalog) | The five 013 functions and `match_document_chunks`: `service_role` only, not `anon` or `authenticated` |
| Anonymous Storage | Upload refused by RLS. The list returns `[]` (private bucket, 0 objects) |

The key was used in memory only and is not recorded here.

## Not checked
- **On the hosted database:** pgTAP, race tests and the API were not run against it.
- **No API deploy:** `/v1/chat` has not run against the hosted project, and no real provider call was made.
- **Evaluation baseline:** the P7 gate's evaluation-set baseline is still not done (status §3a bt).
- **Dashboard items:** public signup and TOTP on the hosted project (status §3a bj).
