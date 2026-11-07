-- ContextFlow 2.6: Ultra (com.contextflow.ultra.monthly / .yearly), the yearly plans (pro.yearly, byok.yearly) and read
-- aloud. Not applied anywhere yet: the director applies it in production (tier 2), after
-- 20261107120000_contextflow_guided_tour.sql (cf_feature_funnels below extends that version).
--
-- What changes:
-- - cf_entitlement_upsert keeps the product of the transaction that runs longer, so a late old Ultra transaction can't
--   undo a downgrade to Pro (netlify/shared/plan.mts resolveAccess reads it back).
-- - Every report that sorts paid from free counts 'ultra' as paid; the limits report puts Ultra's answers with Pro's
--   weekly allowance (Ultra and Pro share one weekly answer counter per subscription).
-- - subscription_terms knows the list prices of the new products (USD) for subscriptions no notification priced yet.
-- - cf_feature_funnels: "listen_ultra" (Listen without Ultra → plans sheet → plan chosen → bought) and "plans".
-- - cf_speak_report(days): read aloud's minutes, people, cost per minute now and at the 2027 prices, first audio.
-- Each function below is its latest version with only these edits (diff it against the file named in its comment).
-- The usage counters need nothing new: read aloud and find similar use the existing weekly counters
-- (speak:tx:<otid> in seconds, similar:tx:<otid> in searches).

