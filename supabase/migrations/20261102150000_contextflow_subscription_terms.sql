-- How each subscription was taken and what it pays now (/analytics), from Apple's transactions (offerType,
-- offerIdentifier, price, currency in the 'appstore_notification' events; logged since 2026-10-29):
--   full       no offer, full price;
--   discount   an offer with a price, e.g. the −50% first month by code (offerType 3);
--   trial      an introductory offer at price 0 (offerType 1);
--   free_code  any other offer at price 0;
--   press      a gift offer code (contextflow.gift_offers, by the reference name that Apple's transactions carry as
--              offerIdentifier), e.g. "Press and creators: free year";
--   owner      our own subscriptions (contextflow.own_subscriptions).
-- A subscription counts as paying from its first transaction with a price above zero; ours never do. Free ones are
-- listed apart and left out of the subscription counts, new users' conversion, the first-payment funnel, Apple Ads'
-- "subscribed" and MRR. cf_owner_insights also returns MRR by week, per currency (the page converts to USD).

create table if not exists contextflow.gift_offers (
  offer_id text primary key,  -- the offer's reference name in App Store Connect
  label    text not null      -- 'press'
);
alter table contextflow.gift_offers enable row level security;
revoke all on contextflow.gift_offers from public, anon, authenticated;
insert into contextflow.gift_offers (offer_id, label)
values ('Press and creators: free year', 'press')
on conflict (offer_id) do nothing;

create table if not exists contextflow.own_subscriptions (
  otid       text primary key,  -- entitlements.original_transaction_id
  install_id uuid,              -- the device it's used on, when known
  note       text not null
);
alter table contextflow.own_subscriptions enable row level security;
revoke all on contextflow.own_subscriptions from public, anon, authenticated;
-- The owner's Pro: the last code of the press batch, redeemed on 2026-11-02 in the App Store (CYP) on his
-- iPhone, which opened the ContextFlow app 17 s later. That iPhone ran 2.4 before its release and got Apple's
-- sample Apple Ads record, which only development and TestFlight builds get.
insert into contextflow.own_subscriptions (otid, install_id, note)
values ('470003572012771', '8ff37b48-50e0-475c-b0bc-b701cbe00e1e', 'Owner, press gift code, 2026-11-02, iPhone')
on conflict (otid) do nothing;

