# FIX-D1 — pre-billing fix batch — evidence (`fix/d1`, base `main` @ `4ee7f59`)

> Owner directive: fix everything fixable without paid calls before billing.
> No migration, no hosted write, no push. Branch `fix/d1`, unmerged.

## Defects fixed (test-first)

1. **secret-scan self-test, Windows probe (red before, green after).**
   The fail-closed probe used a file named `:odd.env`; Windows filesystems
   refuse a leading colon, so git never emitted the line and the probe failed
   empty (26 passed, 1 failed). Worse, the probe called `named_filter`,
   which is defined later in the file than the self-test block, so a naive
   inline call fails with "command not found" (bash executes top-level
   blocks in order). The probe now feeds the same shape through the real
   `named_filter`, extracted from this same file at run time (no duplication):
   identical assertion (exactly one `unparsed` verdict, value never echoed).
   Full self-test after the fix: **27 passed, 0 failed**.
2. **P9 analysis save-path RB037 retried to dead-letter (red before, green after).**
   A conversation deleted between the context read and `save_conversation_analysis`
   threw, retrying to `max_attempts` for a row that can never be written.
   New regression test `returns quietly when the conversation vanishes before
   save` failed first (`DbError ... RB037` thrown), then the handler was fixed
   to settle the real spend and return quietly, mirroring the context-read path.
   `analyze-conversation.test.ts`: 11/11, worker suite files green in isolation.

## Deliberately not changed (documented, no code)

- Transient-retry estimate is recorded before the throw: fail-closed
  over-count, bounded by one estimate per attempt — by design; clarifying
  comment added in code (P6 precedent).
- `get_analysis_context` takes no `bot_id`: job rows are service-role-only,
  so a mismatch requires service-role compromise (game over anyway). Accepted
  risk; no migration.
- Queue fallback select returning a terminal id: the API ignores the return
  (`enqueue` returns void). Cosmetic; a migration to reorder it is not worth it.
- Full-unit timing flakes, PDF-child suites, integration signal suites,
  api-smoke SIGTERM checks, race-db npipe guard, missing `make`, CRLF history:
  environmental or by design (unchanged by this batch; documented in `status.md`).

## Gates (this box, Node 26.13.1, local stack at 017, clean seed)

- `typecheck`, `lint`, `format:check`: exit 0. `bash -n` on the script: clean.
- Full `npm test`: flakes only, in documented families; every touched file
  green in isolation (111 worker incl. new test; 15 deploy/smoke).
- pgTAP: unchanged schema (no migration in this batch); prior 28/3399 stands.
- `secret-scan --self-test`: 27/27. Default scan: only the owner-kept demo key.

## Open (owner)

- Merge `fix/d1` → `main` + push (awaiting approval).
- P11 start + paid-tier billing + fallback key; P7–P10 acceptances.
- 018 analysis-policy migration, C8 warmer wiring, D1 moderation-L2: decisions,
  not defects — untouched.
