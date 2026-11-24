# Cross-repo review — 2026-11-24 (read-only, no code changes)

## Sources (live GitHub state)
- `ragbot-widget` remote `main @ 8a38455` (pushed 2026-11-21, unchanged since).
  Local checkout is ahead: docs overlay to `495db6f` + today's uncommitted P11
  work (harness, eval 23/24, multimarker fix, F1 3.5 default, F2 log, T4, P12 prep).
- `ragbot-admin-panel` remote `main @ 6cbfa6e`: A0–A4 complete/owner-accepted,
  A7 scaffold (mocked), A5/A6/A8 not started. Contract pinned to widget
  `ebc75ec`, schema 027.
- `Text_AI_Complete_product_doc` remote `main @ 83219e1`: snapshot dated
  2026-11-21 (P11 "not started", Render baseline, AWS undecided). Now stale
  on P11 + model default; governance requires source-repo-first updates.

## Compatibility check (backend ↔ panel contract)
- Backend schema still 027, no migration since the pin → panel's RPC/RLS
  surface is intact. Today's backend changes (prompt/citation parsers, log
  line, model defaults) do not touch admin RPCs/RLS — panel contract valid,
  but panel checks were never re-run against the new backend code.
- Auth-policy conflict found: backend P12 runbook says "public signup off +
  make first-admin"; panel ADR 0004 says "self-registration allowed, accounts
  inert until provider activation". Must be resolved before P12.
- Panel approval boundary already gates AWS provisioning; product hub lists
  the AWS option items. Both Vercel (widget) and panel (Vite static `dist/`)
  are static bundles → S3+CloudFront fits and kills the Hobby-commercial issue.
- 3.5 pricing (3–6x over 2.5) affects the hub's open "commercial model"
  question (caps, tiers, provider costs).

## Standing gaps for "complete"
1. AWS baseline decision (ADR 0021 proposed) — Render/Vercel remain documented.
2. Panel A5/A6/A8 + provider backend 0% (A7a–c) — client-only P12 possible.
3. Auth signup-policy conflict (above).
4. Host-bound gates: T25-d/T26, load p95, throwaway restore rehearsal.
5. Push decision for the local P11 overlay (CI ~10 min on push).
