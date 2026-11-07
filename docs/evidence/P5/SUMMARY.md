# Phase P5 — Visitor sessions and abuse controls — 2026-11-07

Owner-approved. Branch `phase/p5`, not on `main` and not pushed until the owner approves. Base `main` @ `e4e5f77`.
Environment: Node 24.22.2, Supabase CLI 3.0.0, local stack at migration 011.
Workers: `sonnet-implementer` ×5 on their own branches (P5-A, P5-B, P5-D1-A, P5-D1-B, P5-D2), self-reported. Reviews: P5-R1 and P5-R3 (`security-reviewer`), P5-R2 (`reviewer`), static, self-reported. Opus merged each round, reconciled the two halves, fixed the smoke drain probe, updated the docs and ran the gates below. No dependency added. **Migration 011 is not on the hosted dev project** (still at 010).

## Gates on the final merged tree
Run by Opus at 16:11–16:12 after P5-D2 was merged. The owner stopped the command before it finished, so the race suite was not re-run on this tree.

| Check | Exit | Result | Evidence |
|---|---|---|---|
| `npm run build` | 0 | Passed | `npm_build.txt` |
| `make db-local`, `make db-test` | 0 | 24 files, 2639 passed | `db-test.txt` |
| `make db-lint` | 0 | No schema errors | `db-lint.txt` |
| `make test-make` | 0 | 116 passed | `test-make.txt` |
| `npm run test:integration` | 0 | 612 passed | `integration.txt` |
| `npm test` | 0 | 1515 passed | `npm_test.txt` |
| `node scripts/api-smoke.mjs` | 0 | 35 passed | `api-smoke.txt` |
| `npm run lint`, `format:check`, `typecheck` | 0 | Passed | `npm_*.txt` |
| Secret scan with self-test | 0 | No hits | `secret-*.txt` |
| `make db-race` | 0 | 35 orderings, 0 problems, at `9847aac` (before P5-D2) | `db-race.txt` |

The P5-D2 worker reports `race-db.sh` passing 3 times with 36 orderings (self-reported). The smoke drain probe passed 10 of 10 runs at `4643b96`, after Opus made it deterministic.

## Delivered
- **Migration 011:**
  - `get_session_policy`, `create_visitor_session`, `get_rate_policy`, `set_request_run_state` (conditional) and `get_request_run`.
  - `begin_request_run` and `reserve_request_budget` refuse a disabled bot (RB039).
  - `lock_timeout = 2s` on these, settle, release and `record_rate_limit_attempt`.
  - Per-IP and per-bot session limits; `schema_version()` is 11; the dev seed has Turnstile off.
- **API:**
  - `POST /v1/sessions` checks, in order: body, per-IP preflight, policy, disabled check, per-bot-and-IP limit, Turnstile when required, per-bot aggregate, insert.
  - Rate-limit keys are an HMAC of the IP, never the raw address, with IPv6 grouped by /64.
  - Turnstile fails closed, is bound to our hostnames and action, and Cloudflare's test secrets are refused.
  - Idempotency and run services: replay, 409 with a retry hint, 400 on a different body under the same key.
  - Budget wrappers, and one retry on 40P01 and 55P03 for calls safe to repeat.
- **Shared:** RB039 `bot_disabled`, which maps to `FORBIDDEN`.
- **Worker guard:** refuses the rate-limit and Turnstile secrets, and their prefixed variants.

Plan tests, proven against the real database: concurrent reservations never exceed the cap; a duplicate idempotency key cannot spend twice; a different body under the same key is refused; the rate-limit window rolls over.

## Defects found and fixed
| Found by | Defect |
|---|---|
| Opus, at integration | A session the database no longer accepts returned 400 instead of `UNAUTHORIZED` |
| Opus, at integration | Smoke drain probe failed about 1 run in 6 (test race, server correct) |
| P5-R1, R2 | A disabled bot at chat start returned 500 instead of 403 |
| P5-R1 | Each `/v1/sessions` call hit the database before any rate limit |
| P5-R1, R2 | Three retried functions had no `lock_timeout` |
| P5-R2 | Token TTL config accepted values the database refuses |
| P5-R2 | A test was left unable to fail after the version bump |
| P5-R3 | The per-bot session cap was spent before Turnstile, so about 20 addresses could lock out a bot |
| P5-R3 | A race ordering passed even when no deadlock happened |

## Existing tests changed
- **Six older pgTAP files:** fixture bots are created enabled, inside a rolled-back transaction, because 011 refuses disabled bots.
- **190:** the expected `proconfig` now includes `lock_timeout`.
- **220 and two integration tests:** schema version 11.
- **Run tests:** RB004 from `begin_request_run` is now `UNAUTHORIZED`.

## Not done or not proven
- **Race suite on the final tree:** not re-run by Opus, as above.
- **Rule-following race ordering:** waits about 1.8 s against a 2 s lock timeout, so it may flake on a slow machine.
- **Turnstile:** never called for real (fake verifier only). The widget must render Turnstile with action `session_create`; it doesn't exist yet.
- **Shared NAT:** the per-IP preflight is shared across bots, so one user behind a shared address can block session creation for others there. Keep `SESSION_PREFLIGHT_PER_IP_LIMIT` well above the per-bot per-IP limit.
- **Proxy hops:** a wrong `TRUSTED_PROXY_HOPS` puts everyone in one bucket. Measuring it on Render stays a P10 gate.
- **Contention:** `FOR SHARE` on the bot row for every start may contend under load. Untested; P11.
- **Bucket growth:** `rate_limit_buckets` grows under IPv6 rotation until the P6 worker schedules `purge_expired_rate_limit_buckets`.
- **Hosted database:** migration 011 needs owner approval to apply.
- **Design deviation:** the plan's `Db` insert, update and list methods were replaced by service-role RPCs.
