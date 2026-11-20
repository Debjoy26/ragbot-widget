# ADR 0019 — Managed Admin Platform Integration Boundary

- **Status:** Proposed
- **Date:** 2026-11-20
- **Decision owner:** Product owner
- **Related:** ADR 0015 (MFA), ADR 0017 (client admin direct to Supabase),
  `ragbot-admin-panel` documentation baseline

## Context

The owner created a separate
[`ragbot-admin-panel`](https://github.com/Debjoy26/ragbot-admin-panel)
repository for client and provider administration. The requested product
includes the existing client admin capabilities plus provider-wide client
management, subscription/suspension controls, a public widget identifier,
and an admin-reviewed path for answering frequent knowledge gaps.

The current backend already supports client-scoped authentication, membership,
`aal2`, RLS, admin RPCs, Storage, document indexing, and aggregate
`knowledge_gaps` reporting. It does not define a provider control plane,
complete subscription lifecycle, dedicated widget-key lifecycle, or an
admin-authored-answer publishing workflow.

## Proposed boundary

1. Keep this repository authoritative for tenant migrations, RLS, RPCs,
   Storage policies, shared backend contracts, visitor API, worker, and widget.
2. The client admin frontend consumes approved tenant contracts directly
   through Supabase Auth, RLS, RPCs, and Storage, consistent with ADR 0017.
3. Provider administration is a separate trust domain. A provider browser
   must not hold service-role credentials or connect arbitrarily to tenant
   projects. A provider API/registry, identity, roles, delegation, and audit
   model must be designed before implementation.
4. A future widget key is public identification only, never client/visitor
   authentication. The current embed contract remains unchanged until a
   replacement is approved.
5. Subscription and suspension state must be enforced by an authoritative
   server-side path. `bot_profiles.enabled` alone is not subscription
   management.
6. Knowledge-gap answers are written and approved by an authorized human,
   then validated and indexed through the tenant knowledge lifecycle. They
   become retrievable only after successful activation; visitor or model text
   is never automatically trusted.
7. Tenant schema changes remain in the single `supabase/migrations` history.
   The provider registry is not placed in the tenant schema by default.

## Consequences and unresolved decisions

- The proposal does not add provider roles, registry tables, widget-key tables,
  subscription columns, or FAQ tables to the current tenant schema.
- Decide provider identity/MFA/roles, control-plane ownership, cross-client
  access policy, and audit requirements.
- Decide widget-key generation, storage/lookup, hostname restrictions,
  rotation, revocation, and bootstrap behavior.
- Decide subscription states, periods, limits, grace behavior, enforcement
  location, and runtime failure policy.
- Decide whether approved knowledge is a Markdown document or a dedicated FAQ
  entity, and define ownership, audit, retention, deduplication, and citation
  semantics.
- Decide whether to replace the current Render API/worker deployment with AWS,
  including EC2 versus ECS/Fargate, per-client versus shared service
  isolation, secrets/monitoring, and static widget hosting. Docker is for
  server processes; the widget remains a static JavaScript bundle.
- The admin panel's [PRD](https://github.com/Debjoy26/ragbot-admin-panel/blob/main/PRD.md)
  is a proposed UI/product contract, not implementation evidence or approval
  to start a new phase.

## Approval

No implementation, migration, hosted change, provider credential, deployment,
or phase progression is authorized by this proposed ADR. Owner acceptance and
a bounded implementation plan are required.