-- cf_entitlement_upsert: the product follows the transaction that runs longer [latest version: 20261023100100_contextflow_rpc_functions.sql]
create or replace function public.cf_entitlement_upsert(p jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  insert into contextflow.entitlements as e (
    original_transaction_id, product_id, environment, expires_at, revoked_at,
    app_account_token, last_transaction_id, last_notification)
  values (
    p->>'original_transaction_id', p->>'product_id', coalesce(p->>'environment', 'Production'),
    (p->>'expires_at')::timestamptz, (p->>'revoked_at')::timestamptz,
    nullif(p->>'app_account_token', '')::uuid, p->>'last_transaction_id', p->>'last_notification')
  on conflict (original_transaction_id) do update set
    -- 2.6: the product of the transaction that runs longer. An upgrade (Pro → Ultra) runs longer at once; a downgrade
    -- (Ultra → Pro) takes over at its renewal; an old signed transaction sent late can't bring the old plan back.
    product_id          = case when excluded.revoked_at is not null or excluded.expires_at is null or e.expires_at is null
                                 or excluded.expires_at >= e.expires_at then excluded.product_id
                               else e.product_id end,
    environment         = excluded.environment,
    expires_at          = case when excluded.revoked_at is not null then excluded.expires_at
                               else greatest(e.expires_at, excluded.expires_at) end,
    revoked_at          = case when excluded.revoked_at is not null then excluded.revoked_at
                               when excluded.expires_at > coalesce(e.revoked_at, '-infinity') then null
                               else e.revoked_at end,
    app_account_token   = coalesce(excluded.app_account_token, e.app_account_token),
    last_transaction_id = coalesce(excluded.last_transaction_id, e.last_transaction_id),
    last_notification   = coalesce(excluded.last_notification, e.last_notification),
    updated_at          = now()
  returning to_jsonb(e);
$$;

-- cf_ads_funnel: Ultra is a paid plan [latest version: 20261102150000_contextflow_subscription_terms.sql]
create or replace function public.cf_ads_funnel(p_from date, p_to date)
returns table (
  campaign_id bigint, ad_group_id bigint, keyword_id bigint,
  installs bigint, extension_on bigint, first_answer bigint, subscribed bigint
)
language sql stable security definer set search_path = '' as $$
  with unpaid as (select otid from contextflow.subscription_terms() where paid_from is null),
  ads as (
    select distinct on (e.data->>'app')
      e.data->>'app' as app,
      (e.data->>'campaignId')::bigint as campaign_id,
      (e.data->>'adGroupId')::bigint as ad_group_id,
      nullif(e.data->>'keywordId', '')::bigint as keyword_id,
      e.install_id
    from contextflow.events e
    where e.kind = 'ads_attribution' and e.data ? 'app'
      and (e.created_at at time zone 'utc')::date between p_from and p_to
    order by e.data->>'app', e.created_at
  ),
  installs as (
    select a.*,
      coalesce(a.install_id, (
        select o.install_id from contextflow.events o
        where o.kind = 'app_open' and o.data->>'app' = a.app and o.install_id is not null
        order by o.created_at limit 1
      )) as install
    from ads a
  ),
  steps as (
    select i.*,
      i.install is not null and exists (select 1 from contextflow.install_days d where d.install_id = i.install) as on_,
      i.install is not null and exists (
        select 1 from contextflow.events c
        where c.install_id = i.install and c.kind = 'chat' and coalesce(c.data->>'ok', 'true') <> 'false'
      ) as answered,
      exists (
        select 1 from contextflow.entitlements s
        where s.environment = 'Production'
          and s.app_account_token in (i.install, case when i.app ~ '^[0-9a-fA-F-]{36}$' then i.app::uuid end)
          and not exists (select 1 from unpaid u where u.otid = s.original_transaction_id)
      ) or (i.install is not null and exists (
        select 1 from contextflow.events c
        where c.install_id = i.install and c.kind = 'chat' and c.data->>'plan' in ('pro', 'byok', 'ultra')
          and not exists (select 1 from unpaid u where u.otid = c.data->>'otid')
      )) as paid
    from installs i
  )
  select campaign_id, ad_group_id, keyword_id,
    count(*), count(*) filter (where on_), count(*) filter (where answered), count(*) filter (where paid)
  from steps
  group by 1, 2, 3
  order by 7 desc, 4 desc;
$$;

-- cf_owner_insights: Ultra is a paid plan [latest version: 20261102150000_contextflow_subscription_terms.sql]
create or replace function public.cf_owner_insights(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  -- Our own test devices, left out entirely.
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' = 'dev-check')
  ),
  -- The moment each install was first seen (panel opened or a question asked).
  first_seen as (
    select distinct on (install_id) install_id, first_at, platform, version
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, s.created_at, s.expires_at, s.revoked_at, s.app_account_token,
      s.last_notification, t.terms, t.offer_id, t.paid_from, t.price, t.currency, t.estimated,
      t.terms in ('trial', 'free_code', 'press', 'owner') as free_start
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production'
  ),
  -- Links 1 and 2.
  known as (
    select data->>'otid' as otid, install_id from contextflow.events
    where kind = 'chat' and install_id is not null and data->>'otid' is not null
    union
    select s.otid, i.install_id from subs s join contextflow.installs i on i.install_id = s.app_account_token
    union
    select s.otid, o.install_id from subs s
    join contextflow.events o on o.kind = 'app_open' and o.install_id is not null and o.data->>'app' = s.app_account_token::text
    union
    -- Our own subscriptions name their device.
    select o.otid, o.install_id from contextflow.own_subscriptions o where o.install_id is not null
  ),
  -- Link 3: each install's first paid answer from before answers carried the otid. App Review windows are
  -- not left out here: these are production purchases, and a window closed late would hide a subscriber.
  paid as (
    select e.install_id, min(e.created_at) as first_at
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and e.data->>'plan' in ('pro', 'byok', 'ultra') and e.data->>'otid' is null
      and coalesce(e.data->>'audience', '') <> 'test' and coalesce(e.data->>'version', '') <> 'dev-check'
    group by e.install_id
  ),
  -- The server records a subscription before the first answer it pays for, so that answer comes after it.
  candidates as (
    select s.otid, p.install_id, p.first_at - s.created_at as gap
    from subs s
    join paid p on p.first_at >= s.created_at and p.first_at < s.created_at + interval '1 day'
    where not exists (select 1 from known k where k.otid = s.otid)
      and not exists (select 1 from known k where k.install_id = p.install_id)
  ),
  links as (
    select k.otid, k.install_id, true as exact from known k
    union all
    select c.otid, c.install_id, false from candidates c
    where c.gap = (select min(x.gap) from candidates x where x.otid = c.otid)
      and c.gap = (select min(x.gap) from candidates x where x.install_id = c.install_id)
  ),
  converted as (
    select l.install_id, min(s.paid_from) as at from links l join subs s on s.otid = l.otid
    where s.paid_from is not null group by l.install_id
  ),
  -- Apple Ads: the first attribution of each app, tied to the extension's install through 'app_open'.
  ads as (
    select distinct on (e.data->>'app')
      e.data->>'app' as app,
      e.created_at,
      coalesce(e.install_id, (
        select o.install_id from contextflow.events o
        where o.kind = 'app_open' and o.data->>'app' = e.data->>'app' and o.install_id is not null
        order by o.created_at limit 1
      )) as install_id,
      nullif(e.data->>'campaignId', '')::bigint as campaign_id,
      nullif(e.data->>'adGroupId', '')::bigint as ad_group_id,
      nullif(e.data->>'keywordId', '')::bigint as keyword_id,
      e.data->>'countryOrRegion' as country
    from contextflow.events e
    -- Development and TestFlight builds get Apple's sample record (campaign 1234567890), not an ad.
    where e.kind = 'ads_attribution' and e.data ? 'app' and coalesce(e.data->>'campaignId', '') <> '1234567890'
    order by e.data->>'app', e.created_at
  ),
  -- Installs that opened the ContextFlow app (2.4+): the app asks Apple Ads about every download, so
  -- for these no attribution means the download didn't come from an ad.
  app_installs as (
    select distinct install_id from contextflow.events where kind = 'app_open' and install_id is not null
  ),
  -- New users of the period: installs first seen in it, without tests and App Review.
  cohort as (
    select f.install_id, f.first_at
    from first_seen f, d
    where (f.first_at at time zone 'utc')::date > d.today - d.days
      and coalesce(f.version, '') <> 'dev-check'
      and not exists (select 1 from tests t where t.install_id = f.install_id)
      and not contextflow.in_review(f.platform, f.version, f.first_at)
  ),
  -- Real users' questions in the period, the same ones as in cf_usage_report.
  chats as (
    select x.day, x.install_id, x.paid and not x.gift as paid, x.gift
    from (
      select (e.created_at at time zone 'utc')::date as day, e.install_id,
        coalesce(e.data->>'plan', '') in ('pro', 'byok', 'ultra') or e.data->>'key' = 'own' as paid,
        -- Pro on a free start (trial, gift code, ours) before anyone paid for it.
        exists (
          select 1 from subs s
          where s.otid = e.data->>'otid' and s.free_start and (s.paid_from is null or e.created_at < s.paid_from)
        ) as gift
      from contextflow.events e, d
    where e.kind = 'chat' and e.created_at >= now() - make_interval(days => d.days)
      and coalesce(e.data->>'audience', '') <> 'test' and coalesce(e.data->>'version', '') <> 'dev-check'
      and not contextflow.in_review(e.data->>'platform', e.data->>'version', e.created_at)
    ) x
  ),
  user_days as (
    select u.day, u.install_id
    from contextflow.install_days u, d
    where u.day > d.today - d.days
      and coalesce(u.version, '') <> 'dev-check'
      and not exists (select 1 from tests t where t.install_id = u.install_id)
      and not contextflow.in_review(u.platform, u.version, u.first_at)
  ),
  asked as (select day, install_id, count(*) as n, bool_or(paid) as paid, bool_or(gift) as gift from chats group by day, install_id),
  -- Each active user's day as free, paying or free Pro: such an answer that day, or such a subscription active then.
  plan_days as (
    select u.day, u.install_id, coalesce(a.n, 0) as n,
      coalesce(a.paid, false) or exists (
        select 1 from links l join subs s on s.otid = l.otid
        where l.install_id = u.install_id
          and u.day between (s.paid_from at time zone 'utc')::date
                        and coalesce((least(s.expires_at, s.revoked_at) at time zone 'utc')::date, u.day)
      ) as paid,
      coalesce(a.gift, false) or exists (
        select 1 from links l join subs s on s.otid = l.otid
        where l.install_id = u.install_id and s.free_start
          and u.day between (s.created_at at time zone 'utc')::date
                        and coalesce((least(s.paid_from, s.expires_at, s.revoked_at) at time zone 'utc')::date, u.day)
      ) as gift
    from user_days u
    left join asked a on a.day = u.day and a.install_id = u.install_id
  ),
  -- MRR at the end of each week (now for this one): every subscription active then, at the price of its transaction
  -- in effect, the latest Apple told us of by then, else its first one, else the estimate (subscription_terms).
  -- A yearly plan counts a twelfth; ours count as free. Amounts in milliunits of each currency.
  priced as (
    select n.data->>'otid' as otid, n.created_at as at, (n.data->>'price')::numeric as price, n.data->>'currency' as currency
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data ? 'otid' and n.data->>'price' is not null
  ),
  points as (
    select w::date as week, least((w + interval '7 days') at time zone 'utc', now()) as at, w = date_trunc('week', d.today::timestamp) as current
    from d, generate_series(date_trunc('week', (d.today - (d.days - 1))::timestamp), date_trunc('week', d.today::timestamp), interval '7 days') w
  ),
  mrr_subs as (
    select p.week, p.current, s.renewal_off,
      coalesce(x.currency, y.currency, s.currency) as currency,
      case when s.terms = 'owner' then 0
           else coalesce(x.price, y.price, s.price) / case when s.product_id like '%yearly%' then 12 else 1 end end as monthly,
      x.price is null and y.price is null and s.estimated as estimated
    from points p
    join (
      select *, last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED' as renewal_off from subs
    ) s on s.created_at <= p.at and coalesce(least(s.expires_at, s.revoked_at), 'infinity') > p.at
    left join lateral (select r.price, r.currency from priced r where r.otid = s.otid and r.at <= p.at order by r.at desc limit 1) x on true
    left join lateral (select r.price, r.currency from priced r where r.otid = s.otid order by r.at limit 1) y on true
  )
  select jsonb_build_object(
    'days', (select days from d),
    'subscribers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'created_at', s.created_at,
        'product_id', s.product_id,
        'terms', s.terms,
        'offer_id', s.offer_id,
        'paid_from', s.paid_from,
        'storefront', (
          select n.data->>'storefront' from contextflow.events n
          where n.kind = 'appstore_notification' and n.data->>'otid' = s.otid and n.data->>'storefront' is not null
          order by n.created_at desc limit 1
        ),
        'link', case when x.installs is null then null when x.exact then 'exact' else 'time' end,
        'installs', coalesce(x.installs, '[]'::jsonb),
        'ads', (
          select jsonb_build_object('campaign_id', a.campaign_id, 'ad_group_id', a.ad_group_id, 'keyword_id', a.keyword_id, 'country', a.country)
          from ads a
          where a.app = s.app_account_token::text or a.install_id in (select l.install_id from links l where l.otid = s.otid)
          order by a.created_at limit 1
        ),
        'app', exists (
          select 1 from contextflow.events o
          where o.kind = 'app_open'
            and (o.data->>'app' = s.app_account_token::text or o.install_id in (select l.install_id from links l where l.otid = s.otid))
        )
      ) order by s.created_at desc), '[]'::jsonb)
      from (select * from subs order by created_at desc limit 200) s
      left join lateral (
        select bool_and(l.exact) as exact,
          jsonb_agg(jsonb_build_object('platform', i.platform, 'locale', i.locale, 'first_seen', f.first_at) order by f.first_at) as installs
        from links l
        left join contextflow.installs i on i.install_id = l.install_id
        left join first_seen f on f.install_id = l.install_id
        where l.otid = s.otid
      ) x on true
    ),
    -- Questions per UTC day from installs first seen that same day vs everyone else.
    'requests_by_age', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.day), '[]'::jsonb) from (
        select c.day,
          count(*) filter (where c.day = (f.first_at at time zone 'utc')::date) as new,
          count(*) filter (where f.first_at is null or c.day <> (f.first_at at time zone 'utc')::date) as old
        from chats c
        left join first_seen f on f.install_id = c.install_id
        group by c.day
      ) x
    ),
    -- New users by the UTC day they were first seen, and how many of them subscribed: so far, and within
    -- 7 / 30 days among those first seen at least 7 / 30 days ago.
    'cohorts', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.day), '[]'::jsonb) from (
        select (c.first_at at time zone 'utc')::date as day,
          count(*) as users,
          count(v.at) as subscribed,
          count(*) filter (where c.first_at <= now() - interval '7 days') as ready_7,
          count(*) filter (where c.first_at <= now() - interval '7 days' and v.at < c.first_at + interval '7 days') as in_7,
          count(*) filter (where c.first_at <= now() - interval '30 days') as ready_30,
          count(*) filter (where c.first_at <= now() - interval '30 days' and v.at < c.first_at + interval '30 days') as in_30
        from cohort c
        left join converted v on v.install_id = c.install_id
        group by 1
      ) x
    ),
    'per_user', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.plan), '[]'::jsonb) from (
        select case when paid then 'paid' when gift then 'gift' else 'free' end as plan,
          count(distinct install_id) as users,
          count(*) as user_days,
          count(*) filter (where n > 0) as asked_days,
          sum(n) as requests,
          max(n) as max_per_day
        from plan_days
        group by 1
      ) x
    ),
    -- Per week and currency: paying subscriptions and what they pay a month; free ones; auto-renew off (this week).
    'mrr', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.week, x.currency), '[]'::jsonb) from (
        select week, currency,
          count(*) filter (where monthly > 0) as paying,
          coalesce(sum(monthly) filter (where monthly > 0), 0) as amount,
          count(*) filter (where monthly > 0 and estimated) as estimated,
          count(*) filter (where monthly = 0) as free,
          count(*) filter (where current and monthly > 0 and renewal_off) as renewal_off,
          coalesce(sum(monthly) filter (where current and monthly > 0 and renewal_off), 0) as renewal_off_amount
        from mrr_subs
        group by week, currency
      ) x
    ),
    'sources', jsonb_build_object(
      'new_users', (select count(*) from cohort),
      'apple_ads', (select count(*) from cohort c where exists (select 1 from ads a where a.install_id = c.install_id)),
      'not_ads', (
        select count(*) from cohort c
        where exists (select 1 from app_installs p where p.install_id = c.install_id)
          and not exists (select 1 from ads a where a.install_id = c.install_id)
      ),
      'campaigns', (
        select coalesce(jsonb_agg(row_to_json(x) order by x.apps desc), '[]'::jsonb) from (
          select a.campaign_id, a.ad_group_id, a.keyword_id,
            count(*) as apps,
            count(a.install_id) as users,
            count(*) filter (where exists (select 1 from converted v where v.install_id = a.install_id)
                                or exists (select 1 from subs s where s.app_account_token::text = a.app and s.paid_from is not null)) as subscribed
          from ads a, d
          where (a.created_at at time zone 'utc')::date > d.today - d.days
          group by 1, 2, 3
        ) x
      ),
      'app_store_connect', (
        select coalesce(jsonb_agg(row_to_json(x) order by x.day_from desc, x.downloads desc), '[]'::jsonb) from (
          select day_from, day_to, source, detail, impressions, page_views, downloads
          from contextflow.asc_sources
          order by day_from desc
          limit 200
        ) x
      )
    )
  );
