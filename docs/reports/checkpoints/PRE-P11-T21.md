# T21 - guards and secret scanner

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T21 (verification + classification only; no values printed
anywhere). Local schema 027, hosted-last 017 unchanged.

Verification (main-run, root; Git Bash direct invocation — the npm scripts'
bare `bash` resolves to the broken WSL shim on this box):
- `bash scripts/secret-scan.sh --self-test`: 27 passed, 0 failed.
- `bash scripts/secret-scan.sh` (tracked only): 1 hit —
  `widget/public/index.html:14 named-secret`. This is the known owner-kept
  demo hit: a tracked file under the standing preserve-owner-edits
  instruction. Not removed, not printed, not weakened.
- `bash scripts/secret-scan.sh --include-untracked`: 14 hits, classified by
  location/context only (values never read or printed):
  1. `widget/public/index.html:14` — owner-kept demo hit (above).
  2. `tests/integration/cache-warming-roundtrip.test.ts:125`,
     `tests/unit/local-stack-helper.test.ts:18` — test fake/placeholder
     markers, short lines; benign test fixtures (both files untracked).
  3. `tests/integration/restore-collector.test.ts:15`,
     `tests/unit/restore-project-check.test.ts:20,93` — postgres URLs naming
     supabase.co hosts inside untracked T23-scope restore-test files.
     Real-vs-placeholder UNVERIFIED (values deliberately not read) —
     carried to the T23 file review, which owns these files. Nothing here is
     committed or in any build output.
  4. `codex-session-01a1e923-...md` (8 hits) — untracked third-party session
     transcript at repo root, not code/tests/docs of this repo. Recommend
     owner triage (keep elsewhere or delete); values never printed.
- Make guards (from T19, unchanged): 111/116 pass via Git Bash; the 5 failures
  exec the absent `make` binary (rc=127). Guard logic itself is sound.

No real-secret defect established. No concealment: every hit is listed above
by location with its disposition.

Next: T22 combined analysis rerun on a clean DB (reset first — the T18a
handback-pollution finding requires it). Then T23 (owns the restore-test URL
classification above), T24-T27 full gates, T28 sync + STOP BEFORE P11.
