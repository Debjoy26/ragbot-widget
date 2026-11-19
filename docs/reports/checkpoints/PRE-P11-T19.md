# T19 - Windows database and Make gates

COMPLETE 2026-11-19 (one real fix; one carried platform limitation, no product
impact). Root p7.5/d4-integration@aa6425a plus preserved dirty overlay,
Node26.13.1. No hosted/provider/release/commit action. One Makefile line
changed (T19-authorized; Makefile is not a frozen contract). Local schema 027,
hosted-last 017 unchanged.

T19a FIX — `db-lint` v4-future-proof (verified, no behavior change):
- `npx --no-install supabase db lint --local` on pinned CLI 3.0.0 prints
  `Warning: --local isn't needed (local is the default) and will be removed
  in v4`, then lints clean (`No schema errors found`, extensions + public).
- Removed the deprecated `--local` from the `db-lint` recipe, matching the
  Makefile's own line-95 comment (the CLI has no `--local` flag for local
  commands; local is the default). Re-ran without the flag: `No schema errors
  found`, exit 0.

T19b Make-binary status (carried limitation, recorded exactly):
- No GNU `make` on this Windows box (`Get-Command make` empty; no make.exe in
  Git usr/bin) and WSL is broken (disk-attach failure), so `make <target>`
  cannot execute here. Installing make is a toolchain install — NOT done
  (owner approval required).
- Ran the guard script directly via Git Bash
  (`bash scripts/test-make-guards.sh`): 111 passed / 5 failed. All 5 failures
  exec `make` itself (rc=127 / "did not reach the stub"): db-plan, db-create,
  first-admin stub-reach tests + check-ref/check-confirm standalone accepts.
  All 111 pure guard-logic checks pass — the guards are sound, only the
  `make` runner is missing.
- `db-race` recipe (`bash scripts/race-db.sh`, docker-exec psql) and `db-test`
  (`supabase test db`) are thin wrappers over CLIs present here; their real
  runs are T25's gates, executed via Git Bash direct invocation (the supported
  path on a make-less box). Managed Storage static-lint findings stay T19-open
  as before (no runtime Storage defect established).

Next: T20 API smoke + worker-drain shutdown behavior (incl. 4 cases routed
from T18f). T22 combined analysis rerun must still start from a clean DB.
