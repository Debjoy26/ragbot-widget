# P6 post-push checks (rules.md §5), 2026-11-08

Owner-approved:
- `phase/p6` was fast-forwarded into `main` and pushed (`eac6392`).
- Migration 012 was applied to the hosted dev project `rbejeqwxyxtklehuzibv`:
  - `make db-plan` listed only `012_ingestion.sql`.
  - Then `supabase db push --remote=<ref> --yes`.
  - No seed was applied.

Evidence is in `docs/evidence/P6-remote/`.

## 1. Local suite on `main`
Run at 20:08 on `eac6392` (`suite-main/`). Every command exited 0:
- `db-test`: 25 files, 3065 passed.
- `db-race`: 47 orderings, 0 problems.
- `npm test`: 2155 passed.
- Integration: 684 passed.
- API smoke: 35 passed.
- `test-make`: 116 passed.
- Secret scan: no hits.
- Local advisors: no issues.
- Extraction check and timing probe: passed.

## 2. Hosted dev project (read-only)
| Check | Result |
|---|---|
| `make db-plan` after the push | Up to date, nothing pending (`db-plan-after.txt`) |
| Migration history and `schema_version()` | 12 migrations, version 12. 0 users, 0 bots |
| Catalog fingerprint, local vs hosted | Identical in all 8 parts: table grants, column privileges, policies, functions, triggers, constraints, indexes, columns. Counts: 32, 111, 11, 86, 15, 137, 74, 208. Query in `fingerprint.sql`, local result in `fp-local.txt` |
| Security advisors | Unchanged: 19 WARN, the intended SECURITY DEFINER admin functions; 13 INFO `rls_enabled_no_policy` |
| Performance advisors | INFO only. One unindexed foreign key, `request_runs_session_fk`, comes from migration 001 and is not new. 37 unused indexes, expected on an empty database |
| Anonymous HTTP, publishable key | `public_bot_config` 200; 11 other tables 401 |
| Anonymous RPC calls | 401 (42501) for all 11 called: every new 012 function tried, `purge_expired_data_entries`, `schema_version` and `admin_list_bots` |
| Anonymous Storage | Upload refused by RLS. The list returns `[]`: the bucket is private, has no anonymous policy and holds 0 objects |

The key was used in memory only and is not recorded here.

## 3. Finding: CI failed on `main`, a flaky test (debug cycle P6-D7)
The owner asked about CI. Both recent failures were the same test:
- **Test:** `tests/unit/api/rate-key.test.ts`, "does not contain the plain identifier".
- **Runs:** CI runs 42441258797 (the `rules.md` commit, before P6) and 42490613455 (P6).
- **Cause:** the test checked that a 64-character HMAC hex digest, keyed by a random secret per run, does not contain the fragment `203`. That happens by chance.
- **Measured on this system:** 304 of 20,000 random secrets fail (1.52%). This is not a code defect.
- **Fix:** the test now checks the whole identifier, as text and hex-encoded. It still fails if the key leaks the address, and fails by chance 0 times in 20,000 (`rate-key-flake-before.txt`).
- **Process:** committed on `p6/d7` after the full suite, then merged and pushed with owner approval.

## Not checked
- pgTAP, race tests and the API were not run against the hosted database.
- Public signup and TOTP on the hosted project still need the dashboard (status §3a bj).
