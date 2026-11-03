-- Onboarding to the first answer, by the day each new person first showed up (/analytics).
--
-- 2.4 is the first version whose app ("app_open") and extension ("ext_on") report the first steps, so a
-- person is one of three kinds:
--   app — started in the ContextFlow app (2.4+): app opened → (notifications) → extension on → panel → answer;
--   ext — 2.4+ extension switched on with no app opening before it (or none we could tie to it): from the
--         extension on;
--   old — first seen in the panel: before 2.4, or a 2.4 install whose first steps never reached us (an
--         "ext_on" days after the panel is a reinstall, not a new person). Panel → answer only.
-- The app learns its extension's install once the extension talks to it, and says so on its next day's
-- opening; an app that never did is tied to the nearest new extension switched on within 3 days on the
-- same type of device ("time" link).
--
-- Also: a version's events count as ours (tests, App Review) until its review ends, including the days
-- before it was submitted, when only we had the build. Before, only the review itself was left out.

create or replace function contextflow.in_review(p_platform text, p_version text, p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from contextflow.review_windows w
    where w.platform = case when p_platform in ('ios', 'ipados') then 'IOS' when p_platform = 'macos' then 'MAC_OS' end
      and w.version = regexp_replace(coalesce(p_version, ''), '\.0$', '')
      and (w.completed_at is null or p_at < w.completed_at)
  )
$$;
revoke all on function contextflow.in_review(text, text, timestamptz) from public, anon, authenticated;

-- 2.4 went to App Review on 2026-11-03 (iOS 16:43, Mac 16:48 UTC), unless a window is there already.
insert into contextflow.review_windows (platform, version, submitted_at, completed_at)
select v.platform, v.version, v.submitted_at, null
from (values ('IOS', '2.4', timestamptz '2026-11-03 16:43:00+00'),
             ('MAC_OS', '2.4', timestamptz '2026-11-03 16:48:00+00')) v(platform, version, submitted_at)
where not exists (select 1 from contextflow.review_windows w where w.platform = v.platform and w.version = v.version);

-- One row per new person of the last p_days days (tests and App Review left out): the day they showed up,
-- device, kind, how the app was tied to the extension, whether notifications were allowed, and seconds
-- from showing up to each step reached. Also the review windows still open: their versions stay out
-- until someone closes them.
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
  installs as (
    select i.install_id, x.at as ext_at, x.version as ext_version, p.at as panel_at, p.version as panel_version,
      a.at as answer_at,
      -- Until the panel tells it, the extension doesn't know the device ("other").
      coalesce(p.platform, nullif(x.platform, 'other')) as platform,
      least(x.at, p.at) as first_at
    from (select install_id from ext union select install_id from panel) i
    left join ext x on x.install_id = i.install_id
    left join panel p on p.install_id = i.install_id
    left join answer a on a.install_id = i.install_id
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
    select p.*, i.ext_at, i.ext_version, i.panel_at, i.panel_version, i.answer_at, i.platform as install_platform,
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
        'answer', case when r.answer_at is not null then greatest(0, floor(extract(epoch from r.answer_at - r.first_at))) end
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
