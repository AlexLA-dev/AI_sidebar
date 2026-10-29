-- Users and subscriptions on the analytics page: daily active users next to new users,
-- App Store subscriptions by status, and requests by plan.
--
-- DAU = installs that opened ContextFlow (the panel calls /api/v2/status when it opens) or asked
-- something that day (UTC). From now on cf_touch_install records one row per install per day.
-- Earlier days are rebuilt from what was kept: questions and limit hits (events), the day an
-- install appeared and the day it was last seen. So days before this migration are a lower bound:
-- someone who only opened the panel on some other day is missing.

create table if not exists contextflow.install_days (
  day        date not null,
  install_id uuid not null,
  platform   text,
  version    text,
  first_at   timestamptz not null default now(),
  primary key (day, install_id)
);
alter table contextflow.install_days enable row level security;
revoke all on contextflow.install_days from public, anon, authenticated;

insert into contextflow.install_days (day, install_id, platform, version, first_at)
select distinct on ((x.at at time zone 'utc')::date, x.install_id)
  (x.at at time zone 'utc')::date, x.install_id, x.platform, x.version, x.at
from (
  select e.created_at as at, e.install_id, e.data->>'platform' as platform, e.data->>'version' as version
  from contextflow.events e
  where e.install_id is not null and e.kind in ('chat', 'limit')
  union all
  select i.created_at, i.install_id, i.platform, i.app_version from contextflow.installs i
  union all
  select i.last_seen_at, i.install_id, i.platform, i.app_version from contextflow.installs i
) x
order by (x.at at time zone 'utc')::date, x.install_id, x.at
on conflict do nothing;

create or replace function public.cf_touch_install(
  p_install uuid, p_platform text, p_version text, p_locale text, p_requests integer default 0)
returns void language sql security definer set search_path = '' as $$
  insert into contextflow.installs (install_id, platform, app_version, locale, requests_total)
  values (p_install, left(p_platform, 20), left(p_version, 20), left(p_locale, 12), greatest(p_requests, 0))
  on conflict (install_id) do update set
    last_seen_at   = now(),
    platform       = coalesce(excluded.platform, contextflow.installs.platform),
    app_version    = coalesce(excluded.app_version, contextflow.installs.app_version),
    locale         = coalesce(excluded.locale, contextflow.installs.locale),
    requests_total = contextflow.installs.requests_total + greatest(p_requests, 0);

  insert into contextflow.install_days (day, install_id, platform, version)
  values ((now() at time zone 'utc')::date, p_install, left(p_platform, 20), left(p_version, 20))
  on conflict do nothing;
$$;

-- Whether something from this platform and version happened while that version was in App Review
-- (then it came from the reviewer or the owner, not from real users).
create or replace function contextflow.in_review(p_platform text, p_version text, p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from contextflow.review_windows w
    where w.platform = case when p_platform in ('ios', 'ipados') then 'IOS' when p_platform = 'macos' then 'MAC_OS' end
      and w.version = regexp_replace(coalesce(p_version, ''), '\.0$', '')
      and p_at >= w.submitted_at
      and (w.completed_at is null or p_at < w.completed_at)
  )
$$;
revoke all on function contextflow.in_review(text, text, timestamptz) from public, anon, authenticated;

