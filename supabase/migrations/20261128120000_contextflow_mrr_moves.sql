-- A subscription's first payment never moves; renewals and endings on /analytics («MRR по дням»: «продлённые» at the
-- bottom, «закончились» on top; «Продления» next to «Новые подписки»).
--
-- 1. contextflow.subscription_terms: paid_from was the first App Store note with a price above zero, whatever the
--    note. Subscriptions bought before Apple's notes carried prices (their SUBSCRIBED note has none) got paid_from on
--    the day of their first priced note, a renewal or an expiry a month later: they showed up as new subscriptions
--    on the day they came due, and their first month dropped out of the past days' MRR. paid_from is now the day the
--    subscription first cost money:
--    - no priced note at all: the entitlement's created_at (as before);
--    - the first priced note is not a purchase (its type isn't SUBSCRIBED or OFFER_REDEEMED) and has no offer or a
--      price above zero: the subscription was paying before price logging began, so created_at;
--    - otherwise (a purchase, or a free offer — a trial, a free code, a gift): the first payment note — SUBSCRIBED,
--      OFFER_REDEEMED or DID_RENEW — with a price above zero; none yet: not paid (null). An EXPIRED, a
--      DID_CHANGE_RENEWAL_* or any other note never sets it, so a trial that expires unpaid is never "bought".
--    Every other column is as before. Everything that reads paid_from follows: cf_new_user_outcomes («Новые
--    подписки»), cf_mrr_history, cf_retention, cf_owner_insights, cf_ladder.
-- 2. public.cf_mrr_moves(days): read only. Per day (UTC), plan, period and currency, how MRR moved and why — counts
--    of subscriptions and amounts a month in milliunits of the currency (a yearly price is a twelfth):
--      new        first payment (paid_from);
--      returned   paying again after a lapse: SUBSCRIBED:RESUBSCRIBE, DID_RENEW:BILLING_RECOVERY;
--      upgraded   DID_CHANGE_RENEWAL_PREF:UPGRADE once paying: the new price less the old one;
--      downgraded a renewal into a cheaper product: the old price less the new one;
--      left       EXPIRED, GRACE_PERIOD_EXPIRED, REFUND, REVOKE once paying (one per subscription and day): the price
--                 in effect;
--      due        a paid period ended: DID_RENEW (not a recovery), EXPIRED (not after a billing retry),
--                 DID_FAIL_TO_RENEW; a trial's end is its first payment, not a renewal;
--      renewed    DID_RENEW (not a recovery) after the first payment.
--    Our own subscriptions and the sandbox are out, as in cf_mrr_history. The page reads "left" (the red crossed
--    layer: what left MRR that day, at its last price), "due" and "renewed" (the tooltip, the «Продления» curve).
-- 3. public.cf_mrr_history: each point also says whether its subscriptions have renewed by then ("renewed"), so the
--    chart can put renewed subscriptions in a layer of their own.
--
-- Order: after 20261111120000_contextflow_renewal_mrr.sql. It changes no table and writes no data.

do $guard$
begin
  if to_regprocedure('public.cf_mrr_history(integer)') is null then
    raise exception 'apply 20261111120000_contextflow_renewal_mrr.sql first: public.cf_mrr_history(integer) is missing';
  end if;
end
$guard$;

-- contextflow.subscription_terms [latest version: 20261108120000_contextflow_ultra.sql]: only paid_from changes (and
-- the notes it reads carry their type).
create or replace function contextflow.subscription_terms()
returns table (otid text, terms text, offer_id text, paid_from timestamptz, price numeric, currency text, estimated boolean)
language sql stable set search_path = '' as $$
  with notes as (
    select n.data->>'otid' as otid, n.created_at, (n.data->>'price')::numeric as price, n.data->>'currency' as currency,
      n.data->>'offer' as offer, n.data->>'offer_id' as offer_id, n.data->>'type' as type
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data ? 'otid' and n.data->>'price' is not null
  )
  select s.original_transaction_id,
    case
      when o.otid is not null then 'owner'
      when f.otid is null or f.offer is null then 'full'
      when f.price > 0 then 'discount'
      when g.label is not null then g.label
      when f.offer = '1' then 'trial'
      else 'free_code'
    end,
    f.offer_id,
    case
      when o.otid is not null then null
      when f.otid is null then s.created_at
      when coalesce(f.type, '') not in ('SUBSCRIBED', 'OFFER_REDEEMED') and (f.offer is null or f.price > 0) then s.created_at
      else (
        select min(n.created_at) from notes n
        where n.otid = s.original_transaction_id and n.price > 0 and n.type in ('SUBSCRIBED', 'OFFER_REDEEMED', 'DID_RENEW')
      )
    end,
    coalesce(l.price, case s.product_id when 'com.contextflow.pro.monthly' then 6990 when 'com.contextflow.byok.monthly' then 1990
      when 'com.contextflow.pro.yearly' then 59990 when 'com.contextflow.ultra.monthly' then 12990 when 'com.contextflow.ultra.yearly' then 119990
      when 'com.contextflow.byok.yearly' then 16990 end),
    coalesce(l.currency, 'USD'),
    l.otid is null
  from contextflow.entitlements s
  left join contextflow.own_subscriptions o on o.otid = s.original_transaction_id
  left join lateral (select * from notes n where n.otid = s.original_transaction_id order by n.created_at limit 1) f on true
  left join lateral (select * from notes n where n.otid = s.original_transaction_id order by n.created_at desc limit 1) l on true
  left join contextflow.gift_offers g on g.offer_id = f.offer_id and f.offer = '3'
  where s.environment = 'Production'
$$;
revoke all on function contextflow.subscription_terms() from public, anon, authenticated;

-- public.cf_mrr_history [latest version: 20261111120000_contextflow_renewal_mrr.sql]: each point also says whether
-- its subscriptions have renewed (a DID_RENEW with a payment after the first payment, by the point's moment):
-- «продлённые» on the page. Sums over the old keys are unchanged, so a page that ignores "renewed" reads as before.
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
      exists (
        select 1 from notes n
        where n.otid = s.otid and n.type = 'DID_RENEW' and n.price > 0 and n.at <= p.at and n.at > s.paid_from
      ) as renewed,
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
    select day, at, ends, trial, renewal_off, discounted, renewed, currency,
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
    select day, trial, plan, yearly, renewal_off, discounted, renewed, currency, estimated, renewal_currency, renewal_estimated,
      price / case when yearly then 12 else 1 end as monthly,
      case when renewal_off then 0 else renewal_price / case when next_yearly then 12 else 1 end end as renewal_monthly,
      renewal_off and coalesce(ends, 'infinity') < at + interval '30 days' as ending,
      price
    from priced
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'points', coalesce((select jsonb_agg(to_jsonb(x) order by x.day, x.plan, x.yearly, x.renewal_off, x.discounted, x.renewed, x.currency, x.renewal_currency) from (
      select day, plan, yearly, renewal_off, discounted, renewed, currency, renewal_currency,
        count(*) as subs,
        round(sum(monthly)) as amount,
        count(*) filter (where ending) as ending,
        coalesce(round(sum(monthly) filter (where ending)), 0) as ending_amount,
        count(*) filter (where estimated) as estimated,
        round(sum(renewal_monthly)) as renewal_amount,
        count(*) filter (where renewal_estimated and not renewal_off) as renewal_estimated
      from rows
      where not trial and price > 0
      group by 1, 2, 3, 4, 5, 6, 7, 8
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

create or replace function public.cf_mrr_moves(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, s.created_at, least(s.expires_at, s.revoked_at) as ends,
      t.paid_from
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.terms <> 'owner'
  ),
  notes as (
    select n.data->>'otid' as otid, n.created_at as at, n.data->>'type' as type, coalesce(n.data->>'subtype', '') as subtype,
      coalesce(n.data->>'product', s.product_id) as product, (n.data->>'price')::numeric as price,
      n.data->>'currency' as currency, (n.data->>'auto_renew')::boolean as auto_renew, s.paid_from
    from contextflow.events n
    join subs s on s.otid = n.data->>'otid'
    where n.kind = 'appstore_notification'
  ),
  -- What a product costs a month: the note's price, else the US list price.
  list as (
    select * from (values
      ('com.contextflow.pro.monthly', 6990), ('com.contextflow.pro.yearly', 59990),
      ('com.contextflow.ultra.monthly', 12990), ('com.contextflow.ultra.yearly', 119990),
      ('com.contextflow.byok.monthly', 1990), ('com.contextflow.byok.yearly', 16990)
    ) v(product, price)
  ),
  -- Each note with the price in effect up to it (the latest priced note before it) and its own.
  priced as (
    select n.*,
      p.price as before_price, p.currency as before_currency, p.product as before_product
    from notes n
    left join lateral (
      select x.price, x.currency, x.product from notes x
      where x.otid = n.otid and x.at < n.at and x.price > 0
      order by x.at desc limit 1
    ) p on true
  ),
  moves as (
    -- new: the first payment, at the price of the note that made it (or the earliest priced one, or the list price).
    select s.otid, (s.paid_from at time zone 'utc')::date as day, 'new' as kind,
      coalesce(pay.product, s.product_id) as product,
      coalesce(pay.currency, 'USD') as currency,
      coalesce(pay.price, (select l.price from list l where l.product = s.product_id)) as amount
    from subs s
    left join lateral (
      select n.product, n.currency, n.price from notes n
      where n.otid = s.otid and n.price > 0
      order by abs(extract(epoch from n.at - s.paid_from)), n.at limit 1
    ) pay on true
    where s.paid_from is not null
    union all
    select otid, (at at time zone 'utc')::date, 'returned', product, coalesce(currency, before_currency, 'USD'),
      coalesce(nullif(price, 0), before_price, (select l.price from list l where l.product = priced.product))
    from priced
    where paid_from is not null and at > paid_from
      and ((type = 'SUBSCRIBED' and subtype = 'RESUBSCRIBE') or (type = 'DID_RENEW' and subtype = 'BILLING_RECOVERY'))
    union all
    -- An upgrade moves MRR when its price is known in the same currency as before; else it counts with no amount.
    select otid, (at at time zone 'utc')::date, 'upgraded', product, coalesce(currency, before_currency, 'USD'),
      case when price > 0 and before_price > 0 and currency = before_currency
        then greatest(0, price / case when product like '%.yearly' then 12 else 1 end
                       - before_price / case when before_product like '%.yearly' then 12 else 1 end)
        else 0 end
    from priced
    where paid_from is not null and at >= paid_from and type = 'DID_CHANGE_RENEWAL_PREF' and subtype = 'UPGRADE'
    union all
    select otid, (at at time zone 'utc')::date, 'downgraded', product, currency,
      before_price / case when before_product like '%.yearly' then 12 else 1 end
        - price / case when product like '%.yearly' then 12 else 1 end
    from priced
    where paid_from is not null and at > paid_from and type = 'DID_RENEW' and subtype <> 'BILLING_RECOVERY'
      and product <> before_product and price > 0 and currency = before_currency
      and price / case when product like '%.yearly' then 12 else 1 end
        < before_price / case when before_product like '%.yearly' then 12 else 1 end
    union all
    select distinct on (otid, (at at time zone 'utc')::date)
      otid, (at at time zone 'utc')::date, 'left', product,
      case when price > 0 then currency else coalesce(before_currency, 'USD') end,
      coalesce(nullif(price, 0), before_price, (select l.price from list l where l.product = priced.product))
    from priced
    where paid_from is not null and at >= paid_from and type in ('EXPIRED', 'GRACE_PERIOD_EXPIRED', 'REFUND', 'REVOKE')
    union all
    select distinct on (otid, (at at time zone 'utc')::date)
      otid, (at at time zone 'utc')::date, 'due', product,
      case when price > 0 then currency else coalesce(before_currency, 'USD') end, 0
    from priced
    where paid_from is not null and at > paid_from
      and ((type = 'DID_RENEW' and subtype <> 'BILLING_RECOVERY')
        or (type = 'EXPIRED' and subtype <> 'BILLING_RETRY')
        or type = 'DID_FAIL_TO_RENEW')
    union all
    select otid, (at at time zone 'utc')::date, 'renewed', product, coalesce(currency, before_currency, 'USD'), 0
    from priced
    where paid_from is not null and at > paid_from and type = 'DID_RENEW' and subtype <> 'BILLING_RECOVERY'
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'moves', coalesce((select jsonb_agg(to_jsonb(x) order by x.day, x.kind, x.plan, x.yearly, x.currency) from (
      select m.day, m.kind, split_part(m.product, '.', 3) as plan, split_part(m.product, '.', 4) = 'yearly' as yearly,
        m.currency, count(*) as subs,
        round(sum(m.amount / case when m.kind in ('upgraded', 'downgraded') or split_part(m.product, '.', 4) <> 'yearly' then 1 else 12 end)) as amount
      from moves m, d
      where m.day > d.today - d.days and m.day <= d.today
      group by 1, 2, 3, 4, 5
    ) x), '[]'::jsonb)
  )
$$;
revoke all on function public.cf_mrr_moves(integer) from public, anon, authenticated;
grant execute on function public.cf_mrr_moves(integer) to service_role;
