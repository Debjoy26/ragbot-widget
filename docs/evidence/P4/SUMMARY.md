# Phase P4 — API foundation — 2026-11-06

Owner-approved. Branch `phase/p4`, not on `main` and not pushed until the owner approves. Base `main` @ `4cad62f`.
Environment: Node 24.22.2, Supabase CLI 3.0.0, local stack at migration 010.
Workers: `sonnet-implementer` ×5 on their own branches (P4-T1, T2, P4-D1, D2, D3), self-reported. Reviews: P4-R1 and P4-R3 (`security-reviewer`), P4-R2 (`reviewer`), static, self-reported. Opus joined the server and auth halves, wrote `api/src/app.ts` and `tests/integration/api-wiring.test.ts`, added `INTERNAL_ERROR`, and reran every gate below. No dependency added. No remote change.

## Final gates (Opus, integrated tree)
| Check | Exit | Result | Evidence |
|---|---|---|---|
| `npm run build` | 0 | Passed | `npm_build.txt` |
| `make db-local`, `make db-test` | 0 | 23 files, 2478 passed | `db-test.txt` |
| `make db-lint` | 0 | No schema errors | `db-lint.txt` |
| `make db-race` | 0 | 26 orderings, 0 problems, 0 warnings | `db-race.txt` |
| `make test-make` | 0 | 116 passed | `test-make.txt` |
| `npm run test:integration` | 0 | 576 passed | `integration.txt` |
| `npm test` | 0 | 1232 passed | `npm_test.txt` |
| `node scripts/api-smoke.mjs` | 0 | 25 passed: built server against the local stack, including bad config, CORS, drain and `SIGTERM` | `api-smoke.txt` |
| `npm run lint`, `format:check`, `typecheck` | 0 | Passed | `npm_*.txt` |
| `npm run secret-scan:self-test`, `scripts/secret-scan.sh --include-untracked` | 0 | No hits | `secret-self.txt`, `secret-scan.txt` |

## Delivered
- `api/src/lib/config.ts`: Zod-validated env, fail closed, no defaults for limits; secrets kept out of serialised config.
- `api/src/lib/logger.ts`: structured logging with redaction; generated request ids.
- `api/src/lib/errors.ts`: stable error envelope for every path, including framework and client errors.
- `api/src/lib/supabase.ts`: fetch-based server-only database client.
- `api/src/lib/client-ip.ts`, `request.clientIp`: canonical client IP from `TRUSTED_PROXY_HOPS`.
- `api/src/server.ts`, `app.ts`, `main.ts`, `lib/headers.ts`, `lib/lifecycle.ts`: limits, CORS, security headers, graceful drain.
- `api/src/routes/health.ts`: `/health/live`, `/health/ready`, bounded, single-flight, cached, no detail.
- `api/src/services/auth.ts`: HMAC visitor tokens checked against `visitor_sessions`, with secret rotation.
- `shared`: `INTERNAL_ERROR` added; missing-policy database states map to it.
- CI: API smoke step after build.

Acceptance from `plan.md`: expired, forged and wrong-bot tokens are refused, in unit and real-stack tests.

## Defects found and fixed
| Found by | Defect |
|---|---|
| Opus, at integration | Forged tokens would have returned `INVALID_REQUEST` instead of `UNAUTHORIZED` |
| P4-R1, R2, confirmed by test | `/%zz` echoed the URL and query string in a default Fastify body |
| P4-R2 | Shutdown would kill chats before they settled; readiness stayed 200 while draining |
| P4-R2 | Server-side permission faults reached visitors as `FORBIDDEN` (R3-7) |
| P4-R2 | `request.ip` behind a proxy would put all visitors in one rate-limit bucket |
| P4-R1 | Secrets printable through a logged config object |
| P4-R2 | `selectOne` could not detect a non-unique row |
| P4-R3 | Large timeouts overflowed the shutdown timer, forcing immediate exit on `SIGTERM` |
| P4-R3 | Readiness cache used the wall clock; a TTL cut logged visitors out with the wrong code |
| Secret scan | 17 fake test values and false positives. Literals replaced by generated values, no exemptions added |

An early commit on the branch (`1a2c674`) was made while the scan was failing, because the steps were chained. It held fake values only and was never pushed. The last commit was gated on every check.

## Existing tests changed
`server.test.ts`, `api-wiring`: `INTERNAL_ERROR` replaces caller-class codes for server faults. `supabase-client.test.ts`: `limit=2`. `auth-hardening`: `SESSION_EXPIRED` after a TTL cut. `config-hardening`: timeout relation tests replaced, because the first rule rested on a wrong premise. `events-errors`, `db-errors`: 12 codes.

## Not done or not proven
- **P4-D2 and P4-D3 were not independently re-reviewed.** They are covered by tests and integration by Opus.
- **No mutation run across the API suite.** Individual fixes were shown to fail on old code by the workers (self-reported).
- **Not on a real host:** `TRUSTED_PROXY_HOPS` isn't measured on Render, and no Render deploy exists. The API has not run against the hosted database.
- **`REQUEST_TIMEOUT_MS` firing isn't tested**, because Node's check interval is 30 seconds.
- **Redaction is a name list**, four levels deep. Later routes must log only ids, counts and codes.
- **Later-phase obligations:** `plan.md` P4 section.
