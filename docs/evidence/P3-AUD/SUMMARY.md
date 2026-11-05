# P0–P3 audit and live database check — 2026-11-06

Base: `main` @ `e2a044e`, plus uncommitted owner doc edits and ADR 0017, which are treated as current.
Audits AUD-P0, P1, P2, P3-S (`reviewer`) and AUD-P3-X (`security-reviewer`): static, read-only, self-reported, no database access.
Live check: Opus, on dev project `rbejeqwxyxtklehuzibv`. Read-only `SELECT`s through MCP, anonymous HTTP reads with the public key. Local stack at 001–007 for comparison. No writes. No fixes made.

## Live database against the updated architecture

### Local and remote catalogs
Same SQL on both, md5 per category.

| Category | Count (remote) | Result |
|---|---|---|
| Table grants | 32 | Identical |
| Column privileges | 306 | Identical |
| Policies (`public`, `storage`) | 9 | Identical |
| Functions, including source, security mode, config and execute rights | 32 | Identical, excluding `reserve_request_budget` (changed in 007) |
| Triggers | 10 | Identical, excluding the 007 trigger |
| Constraints | 130 | Identical |
| Indexes | 70 | Identical |
| Columns | 201 | Identical |
| Global default ACL | 1 | Identical |

Local has one more function and one more trigger, both from 007. The remote therefore differs from the repo only by 007.

### Compliant on the live project
- `anon` holds only SELECT on `public_bot_config`. No function is executable by `anon`.
- `authenticated` holds SELECT only, on 9 tables. No write grants on any public table, as ADR 0017 requires.
- `bot_profiles`, `client_settings`, `document_chunks`, `jobs`, `usage_events`, memberships, sessions, budgets, runs and caches: no authenticated grant.
- `authenticated` can execute exactly the 5 documented functions, all `SECURITY DEFINER`. Every public function pins `search_path`.
- All 9 policies are SELECT, and all except `public_bot_config` go through `is_active_member_mfa`. `data_entries` and `audit_logs` are owner and admin only.
- Bucket `knowledge`: private, 20 MiB, PDF, Markdown and text only. No Realtime publication, no public views, `pg_graphql` off, no `pg_cron` (worker schedules cleanup, as documented).
- Anonymous HTTP: `public_bot_config` 200, all 21 other tables 401. REST root 401. Bucket list empty, object list empty (the bucket is empty too, so this does not prove the deny on its own), public object URL 400.
- Auth: email is the only provider, email confirmation required, SAML off.

### Not compliant or absent on the live project
| ID | Finding | Why |
|---|---|---|
| L-1 | Migration 007 not applied | Awaiting owner approval |
| L-2 | No admin write RPC exists | ADR 0017 writes need P3.5 |
| L-3 | `storage.objects` has 0 policies | Deny-all today. `anon` and `authenticated` hold full table grants (Supabase default), so RLS is the only barrier. P3.5 policies must be `to authenticated`, never `to public` |
| L-4 | `messages_select_members` has no `role <> 'system'` filter | Conflicts with the ruling in `plan.md` §1a |
| L-5 | `public_bot_config` is readable only when published | Admins can't read their own unpublished bot (B-3) |
| L-6 | Public signup on (`disable_signup: false`) | Open signup gives anyone `authenticated`, which reaches every P3.5 function |
| L-7 | `audit_logs` has no writer other than `service_role` | ADR 0017 RPCs must write audit rows; the matrix ruling still says service role only |

### Not checked
- `authenticated` over real HTTP, and a real `aal2` session. This needs a test user, which is a remote write.
- Remote TOTP settings. The public settings endpoint doesn't expose them; 0 MFA factors exist. Needs the dashboard.
- Exposed schemas and JWT expiry settings.
- pgTAP and race checks have run locally and in CI, never against the remote.

## Debug cycle P3-D5: gaps to close before the next phase
Verified: **E** by execution, **R** by Opus reading code or the live catalog, **A** auditor report only.

### Database (migration 008, plus 007, on local first)
| ID | Source | Severity | Verified | Gap | Fix |
|---|---|---|---|---|---|
| G-1 | P2-1 | High | E | `mark_document_deleted` writes `{document_id, bot_id}`; `jobSchema` rejects it | Emit the schema's shape; test with the real SQL payload |
| G-2 | P3S-2 | Medium | R | Nothing increments `settings_version` | Triggers on the three settings tables, or document RPC-only and test it |
| G-3 | P3S-5, P3X-3 | Medium | R | `jobs.dedupe_key` is unique forever, and `on conflict do nothing` hides it | Partial unique index on live jobs, or a version and epoch in the key |
| G-4 | P3S-8 | Low-Medium | R | `message_sources` can reference another bot's chunk or version | Ownership constraint or trigger, with a negative test |
| G-5 | L-4, P3X-1 | Medium | R | Members can read `system` messages | New policy excluding `role = 'system'`; pgTAP per role |
| G-6 | P3S-3, P3S-4 | Medium | A | No `failure_code`, `batches_done`, `batches_total`, `chunking_version`, `extraction_version` on `document_versions` | Add columns with CHECKs |
| G-7 | P3S-9 | Low | A | Terminal `jobs` rows are never purged | Purge function, with tests |
| G-8 | P3X-7 | Low | A | `document_versions.storage_path` has no pattern CHECK | Add the CHECK |

