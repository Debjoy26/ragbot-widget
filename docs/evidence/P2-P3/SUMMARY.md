# P2 + P3 evidence (incl. debug cycles P3-D1, P3-D2)

Final run 2026-11-04 · branch `phase/p2-p3` · Node v24.22.2 · local Supabase stack (PostgreSQL 17.11, pgvector 0.8.2) · remote dev project untouched.

| Command | Exit | Result |
|---|---|---|
| `npm ci` (clean) | 0 | |
| `npm run lint` / `format:check` / `typecheck` / `build` | 0 | |
| `npm test` | 0 | 9 files, 157 passed, 0 failed, 0 skipped |
| `npm run test:integration` | 0 | no Vitest integration tests yet |
| `supabase db reset` | 0 | migrations 001–005 + seed |
| `supabase db lint --local` | 0 | no schema errors |
| `npm run test:db` (pgTAP) | 0 | 17 files, 1465 passed, 0 failed |

History: P2-T1 + P3-T1 (workers, verified by Opus: 157 / 932) → security review P3-R1 (5 medium, 14 low) → P3-D1 (1374 pgTAP) → re-review P3-R2 (14 of 15 fixed, M4 partial; new N1–N9) → P3-D2 (1465 pgTAP). Logs in `final-after-P3-D2/`, `after-P3-D1/` (gitignored).

Not covered (explicit): real multi-connection race tests (P5/P6); real GoTrue aal2 tokens (claims forged in tests; TOTP disabled in local config); API-level matrix cells (field-level settings RPC → P9, management API, audit redaction, signed URLs); P3-D2 not separately security-reviewed (verified by tests + Opus code read only). Deferred lows: L8, L11, L12, L14, N6, N9.
