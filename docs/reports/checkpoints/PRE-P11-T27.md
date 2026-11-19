# T27 - running-system/guard gates

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T27 (verification only). Local schema 027, hosted-last 017
unchanged.

Results (main-run, root):
- T27-a API smoke `node scripts/api-smoke.mjs`: 33 passed, 0 failed,
  2 skipped (T20 POSIX-only drain guards; re-verified post-prettier in T24).
- T27-b compiled worker `node scripts/worker-dist-check.mjs`: PASS
  (dist child ok: pdf_text x1 pdfjs-6.4.299, 2 pages, 156 chars).
- T27-c Make guards `bash scripts/test-make-guards.sh` (Git Bash): 111
  passed / 5 failed — identical to T19; all 5 exec the absent `make` binary
  (rc=127). Guard logic sound; `make` install needs owner approval.
- T27-d secret self-test: 27 passed, 0 failed (Git Bash; npm bare-`bash`
  hits broken WSL — environment note, same as T21).
- T27-e untracked-inclusive scan: same 14 hits as T21, dispositions
  unchanged (1 owner-kept demo, 2 test fakes, 3 restore-test runtime fakes,
  8 codex transcript for owner triage). No new hits from the T20/T24 edits.
  Values never printed. Tracked-only scan stays at the 1 known owner-kept hit.

No new findings. The T25-race and T26 single-command gates stay OPEN per
their checkpoints (host memory/exec-speed bound); everything else here is
closed. Next: T28 docs sync + STOP BEFORE P11.