### Tests
| ID | Source | Severity | Verified | Gap |
|---|---|---|---|---|
| G-9 | P3S-6 | Medium | A | `query_embedding_cache` purge not exercised; argument bounds missing on 4 purge RPCs and on `expire_visitor_sessions` above 10000; no source-deletion snapshot test; no `data_entries_conversation_fk` test |
| G-10 | §3a ac | Medium | R | No race tests for `claim_jobs`, `begin_request_run`, `record_rate_limit_attempt` or parallel budget reservation |
| G-11 | P2-6, P2-1 | Medium | A | No tests for session schemas, admin schemas, `idParamSchema`; happy-path only for `sourceRefSchema`; chat strictness doesn't name `role`, `usage`, `sources`, `citations`, `provider`, `temperature`; no NUL case |
| G-12 | AUD-P2 (b) | Low | A | The enum test checks TypeScript copies, so SQL drift goes unnoticed. Compare against the migrations |
| G-13 | P3X-2 | Medium | A | Storage negative tests lack `aal2`, and the policy census matches text only |

### Shared contracts
| ID | Source | Severity | Verified | Gap |
|---|---|---|---|---|
| G-14 | P2-3 | High for P3.5 | A | No SQLSTATE-to-error mapping in `shared`; `RB0xx`, `begin_request_run` outcomes and B-11 codes absent |
| G-15 | P2-4 | Medium | E | `excerpt` rejects newlines and `a > b`. Specify a normaliser or loosen it |
| G-16 | P2-2 | Medium | A | Mark `/v1/admin/*` shapes `@deprecated`. Removal stays in P3.5 |
| G-17 | P2-8 | Medium | A | Invented shapes unconfirmed. History `has_more` has no cursor; idempotent replay response undefined |
| G-18 | P3S-10 | Low | A | Policy JSON keys SQL depends on have no contract in `shared` |

### Tooling and CI
| ID | Source | Severity | Verified | Gap |
|---|---|---|---|---|
| G-19 | P1-6 | High | E | `test:integration` passes with zero tests; `test:e2e` exits 1 with zero tests and isn't in CI; no secret scan |
| G-20 | P1-3 | Medium | R | API and worker dev scripts share root `.env`. The secret isn't there today. Load per workspace; worker refuses `VISITOR_TOKEN_SECRET` |
| G-21 | P1-4 | Medium | R | 45 evidence `.log` files ignored by git, and none are tracked for P1, while summaries cite them |
| G-22 | P1-5, P1-7 | Low | R | ESLint doesn't ignore `.claude/**`; CI has no `db lint`; no `--max-warnings 0` |
| G-23 | P3S-1 | Medium | R | Operator script for the first admin is missing (`plan.md:126`). Add it, with a test that a new owner at `aal1` sees nothing |
| G-24 | B-13 to B-15 | Medium | R | Local TOTP off, no admin dev redirect, no test-user fixture. No real `aal2` test possible until done |

### Docs
| ID | Source | Gap |
|---|---|---|
| G-25 | P0-7, P3X-5 | `DATABASE_SCHEMA`: "Restricted management API" and "only the service role writes" audit rows predate ADR 0017; RB012 and RB013 missing; `is_published` and `reply_to_message_id` missing from Tables |
| G-26 | P1-1, P1-2 | `README` layout: mark the tree as cumulative by phase; add missing files; migrations stop at 005; "no runnable application code" is stale |
| G-27 | P0-8, P0-9 | `PRD` open decisions; `plan.md` P3 table stops at 005, D12–D14 missing; ADR 0012 and 0006 need Gemini notes; ADR 0001 stale |
| G-28 | P3S doc list | `TECH_SPECS:80` "All caches are bot-scoped" conflicts with tables that have no `bot_id`; `plan.md:244` index differs; P5 "one generation per conversation" has no schema support; `usage_events` lacks a failed or fallback flag |
| G-29 | P0-2 | Name the feature-flag keys for moderation mode, Turnstile, Markdown and history in `DATABASE_SCHEMA` |

## Owner decisions needed
| ID | Decision | Blocks |
|---|---|---|
| O-1 | Approve P3-D5 scope | P3-D5 |
| O-2 | Apply 007 and 008 to the remote, and when | Remote compliance |
| O-3 | Turn off public signup on the remote (L-6) | P3.5 acceptance |
| O-4 | Check remote TOTP in the dashboard; disable phone MFA | P3.5 acceptance |
| O-5 | Approve P3.5 scope and the `plan.md` §1a rulings; no ADR covers them | P3.5 |
| O-6 | Commit the uncommitted doc edits and ADR 0017 | Doc baseline |
| O-7 | Confirm ADR 0016 | Retention |
| O-8 | Blocked text for analysts: policy, or accept (R3-8) | P7 |
| O-9 | `audit_logs` retention policy | P9 |
| O-10 | Run the embedding retrieval check before corpus grows; 1536 is live | P6 |
| O-11 | P3.5 before P4, or in parallel | Sequencing |

## Stays in P3.5, by design
L-2, L-3, L-5, L-7: admin RPCs, Storage policies, safe settings read, audit writes. Also the settings parity fixture (P2-5, P3X-9), quotas on admin RPCs (P3X-4), reindex by new version (P3X-3), audit metadata allowlist (P3X-8), census allowlist, removal of admin shapes, the enable-time contact gate (P3S-7).

## Before client data or go-live only
Production daily cap; jurisdiction and DPAs; paid Gemini billing; second provider key; Cloudflare details; per-client contacts; Render and Vercel accounts and spend caps; `jwt_expiry` and session limits.

## Known limits of this list
Audits were keyword and spot reads, and items marked A were not verified by Opus. The list covers what was found, not everything that exists. The admin repo was not read.
