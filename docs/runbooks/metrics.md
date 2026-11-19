# Metrics and alerts (P10)

> Current execution checkpoint (2026-11-18): completedT03c-3a; nextT03c-3b full LOCAL pgTAP is NOT STARTED. LOCAL020/hosted-last017; P7-P10 acceptance OPEN. Work stopped for handoff after owner-reported10% usage remaining. See [OpenCode handoff](../reports/OPENCODE-HANDOFF.md) for done/pending work and exact resume steps. STOP BEFORE P11; this document does not authorize hosted/release/provider actions.

Query source: the per-client Postgres (service role or dashboard SQL), plus
Render logs. All cost/usage rows already exist in `usage_events`; queue state
in `jobs`; monetary reservations in `budget_reservations` and request state
in `request_runs`. No new tables.

## Latency (PRD §8: p95 first event ≤ 5 s, ordinary answer ≤ 20 s)

```sql
-- Chat + analysis latency distribution, per provider/model/operation.
select operation, provider, model,
       count(*),
       percentile_cont(0.5) within group (order by latency_ms) as p50_ms,
       percentile_cont(0.95) within group (order by latency_ms) as p95_ms
  from public.usage_events
 where created_at > now() - interval '1 day'
 group by 1, 2, 3 order by 1, 2, 3;
```

TTFT is measured by `scripts/smoke-test.mjs` per run and calibrated properly
in P11; treat `latency_ms` here as total provider time per call.

Alert: p95 `chat` latency > 20 s for 10 minutes → page. Sustained rise with
flat provider status → check `retrieval_cache`/`answer_cache` hit rates below
and queue age.

## Answer-cache hits and cache inventory (P7.5)

Run the canonical [cache-hit query](../../scripts/sql/cache-hit-metrics.sql)
using `psql -f scripts/sql/cache-hit-metrics.sql`, or paste its SELECT into
the dashboard SQL editor. It groups by bot and hour. Current deployed hits
use operation `chat`, provider `cache`, model `answer_cache`; the query also
supports the `answer_cache_hit` operation defined by the shared ledger
contract. Those cache identities count as hits, never provider generations.
NULL provider/model values still count as provider calls rather than disappearing.

These are usage-event counts, not unique visitor requests: provider retries
and fallback can produce multiple generation calls per request. Table sizes
below are occupancy/expiry diagnostics, not C4–C6 hit ratios. Per-layer hit/miss
counters must exist before reporting those ratios.

```sql
-- L2 table occupancy and expiry pressure; neither measures a hit ratio.
select 'answer_cache' as tbl, count(*), count(*) filter (where expires_at < now() + interval '1 hour') as expiring_soon from public.answer_cache
union all
select 'retrieval_cache', count(*), count(*) filter (where expires_at < now() + interval '1 hour') from public.retrieval_cache
union all
select 'query_embedding_cache', count(*), count(*) filter (where expires_at < now() + interval '1 hour') from public.query_embedding_cache
union all
select 'moderation_cache', count(*), count(*) filter (where expires_at < now() + interval '1 hour') from public.moderation_cache;
```

Alert: answer-hit ratio collapses after a deploy → a version key changed
(`corpus_version`, `settings_version`, model). Expected dips follow corpus
activation and settings edits.

## Queue age, failures, dead letters

```sql
-- Oldest unclaimed work and terminals per type.
select type, state, count(*), min(available_at) as oldest
  from public.jobs
 group by 1, 2 order by 1, 2;
```

Alert: any `queued` row older than 10 minutes → page (worker stuck or down).
Alert: `failed` rows (dead letters after `max_attempts`) → ticket; inspect
`last_error`, never the payload content.

## Rate/budget denials and fallback frequency

```sql
-- Spend and denials per bot per day (reservations are per UTC day).
select bot_id, date_trunc('day', created_at) as day,
       sum(estimated_cost) as spend_usd,
       count(*) filter (where operation = 'analysis') as analyses
  from public.usage_events
 group by 1, 2 order by 1, 2;
```

```sql
-- Reservation amounts show conservative exposure, separate from recorded usage.
-- Expired background holds can continue counting until reconciliation.
select bot_id, state, count(*), sum(amount) as reservation_usd
  from public.budget_reservations
 where created_at > now() - interval '1 day'
 group by 1, 2 order by 1, 2;
```

Alert: bot spend ≥ 80% of its daily cap → notify the client (budget alerts
are per-client; the cap itself fails closed). Denial spikes with one IP
bucket → check `proxy-hops.md` before anything else. Fallback usage shows up
as rows with a fallback model name; a fallback-only week means the primary
quota story needs attention (`status.md §3a o`).

## Readiness

Alert: `/health/ready` non-200 for 2 minutes → page. It shares a 2 s cached
probe, so one bad database minute pages once.
