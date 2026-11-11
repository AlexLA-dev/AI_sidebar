-- /analytics: every plan counted (Pro, Ultra, Own key; monthly and yearly), MRR by day, retention.
-- Applied after 20261108120000_contextflow_ultra.sql (subscription_terms there knows every product's list price).
--
-- - cf_new_user_outcomes: "bought" counts every paid subscription (Own key too), with Pro / Ultra / Own key apart;
--   "pro_bought" stays as it was (Pro and Ultra) for a page from before this change.
-- - cf_mrr_history(days): MRR at the end of each UTC day (now for today), per plan, monthly or yearly, renewal on or
--   off, and currency (the page converts to USD at the day's rates).
-- - cf_retention(days): users by the week they were first seen, active in each later week; paying subscribers by
--   the month of their first payment, still paying in each later month; first renewals and churn per plan.
--
-- Paying, as on the rest of the page: production subscriptions only (App Review buys in the sandbox), without our
-- own (contextflow.own_subscriptions, terms 'owner'), from the first transaction with a price above 0 (a trial, a
-- free code or a gift isn't paying until someone pays).

-- cf_new_user_outcomes: every paid plan [latest version: 20261108120000_contextflow_ultra.sql]
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
  -- Every paid subscription on the day of its first payment, by the plan it was bought as (Own key's upgrade to Pro
  -- an hour later stays Own key here).
  bought as (
    select (t.paid_from at time zone 'utc')::date as day,
      split_part(coalesce((
        select n.data->>'product' from contextflow.events n
        where n.kind = 'appstore_notification' and n.data->>'otid' = s.original_transaction_id and n.data->>'product' is not null
        order by n.created_at limit 1
      ), s.product_id), '.', 3) as plan
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.paid_from is not null and t.terms <> 'owner'
  ),
  days as (
    select generate_series(d.today - (d.days - 1), d.today, interval '1 day')::date as day from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', x.day,
    'new', (select count(*) from fresh f where f.day = x.day),
    'limit_d0', (select count(*) from limited l where l.day = x.day),
    'bought', (select count(*) from bought b where b.day = x.day),
    'bought_pro', (select count(*) from bought b where b.day = x.day and b.plan = 'pro'),
    'bought_ultra', (select count(*) from bought b where b.day = x.day and b.plan = 'ultra'),
    'bought_byok', (select count(*) from bought b where b.day = x.day and b.plan = 'byok'),
    'pro_bought', (select count(*) from bought b where b.day = x.day and b.plan in ('pro', 'ultra'))
  ) order by x.day), '[]'::jsonb)
  from days x
$$;

-- MRR at the end of each UTC day of the last p_days (now for today). A subscription counts from its first payment
-- until it ends (expiry or refund), at the price of its transaction in effect then: the latest one Apple told us of
-- by then (an introductory or code price while it applies, the regular price from the renewal that ends it), else
-- its first priced one, else the plan's list price in the US (subscriptions from before prices were recorded,
-- 29.10). The plan is the product of the latest notification by then (an upgrade moves it at once). A yearly plan
-- counts a twelfth of its price each month of its year. Renewal off (the latest renewal status by then is
-- AUTO_RENEW_DISABLED, not the one Apple sends with an upgrade or downgrade) still counts until the end of what was
-- paid; "ending" is the part of it that ends within 30 days. Amounts in milliunits of each currency.
create or replace function public.cf_mrr_history(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, s.created_at, least(s.expires_at, s.revoked_at) as ends, t.paid_from
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.paid_from is not null and t.terms <> 'owner'
  ),
  notes as (
    select n.data->>'otid' as otid, n.created_at as at, n.data->>'type' as type, n.data->>'subtype' as subtype,
      n.data->>'product' as product, (n.data->>'price')::numeric as price, n.data->>'currency' as currency
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data ? 'otid'
      and exists (select 1 from subs s where s.otid = n.data->>'otid')
  ),
  points as (
    select g::date as day, least((g + interval '1 day') at time zone 'utc', now()) as at
    from d, generate_series((d.today - (d.days - 1))::timestamp, d.today::timestamp, interval '1 day') g
  ),
  state as (
    select p.day, p.at, s.ends,
      coalesce(pr.product, s.product_id) as product,
      coalesce(x.price, y.price) as price,
      coalesce(x.currency, y.currency, 'USD') as currency,
      coalesce(r.subtype = 'AUTO_RENEW_DISABLED' and not exists (
        select 1 from notes c
        where c.otid = s.otid and c.type = 'DID_CHANGE_RENEWAL_PREF' and c.at >= r.at and c.at < r.at + interval '2 minutes'
      ), false) as renewal_off
    from points p
    join subs s on s.paid_from <= p.at and coalesce(s.ends, 'infinity') > p.at
    left join lateral (select n.product from notes n where n.otid = s.otid and n.at <= p.at and n.product is not null order by n.at desc limit 1) pr on true
    left join lateral (select n.price, n.currency from notes n where n.otid = s.otid and n.at <= p.at and n.price is not null order by n.at desc limit 1) x on true
    left join lateral (select n.price, n.currency from notes n where n.otid = s.otid and n.price is not null order by n.at limit 1) y on true
    left join lateral (
      select n.at, n.subtype from notes n
      where n.otid = s.otid and n.at <= p.at and n.type = 'DID_CHANGE_RENEWAL_STATUS'
      order by n.at desc limit 1
    ) r on true
  ),
  priced as (
    select day, at, ends, renewal_off, currency,
      split_part(product, '.', 3) as plan,
      split_part(product, '.', 4) = 'yearly' as yearly,
      price is null as estimated,
      coalesce(price, case product
        when 'com.contextflow.pro.monthly' then 6990 when 'com.contextflow.pro.yearly' then 59990
        when 'com.contextflow.ultra.monthly' then 12990 when 'com.contextflow.ultra.yearly' then 119990
        when 'com.contextflow.byok.monthly' then 1990 when 'com.contextflow.byok.yearly' then 16990 end) as price
    from state
  ),
  rows as (
    select day, plan, yearly, renewal_off, currency, estimated,
      price / case when yearly then 12 else 1 end as monthly,
      renewal_off and coalesce(ends, 'infinity') < at + interval '30 days' as ending
    from priced
    where price > 0
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'points', coalesce((select jsonb_agg(to_jsonb(x) order by x.day, x.plan, x.yearly, x.renewal_off, x.currency) from (
      select day, plan, yearly, renewal_off, currency,
        count(*) as subs,
        round(sum(monthly)) as amount,
        count(*) filter (where ending) as ending,
        coalesce(round(sum(monthly) filter (where ending)), 0) as ending_amount,
        count(*) filter (where estimated) as estimated
      from rows
      group by 1, 2, 3, 4, 5
    ) x), '[]'::jsonb)
  )
