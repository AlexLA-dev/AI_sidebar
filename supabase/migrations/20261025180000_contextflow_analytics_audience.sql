-- Analytics audience: real users vs App Review / owner checks vs dev tests, with a device breakdown.
--
-- Events from a version while it was in App Review come from the reviewer or the owner, not real users.
-- Review windows are listed in contextflow.review_windows (one row per submission; completed_at stays
-- null while the version is in review). On submit:
--   insert into contextflow.review_windows values ('IOS', '2.2', now(), null);
-- When review finishes (approved and released, or rejected):
--   update contextflow.review_windows set completed_at = now() where platform = 'IOS' and version = '2.2' and completed_at is null;
-- Dev checks are marked with data.audience = 'test' (or client version 'dev-check') and left out of the report.

create table if not exists contextflow.review_windows (
  platform     text not null check (platform in ('IOS', 'MAC_OS')),
  version      text not null,
  submitted_at timestamptz not null,
  completed_at timestamptz,
  primary key (platform, version, submitted_at)
);
alter table contextflow.review_windows enable row level security;
revoke all on contextflow.review_windows from public, anon, authenticated;

insert into contextflow.review_windows (platform, version, submitted_at, completed_at) values
  ('IOS',    '2.0', '2026-10-23T20:39:43Z', '2026-10-23T23:16:47Z'),
  ('MAC_OS', '2.0', '2026-10-23T20:39:39Z', '2026-10-24T23:41:27Z'),
  ('MAC_OS', '2.1', '2026-10-25T11:52:58Z', '2026-10-25T16:43:15Z'),
  ('IOS',    '2.1', '2026-10-25T11:52:46Z', null)
on conflict do nothing;

-- Claude's checks on 2026-10-25 (preview / production smoke tests).
update contextflow.events set data = data || '{"audience": "test"}'::jsonb
where id in (10, 11, 12, 13, 14, 15, 16) and coalesce(data->>'audience', '') <> 'test';

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
      coalesce(e.data->>'ok', 'true') <> 'false' as ok,
      case e.data->>'platform' when 'ios' then 'iPhone' when 'ipados' then 'iPad' when 'macos' then 'Mac'
                               when 'chrome' then 'Chrome' else 'unknown' end as device,
      case
        when e.data->>'audience' = 'test' or e.data->>'version' = 'dev-check' then 'test'
        when exists (
          select 1 from contextflow.review_windows w
          where w.platform = case when e.data->>'platform' in ('ios', 'ipados') then 'IOS' when e.data->>'platform' = 'macos' then 'MAC_OS' end
            and w.version = regexp_replace(coalesce(e.data->>'version', ''), '\.0$', '')
            and e.created_at >= w.submitted_at
            and (w.completed_at is null or e.created_at < w.completed_at)
        ) then 'review'
        else 'real'
      end as audience,
      e.data->>'version' as version
    from contextflow.events e, d
    where e.created_at >= now() - make_interval(days => d.days)
      and e.kind in ('chat', 'limit', 'upstream_error')
  ),
  all_chats as (select * from ev where kind = 'chat'),
  chats as (select * from all_chats where audience = 'real'),
  real_ev as (select * from ev where audience = 'real')
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
    'by_device', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.requests desc), '[]'::jsonb) from (
        select device, key, segment,
          count(*) as requests,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries
        from chats group by device, key, segment
      ) s
    ),
    -- Owner / App Review traffic while a version was in review, by device and version.
    'review', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.device, s.version, s.segment), '[]'::jsonb) from (
        select device, version, key, segment,
          count(*) as requests,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries,
          min(day) as first_day,
          max(day) as last_day
        from all_chats where audience = 'review' group by device, version, key, segment
      ) s
    ),
    'excluded_tests', (select count(*) from ev where audience = 'test'),
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
        from real_ev where kind = 'limit' group by 1, 2, 3
      ) s
    ),
    'upstream_errors', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.errors desc), '[]'::jsonb) from (
        select segment, provider, count(*) as errors
        from real_ev where kind = 'upstream_error' group by 1, 2
      ) s
    )
  );
$$;

revoke all on function public.cf_usage_report(integer) from public, anon, authenticated;
grant execute on function public.cf_usage_report(integer) to service_role;
