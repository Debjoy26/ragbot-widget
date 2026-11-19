# T26 - full unit + integration gates

PARTIAL 2026-11-19. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1. No hosted/provider/release/commit action. No product or
test change in T26 (verification only). Local schema 027 (post-T22 reset; T26
runs added rows/users, no migrations), hosted-last 017 unchanged.

ROOT CAUSE (measured): the Windows host is out of memory — 0.5 GB free of
7.7 GB (Spotify/VS Code/Edge + Docker Desktop VM competing; owner activity,
nothing this session can legitimately kill). Consequences measured: bare
`node -e` 2.6s (normal ~0.1s), `node scripts/deploy-client.mjs --help` 24s,
`docker exec psql SELECT 1` 3.5-7s. Any 5s-timeout suite collapses; no code or
test change can fix host paging, and timeouts were NOT raised (T16 rule).

T26-a full unit `npm test` (single command): 6 files failed, 68-70 failed /
~3431 passed (3501), 43+ failures are `Test timed out in 5000ms`. Full log:
`C:\Users\DEBJOY\AppData\Local\Temp\opencode\unit-full.log`. Contention-flake
hypothesis CONFIRMED — every failing file re-run alone this session, all
green: browser-and-enums 3/3, chunk 56/56, create-first-admin 8/8,
extract 32/32, extract-confinement 12/12, index-document 129/129.
deploy-client fails 1-6/8 across runs, always and only by 5s timeouts on
`node` spawns (24s measured above). Remaining assertion diffs
(FILE_UNSUPPORTED-vs-expected etc.) occur only inside the same loaded runs
and never in isolation — timeout cascades, not product regressions.

T26-b full integration (single command): NOT run — same collapse mechanism
proven by a 5-file batch (db-boundary suite failed on its beforeAll hook,
then 24/24 alone in 12s). Instead, file-by-file coverage run this session,
ALL GREEN: first-admin 21/21 (T18b), settings-parity 264/264 (T18c),
local-stack-helper 8/8 (T18c), admin-real-session 244/244 (T18d), api-wiring
10/10 + limits/visitor-auth 40/40 (T18e), ingestion-e2e green +
ingestion-process 6 passed/4 POSIX-skipped (T18f/T20), chat-e2e 82/82 +
worker-runtime 7/7 (T18f), analysis-budget+scheduling 18/18 combined (T22),
restore-checker 18/18 + widget 73/73 + shared/policy 1140/1140 (T23),
api-health/api-socket/sessions-route/cache-metrics 36/36 + db-boundary 24/24
(this task), cache-warming-policy/queue/version 34/34 + roundtrip 1/1 (this
task).

Carry: T26-a single-command full unit stays OPEN until re-run on a host with
free memory (final: 3497/3501, 4 PDF-child 5s timeouts in extract.test.ts at
0.2GB free; every failing file proven green alone when the box was healthier).
T26-b CLOSED 2026-11-19: `npm run test:integration -- --maxWorkers=4` on a
clean reset DB — 23 files, 848 passed, 4 POSIX-skipped, 0 failed, exit 0
(log: docs/evidence/T26/integration-full.log). File-by-file evidence above
stands as supporting basis. Worker-count flags change only parallelism, never
assertions. No test was weakened, skipped (except the T20 POSIX-only signal
cases), or deleted to get here.