-- Every production subscription: how it was taken (terms, offer_id: its first transaction we know of), since when
-- it is paid for (null: not yet; never for ours), and its current price in milliunits of currency. Subscriptions
-- bought before Apple's notifications carried prices (2026-10-28, no offers existed then) count as full price at
-- the US list price, marked estimated, until a renewal brings the real one.
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
    coalesce(l.price, case s.product_id when 'com.contextflow.pro.monthly' then 6990 when 'com.contextflow.byok.monthly' then 1990 end),
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
    select s.product_id, s.created_at, s.expires_at, t.terms, t.offer_id, t.paid_from, t.price, t.currency, t.estimated,
      case
        when s.revoked_at is not null then 'refunded'
        when s.last_notification like 'DID_FAIL_TO_RENEW%' then 'billing_retry'
        when s.expires_at is not null and s.expires_at < now() then 'expired'
        when s.last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED' then 'renewal_off'
        when s.last_notification = 'DID_CHANGE_RENEWAL_PREF:DOWNGRADE' then 'downgrade'
        else 'active'
      end as status,
      -- Everything App Store told us about this subscription (an upgrade keeps the original transaction).
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'at', e.created_at, 'type', e.data->>'type', 'subtype', e.data->>'subtype', 'product', e.data->>'product'
        ) order by e.created_at), '[]'::jsonb)
        from contextflow.events e
        where e.kind = 'appstore_notification' and e.data->>'otid' = s.original_transaction_id
      ) as history
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production'
  ),
  subs_x as (
    select *, (select count(distinct h->>'product') from jsonb_array_elements(history) h) > 1 as switched from subs
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
            count(*) filter (where status in ('active', 'renewal_off', 'billing_retry', 'downgrade')) as active,
            count(*) filter (where status = 'renewal_off') as renewal_off,
            count(*) filter (where status = 'billing_retry') as billing_retry,
            count(*) filter (where status = 'expired') as expired,
            count(*) filter (where status = 'refunded') as refunded,
            count(*) filter (where switched) as switched,
            count(*) filter (where paid_from >= now() - make_interval(days => (select days from d))) as new
          from subs_x where paid_from is not null group by product_id
        ) s
      ),
      'list', (
        select coalesce(jsonb_agg(row_to_json(s) order by s.created_at desc), '[]'::jsonb) from (
          select product_id, created_at, expires_at, status, switched, history, terms, offer_id, paid_from, price, currency, estimated
          from subs_x order by created_at desc limit 200
        ) s
      ),
      -- Free ones nobody pays for (yet), by how they were taken; not in the counts above.
      'free', (
        select coalesce(jsonb_object_agg(terms, n), '{}'::jsonb) from (
          select terms, count(*) as n from subs_x
          where paid_from is null and status in ('active', 'renewal_off', 'billing_retry', 'downgrade')
          group by terms
        ) f
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

create or replace function public.cf_setup_funnel(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' = 'dev-check')
  ),
  apps as (
    select data->>'app' as app, min(created_at) as at, bool_or(data->>'notifications' = 'granted') as notified
    from contextflow.events where kind = 'app_open' and data ? 'app' group by 1
  ),
  notes as (
    select data->>'otid' as otid, data->>'type' as type, created_at,
      coalesce(data->>'type' = 'SUBSCRIBED' and data->>'offer' = '3', false) as by_code
    from contextflow.events where kind = 'appstore_notification' and data ? 'otid'
  ),
  subs as (
    select
      case when t.terms = 'discount' then
        (select min(n.created_at) from notes n where n.otid = s.original_transaction_id and n.by_code) end as code_at,
      -- Free starts (trials, gift codes, ours) count from their first paid transaction, if any.
      t.paid_from as paid_at
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production'
  ),
  steps as (
    select 'extension_on' as step, install_id, min(created_at) as at
      from contextflow.events where kind = 'ext_on' and install_id is not null group by 2
    union all
    select 'panel_opened', install_id, min(first_at) from contextflow.install_days group by 2
    union all
    select 'first_answer', install_id, min(created_at)
      from contextflow.events where kind = 'chat' and install_id is not null and coalesce(data->>'ok', 'true') <> 'false' group by 2
  ),
  days as (
    select generate_series((now() at time zone 'utc')::date - (greatest(1, least(p_days, 180)) - 1),
                           (now() at time zone 'utc')::date, interval '1 day')::date as day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', d.day,
    'app_opened', (select count(*) from apps a where (a.at at time zone 'utc')::date = d.day),
    'notifications_allowed', (select count(*) from apps a where (a.at at time zone 'utc')::date = d.day and a.notified),
    'extension_on', (select count(*) from steps s where s.step = 'extension_on' and (s.at at time zone 'utc')::date = d.day and s.install_id not in (select install_id from tests)),
    'panel_opened', (select count(*) from steps s where s.step = 'panel_opened' and (s.at at time zone 'utc')::date = d.day and s.install_id not in (select install_id from tests)),
    'first_answer', (select count(*) from steps s where s.step = 'first_answer' and (s.at at time zone 'utc')::date = d.day and s.install_id not in (select install_id from tests)),
    'offer_redeemed', (select count(*) from subs s where (s.code_at at time zone 'utc')::date = d.day),
    'subscribed', (select count(*) from subs s where (s.paid_at at time zone 'utc')::date = d.day)
  ) order by d.day desc), '[]'::jsonb)
  from days d;
$$;
revoke all on function public.cf_setup_funnel(integer) from public, anon, authenticated;
grant execute on function public.cf_setup_funnel(integer) to service_role;

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
        where c.install_id = i.install and c.kind = 'chat' and c.data->>'plan' in ('pro', 'byok')
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
revoke all on function public.cf_ads_funnel(date, date) from public, anon, authenticated;
grant execute on function public.cf_ads_funnel(date, date) to service_role;

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
        coalesce(e.data->>'plan', '') in ('pro', 'byok') or e.data->>'key' = 'own' as paid,
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
revoke all on function public.cf_owner_insights(integer) from public, anon, authenticated;
grant execute on function public.cf_owner_insights(integer) to service_role;