$$;

-- subscription_terms: list prices of the new products (USD, milliunits) when no notification gave one [latest version: 20261102150000_contextflow_subscription_terms.sql]
create or replace function contextflow.subscription_terms()
returns table (otid text, terms text, offer_id text, paid_from timestamptz, price numeric, currency text, estimated boolean)
language sql stable set search_path = '' as $$
  with notes as (
    select n.data->>'otid' as otid, n.created_at, (n.data->>'price')::numeric as price, n.data->>'currency' as currency,
      n.data->>'offer' as offer, n.data->>'offer_id' as offer_id
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
      else (select min(n.created_at) from notes n where n.otid = s.original_transaction_id and n.price > 0)
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

-- cf_limits_report: Ultra's answers count with Pro's weekly allowance (the same counter) [latest version: 20261103100000_contextflow_limits_report.sql]
create or replace function public.cf_limits_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 28), 180)) as days
  ),
  -- Our own test devices and installs, left out.
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' = 'dev-check')
    union
    select install_id from contextflow.own_subscriptions where install_id is not null
  ),
  ev as (
    select e.created_at, (e.created_at at time zone 'utc')::date as day, e.kind, e.install_id, e.data
    from contextflow.events e, d
    where e.kind in ('chat', 'limit')
      and e.created_at >= now() - make_interval(days => d.days)
      and e.install_id is not null
      and not exists (select 1 from tests t where t.install_id = e.install_id)
  ),
  answers as (
    select created_at, day, install_id, data,
      case when data->>'plan' in ('pro', 'ultra') then 'pro' else 'free' end as grp,
      coalesce(data->>'mode', 'chat') as mode,
      data->>'limits_v' is not null as flagged,
      coalesce((data->>'history')::int, 0) as history,
      (data->>'chat_turns')::int as chat_turns,
      (data->>'chat_pages')::int as chat_pages,
      (data->>'chats')::int as chats,
      coalesce((data->>'other_pages')::int, 0) as other_pages,
      coalesce((data->>'page_chars')::int, 0) as page_chars,
      coalesce(data->>'whole_chat' = 'true', false) as whole_chat
    from ev
    where kind = 'chat' and coalesce(data->>'ok', 'true') = 'true'
  ),
  -- Which answers each limit could touch (base) and which it did (hit).
  touched as (
    select 'page_cut' as key, a.*, a.data->>'page' in ('page', 'selection') as base,
      case when a.flagged then a.data->>'page_cut' = 'true'
           else (a.data->>'page' = 'page' and a.data->>'media' is null and a.page_chars >= 24000)
             or (a.data->>'page' = 'selection' and a.page_chars >= 12000)
             or (a.data->>'media' is not null and a.page_chars >= 99000) end as hit
    from answers a
    union all
    select 'answer_cut', a.*, true, a.data->>'answer_cut' = 'true' from answers a
    union all
    -- The usual chat: the model sees the last 12 questions and answers.
    select 'memory_window', a.*, a.mode = 'chat' and not a.whole_chat, a.history >= 12 from answers a
    union all
    -- "Whole chat": up to 48,000 characters of it; ContextFlow 2.4 says how long the chat was.
    select 'whole_chat_cut', a.*, a.whole_chat,
      a.data->>'history_cut' = 'true' or a.chat_turns > a.history from answers a
    union all
    -- "Whole chat" and the app: 3 other pages (the app 9), each up to 8,000 characters.
    select 'other_pages', a.*, a.whole_chat,
      coalesce((a.data->>'other_pages_cut')::int, 0) > 0 or a.chat_pages - 1 > a.other_pages from answers a
    union all
    select 'digest_cut', a.*, a.mode in ('history', 'find'), a.data->>'digest_cut' = 'true' from answers a
    union all
    -- Storage on the device (ContextFlow 2.4 sends the sizes): 40 messages a chat, 50 chats, 10 pages' texts.
    select 'turns_40', a.*, a.chat_turns is not null, a.chat_turns > 40 from answers a
    union all
    select 'chats_50', a.*, a.chats is not null, a.chats >= 50 from answers a
    union all
    select 'pages_10', a.*, a.chat_pages is not null, a.chat_pages > 10 from answers a
  ),
  -- Answers per Pro subscription per week, against the weekly 375 (300+ counts as close to it).
  pro_weeks as (
    select a.data->>'otid' as otid, date_trunc('week', a.created_at at time zone 'utc')::date as week,
      count(*) as n, max(a.day) as last_day
    from answers a where a.grp = 'pro' and a.data->>'otid' is not null
    group by 1, 2
  ),
  refused as (
    select case data->>'reason'
             when 'ip' then 'ip_daily'
             when 'busy' then 'busy'
             when 'search' then 'search'
             else case when data->>'plan' in ('pro', 'ultra') then 'pro_weekly' else 'free_daily' end
           end as key,
           case when data->>'plan' in ('pro', 'ultra') then 'pro' else 'free' end as grp,
           install_id, day
    from ev where kind = 'limit'
  ),
  active as (
    select grp, install_id from answers
    union select grp, install_id from refused
  ),
  group_users as (
    select grp, count(distinct install_id) as n from active group by grp
    union all
    select 'all', count(distinct install_id) from active
  ),
  answer_limits as (
    select k.key, k.grp,
      (select count(*) from refused r where r.key = k.key) as hits,
      null::bigint as base,
      (select count(distinct r.install_id) from refused r where r.key = k.key) as users,
      (select count(*) from (select r.install_id from refused r where r.key = k.key group by r.install_id having count(distinct r.day) >= 2) x) as repeat_users,
      (select max(r.day) from refused r where r.key = k.key) as last_day
    from (values ('free_daily', 'free'), ('ip_daily', 'free'), ('busy', 'all'), ('search', 'all'), ('pro_weekly', 'pro')) as k(key, grp)
  ),
  pro_near as (
    select 'pro_near' as key, 'pro' as grp,
      count(*) filter (where n >= 300) as hits,
      count(*) as base,
      count(distinct otid) filter (where n >= 300) as users,
      (select count(*) from (select otid from pro_weeks where n >= 300 group by otid having count(*) >= 2) x) as repeat_users,
      max(last_day) filter (where n >= 300) as last_day
    from pro_weeks
  ),
  answer_rows as (
    select t.key, 'all' as grp,
      count(*) filter (where t.base and t.hit) as hits,
      count(*) filter (where t.base) as base,
      count(distinct t.install_id) filter (where t.base and t.hit) as users,
      (select count(*) from (
         select x.install_id from touched x where x.key = t.key and x.base and x.hit
         group by x.install_id having count(distinct x.day) >= 2) r) as repeat_users,
      max(t.day) filter (where t.base and t.hit) as last_day,
      count(distinct t.install_id) filter (where t.base) as users_base
    from touched t group by t.key
  ),
  all_rows as (
    select l.key, l.grp, l.hits, l.base, l.users, l.repeat_users, l.last_day,
      (select n from group_users g where g.grp = l.grp) as users_base
    from answer_limits l
    union all
    select p.key, p.grp, p.hits, p.base, p.users, p.repeat_users, p.last_day,
      (select count(distinct otid) from pro_weeks)
    from pro_near p
    union all
    select r.key, r.grp, r.hits, r.base, r.users, r.repeat_users, r.last_day, r.users_base from answer_rows r
  )
  select jsonb_build_object(
    'days', (select days from d),
    -- Since when answers carry the flags and the chat sizes (the server with limits_v, ContextFlow 2.4).
    'flags_since', (select min(day) from answers where flagged),
    'sizes_since', (select min(day) from answers where chat_turns is not null),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'key', key, 'group', grp, 'hits', hits, 'base', base, 'users', users,
        'users_base', coalesce(users_base, 0), 'repeat_users', repeat_users, 'last_day', last_day,
        'status', case
          when coalesce(hits, 0) = 0 then 'none'
          when repeat_users >= 3 or (users >= 3 and coalesce(users_base, 0) > 0 and users::numeric / users_base >= 0.10) then 'systematic'
          else 'occasional' end
      ) order by key) from all_rows), '[]'::jsonb)
  )
