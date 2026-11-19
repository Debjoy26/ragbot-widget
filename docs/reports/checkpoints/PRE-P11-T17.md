# T17 - citation timing defects

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. Shared-server
change only (no migration; shared/server is not a frozen contract and T17
authorizes the fix).

Gap: six recorded 500ms delink failures — the F3/R1-3 timing tests flake under
parallel load (measured 502-749ms vs the 500ms bound), while passing isolated.

Profiling (main-run, controlled; CPU profiles on compiled dist output):
- findBareHosts re-scanned up to 64 chars at EVERY label position, because a
  >63-char dotless run yields an empty chain with end == start and the caller
  advanced by one: ~12.8M char visits for a 200k run (~100ms, superlinear
  tail at larger n). Confirmed top hotspot (68% of samples on dotless shapes).
- neutraliseMarkdown's destinationEnd burned the shared 64n budget on orphan
  tails whose scan provably cannot succeed (no `)` in range): ~50-200ms on
  `](`-heavy inputs.
- buildWork paid a closure call + triple array push per char (~48% of samples
  on dotted runs).

Fixes (all exact-behavior-preserving; no bound raised, no hostile case or
assertion dropped or weakened):
1. findBareHosts skips positions that provably cannot match: with a dotless
   64-window the chain is single-label, and a bare-host match needs >= 2
   labels, so jump to nextDot-64 (or the end when none remains). Skipped
   windows contain no dot and no dot at the boundary; any chain there would
   be single-label. Proof in code comment.
2. destinationEnd prechecks a memoized next-paren index: no `)` in range
   means the balance can never reach zero, so return -1 without scanning.
   The memo is monotonic with the left-to-right scan (resets correctly on
   any backward step); all callers unchanged.
3. buildWork bulk-copies ASCII runs (only `&`/`[`/`(`/`{` need the slow path;
   no ASCII invisible or dash mapping exists), identical pushes in identical
   order, no per-char closure dispatch.

New regression pin: a host after a 199990-char dotless run is still detected
(skip does not overshoot), with round-trip output equality.

Verification (main-run, root):
- Timing suites: 198/198 (incl. the new pin) across 5 runs — isolated,
  3x targeted repeats, and 2x full parallel api scope (45 files/1524 PASS;
  previously 2 failed in the same configuration).
- Worst isolated shapes now 12-68ms (was 25-240ms) — 5-10x margin to the
  bound; 400k (2x test size) worst 154ms, linear-enough, bounded.
- Full unit/shared suites green in scope (api 1524, shared 1123; worker/env
  families untouched, carried to T16/T18); typecheck 0; lint 0; format clean
  on touched files (temp profilers deleted).
- Residual note: no product/API behavior changed — same spans, same output
  (failing-budget paths now neutralize MORE, which is the fail-closed
  direction already pinned by the P7-R4 test).

Next T18 extraction/confinement and admin setup families; T03 stays COMPLETE
with carried limits.
