-- New users by day next to what follows (/analytics → «Активные пользователи по дням»): how many of each day's new
-- users ran out of free answers that same day, and how many Pro subscriptions were bought that day.
--
-- New = the install's first panel day, the same people as the chart's «Новые» (cf_usage_report): tests (audience
-- "test", versions "dev-check" and "calibrate") and App Review / our builds (contextflow.in_review) left out.
-- Out of answers on d0 = a "limit" refusal of the daily allowance (reason "limit", or "search" for Google answers) on
-- the install's first day (UTC). Pro bought = the subscription's first paid transaction (contextflow.subscription_terms
-- paid_from: free trials and codes count from their first payment, renewals and ours never), Pro monthly or yearly.

create or replace function public.cf_new_user_outcomes(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate'))
  ),
  firsts as (
    select distinct on (install_id) install_id, day, platform, version, first_at
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  fresh as (
    select f.install_id, f.day
    from firsts f, d
    where f.day > d.today - d.days
      and coalesce(f.version, '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.install_id = f.install_id)
      and not contextflow.in_review(f.platform, f.version, f.first_at)
  ),
  limited as (
    select distinct f.install_id, f.day
    from fresh f
    join contextflow.events e on e.kind = 'limit' and e.install_id = f.install_id
      and e.data->>'reason' in ('limit', 'search') and (e.created_at at time zone 'utc')::date = f.day
  ),
  bought as (
    select (t.paid_from at time zone 'utc')::date as day
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production'
      and s.product_id in ('com.contextflow.pro.monthly', 'com.contextflow.pro.yearly')
      and t.paid_from is not null
  ),
  days as (
    select generate_series(d.today - (d.days - 1), d.today, interval '1 day')::date as day from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', x.day,
    'new', (select count(*) from fresh f where f.day = x.day),
    'limit_d0', (select count(*) from limited l where l.day = x.day),
    'pro_bought', (select count(*) from bought b where b.day = x.day)
  ) order by x.day), '[]'::jsonb)
  from days x
$$;
revoke all on function public.cf_new_user_outcomes(integer) from public, anon, authenticated;
grant execute on function public.cf_new_user_outcomes(integer) to service_role;
