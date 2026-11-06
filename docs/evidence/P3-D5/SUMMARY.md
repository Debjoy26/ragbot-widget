# Debug cycle P3-D5 and phase P3.5 — 2026-11-06

Owner-approved: "complete P3-D5 and P3.5, debugged, before P4". Base `main` @ `13b81e8`. Local stack only.
Environment: Node 24.22.2, Supabase CLI 3.0.0, GNU Make 4.4.1.
Workers: `sonnet-implementer` ×8 task runs (P3-D5-T1, T2, T3; P3.5-T1, T2, T3; P35-D1-A, B), self-reported. Reviews: P3.5-R1 and R3 (`security-reviewer`), P3.5-R2 (`reviewer`), static, self-reported. Opus integrated each wave, read the migrations' guards and policies, made the final fixes and reran every gate below.

**Nothing here is applied to the remote dev project.** It is still at migration 006. No remote write was made.

## Final gates (Opus, integrated tree)
| Check | Exit | Result | Evidence |
|---|---|---|---|
| `make db-local` | 0 | 001–010 and dev seed | `db-local.txt` |
| `make db-test` | 0 | 23 files, 2478 passed | `db-test.txt` |
| `make db-lint` | 0 | No schema errors | `db-lint.txt` |
| `make db-race` | 0 | 26 orderings, 0 problems, 0 warnings | `db-race.txt` |
| `make test-make` | 0 | 116 passed | `test-make.txt` |
| `npm run test:integration` | 0 | 530 passed, including real TOTP and `aal2` sessions over HTTP, and 239 SQL and Zod settings parity cases | `integration.txt` |
| `npm test` | 0 | 760 passed | `npm_test.txt` |
| `npm run lint`, `format:check`, `typecheck`, `build` | 0 | Passed | `npm_*.txt` |
| `npm run secret-scan:self-test`, `scripts/secret-scan.sh --include-untracked` | 0 | No hits | `secret-self.txt`, `secret-scan.txt` |
| `supabase db advisors --type all --level warn` (local) | not captured | No issues found | `advisors-local.txt` |

## Delivered
- **Migrations:** 008 (P3-D5 G-1 to G-8), 009 (documents, Storage, job budget), 010 (settings, conversations, identity). 007 from P3-D4.
- **Admin data layer:** 15 browser-callable RPCs, Storage policies, audit and quota helpers. Table in `DATABASE_SCHEMA.md` "Admin RPCs".
- **Shared:** retired `/v1/admin/*` contracts removed; database error map, RPC response schemas, policy schemas, excerpt normaliser.
- **Tooling:** integration gate needs real tests, secret scan, worker env guard, evidence logs tracked, first-admin script, test-user seed script, local TOTP.
- **ADR 0017 open questions:** answered in the ADR.

## Backlog outcome
G-1 to G-16, G-18 to G-27, G-29: closed. Partly closed:
- G-17: `before` cursor and replay shape defined; shapes in `status.md §3a t` stay unconfirmed by the owner.
- G-28: doc conflicts fixed; the `usage_events` failed or fallback flag is deferred to P7.

## Defects found by the process and fixed
| Found by | Defect |
|---|---|
| P3.5-R2, real session | Seed `business_hours` shape refused every edit of the dev bot |
| P3.5-R2 | A job could never re-reserve budget after a retry |
| P3.5-R1 | Settled or expired reservations reused with no cap re-check |
| P3.5-R1, R2 | `allowed_languages` not kept in step with `supported_languages` |
| P3.5-R1 | Deleted documents still downloadable; pre-registered accounts adoptable as owner; unlimited write RPCs; prompt text could carry invisible characters |
| P3.5-R2 | Versions stuck with no recovery path after a dead-lettered job |
| P3.5-R3 | Write quota could block the emergency disable; self-registered unconfirmed account still adoptable; a stale settle could exceed the cap |
| Secret scan | Opus's own evidence file held a local-stack S3 key. Removed, and the unpushed commits carrying it were squashed |

## Existing tests changed
- 130, 170, 180: earlier cycles. 030: named allowlists replace the census counts. 100: rewritten with real `aal2` claims, and its delete case now asserts the exact error.
- 010, 040, 050, 080, 120: `storage_path` fixture literals, for the G-8 CHECK.
- 210, 220, `admin-real-session`, parity: expectations moved with deliberate behaviour changes: expired job reservations count; disabling is not a counted write; a repeat delete is a no-op; `tone` is single-line.

## Not done or not proven
- **Mutation checks on the real-session suite were not run.** The worker's attempt was blocked and the owner stopped Opus's run. P3.5-T1 mutated the Storage INSERT policy and `admin_require` against pgTAP, which failed as expected (self-reported).
- **The final fixes after P3.5-R3 were not re-reviewed.** They are covered by tests and an Opus read.
- **Remote:** 007 to 010 not applied; signup still on; TOTP unknown. Migrations have never run against real data.
- **Races not tested:** same job reserved twice, retry racing a running worker, stale settle under load.
- **Reviewer items left open:**
  - R3-4, R3-5 (P6): the worker must settle or release on every exit, fence chunk writes, fail closed on a null `upload_etag`. Recorded in `DATABASE_SCHEMA.md`.
  - R3-6: URLs get no format-character check.
  - R3-7: some operator faults map to caller-class API codes. Revisit in P4.
  - S-10: the secret scan is a heuristic.
  - Denied attempts are not audited, because they roll back. Signed URLs can't be recalled. Both are documented.
- **Admin panel:** must run `contracts:sync`: `/v1/admin/*` types are gone, `AdminBotSettingsPatch` is `BotSettingsPatch`, new error map and RPC schemas. The admin repo was not read.
