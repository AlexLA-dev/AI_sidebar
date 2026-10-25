-- Usage analytics: Google answers vs other AI answers, through our keys vs the user's own key.
-- select public.cf_usage_report(30);  (SQL editor / service role; also GET /api/v2/admin/usage)
--
-- Every AI request is a 'chat' event. Its segment comes from the event data:
--   key      'ours' (our server, our API keys) | 'own' (user's own key, reported by the extension)
--   segment  'google' (mode = google: Gemini + Google Search) | 'ai' (everything else)
-- Events written before these fields existed are server answers: key 'ours', segment 'ai'.

create or replace function public.cf_usage_report(p_days integer default 30)
returns jsonb language sql security definer set search_path = '' stable as $$
  with d as (select greatest(1, least(coalesce(p_days, 30), 180)) as days),
  ev as (
    select
      (e.created_at at time zone 'utc')::date as day,
      e.install_id,
      e.kind,
      e.data,
      coalesce(e.data->>'key', 'ours') as key,
      -- Errors logged before mode/provider were recorded start with the model name ("gemini-…: 429 …").
      case when e.data->>'mode' = 'google' or e.data->>'message' like 'gemini%' then 'google' else 'ai' end as segment,
      coalesce(
        e.data->>'provider',
        case when e.data->>'model' like 'gemini%' or e.data->>'message' like 'gemini%' then 'gemini'
             when e.data->>'model' like 'claude%' then 'anthropic'
             else 'openai' end
      ) as provider,
      coalesce(e.data->>'model', 'unknown') as model,
      coalesce(nullif(e.data->>'prompt_tokens', '')::bigint, 0) as prompt_tokens,
      coalesce(nullif(e.data->>'completion_tokens', '')::bigint, 0) as completion_tokens,
      coalesce(nullif(e.data->>'search_queries', '')::bigint, 0) as search_queries,
      nullif(e.data->>'ms', '')::bigint as ms,
      coalesce(e.data->>'ok', 'true') <> 'false' as ok
    from contextflow.events e, d
    where e.created_at >= now() - make_interval(days => d.days)
      and e.kind in ('chat', 'limit', 'upstream_error')
  ),
  chats as (select * from ev where kind = 'chat')
  select jsonb_build_object(
    'days', (select days from d),
    'generated_at', now(),
    'segments', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.key desc, s.segment), '[]'::jsonb) from (
        select key, segment,
          count(*) as requests,
          count(*) filter (where not ok) as failed,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries,
          round(avg(ms)) as avg_ms
        from chats group by key, segment
      ) s
    ),
    'by_day', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.day, s.key desc, s.segment), '[]'::jsonb) from (
        select day, key, segment,
          count(*) as requests,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries
        from chats group by day, key, segment
      ) s
    ),
    'by_model', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.requests desc), '[]'::jsonb) from (
        select key, segment, provider, model,
          count(*) as requests,
          count(*) filter (where not ok) as failed,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries,
          round(avg(ms)) as avg_ms
        from chats group by key, segment, provider, model
      ) s
    ),
    'limits', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.hits desc), '[]'::jsonb) from (
        select segment, coalesce(data->>'reason', 'limit') as reason, coalesce(data->>'plan', 'unknown') as plan, count(*) as hits
        from ev where kind = 'limit' group by 1, 2, 3
      ) s
    ),
    'upstream_errors', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.errors desc), '[]'::jsonb) from (
        select segment, provider, count(*) as errors
        from ev where kind = 'upstream_error' group by 1, 2
      ) s
    )
  );
$$;

revoke all on function public.cf_usage_report(integer) from public, anon, authenticated;
grant execute on function public.cf_usage_report(integer) to service_role;
