-- Owner analytics, second part (/analytics): who the subscribers are (device, language, country, install
-- source), requests from new vs returning users, conversion of new users into subscribers, requests per
-- user per day for free and paying users, and install sources.
-- select public.cf_owner_insights(30);  (service role; also GET /api/v2/admin/usage → insights)
--
-- A subscription is tied to the installs that use it, best evidence first:
--   1. a subscriber's answers carry the subscription's original transaction id ("otid" in chat events,
--      logged by the server released with this migration);
--   2. purchases from ContextFlow 2.4 carry the extension's install id, or the app's own id, as appAccountToken;
--   3. earlier subscriptions: the install whose first paid answer came soonest after the purchase (within
--      a day), when that purchase is also the nearest one for that install. The page marks these "≈".
-- Country is the App Store storefront from Apple's notifications; language and region are the extension's
-- UI language (installs.locale, e.g. "de-DE"). Nothing more precise than a country is kept.
--
-- Install sources: Apple Ads attribution (ContextFlow 2.4+, 'ads_attribution' events) is known per install.
-- App Store search and browse, the ChatGPT app and websites exist only as App Store Connect totals; they go
-- into contextflow.asc_sources by hand (SQL editor) or by a script, one row per period, source and detail:
--   insert into contextflow.asc_sources (day_from, day_to, source, detail, impressions, page_views, downloads)
--   values ('2026-10-26', '2026-10-31', 'App Store Search', '', 3788, 59, 34);

create table if not exists contextflow.asc_sources (
  day_from    date not null,
  day_to      date not null,
  source      text not null,             -- as App Store Connect names it: "App Store Search", "App Referrer", …
  detail      text not null default '',  -- the referring app or website when ASC names it, e.g. "ChatGPT"
  impressions integer,
  page_views  integer,
  downloads   integer not null,
  updated_at  timestamptz not null default now(),
  primary key (day_from, day_to, source, detail)
);
alter table contextflow.asc_sources enable row level security;
revoke all on contextflow.asc_sources from public, anon, authenticated;

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
    select original_transaction_id as otid, product_id, created_at, expires_at, revoked_at, app_account_token
    from contextflow.entitlements
    where environment = 'Production'
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
  ),
  -- Link 3: each install's first paid answer from before answers carried the otid. App Review windows are
  -- not left out here: these are production purchases, and a window closed late would hide a subscriber.
  paid as (
    select e.install_id, min(e.created_at) as first_at
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and e.data->>'plan' in ('pro', 'byok') and e.data->>'otid' is null
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
    select l.install_id, min(s.created_at) as at from links l join subs s on s.otid = l.otid group by l.install_id
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
    select (e.created_at at time zone 'utc')::date as day, e.install_id,
      coalesce(e.data->>'plan', '') in ('pro', 'byok') or e.data->>'key' = 'own' as paid
    from contextflow.events e, d
    where e.kind = 'chat' and e.created_at >= now() - make_interval(days => d.days)
      and coalesce(e.data->>'audience', '') <> 'test' and coalesce(e.data->>'version', '') <> 'dev-check'
      and not contextflow.in_review(e.data->>'platform', e.data->>'version', e.created_at)
  ),
  user_days as (
    select u.day, u.install_id
    from contextflow.install_days u, d
    where u.day > d.today - d.days
      and coalesce(u.version, '') <> 'dev-check'
      and not exists (select 1 from tests t where t.install_id = u.install_id)
      and not contextflow.in_review(u.platform, u.version, u.first_at)
  ),
  asked as (select day, install_id, count(*) as n, bool_or(paid) as paid from chats group by day, install_id),
  -- Each active user's day as free or paying: a paid answer that day, or a subscription of theirs active then.
  plan_days as (
    select u.day, u.install_id, coalesce(a.n, 0) as n,
      coalesce(a.paid, false) or exists (
        select 1 from links l join subs s on s.otid = l.otid
        where l.install_id = u.install_id
          and u.day between (s.created_at at time zone 'utc')::date
                        and coalesce((least(s.expires_at, s.revoked_at) at time zone 'utc')::date, u.day)
      ) as paid
    from user_days u
    left join asked a on a.day = u.day and a.install_id = u.install_id
  )
  select jsonb_build_object(
    'days', (select days from d),
    'subscribers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'created_at', s.created_at,
        'product_id', s.product_id,
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
        select case when paid then 'paid' else 'free' end as plan,
          count(distinct install_id) as users,
          count(*) as user_days,
          count(*) filter (where n > 0) as asked_days,
          sum(n) as requests,
          max(n) as max_per_day
        from plan_days
        group by 1
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
                                or exists (select 1 from subs s where s.app_account_token::text = a.app)) as subscribed
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

revoke all on function public.cf_owner_insights(integer) from public, anon, authenticated;
grant execute on function public.cf_owner_insights(integer) to service_role;