$$;

-- cf_new_user_outcomes: Ultra bought counts with Pro bought [latest version: 20261104150000_contextflow_new_user_outcomes.sql]
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
      and s.product_id in ('com.contextflow.pro.monthly', 'com.contextflow.pro.yearly', 'com.contextflow.ultra.monthly', 'com.contextflow.ultra.yearly')
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

-- cf_after_limit: Ultra is a paid plan [latest version: 20261106120000_contextflow_funnel_to_paid.sql]
create or replace function public.cf_after_limit(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
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
  unpaid as (
    select otid from contextflow.subscription_terms() where paid_from is null
  ),
  answers as (
    select e.install_id, e.created_at, (e.created_at at time zone 'utc')::date as day,
      coalesce(e.data->>'plan', 'free') as plan, coalesce(e.data->>'mode', 'chat') as mode, e.data->>'otid' as otid
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and coalesce(e.data->>'ok', 'true') <> 'false'
      and not exists (select 1 from tests t where t.install_id = e.install_id)
  ),
  paid as (
    select * from answers a
    where a.plan in ('pro', 'byok', 'ultra') and (a.otid is null or not exists (select 1 from unpaid u where u.otid = a.otid))
  ),
  hits as (
    select e.install_id, e.created_at as at, (e.created_at at time zone 'utc')::date as day, e.data->>'reason' as reason,
      e.data->>'platform' as platform, e.data->>'version' as version
    from contextflow.events e
    where e.kind = 'limit' and e.install_id is not null
      and coalesce(e.data->>'plan', 'free') = 'free' and e.data->>'reason' in ('limit', 'search')
      and coalesce(e.data->>'version', '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.install_id = e.install_id)
      and not contextflow.in_review_any(e.data->>'platform', e.data->>'version', e.created_at)
  ),
  buys as (
    select * from contextflow.purchases()
  ),
  first_hit as (
    select distinct on (install_id) * from hits order by install_id, at
  ),
  people as (
    select h.*, f.day as first_day,
      (select jsonb_agg(distinct x.reason) from hits x where x.install_id = h.install_id and x.day = h.day) as reasons,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.created_at < h.at) as before,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.created_at < h.at and a.mode = 'google') as google_before,
      (select min(a.created_at) from answers a where a.install_id = h.install_id and a.day = h.day) as day_first,
      (select min(b.at) from buys b where b.install_id = h.install_id and b.at > h.at) as paid_at,
      (select count(*) from contextflow.install_days i where i.install_id = h.install_id and i.day > h.day) as back_days,
      (select count(distinct a.day) from answers a where a.install_id = h.install_id and a.day > h.day) as asked_days,
      (select count(distinct x.day) from hits x where x.install_id = h.install_id and x.day > h.day) as hit_days,
      (select max(i.day) from contextflow.install_days i where i.install_id = h.install_id) as last_day
    from first_hit h
    cross join d
    left join firsts f on f.install_id = h.install_id
    where h.day > d.today - d.days
  ),
  paying as (
    select f.install_id, f.first_at, f.platform,
      (select min(p.created_at) from paid p where p.install_id = f.install_id) as first_paid,
      (select max(p.created_at) from paid p where p.install_id = f.install_id) as last_paid,
      (select count(distinct p.day) from paid p where p.install_id = f.install_id) as paid_days,
      (select max(i.day) from contextflow.install_days i where i.install_id = f.install_id) as last_day
    from firsts f
    where not exists (select 1 from tests t where t.install_id = f.install_id)
      and (
        exists (select 1 from paid p where p.install_id = f.install_id)
        or exists (
          select 1 from contextflow.entitlements s
          where s.environment = 'Production' and s.app_account_token = f.install_id
            and not exists (select 1 from unpaid u where u.otid = s.original_transaction_id)
        )
      )
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', p.day,
        'at', p.at,
        'first_day', p.first_day,
        'platform', p.platform,
        'locale', (select i.locale from contextflow.installs i where i.install_id = p.install_id),
        'version', p.version,
        'offer', contextflow.version_num(p.version) >= contextflow.version_num('2.4'),
        'reasons', coalesce(p.reasons, '[]'::jsonb),
        'before', p.before,
        'google_before', p.google_before,
        'secs', case when p.day_first is not null then greatest(0, floor(extract(epoch from p.at - p.day_first))) end,
        'paid_after', case when p.paid_at is not null then floor(extract(epoch from p.paid_at - p.at)) end,
        'back_days', p.back_days,
        'asked_days', p.asked_days,
        'hit_days', p.hit_days,
        'last_day', p.last_day
      ) order by p.at desc)
      from people p
    ), '[]'::jsonb),
    'paying', coalesce((
      select jsonb_agg(jsonb_build_object(
        'first_seen', y.first_at,
        'platform', y.platform,
        'first_paid', y.first_paid,
        'last_paid', y.last_paid,
        'paid_days', y.paid_days,
        'last_day', y.last_day,
        'days_since_paid', (
          select count(*) from contextflow.install_days i
          where i.install_id = y.install_id and y.first_paid is not null and i.day >= (y.first_paid at time zone 'utc')::date
        )
      ) order by y.first_paid nulls last)
      from paying y
    ), '[]'::jsonb)
  )
