# Security review P3-R4 — 2026-11-05

Scope: debug cycle P3-D3 (code `815cfb9`, base `main` @ `0059991`): migration 006, pgTAP 170 and 180, the race script, `Makefile`, `database/`, the FDE section of `README.md`.
Reviewer: `security-reviewer` (configured `claude-sonnet-5-5`), static, read-only. Its report is self-reported.
Opus verification: code read of the cited lines, plus the commands below. pgTAP and the race script were not rerun. No fixes made. No remote write. This is not an approval.

## Findings after Opus verification
| ID | Severity | State after verification | Summary | Proposed fix |
|---|---|---|---|---|
| R4-3 | Low-Medium (raised from Low) | Confirmed by execution | `check-ref` expands `PROJECT_REF` into shell text before validating it, so a crafted value runs a command. An exported `PROJECT_REF` is accepted silently. | Validate `$$PROJECT_REF` through the environment; accept only a command-line value, or print the ref first |
| R4-2 | Low-Medium | Confirmed by code read; exploit needs an API and worker that do not exist | The reaper threshold is only bounded to 60..86400 s, not tied to the maximum request duration. A reaped run that is still going frees its concurrency slot and budget hold, so later spend can exceed the cap. Better than before 006, when that spend was not counted at all. | P5/P9: hard request deadline below the reaper threshold, pinned by a test. Or a new migration that counts recent `expired` reservations |
| R4-1 | Low (lowered from Medium) | Main claim refuted; residual remains | The CLI honours `--remote=<ref>`, see below. Residual: `db-create` has no typed confirmation, so a valid but wrong ref relies on the CLI prompt. | Add `CONFIRM_REF`; print the ref before remote commands |
| R4-4 | Low | Confirmed | Race script covers INSERT orderings only and is manual. The only CI check of the lock is the regex `for\s+share` (`180:75`), which a comment would satisfy. | Add UPDATE and DELETE orderings; tighten the regex |
| R4-6 | Low/Info | Confirmed by code read; unreachable today | First trigger branch (`006:60-62`) still runs under the invoker's RLS, so a non-BYPASSRLS writer could skip it. Only `service_role` writes today. | Catalog test: no other role holds INSERT or UPDATE on `messages` |
| R4-5 | Low | Hypothesis, not tested | `FOR SHARE` could deadlock if an API transaction inserts a reply and then updates the question row. No such API exists. | P5 obligation: no question UPDATE after the reply in one transaction; set `lock_timeout` |
| R4-7 | Info | Confirmed by code read | `170:214` (self-reply) is now caught by the trigger, not the CHECK, so that CHECK is no longer exercised by this test. | Assert the message or constraint name |
| R4-8 | Info | Confirmed by code read | Comment at `004:418-419` still says the reaper releases reservations. `reserve_request_budget` does not check run state, so a reaped run can still get a reservation. | Note in a later migration; check run state |
| R4-9 | Info | Partly verified | `db reset` and `test db` are local by default (CLI help), but `db-local` and `db-test` do not state it. `db-advisors` still not run. Password guidance in `database/README.md` could be safer. | Reviewer proposed `--local`; check the flag exists in CLI 3.0.0, since help lists only `--remote` |

The review answered its five questions without a finding on: 006 keeping owner, grants, `search_path` and security mode; `expired` handling and double settle; existence leaks in the error text. These are static conclusions by the reviewer. Opus checked the cited reserve and reaper code, not every claim.

## Verification commands
Environment: cwd repo root, Supabase CLI 3.0.0, revision `0059991`, worktree clean.

| Check | Exit | Result |
|---|---|---|
| `make check-ref` with the reviewer's example payload | 2 | Bash syntax error, nothing ran. The example as written does not work |
| `make check-ref` with a payload that closes `[[ ]]` first, `touch` on a scratchpad marker file | 2 | **Marker file created.** The injected command ran, then the target failed |
| `PROJECT_REF=abcdefghijklmnopqrst make check-ref` (exported, not on the command line) | 0 | Accepted silently |
| `supabase migration list --remote=abcdefghijklmnopqrst` (read-only; ref is not the linked project, which is `rbejeqwxyxtklehuzibv`) | not captured (pipeline) | Printed `Target: project abcdefghijklmnopqrst (not the linked project)`, then failed with `DbConfigIpv6Error`. Linked project not used |
| `supabase db reset --help`, `supabase test db --help` | not captured | Both say local by default; `--remote` is needed to target a remote |

The non-linked ref check shows the ref is honoured by `migration list`. `db push` documents the same flag but was not run with a non-linked ref. The ref used is a placeholder, and the CLI stopped before connecting.

## Not covered
- All dynamic behaviour other than the commands above. pgTAP (1485) and race results are from P3-D3, not rerun.
- Remote ACLs, role attributes and hosted default privileges.
- TECH_SPECS §9 negative cases were not compared in full.
- Missing test cases listed by the reviewer, not yet triaged: UPDATE path of `reply_to_message_id`; writer without UPDATE gets 42501; release after reap; reserve retry after reap; reaper after sweeper; late-settle overshoot; settle across UTC midnight; settle after purge; reaper races with settle, release and reserve; reaper with `p_batch` below the number of stuck runs.

## CI check (same session)
`gh run list`: run 41708210161 for `19438c5` and run 41974998511 for `0059991` completed with success. `0059991` contains the P3-D3 code. `815cfb9` has no run of its own. Overall results only; individual jobs not inspected.
