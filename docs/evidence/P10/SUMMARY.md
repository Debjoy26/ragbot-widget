# P10 — Observability & ops hardening — evidence (`phase/p10`)

> Base `main` @ `e1c2c18` (P9 merged). No migration, no API/worker behavior
> change, no hosted write, no push. Docker recovered (`wsl --shutdown` +
> Desktop restart). Local stack at 017.

## Scope (plan.md P10, TECH_SPECS §8 obligations)

- T1 (`d908d64`): `render.yaml` (API web + worker, every key `sync: false`,
  no values), `clients/example/deployment.example.json` (public IDs only,
  `<placeholder>` values), `scripts/deploy-client.mjs` (validates shape,
  refuses secret-like values, prints the README checklist), unit tests
  `tests/unit/deploy-client.test.ts` (8/8, spawn-based).
- T2 (`3d61970`): `scripts/smoke-test.mjs` (health → session → chat →
  contract → SLO report; default fail-closed mode, `--live` known-answer
  mode), unit tests `tests/unit/smoke-test.test.ts` (7/7, helper imports).
- T3/T4 (`221d5b6`): `docs/runbooks/` — provider-outage, key-rotation,
  rollback, restore-rehearsal, incident-response, metrics (SQL against
  `usage_events`/`jobs`/`request_runs`/cache tables + alert thresholds),
  proxy-hops (marker-bucket measurement against `client-ip.ts` semantics).
  README deployment order updated to reference them.

## Gates (this box, Node 26.13.1, local stack at 017)

- `npm run build`, `lint`, `format:check`, `typecheck`: exit 0.
- Full unit: flakes only in untouched perf-timing/PDF-child families
  (6–10 across runs, varying set); P10 files 15/15 in isolation.
- pgTAP re-run on the final tree: 28 files, 3399 passed (schema unchanged by P10).
  Incident: an intermediate re-run showed failures (060/claim/090 ordering and
  count assertions) caused by smoke-test residue (sessions, conversations,
  request_runs) left in the local DB by the T2 smoke run — not a regression.
  Fixed by `db reset` (clean seed) and a green re-run; local DB left clean.
- `db lint` clean; advisors no issues; `worker-dist-check` pass.
- `node scripts/smoke-test.mjs` (default): 7/7, exit 0 (one cold-boot flake
  observed, green on rerun; boot wait raised 15 s → 30 s).
- `scripts/deploy-client.mjs` on the shipped example: correctly refuses
  (placeholders are not deployable); valid concrete fixture passes.
- `secret-scan`: only the owner-kept demo key (`widget/public/index.html:14`).
  One P10 fixture initially tripped `named-secret`; replaced with an
  11-char obviously-fake value that the validator still refuses (P8 pattern).
- `race-db.sh`: refused by design guard (npipe); P10 adds no lock ordering.
  `test-make`: 111/5, all 5 need `make` (absent on Windows).
- `api-smoke`: 33/2 (documented Windows SIGTERM-by-design).
- Integration: 474/14/279 pattern (Windows signal suites).

## Open (needs owner / staging)

- `--live` smoke (known-answer handoff) needs a paid-tier provider key:
  not run, same rule as the P11 eval.
- `TRUSTED_PROXY_HOPS` measurement needs a real Render deploy: procedure
  ready, value not measured.
- Hosted 014–017 apply + advisors; P7/P7.5/P8/P9 acceptance.
- P10 merge to `main` + push: awaiting owner approval.