$$;

-- purchases: Ultra is a paid plan [latest version: 20261106120000_contextflow_funnel_to_paid.sql]
create or replace function contextflow.purchases()
returns table (otid text, install_id uuid, app text, at timestamptz)
language sql stable set search_path = '' as $$
  with subs as (
    select s.original_transaction_id as otid, s.created_at, s.app_account_token as token
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.paid_from is not null
      and not exists (select 1 from contextflow.own_subscriptions o where o.otid = s.original_transaction_id)
  ),
  -- The token is the app's id when the app has sent it in an opening, else the extension's install id.
  by_token as (
    select s.otid,
      case when x.is_app then x.install_id else s.token end as install_id,
      case when x.is_app then s.token::text end as app
    from subs s
    cross join lateral (
      select
        exists (select 1 from contextflow.events o where o.kind = 'app_open' and o.data->>'app' = s.token::text) as is_app,
        (select o.install_id from contextflow.events o
         where o.kind = 'app_open' and o.install_id is not null and o.data->>'app' = s.token::text
         order by o.created_at limit 1) as install_id
    ) x
    where s.token is not null
  ),
  by_answer as (
    select distinct on (e.data->>'otid') e.data->>'otid' as otid, e.install_id
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and e.data->>'otid' is not null
    order by e.data->>'otid', e.created_at
  ),
  known as (
    select s.otid, coalesce(t.install_id, a.install_id) as install_id, t.app
    from subs s
    left join by_token t on t.otid = s.otid
    left join by_answer a on a.otid = s.otid
    where coalesce(t.install_id, a.install_id) is not null or t.app is not null
  ),
  old_paid as (
    select e.install_id, min(e.created_at) as first_at
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and e.data->>'plan' in ('pro', 'byok', 'ultra') and e.data->>'otid' is null
    group by e.install_id
  ),
  candidates as (
    select s.otid, p.install_id, p.first_at - s.created_at as gap
    from subs s
    join old_paid p on p.first_at >= s.created_at and p.first_at < s.created_at + interval '1 day'
    where not exists (select 1 from known k where k.otid = s.otid)
      and not exists (select 1 from known k where k.install_id = p.install_id)
  ),
  links as (
    select k.otid, k.install_id, k.app from known k
    union all
    select c.otid, c.install_id, null from candidates c
    where c.gap = (select min(x.gap) from candidates x where x.otid = c.otid)
      and c.gap = (select min(x.gap) from candidates x where x.install_id = c.install_id)
  )
  select s.otid, l.install_id, l.app, s.created_at as at
  from subs s
  left join links l on l.otid = s.otid