create or replace function public.cf_usage_report(p_days integer default 30)
returns jsonb language sql security definer set search_path = '' stable as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
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
      -- Own-key reports come from the device and carry no plan.
      coalesce(e.data->>'plan', case when e.data->>'key' = 'own' then 'own_key' else 'unknown' end) as plan,
      coalesce(nullif(e.data->>'prompt_tokens', '')::bigint, 0) as prompt_tokens,
      coalesce(nullif(e.data->>'completion_tokens', '')::bigint, 0) as completion_tokens,
      coalesce(nullif(e.data->>'search_queries', '')::bigint, 0) as search_queries,
      nullif(e.data->>'ms', '')::bigint as ms,
      coalesce(e.data->>'ok', 'true') <> 'false' as ok,
      case e.data->>'platform' when 'ios' then 'iPhone' when 'ipados' then 'iPad' when 'macos' then 'Mac'
                               when 'chrome' then 'Chrome' else 'unknown' end as device,
      case
        when e.data->>'audience' = 'test' or e.data->>'version' = 'dev-check' then 'test'
        when contextflow.in_review(e.data->>'platform', e.data->>'version', e.created_at) then 'review'
        else 'real'
      end as audience,
      e.data->>'version' as version
    from contextflow.events e, d
    where e.created_at >= now() - make_interval(days => d.days)
      and e.kind in ('chat', 'limit', 'upstream_error')
  ),
  all_chats as (select * from ev where kind = 'chat'),
  chats as (select * from all_chats where audience = 'real'),
  real_ev as (select * from ev where audience = 'real'),
  -- Our own test devices, left out of the user counts entirely.
  test_installs as (
    select distinct e.install_id from contextflow.events e
    where e.install_id is not null and (e.data->>'audience' = 'test' or e.data->>'version' = 'dev-check')
  ),
  first_days as (select install_id, min(day) as day from contextflow.install_days group by install_id),
  user_days as (
    select u.day, u.install_id, u.day = f.day as is_new
    from contextflow.install_days u
    join first_days f on f.install_id = u.install_id
    cross join d
    where u.day > d.today - d.days
      and coalesce(u.version, '') <> 'dev-check'
      and u.install_id not in (select install_id from test_installs)
      and not contextflow.in_review(u.platform, u.version, u.first_at)
  ),
  asked as (select distinct day, install_id from chats),
  subs as (
    select s.product_id, s.created_at, s.expires_at,
      case
        when s.revoked_at is not null then 'refunded'
        when s.last_notification like 'DID_FAIL_TO_RENEW%' then 'billing_retry'
        when s.expires_at is not null and s.expires_at < now() then 'expired'
        when s.last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED' then 'renewal_off'
        else 'active'
      end as status
    from contextflow.entitlements s
    where s.environment = 'Production'
  )
  select jsonb_build_object(
    'days', (select days from d),
    'generated_at', now(),
    'users', (
      select jsonb_build_object(
        'active', count(distinct u.install_id),
        'new', count(distinct u.install_id) filter (where u.is_new),
        'active_today', count(*) filter (where u.day = d.today),
        'new_today', count(*) filter (where u.day = d.today and u.is_new),
        'asked', (select count(distinct install_id) from asked),
        'by_day', (
          select coalesce(jsonb_agg(row_to_json(s) order by s.day), '[]'::jsonb) from (
            select x.day,
              count(*) as active,
              count(*) filter (where x.is_new) as new,
              count(*) filter (where exists (select 1 from asked a where a.day = x.day and a.install_id = x.install_id)) as asked
            from user_days x group by x.day
          ) s
        )
      )
      from user_days u, d
    ),
    -- App Store subscriptions in production (App Review buys in the sandbox).
    'subscriptions', jsonb_build_object(
      'by_product', (
        select coalesce(jsonb_agg(row_to_json(s) order by s.product_id), '[]'::jsonb) from (
          select product_id,
            count(*) filter (where status in ('active', 'renewal_off', 'billing_retry')) as active,
            count(*) filter (where status = 'renewal_off') as renewal_off,
            count(*) filter (where status = 'billing_retry') as billing_retry,
            count(*) filter (where status = 'expired') as expired,
            count(*) filter (where status = 'refunded') as refunded,
            count(*) filter (where created_at >= now() - make_interval(days => (select days from d))) as new
          from subs group by product_id
        ) s
      ),
      'list', (
        select coalesce(jsonb_agg(row_to_json(s) order by s.created_at desc), '[]'::jsonb) from (
          select product_id, created_at, expires_at, status from subs order by created_at desc limit 200
        ) s
      ),
      'sandbox', (select count(*) from contextflow.entitlements where environment <> 'Production')
    ),
    'by_plan', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.requests desc), '[]'::jsonb) from (
        select p.plan, sum(p.n) as requests, count(distinct p.install_id) as installs, max(p.n) as max_per_day
        from (select plan, install_id, day, count(*) as n from chats group by plan, install_id, day) p
        group by p.plan
      ) s
    ),
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
        select segment, coalesce(data->>'reason', 'limit') as reason, plan, count(*) as hits
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
