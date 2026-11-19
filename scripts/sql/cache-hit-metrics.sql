-- Canonical dashboard query. Counts usage events, not unique visitor requests.
select bot_id, date_trunc('hour', created_at) as hour,
       count(*) filter (where operation = 'answer_cache_hit'
         or (operation = 'chat' and provider = 'cache' and model = 'answer_cache')) as answer_hits,
       count(*) filter (where operation = 'chat'
         and (provider is distinct from 'cache' or model is distinct from 'answer_cache')) as generations
  from public.usage_events
 where created_at > now() - interval '1 day'
 group by 1, 2 order by 1, 2;
