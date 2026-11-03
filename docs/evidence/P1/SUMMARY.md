# P1 evidence — monorepo scaffold & tooling

- Date: 2026-11-04 · Base revision: `5e416b6` (P1 changes uncommitted at time of run)
- cwd: repo root · Node `v24.22.2` (nvm), npm `11.19.1` · local only, no remote services
- Run order: `rm -rf node_modules widget/dist` → gates below. Logs in this folder.

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | clean install from lockfile |
| `npm run lint` | 0 | ESLint 10 + typescript-eslint, 0 problems |
| `npm run format:check` | 0 | Prettier (Markdown excluded by design) |
| `npm run typecheck` | 0 | `tsc -b` (shared/api/worker) + widget + tests |
| `npm test` | 0 | Vitest unit: 1 file, 3 passed, 0 failed, 0 skipped (scaffold smoke tests only) |
| `npm run test:integration` | 0 | no test files yet (`--passWithNoTests`) — **no coverage, not a gate result** |
| `npm run build` | 0 | `tsc -b` + esbuild → `widget/dist/v1.0.0/widget.js` |
| `npx playwright test --pass-with-no-tests` | 0 | no E2E tests yet; browsers not installed |

Additional checks
- Engine pin: `npm ci` under system Node v24.18.0 → `EBADENGINE` (pin enforced via `.npmrc engine-strict`).
- `npm audit --omit=dev`: 0 vulnerabilities. Full audit: 11 moderate, all one `minimatch` DoS advisory in ESLint tooling (dev-only).
- Secret check: owner-supplied Gemini key present only in gitignored `.env` (mode 600); `git check-ignore` confirms.

First failing run (kept honest): typecheck exit 2 and test:integration exit 1 — both from `passWithNoTests` placed inside a Vitest project (invalid there). Fixed by moving it to the CLI flag; full rerun above.

Not verified / known gaps
- CI workflow `.github/workflows/ci.yml` written but **never executed** (nothing pushed). "CI green" acceptance is pending.
- `supabase start` / `db reset` not run: Docker is not installed locally (needs sudo). Supabase CLI 3.0.0 itself runs.
- No secret scanner in CI yet (definition of done requires one; proposed for P10).
- GitHub Actions pinned by major tag, not commit SHA.
