-- The onboarding funnel goes on past the first answer, to the free limit and the subscription, and the people who
-- ran into the limit (/analytics → «После лимита») carry their device's language and region.
--
-- contextflow.purchases(): one row per paid subscription (a first payment made; trials and free codes count once
-- paid; ours left out), on the device it was bought on, so a subscription used on two devices counts once:
--   1. the install or the app the purchase carries (appAccountToken, 2.4+): an app is tied to its extension's
--      install through its openings;
--   2. else the first install whose answers it paid for (answers carry the otid since 2026-11-02);
--   3. else, for purchases before that, the install whose first paid answer came within a day after the purchase,
--      the nearest one (the same rule as cf_owner_insights).
-- "at" is when the subscription was created: the purchase, or a trial's start.

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
    where e.kind = 'chat' and e.install_id is not null and e.data->>'plan' in ('pro', 'byok') and e.data->>'otid' is null
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
revoke all on function contextflow.purchases() from public, anon, authenticated;

-- Onboarding (cf_onboarding, first in 20261103120000): as before, plus seconds from showing up to the first refusal
-- of the free allowance ("limit": reason "limit", the answers a day, or "search", Google answers a day) and to the
-- subscription bought on this person's device ("paid", contextflow.purchases). Whoever paid answers with a
-- subscription bought on another device is not counted as paying here.
create or replace function public.cf_onboarding(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' = 'dev-check')
  ),
  -- Each copy of the app: its first opening, notifications allowed on any opening, its extension's install
  -- once the app knew it.
  apps as (
    select e.data->>'app' as app, min(e.created_at) as at,
      (array_agg(e.data->>'platform' order by e.created_at))[1] as platform,
      (array_agg(e.data->>'version' order by e.created_at))[1] as version,
      coalesce(bool_or(e.data->>'notifications' = 'granted'), false) as notified,
      (array_agg(e.install_id order by e.created_at) filter (where e.install_id is not null))[1] as install_id,
      coalesce(bool_or(e.data->>'audience' = 'test' or e.data->>'version' = 'dev-check'), false) as test
    from contextflow.events e
    where e.kind = 'app_open' and e.data ? 'app'
    group by 1
  ),
  ext as (
    select install_id, min(created_at) as at,
      (array_agg(data->>'platform' order by created_at))[1] as platform,
      (array_agg(data->>'version' order by created_at))[1] as version
    from contextflow.events
    where kind = 'ext_on' and install_id is not null
    group by 1
  ),
  panel as (
    select distinct on (install_id) install_id, first_at as at, platform, version
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  answer as (
    select install_id, min(created_at) as at
    from contextflow.events
    where kind = 'chat' and install_id is not null and coalesce(data->>'ok', 'true') <> 'false'
    group by 1
  ),
  refused as (
    select install_id, min(created_at) as at
    from contextflow.events
    where kind = 'limit' and install_id is not null
      and coalesce(data->>'plan', 'free') = 'free' and data->>'reason' in ('limit', 'search')
    group by 1
  ),
  buys as (
    select * from contextflow.purchases()
  ),
  installs as (
    select i.install_id, x.at as ext_at, x.version as ext_version, p.at as panel_at, p.version as panel_version,
      a.at as answer_at, r.at as limit_at,
      -- Until the panel tells it, the extension doesn't know the device ("other").
      coalesce(p.platform, nullif(x.platform, 'other')) as platform,
      least(x.at, p.at) as first_at
    from (select install_id from ext union select install_id from panel) i
    left join ext x on x.install_id = i.install_id
    left join panel p on p.install_id = i.install_id
    left join answer a on a.install_id = i.install_id
    left join refused r on r.install_id = i.install_id
  ),
  exact as (
    select distinct on (install_id) app, install_id from apps where install_id is not null order by install_id, at
  ),
  candidates as (
    select a.app, i.install_id, abs(extract(epoch from i.first_at - a.at)) as gap
    from apps a
    join installs i on i.ext_at is not null
      and i.first_at >= a.at - interval '10 minutes' and i.first_at < a.at + interval '3 days'
      and (i.platform is null or i.platform = a.platform)
    where not a.test
      and not exists (select 1 from tests t where t.install_id = i.install_id)
      and not exists (select 1 from exact e where e.app = a.app)
      and not exists (select 1 from exact e where e.install_id = i.install_id)
  ),
  links as (
    select app, install_id, 'exact' as link from exact
    union all
    select c.app, c.install_id, 'time' from candidates c
    where c.gap = (select min(x.gap) from candidates x where x.app = c.app)
      and c.gap = (select min(x.gap) from candidates x where x.install_id = c.install_id)
  ),
  people as (
    select a.app, l.install_id, l.link, a.at as app_at, a.notified, a.platform as app_platform, a.version as app_version, a.test
    from apps a left join links l on l.app = a.app
    union all
    select null, i.install_id, null, null, null, null, null, false
    from installs i
    where not exists (select 1 from links l where l.install_id = i.install_id)
  ),
  steps as (
    select p.*, i.ext_at, i.ext_version, i.panel_at, i.panel_version, i.answer_at, i.limit_at, i.platform as install_platform,
      (select min(b.at) from buys b where b.install_id = p.install_id or b.app = p.app) as paid_at,
      least(p.app_at, i.ext_at, i.panel_at) as first_at,
      case
        when p.app_at is not null and p.app_at <= coalesce(least(i.ext_at, i.panel_at), p.app_at) + interval '10 minutes' then 'app'
        when i.ext_at <= coalesce(i.panel_at, i.ext_at) + interval '10 minutes' then 'ext'
        else 'old'
      end as kind
    from people p
    left join installs i on i.install_id = p.install_id
  ),
  people_in as (
    select s.*,
      case when s.kind = 'app' then s.app_platform else s.install_platform end as platform,
      case s.kind when 'app' then s.app_version when 'ext' then s.ext_version else s.panel_version end as version
    from steps s, d
    where (s.first_at at time zone 'utc')::date > d.today - d.days
      and not s.test
      and not exists (select 1 from tests t where t.install_id = s.install_id)
  ),
  real as (
    select * from people_in r
    where coalesce(r.version, '') <> 'dev-check'
      and not contextflow.in_review(coalesce(r.platform, 'ios'), r.version, r.first_at)
      and not (r.platform is null and contextflow.in_review('macos', r.version, r.first_at))
  )
  select jsonb_build_object(
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', (r.first_at at time zone 'utc')::date,
        'device', case r.platform when 'ios' then 'iPhone' when 'ipados' then 'iPad' when 'macos' then 'Mac'
                                  when 'chrome' then 'Chrome' else 'unknown' end,
        'kind', r.kind,
        'link', case when r.kind = 'app' then r.link end,
        'notified', case when r.kind = 'app' then r.notified end,
        'ext', case when r.kind <> 'old' then floor(extract(epoch from r.ext_at - r.first_at)) end,
        'panel', floor(extract(epoch from r.panel_at - r.first_at)),
        -- An answer can be logged a moment before the panel's first day.
        'answer', case when r.answer_at is not null then greatest(0, floor(extract(epoch from r.answer_at - r.first_at))) end,
        'limit', case when r.limit_at is not null then greatest(0, floor(extract(epoch from r.limit_at - r.first_at))) end,
        'paid', case when r.paid_at is not null then greatest(0, floor(extract(epoch from r.paid_at - r.first_at))) end
      ) order by r.first_at)
      from real r
    ), '[]'::jsonb),
    'open_reviews', coalesce((
      select jsonb_agg(jsonb_build_object('platform', w.platform, 'version', w.version, 'submitted_at', w.submitted_at) order by w.submitted_at)
      from contextflow.review_windows w where w.completed_at is null
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.cf_onboarding(integer) from public, anon, authenticated;
grant execute on function public.cf_onboarding(integer) to service_role;

-- After the limit (cf_after_limit, first in 20261105120000): as before, plus the install's UI language with the
-- device's region ("locale", e.g. "uk-UA"; nothing finer than a country is kept). "Bought" is now the subscription
-- bought on this device after the refusal (contextflow.purchases), the same as the onboarding funnel's last step:
-- a subscription bought on another device no longer counts, and the moment is the purchase, not the first paid answer.
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
    where a.plan in ('pro', 'byok') and (a.otid is null or not exists (select 1 from unpaid u where u.otid = a.otid))
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
revoke all on function public.cf_after_limit(integer) from public, anon, authenticated;
grant execute on function public.cf_after_limit(integer) to service_role;