$$;

-- cf_feature_funnels: the Ultra funnels (needs 20261107120000_contextflow_guided_tour first) [latest version: 20261107120000_contextflow_guided_tour.sql]
create or replace function public.cf_feature_funnels(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with recursive d as (select greatest(1, least(coalesce(p_days, 28), 180)) as days),
  e as (select * from contextflow.feature_events(now() - make_interval(days => (select days from d)))),
  defs(funnel, k, f, acts, via, what) as (values
    ('consent', 1, 'consent', '{shown}'::text[], null, null),
    ('consent', 2, 'consent', '{accepted}', null, null),
    ('consent', 3, 'ask', '{answer}', null, null),
    ('purchase', 1, 'upsell', '{shown}', null, null),
    ('purchase', 2, 'upsell', '{tap}', null, null),
    ('purchase', 3, 'paywall', '{shown}', null, null),
    ('purchase', 4, 'paywall', '{plan}', null, null),
    ('purchase', 5, 'paywall', '{buy_ok}', null, null),
    ('quick_insert', 1, 'qi_list', '{open}', null, null),
    ('quick_insert', 2, 'insert', '{copied,template,answer}', null, null),
    ('templates', 1, 'insert', '{tpl_new}', null, null),
    ('templates', 2, 'insert', '{template}', null, null),
    ('reminders', 1, 'remind', '{set}', null, null),
    ('reminders', 2, 'notif', '{tap}', null, 'remind'),
    ('reminders', 3, 'chat', '{open}', 'reminder', null),
    ('organize', 1, 'organize', '{shown}', null, null),
    ('organize', 2, 'organize', '{accepted}', null, null),
    ('watch', 1, 'watch', '{create}', null, null),
    ('watch', 2, 'watch', '{alert}', null, null),
    ('watch', 3, 'notif', '{tap}', null, 'watch'),
    ('watch', 4, 'page_open', '{tap}', 'watch', null),
    -- 2.6: the guided first request (src/content/Guide.tsx): started, its first answer, off to select text on the
    -- page, Ask AI tapped, the question about the selection asked, all the way to its last card.
    ('guided', 1, 'tour', '{start}', null, null),
    ('guided', 2, 'ask', '{answer}', null, null),
    ('guided', 3, 'tour', '{step}', null, 'pick'),
    ('guided', 4, 'tour', '{step}', null, 'askSel'),
    ('guided', 5, 'tour', '{step}', null, 'answer2'),
    ('guided', 6, 'tour', '{done}', null, null),
    -- 2.6 Ultra: Listen tapped without Ultra, the plans sheet it opened, a plan chosen there, bought in the app.
    ('listen_ultra', 1, 'listen', '{ultra}', null, null),
    ('listen_ultra', 2, 'plans', '{open}', 'listen', null),
    ('listen_ultra', 3, 'plans', '{choose}', null, null),
    ('listen_ultra', 4, 'paywall', '{buy_ok}', null, null),
    -- 2.6: the plans sheet from anywhere (Settings, a full watch list, Listen), to a plan chosen, to a purchase.
    ('plans', 1, 'plans', '{open}', null, null),
    ('plans', 2, 'plans', '{choose}', null, null),
    ('plans', 3, 'paywall', '{buy_ok}', null, null)
  ),
  reach(funnel, k, person, at, gap) as (
    select d1.funnel, 1, e.person, min(e.at), null::double precision
    from defs d1 join e on e.f = d1.f and e.a = any(d1.acts)
      and (d1.via is null or e.via = d1.via) and (d1.what is null or e.what = d1.what)
    where d1.k = 1
    group by 1, 2, 3
    union all
    select r.funnel, d2.k, r.person, x.at, extract(epoch from x.at - r.at)
    from reach r
    join defs d2 on d2.funnel = r.funnel and d2.k = r.k + 1
    cross join lateral (
      select min(e.at) as at from e
      where e.person = r.person and e.f = d2.f and e.a = any(d2.acts) and e.at >= r.at
        and (d2.via is null or e.via = d2.via) and (d2.what is null or e.what = d2.what)
    ) x
    where x.at is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('funnel', funnel, 'steps', steps) order by funnel), '[]'::jsonb)
  from (
    select df.funnel, jsonb_agg(jsonb_build_object(
      'k', df.k, 'step', df.f || '.' || array_to_string(df.acts, '|') || coalesce(' ' || df.via, '') || coalesce(' ' || df.what, ''),
      'people', (select count(*) from reach r where r.funnel = df.funnel and r.k = df.k),
      'median_secs', (select percentile_cont(0.5) within group (order by gap) from reach r where r.funnel = df.funnel and r.k = df.k)
    ) order by df.k) as steps
    from defs df group by 1
  ) x
