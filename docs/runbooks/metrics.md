# Metrics and alerts (P10)

Query source: the per-client Postgres (service role or dashboard SQL), plus
Render logs. All cost/usage rows already exist in `usage_events`; queue state
in `jobs`; reservations in `request_runs`. No new tables.

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

## Cache hit rates (P7.5 layers C4–C7)

```sql
-- Answer-cache hits are usage rows with operation 'answer_cache_hit'.
select date_trunc('hour', created_at) as hour,
       count(*) filter (where operation = 'answer_cache_hit') as answer_hits,
       count(*) filter (where operation = 'chat') as generations
  from public.usage_events
 where created_at > now() - interval '1 day'
 group by 1 order by 1;
```

```sql
-- L2 cache table sizes and expiry pressure (hits are L1; L2 rows prove sharing).
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
       sum(estimated_cost) filter (where operation <> 'answer_cache_hit') as spend_usd,
       count(*) filter (where operation = 'analysis') as analyses
  from public.usage_events
 group by 1, 2 order by 1, 2;
```

```sql
-- Open budget reservations per bot (stuck ones are reaped to `expired`).
select bot_id, state, count(*)
  from public.request_runs
 where started_at > now() - interval '1 day'
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
