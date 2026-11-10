-- ContextFlow analytics: read-only views over contextflow.* for the owner.
-- Open Supabase → SQL editor and run e.g.  select * from contextflow.v_daily;
-- The contextflow schema has no grants for anon/authenticated and is not exposed
-- through the API, so these views are visible only to the project owner.

-- Day by day, last 90 days (UTC): installs, active users, answers, limits, cost.
create or replace view contextflow.v_daily with (security_invoker = true) as
with days as (
  select generate_series(current_date - 89, current_date, interval '1 day')::date as day
),
chats as (
  select (created_at at time zone 'utc')::date as day, install_id, data
  from contextflow.events
  where kind = 'chat' and created_at >= current_date - 89
),
chat_days as (
  select day,
         count(*) filter (where coalesce(data->>'legacy', 'false') <> 'true') as answers,
         count(*) filter (where data->>'plan' = 'pro') as answers_pro,
         count(*) filter (where data->>'legacy' = 'true') as answers_old_builds,
         count(distinct install_id) as active_installs,
         round(avg((data->>'ms')::numeric) / 1000, 1) as avg_seconds,
         sum(coalesce((data->>'prompt_tokens')::bigint, 0)) as tokens_in,
         sum(coalesce((data->>'completion_tokens')::bigint, 0)) as tokens_out,
         -- Estimate at OpenAI list prices per 1M tokens (gpt-4.1-mini 0.40/1.60, gpt-4o-mini 0.15/0.60).
         round(sum(
           case when data->>'model' like 'gpt-4o-mini%'
             then coalesce((data->>'prompt_tokens')::numeric, 0) * 0.15 + coalesce((data->>'completion_tokens')::numeric, 0) * 0.60
             else coalesce((data->>'prompt_tokens')::numeric, 0) * 0.40 + coalesce((data->>'completion_tokens')::numeric, 0) * 1.60
           end) / 1000000, 3) as est_cost_usd
  from chats
  group by day
),
install_days as (
  select (created_at at time zone 'utc')::date as day, count(*) as new_installs
  from contextflow.installs
  where created_at >= current_date - 89
  group by 1
),
limit_days as (
  select (created_at at time zone 'utc')::date as day, count(*) as limit_hits
  from contextflow.events
  where kind = 'limit' and created_at >= current_date - 89
  group by 1
)
select d.day,
       coalesce(i.new_installs, 0) as new_installs,
       coalesce(c.active_installs, 0) as active_installs,
       coalesce(c.answers, 0) as answers,
       coalesce(c.answers_pro, 0) as answers_pro,
       coalesce(c.answers_old_builds, 0) as answers_old_builds,
       coalesce(l.limit_hits, 0) as limit_hits,
       c.avg_seconds,
       coalesce(c.tokens_in, 0) as tokens_in,
       coalesce(c.tokens_out, 0) as tokens_out,
       coalesce(c.est_cost_usd, 0) as est_cost_usd
from days d
left join chat_days c using (day)
left join install_days i using (day)
left join limit_days l using (day)
order by d.day desc;

-- One-line summary for the last 7 and 30 days.
create or replace view contextflow.v_summary with (security_invoker = true) as
select period,
       (select count(*) from contextflow.installs where created_at >= now() - p.span) as new_installs,
       (select count(distinct install_id) from contextflow.events
         where kind = 'chat' and install_id is not null and created_at >= now() - p.span) as active_installs,
       (select count(*) from contextflow.events
         where kind = 'chat' and coalesce(data->>'legacy', 'false') <> 'true' and created_at >= now() - p.span) as answers,
       (select count(*) from contextflow.events where kind = 'limit' and created_at >= now() - p.span) as limit_hits,
       (select count(*) from contextflow.entitlements
         where environment = 'Production' and created_at >= now() - p.span) as new_subscriptions,
       (select count(*) from contextflow.entitlements
         where environment = 'Production' and revoked_at is null and expires_at > now()) as active_subscriptions
from (values ('7 days', interval '7 days'), ('30 days', interval '30 days')) as p(period, span);

-- Activation funnel for installs created in the last 30 days:
-- opened the panel → got at least one answer → returned on another day → hit the free limit.
create or replace view contextflow.v_funnel_30d with (security_invoker = true) as
with cohort as (
  select install_id from contextflow.installs where created_at >= now() - interval '30 days'
),
answered as (
  select install_id, count(distinct (created_at at time zone 'utc')::date) as days
  from contextflow.events
  where kind = 'chat' and install_id in (select install_id from cohort)
  group by 1
),
limited as (
  select distinct install_id from contextflow.events
  where kind = 'limit' and install_id in (select install_id from cohort)
)
select (select count(*) from cohort) as opened_panel,
       (select count(*) from answered) as got_answer,
       (select count(*) from answered where days >= 2) as came_back,
       (select count(*) from limited) as hit_free_limit;

-- Which one-tap actions people use (last 30 days). "question" = typed their own question.
create or replace view contextflow.v_actions_30d with (security_invoker = true) as
select coalesce(nullif(data->>'action', ''), 'question') as action,
       count(*) as answers,
       round(100.0 * count(*) / sum(count(*)) over (), 1) as share_pct
from contextflow.events
where kind = 'chat' and coalesce(data->>'legacy', 'false') <> 'true' and created_at >= now() - interval '30 days'
group by 1
order by answers desc;

-- Audience: platform × interface language, with 7-day activity.
create or replace view contextflow.v_audience with (security_invoker = true) as
select coalesce(platform, 'unknown') as platform,
       coalesce(locale, 'unknown') as locale,
       count(*) as installs,
       count(*) filter (where last_seen_at >= now() - interval '7 days') as active_7d,
       sum(requests_total) as answers_total
from contextflow.installs
group by 1, 2
order by installs desc;

-- App Store subscription lifecycle from Server Notifications (subscribe, renew, expire, refund…).
create or replace view contextflow.v_subscription_events with (security_invoker = true) as
select (created_at at time zone 'utc')::date as day,
       data->>'type' as type,
       data->>'subtype' as subtype,
       data->>'product' as product,
       data->>'environment' as environment,
       count(*) as events
from contextflow.events
where kind = 'appstore_notification'
group by 1, 2, 3, 4, 5
order by day desc, events desc;

-- Current subscriptions by product (Production only).
create or replace view contextflow.v_subscriptions with (security_invoker = true) as
select product_id,
       count(*) filter (where revoked_at is null and expires_at > now()) as active,
       count(*) filter (where created_at >= now() - interval '30 days') as started_30d,
       count(*) filter (where revoked_at is not null) as refunded_or_revoked,
       count(*) filter (where revoked_at is null and expires_at <= now()) as lapsed
from contextflow.entitlements
where environment = 'Production'
group by 1
order by active desc;