$$;

-- cf_speak_report: read aloud by day and by model kind: parts, people, minutes, cost now and at the 2027 prices, first audio
create or replace function public.cf_speak_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select greatest(1, least(coalesce(p_days, 28), 180)) as days),
  s as (
    select (e.created_at at time zone 'utc')::date as day, e.install_id, e.data
    from contextflow.events e, d
    where e.kind = 'speak' and e.created_at >= now() - make_interval(days => d.days)
      and coalesce(e.data->>'audience', '') <> 'test'
  )
  select jsonb_build_object(
    'days', (select days from d),
    'by_day', coalesce((select jsonb_agg(x order by x.day) from (
      select day, count(*) as parts, count(distinct install_id) as people,
        round(sum((data->>'audio_s')::numeric) / 60, 1) as minutes,
        round(sum((data->>'cost_usd')::numeric), 4) as cost_usd,
        round(sum((data->>'cost_usd_2027')::numeric), 4) as cost_usd_2027,
        count(*) filter (where data->>'ok' = 'false') as failed
      from s group by day) x), '[]'::jsonb),
    'by_kind', coalesce((select jsonb_agg(x) from (
      select coalesce(data->>'kind', '?') as kind, coalesce(data->>'what', '?') as what, count(*) as parts,
        round(sum((data->>'audio_s')::numeric) / 60, 1) as minutes,
        round(sum((data->>'cost_usd')::numeric) / nullif(sum((data->>'audio_s')::numeric) / 60, 0), 5) as usd_per_min,
        round(sum((data->>'cost_usd_2027')::numeric) / nullif(sum((data->>'audio_s')::numeric) / 60, 0), 5) as usd_per_min_2027,
        percentile_cont(0.5) within group (order by (data->>'first_audio_ms')::numeric) filter (where data->>'part' = '0') as first_audio_ms_p50,
        percentile_cont(0.9) within group (order by (data->>'first_audio_ms')::numeric) filter (where data->>'part' = '0') as first_audio_ms_p90
      from s group by 1, 2) x), '[]'::jsonb),
    -- Who comes near the week's allowance: minutes a week per person (the top ones).
    'heavy', coalesce((select jsonb_agg(x order by x.minutes desc) from (
      select date_trunc('week', day)::date as week, install_id, round(sum((data->>'audio_s')::numeric) / 60, 1) as minutes
      from s group by 1, 2 order by 3 desc limit 20) x), '[]'::jsonb)
  )
$$;

revoke all on function public.cf_speak_report(integer) from public, anon, authenticated;
grant execute on function public.cf_speak_report(integer) to service_role;
