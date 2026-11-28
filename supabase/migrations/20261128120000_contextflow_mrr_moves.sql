-- A subscription's first payment never moves, and MRR's movement by day (/analytics «Движение MRR по дням»,
-- «Продления»).
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
--    A renewal at the same price doesn't move MRR. "upcoming": subscriptions paid now whose period ends in the next
--    7 days, per plan, period and currency: how many, how many with auto-renew off (the same rule as cf_mrr_history),
--    and what those take with them a month. Our own subscriptions and the sandbox are out, as in cf_mrr_history.
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
  ),
  -- Auto-renew now, as cf_mrr_history reads it: Apple's renewal info where logged, else the latest status change
  -- (a DISABLED within 2 minutes of a plan change is part of the change), else a purchase or renewal means on.
  renewal as (
    select s.otid, s.product_id, s.ends,
      coalesce(pr.product, s.product_id) as product,
      coalesce(x.price, (select l.price from list l where l.product = coalesce(pr.product, s.product_id))) as price,
      coalesce(x.currency, 'USD') as currency,
      coalesce(ar.off, false) as off
    from subs s
    left join lateral (select n.product from notes n where n.otid = s.otid and n.product is not null order by n.at desc limit 1) pr on true
    left join lateral (select n.price, n.currency from notes n where n.otid = s.otid and n.price > 0 order by n.at desc limit 1) x on true
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
      where n.otid = s.otid
        and (n.auto_renew is not null or n.type in ('DID_CHANGE_RENEWAL_STATUS', 'DID_CHANGE_RENEWAL_PREF', 'SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED'))
      order by n.at desc, (n.type = 'DID_CHANGE_RENEWAL_STATUS') desc
      limit 1
    ) ar on true
    where s.paid_from is not null and s.paid_from <= now() and s.ends > now() and s.ends <= now() + interval '7 days'
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
    ) x), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(to_jsonb(x) order by x.plan, x.yearly, x.currency) from (
      select split_part(r.product, '.', 3) as plan, split_part(r.product, '.', 4) = 'yearly' as yearly, r.currency,
        count(*) as due,
        count(*) filter (where r.off) as renewal_off,
        coalesce(round(sum(r.price / case when split_part(r.product, '.', 4) = 'yearly' then 12 else 1 end) filter (where r.off)), 0) as leaving_amount
      from renewal r
      group by 1, 2, 3
    ) x), '[]'::jsonb)
  )
$$;
revoke all on function public.cf_mrr_moves(integer) from public, anon, authenticated;
grant execute on function public.cf_mrr_moves(integer) to service_role;
