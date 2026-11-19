# T16 - first HTTP-test timing defect

COMPLETE 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. LOCAL only; no hosted/provider/release/commit action.
No DB migration (no schema change in T16).

Gap: the E1-era signature (first HTTP turn ~14.5s vs a 5s bound) had no
confirmed cause and no reproduction; the task required profiling
setup/ready/request/provider/cleanup under controlled load before any fix,
without raising timeouts or dropping assertions.

Profiling (main-run, this box, controlled single-file runs):
- Unit chat harness: setup() ~900ms sync (buildServer/Fastify-first-
  construction ~400-700ms, rest services/routes), first inject 150-300ms vs
  steady ~20ms, ready ~7ms. Second Fastify() in-process: ~0ms. Cause of the
  per-test cost is cold per-worker startup (transform + Fastify/AJV init),
  not product code: every service constructor measures ~0ms.
- Built API: spawn-to-ready 4.5s, first full RAG turn 1.5s (legitimate work),
  second turn 0.67s. Budgets (15-20s probes) accommodate boot; nothing slow.
- Bare `node` spawn on this box: 1.7-3s (environmental). A single
  `supabase status -o json` spawn: 5.6-7.8s (Docker queries; 25s under churn
  per the E1 archive).

Confirmed defect (reproduced TODAY, red): every integration file's `beforeAll`
paid TWO full CLI spawns — getLocalStack() plus getLocalPrivilegedKey(),
which spawned a second time instead of reusing the first call's output
(~11-16s on this box) — and the worker-runtime `beforeAll` exceeded its 10s
hook budget under parallel load ("Hook timed out in 10000ms"). Same
double-spawn tax hits all 15+ integration files using the pair.

Fix (test-first, bounded; no timeout raised, no assertion dropped or weakened):
- tests/integration/helpers/local-stack.ts: single memoized `loadStatus()`
  shared by both accessors; test-only `resetLocalStackCacheForTests()`.
  Values are pinned by the local stack config and cannot change mid-run;
  fresh workers re-read; loopback refusal preserved in both accessors.
- tests/unit/local-stack-helper.test.ts: 2 new pins (one spawn shared across
  both accessors; re-read after test-only reset) + cache reset in beforeEach
  to keep the 6 existing tests isolated. Red before (8 failed: helper missing;
  shared-spawn test failed with 2 calls), green after.

Verification (main-run, root):
- Helper units: 8/8 PASS. npm run typecheck exit 0; lint exit 0; format clean
  on touched files (temp profilers deleted).
- The exact failing combo (worker-runtime + sessions-route, hook timeout
  before): 23/23 PASS after the fix.
- Cache-warming trio (heaviest helper users): 34/34 PASS.
- What was deliberately NOT changed: product code (all stages healthy),
  vitest pooling/timeouts, per-test Fastify rebuild (isolation), the bare-node
  spawn cost (environmental: AV/contention; create-first-admin per-test
  spawns remain slowish but passing), the 500ms citation bounds (T17) and
  extraction/env failures (T18). Original advisor-timeout root cause stays
  unproven on its own track.

Next T17 citation timing defects; T03 stays COMPLETE with carried limits.
