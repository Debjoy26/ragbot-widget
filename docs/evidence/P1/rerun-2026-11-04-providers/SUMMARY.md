# P1 rerun — provider-agnostic AI config (ADR 0014)

- Date: 2026-11-04 · Base `5e416b6` + uncommitted P1 + ADR 0014 changes · Node v24.22.2 · local only
- Clean `rm -rf node_modules widget/dist` then: npm ci, lint, format:check, typecheck, test, test:integration, build → all exit 0.
- Unit: 2 files, 21 passed, 0 failed, 0 skipped (3 scaffold + 18 provider-config cases incl. fail-closed, key-not-in-error, https-only base URL, Anthropic-embedding rejection, dimension mismatch, fallback quota flag). Tests use fake placeholder keys.
- Integration/E2E: still no tests.
- Real `.env` validated through `loadApiAiConfig`/`loadWorkerAiConfig` (output: provider:model only; no secrets printed).

Real provider calls made (owner directed Gemini use, 2026-11-04), no client data:
- `GET v1beta/models` (list) — 200.
- `embedContent` on `gemini-embedding-2` and `gemini-embedding-001` with the literal text "hello", `outputDimensionality: 1536` — both 200, 1536 values. (A first scripted attempt produced unparseable output and was retried with status capture.)
- Pricing from Google's official page (aistudio.google.com/docs/pricing, fetched 2026-11-04); third-party aggregators not relied on.

Not done: provider adapters (P6/P7); runtime embedding-model-mismatch guard (P3/P7); Docker / `supabase start`; CI run.
