# Runbook: incident response (P10)

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](../reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

Severity first: protect visitors and data, then diagnose.

## 1. Triage (minutes)

- API down (`/health/ready` not 200): Render dashboard → service status,
  recent deploy, env change. See `rollback.md` if a deploy just landed.
- Chat failing, health fine: provider incident — see `provider-outage.md`.
- Queue growing (`jobs` stuck `queued`/`running`, `locked_until` passing):
  worker down or poisoned job type. Check worker logs for `failed` analysis
  or indexing rows; a poisoned version fails with `FILE_UNSUPPORTED` or
  `OCR_REQUIRED` and stays failed (old version stays live — no data loss).
- Abuse spike (rate/budget denials surge): see `metrics.md`. Buckets are
  atomic in Postgres; a wrong `TRUSTED_PROXY_HOPS` puts everyone in one
  bucket — see `proxy-hops.md` before blocking anything.

## 2. Contain

- Prefer Render env changes and redeploys over code changes.
- Never accept browser-supplied context, history or keys as a "quick fix"
  (invariant 1). Never log message content, payloads or keys while debugging
  (invariant 14): log ids, counts and codes only.
- Never hand-edit the hosted database. Schema changes go in a new migration
  tested on the local stack first.

## 3. Record

- Window, symptoms, first detection source, actions, SHAs, migration state.
- Counts from `metrics.md` queries (denials, failures, dead letters).
- File under `docs/evidence/<phase>/` and link from `status.md`.

## 4. Follow up

- New alert threshold or runbook step for anything detected by a human first.
- P11 owns the security checklist and load test; feed incident findings into it.
