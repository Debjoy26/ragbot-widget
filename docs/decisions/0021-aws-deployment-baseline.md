# ADR 0021 — AWS Deployment Baseline (Plan B, Proposed)

- **Status:** Proposed
- **Date:** 2026-11-24
- **Decision owner:** Product owner
- **Related:** ARCHITECTURE.md §2, README "Deployment order per client",
  `render.yaml`, product hub `DEPLOYMENT_AND_OPERATIONS.md` §3 (AWS option),
  panel `plan.md` A8, ADR 0018 (Node 26)

## Context

The documented baseline is Render (API + worker) + Vercel (widget) + Supabase
(per-client project). Two pressures motivate a recorded AWS alternative:

1. Vercel Hobby is licensed for non-commercial use; every commercial client
   would need Pro seats or its own account. Both frontends (widget bundle,
   admin panel static `dist/`) are plain static assets with no server
   requirement.
2. Render has no India region (open DPDP/data-residency assumption), per-client
   cost scales linearly (~$60–100/mo before AI tokens), and Node 26 support
   is still unverified (ADR 0018).

Supabase stays as the managed tenant database/Auth/Storage in both plans;
no self-hosted Postgres is proposed.

## Proposed mapping (per client, when adopted)

| Component | AWS target | Notes |
|---|---|---|
| Widget bundle | S3 + CloudFront, versioned immutable paths | Kills the Vercel commercial issue; ~$1–5/mo |
| Admin panel | S3 + CloudFront (static build) | Hosting currently unfixed panel-side (A8) |
| Visitor API | ECS Fargate (App Runner acceptable if ops want Render-like simplicity) | Same container as Render; health `/health/ready` |
| Worker | ECS Fargate scheduled service | Same container; lease/heartbeat semantics unchanged |
| Secrets | Secrets Manager + IAM task roles | Rotation per `docs/runbooks/key-rotation.md` |
| TLS/domains/logs | ACM + CloudFront/ALB, CloudWatch | Re-measure `TRUSTED_PROXY_HOPS` (CloudFront+ALB count differs) |
| Tenant DB | Same per-client Supabase project | Match AWS region to the Supabase project region |

Docker applies to server processes only; the widget is never containerised.
Per-client services are retained (a shared cluster would weaken the
tenant-isolation model for small savings).

## Cost sketch (estimates, re-verify at adoption)

- AWS: Fargate micro ×2 + ALB + S3/CloudFront + Supabase ≈ $35–60/mo/client.
- Render baseline ≈ $60–100/mo/client (services + Vercel Pro + Supabase).
- AI tokens dominate at real usage (3.5-flash-lite $0.30/$2.50, ADR 0020):
  caps and subscription tiers matter more than hosting rent.

## Adoption gates (all required before any migration)

1. Owner approves this ADR (status → Accepted) and the client cutover order.
2. AWS manifests + ECR/build pipeline committed here (`aws/` alongside, not
   replacing, `render.yaml` until cutover); runbooks updated (proxy-hops,
   rollback, restore); P12 plan updated.
3. Node 26.13.1 runtime proven on the target (ADR 0018); first throwaway
   deploy + restore rehearsal green; secret-scan clean; health + smoke green.
4. Panel A8 records the static hosting + domains; product hub snapshot refreshed
   per its governance (source repos first).
5. First client stays on the Render baseline until gates 1–4 pass; no
   production traffic moves on documentation alone.
