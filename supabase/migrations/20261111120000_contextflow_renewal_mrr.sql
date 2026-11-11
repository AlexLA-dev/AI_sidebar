-- MRR at renewal (/analytics «MRR при продлении»): cf_mrr_history also says what each day's subscriptions would bring
-- a month once they renew, and which of them are on a discount or a free trial now.
--
-- Order: apply after 20261110120000_contextflow_mrr_retention.sql (it replaces that migration's cf_mrr_history; the
-- guard below stops it otherwise). It replaces this one function and sets its grants; it changes no table and writes
-- no data. Reading only: safe to apply before the page that uses it is deployed (today's page ignores the new fields).
--
-- Renewal price of a subscription, for the product it renews to (the one Apple names for the next renewal, else the
-- current one), the first of:
--   1. Apple's renewal price, when the notification carried renewal info and the next renewal gets no offer
--      (logged by appstore-verify from build 2.6 of the server on: auto_renew, renewal_product, renewal_price,
--      renewal_currency, renewal_offer, renewal_at);
--   2. the latest price without an offer that this subscription paid for that product;
--   3. the latest price without an offer that any production subscription paid for that product in the same storefront;
--   4. the same in the same currency;
--   5. the US list price, marked estimated.
-- Auto-renew at a moment: the latest notification by then that says so wins. Apple's renewal info (auto_renew) where
-- logged; else DID_CHANGE_RENEWAL_STATUS (ENABLED / DISABLED); a purchase, renewal, offer redemption or plan change
-- (SUBSCRIBED, DID_RENEW, OFFER_REDEEMED, DID_CHANGE_RENEWAL_PREF) means it's on. A DISABLED within 2 minutes of a plan
-- change is the one Apple sends with an upgrade or downgrade and doesn't count. Before, only the latest
-- DID_CHANGE_RENEWAL_STATUS counted, so a subscriber who turned renewal back on through a new purchase stayed "leaving".
--
-- New in each point (one row per day, plan, period, renewal state, discount, currency, renewal currency):
--   discounted        true for subscriptions whose price in effect has an offer (a code, promotional, win-back or
--                     paid introductory price);
--   renewal_currency, renewal_amount  what the row's subscriptions bring a month at the renewal price (0 with renewal
--                     off);
--   renewal_estimated how many of them have the US list price as the renewal price (step 5).
-- New list "trials": subscriptions in a free trial or on a free code, not paid yet, with auto-renew on, per day, plan,
-- period and renewal currency: subs, renewal_amount, renewal_estimated. They're not in MRR (nothing is paid yet).

do $guard$
begin
  if to_regprocedure('public.cf_mrr_history(integer)') is null then
    raise exception 'apply 20261110120000_contextflow_mrr_retention.sql first: public.cf_mrr_history(integer) is missing';
  end if;
end
$guard$;

