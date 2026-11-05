# P3 remote apply and security review P3-R3 — 2026-11-05

Git revision: `main` @ `19438c5`. Node 24.22.2. Supabase CLI 3.0.0. No client data. No secrets recorded here.

## Remote apply (owner-approved)
| Command / check | Target | Result |
|---|---|---|
| `supabase db reset` | local stack | Applied 001–005 and seed; CLI reported finished; exit code not captured |
| `supabase db push --dry-run` | local (CLI default) | Exit 0, no remote check: this CLI targets local unless `--remote` is passed |
| `supabase db push --remote --dry-run` | `rbejeqwxyxtklehuzibv` | Exit 0; listed 001–005, no seeds |
| `supabase db push --remote --yes` | `rbejeqwxyxtklehuzibv` | Exit 0; 001–005 applied; `seed.sql` not applied |
| MCP `list_migrations` | remote | Versions 001–005 |
| MCP `list_tables` | remote | 22 tables, RLS enabled on all, 0 rows |
| Local vs remote fingerprints (read-only `SELECT`) | both | Policies, public function definitions and table grants: identical md5 |
| Counts | both | 9 public policies, 32 functions, 70 indexes, 1 bucket |
| Remote only | remote | anon table grant only on `public_bot_config`; bucket `knowledge` private; one overload each of `begin_request_run` and `release_budget_reservation`; `is_active_member` has no `service_role` execute |

Not compared: column-level grants, function execute grants across all functions. pgTAP not run against the remote. Remote Auth TOTP setting not checked.

## Advisors (remote, after apply)
- Security: 5 WARN `authenticated_security_definer_function_executable` (`is_active_member`, `is_active_member_mfa`, `job_status_summary`, `knowledge_gaps`, `usage_daily_summary`), granted deliberately in migration 003. 13 INFO `rls_enabled_no_policy` (default deny); admin panel read needs not yet confirmed for `admin_memberships`, `bot_profiles`, `client_settings`.
- Performance: 34 INFO unused indexes (empty database). 1 INFO unindexed foreign key `request_runs_session_fk`.

### `request_runs_session_fk`: advisor false positive
The foreign key is (`visitor_session_id`, `bot_id`). Unique index `request_runs_idempotency_key` leads with (`bot_id`, `visitor_session_id`). Equality on both columns can use it in any order; the advisor compares column order only.
Local test, 100,000 rows, rolled back: the lookup used `request_runs_idempotency_key` (bitmap index scan, no sequential scan); deleting one session with 50 runs took 2.288 ms. No index added. Owner decision on the proposed `006` index is pending.

## Security review P3-R3 (`security-reviewer`, static, of `65cc738..6b24002`)
Worker report is self-reported. Status below shows what Opus verified.

| ID | Severity | Status | Summary |
|---|---|---|---|
| R3-1 | Medium | Confirmed, reproduced by Opus | `expire_stuck_request_runs` sets reservations to `released`; settle then fails RB003 and real spend is not counted |
| R3-2 | Low | Confirmed by Opus code read; race not exercised | `messages_check_reply_to` takes no lock and skips its check if the target row is not visible (`if found`). Needs a writer that does not exist today |
| R3-3 | Low/Info | Confirmed by Opus | `DATABASE_SCHEMA.md` Budget line still says settle rejects expired, contradicting the later line. The Request start line also still shows the old 4-argument `begin_request_run` |
| R3-4 | Info | Not independently checked | TRUNCATE trigger wording overstates protection against the table owner |
| R3-5 | Process | Closed by Opus | Remote applied fresh at HEAD; no old overloads (see table above) |
| R3-6 to R3-9 | Low/Info | Hypotheses or notes, not verified | `knowledge_gaps` pairing after question deletion; lock order; analysts can read `blocked` text; no `request_runs` state-transition guard |

### R3-1 reproduction (local, rolled back)
Run `running` for 10 minutes, reservation 1.0 with 3600 s TTL, then `expire_stuck_request_runs(60, 100)` reaped 1 run and the reservation became `released`. `settle_budget_reservation(..., 0.75)` failed with RB003. Amount counted toward the cap: 0.
Proposed fix (not implemented): new migration replaces the reaper to set `expired` instead of `released`, plus a pgTAP case for reap then settle.

Test gaps listed by the reviewer: settle after reaper; foreign-bot settle against an `expired` reservation; `purge_expired_conversations` with reply pairs; `request_id` pointing at another bot's run; `knowledge_gaps` after question deletion. All tests remain sequential.