$$;

-- Retention.
-- users: installs first seen in the last p_days (tests, our installs and App Review left out, as in the onboarding
--   report), by the UTC week (Monday) of their first day. Week k is days 7k…7k+6 after the install's own first day;
--   active = the panel opened or a question asked that week (contextflow.install_days). A week counts only once it's
--   over (before today); week 0 is the first.
-- subscribers: paying subscriptions by the UTC month of their first payment. Month m is checked m months after it
--   (two days later, for Apple's renewal): still paying if the subscription hadn't ended (expired or refunded) by
--   then. A yearly plan pays until its year is up, its renewal is month 12.
-- renewals: per plan and period (the current product): paid, due (the first renewal date, two days on, has passed),
--   renewed, churned, active now, leaving (renewal off), refunded.
create or replace function public.cf_retention(p_days integer default 90)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(7, least(coalesce(p_days, 90), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate'))
    union
    select install_id from contextflow.own_subscriptions where install_id is not null
  ),
  firsts as (
    select distinct on (install_id) install_id, day, platform, version, first_at
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  cohort as (
    select f.install_id, f.day as first_day, date_trunc('week', f.day)::date as week
    from firsts f, d
    where f.day > d.today - d.days
      and coalesce(f.version, '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.install_id = f.install_id)
      and not contextflow.in_review(f.platform, f.version, f.first_at)
  ),
  seen as (
    select distinct c.install_id, (u.day - c.first_day) / 7 as k
    from cohort c
    join contextflow.install_days u on u.install_id = c.install_id and u.day >= c.first_day
  ),
  ks as (select generate_series(0, 26) as k),
  user_cells as (
    select c.week, ks.k, count(*) as eligible, count(s.install_id) as active
    from cohort c
    cross join ks
    cross join d
    left join seen s on s.install_id = c.install_id and s.k = ks.k
    where ks.k = 0 or c.first_day + 7 * ks.k + 6 < d.today
    group by 1, 2
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, t.paid_from, s.revoked_at, s.last_notification,
      least(s.expires_at, s.revoked_at) as ends,
      coalesce((
        select n.data->>'product' from contextflow.events n
        where n.kind = 'appstore_notification' and n.data->>'otid' = s.original_transaction_id and n.data->>'product' is not null
        order by n.created_at limit 1
      ), s.product_id) as first_product
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.paid_from is not null and t.terms <> 'owner'
      and not exists (select 1 from contextflow.own_subscriptions o where o.otid = s.original_transaction_id)
  ),
  sx as (
    select x.*,
      date_trunc('month', x.paid_from at time zone 'utc')::date as month,
      split_part(x.first_product, '.', 3) as plan0,
      split_part(x.product_id, '.', 3) as plan,
      split_part(x.product_id, '.', 4) = 'yearly' as yearly,
      x.paid_from + case when split_part(x.product_id, '.', 4) = 'yearly' then interval '12 months' else interval '1 month' end
        + interval '2 days' as renewal_check
    from subs x
  ),
  ms as (select generate_series(0, 24) as m),
  sub_cells as (
    select x.month, ms.m, count(*) as eligible,
      count(*) filter (where ms.m = 0 or coalesce(x.ends, 'infinity') > x.paid_from + make_interval(months => ms.m) + interval '2 days') as paying
    from sx x
    cross join ms
    where ms.m = 0 or x.paid_from + make_interval(months => ms.m) + interval '2 days' <= now()
    group by 1, 2
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'users', jsonb_build_object(
      'cohorts', coalesce((select jsonb_agg(jsonb_build_object('week', c.week, 'size', c.size) order by c.week) from (
        select week, count(*) as size from cohort group by week) c), '[]'::jsonb),
      'cells', coalesce((select jsonb_agg(to_jsonb(x) order by x.week, x.k) from user_cells x), '[]'::jsonb)
    ),
    'subscribers', jsonb_build_object(
      'cohorts', coalesce((select jsonb_agg(to_jsonb(c) order by c.month) from (
        select month, count(*) as size,
          count(*) filter (where plan0 = 'pro') as pro, count(*) filter (where plan0 = 'ultra') as ultra,
          count(*) filter (where plan0 = 'byok') as byok,
          count(*) filter (where split_part(first_product, '.', 4) = 'yearly') as yearly
        from sx group by month) c), '[]'::jsonb),
      'cells', coalesce((select jsonb_agg(to_jsonb(x) order by x.month, x.m) from sub_cells x), '[]'::jsonb),
      'renewals', coalesce((select jsonb_agg(to_jsonb(r) order by r.plan, r.yearly) from (
        select plan, yearly,
          count(*) as paid,
          count(*) filter (where renewal_check <= now()) as due,
          count(*) filter (where renewal_check <= now() and coalesce(ends, 'infinity') > renewal_check) as renewed,
          count(*) filter (where renewal_check <= now() and coalesce(ends, 'infinity') <= renewal_check) as churned,
          count(*) filter (where coalesce(ends, 'infinity') > now()
            and last_notification is distinct from 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED') as active,
          count(*) filter (where coalesce(ends, 'infinity') > now()
            and last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED') as leaving,
          count(*) filter (where revoked_at is not null) as refunded,
          min(renewal_check - interval '2 days') filter (where renewal_check - interval '2 days' > now()) as next_due
        from sx group by plan, yearly) r), '[]'::jsonb)
    )
  )
$$;

revoke all on function public.cf_mrr_history(integer) from public, anon, authenticated;
grant execute on function public.cf_mrr_history(integer) to service_role;
revoke all on function public.cf_retention(integer) from public, anon, authenticated;
grant execute on function public.cf_retention(integer) to service_role;