create or replace function public.cf_mrr_history(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, s.created_at, least(s.expires_at, s.revoked_at) as ends,
      t.paid_from, t.terms
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.terms <> 'owner'
      and (t.paid_from is not null or t.terms in ('trial', 'free_code'))
  ),
  notes as (
    select n.data->>'otid' as otid, n.created_at as at, n.data->>'type' as type, n.data->>'subtype' as subtype,
      n.data->>'product' as product, (n.data->>'price')::numeric as price, n.data->>'currency' as currency,
      n.data->>'storefront' as storefront, n.data->>'offer' as offer,
      (n.data->>'auto_renew')::boolean as auto_renew, n.data->>'renewal_product' as renewal_product,
      (n.data->>'renewal_price')::numeric as renewal_price, n.data->>'renewal_currency' as renewal_currency,
      n.data->>'renewal_offer' as renewal_offer
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data ? 'otid'
      and exists (select 1 from subs s where s.otid = n.data->>'otid')
  ),
  -- Prices without an offer that Apple charged or will charge, any production subscription (ours are free).
  full_prices as (
    select n.data->>'otid' as otid, n.created_at as at, n.data->>'product' as product, n.data->>'storefront' as storefront,
      n.data->>'currency' as currency, (n.data->>'price')::numeric as price
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data->>'environment' = 'Production' and n.data ? 'product'
      and n.data->>'offer' is null and (n.data->>'price')::numeric > 0
    union all
    select n.data->>'otid', n.created_at, n.data->>'renewal_product', n.data->>'storefront',
      n.data->>'renewal_currency', (n.data->>'renewal_price')::numeric
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data->>'environment' = 'Production' and n.data ? 'renewal_product'
      and n.data->>'renewal_offer' is null and (n.data->>'renewal_price')::numeric > 0
  ),
  points as (
    select g::date as day, least((g + interval '1 day') at time zone 'utc', now()) as at
    from d, generate_series((d.today - (d.days - 1))::timestamp, d.today::timestamp, interval '1 day') g
  ),
  state as (
    select p.day, p.at, s.otid, s.ends,
      not (s.paid_from is not null and s.paid_from <= p.at) as trial,
      coalesce(pr.product, s.product_id) as product,
      coalesce(x.price, y.price) as price,
      coalesce(x.currency, y.currency, 'USD') as currency,
      coalesce(x.storefront, y.storefront) as storefront,
      x.offer is not null and coalesce(x.price, 0) > 0 as discounted,
      coalesce(ar.off, false) as renewal_off,
      coalesce(ri.renewal_product, pr.product, s.product_id) as next_product,
      case when ri.renewal_price > 0 and ri.renewal_offer is null then ri.renewal_price end as apple_price,
      ri.renewal_currency as apple_currency
    from points p
    join subs s on coalesce(s.ends, 'infinity') > p.at
      and (s.paid_from <= p.at or (s.terms in ('trial', 'free_code') and s.created_at <= p.at))
    left join lateral (select n.product from notes n where n.otid = s.otid and n.at <= p.at and n.product is not null order by n.at desc limit 1) pr on true
    left join lateral (select n.price, n.currency, n.storefront, n.offer from notes n where n.otid = s.otid and n.at <= p.at and n.price is not null order by n.at desc limit 1) x on true
    left join lateral (select n.price, n.currency, n.storefront from notes n where n.otid = s.otid and n.price is not null order by n.at limit 1) y on true
    left join lateral (
      select case
        when n.auto_renew is not null then not n.auto_renew
        when n.type = 'DID_CHANGE_RENEWAL_STATUS' then n.subtype = 'AUTO_RENEW_DISABLED' and not exists (
          select 1 from notes c
          where c.otid = s.otid and c.type = 'DID_CHANGE_RENEWAL_PREF' and c.at between n.at - interval '2 minutes' and n.at + interval '2 minutes'
        )
        else false
      end as off
      from notes n
      where n.otid = s.otid and n.at <= p.at
        and (n.auto_renew is not null or n.type in ('DID_CHANGE_RENEWAL_STATUS', 'DID_CHANGE_RENEWAL_PREF', 'SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED'))
      order by n.at desc, (n.type = 'DID_CHANGE_RENEWAL_STATUS') desc
      limit 1
    ) ar on true
    left join lateral (
      select n.renewal_product, n.renewal_price, n.renewal_currency, n.renewal_offer from notes n
      where n.otid = s.otid and n.at <= p.at and n.renewal_product is not null
      order by n.at desc limit 1
    ) ri on true
  ),
  renewal as (
    select st.*,
      coalesce(st.apple_price, f1.price, f2.price, f3.price) as found_price,
      case when st.apple_price is not null then st.apple_currency else coalesce(f1.currency, f2.currency, f3.currency) end as found_currency
    from state st
    left join lateral (select f.price, f.currency from full_prices f where st.apple_price is null and f.otid = st.otid and f.product = st.next_product and f.at <= st.at order by f.at desc limit 1) f1 on true
    left join lateral (select f.price, f.currency from full_prices f where st.apple_price is null and f.product = st.next_product and f.storefront = st.storefront order by f.at desc limit 1) f2 on true
    left join lateral (select f.price, f.currency from full_prices f where st.apple_price is null and f.product = st.next_product and f.currency = st.currency order by f.at desc limit 1) f3 on true
  ),
  priced as (
    select day, at, ends, trial, renewal_off, discounted, currency,
      split_part(product, '.', 3) as plan,
      split_part(product, '.', 4) = 'yearly' as yearly,
      price is null as estimated,
      coalesce(price, case product
        when 'com.contextflow.pro.monthly' then 6990 when 'com.contextflow.pro.yearly' then 59990
        when 'com.contextflow.ultra.monthly' then 12990 when 'com.contextflow.ultra.yearly' then 119990
        when 'com.contextflow.byok.monthly' then 1990 when 'com.contextflow.byok.yearly' then 16990 end) as price,
      split_part(next_product, '.', 4) = 'yearly' as next_yearly,
      found_price is null as renewal_estimated,
      coalesce(found_currency, 'USD') as renewal_currency,
      coalesce(found_price, case next_product
        when 'com.contextflow.pro.monthly' then 6990 when 'com.contextflow.pro.yearly' then 59990
        when 'com.contextflow.ultra.monthly' then 12990 when 'com.contextflow.ultra.yearly' then 119990
        when 'com.contextflow.byok.monthly' then 1990 when 'com.contextflow.byok.yearly' then 16990 end) as renewal_price
    from renewal
  ),
  rows as (
    select day, trial, plan, yearly, renewal_off, discounted, currency, estimated, renewal_currency, renewal_estimated,
      price / case when yearly then 12 else 1 end as monthly,
      case when renewal_off then 0 else renewal_price / case when next_yearly then 12 else 1 end end as renewal_monthly,
      renewal_off and coalesce(ends, 'infinity') < at + interval '30 days' as ending,
      price
    from priced
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'points', coalesce((select jsonb_agg(to_jsonb(x) order by x.day, x.plan, x.yearly, x.renewal_off, x.discounted, x.currency, x.renewal_currency) from (
      select day, plan, yearly, renewal_off, discounted, currency, renewal_currency,
        count(*) as subs,
        round(sum(monthly)) as amount,
        count(*) filter (where ending) as ending,
        coalesce(round(sum(monthly) filter (where ending)), 0) as ending_amount,
        count(*) filter (where estimated) as estimated,
        round(sum(renewal_monthly)) as renewal_amount,
        count(*) filter (where renewal_estimated and not renewal_off) as renewal_estimated
      from rows
      where not trial and price > 0
      group by 1, 2, 3, 4, 5, 6, 7
    ) x), '[]'::jsonb),
    'trials', coalesce((select jsonb_agg(to_jsonb(x) order by x.day, x.plan, x.yearly, x.renewal_currency) from (
      select day, plan, yearly, renewal_currency,
        count(*) as subs,
        round(sum(renewal_monthly)) as renewal_amount,
        count(*) filter (where renewal_estimated) as renewal_estimated
      from rows
      where trial and not renewal_off
      group by 1, 2, 3, 4
    ) x), '[]'::jsonb)
  )
$$;
revoke all on function public.cf_mrr_history(integer) from public, anon, authenticated;
grant execute on function public.cf_mrr_history(integer) to service_role;
