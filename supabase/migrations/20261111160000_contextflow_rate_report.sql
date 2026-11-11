-- 2.6 (100): the App Store rating request, per platform. The owner: «почему я в аналитике вижу, что никому не
-- предлагалось оценить приложение? … Оно вообще работает?».
-- "use" steps with f "rate" (src/shared/usage.ts): "due" (a milestone of good answers reached: in Safari, via
-- "ext_moment", sent by the extension; in the app's own chats, via "app_answer"), "ask" (the app asked Apple for its
-- sheet, and at what moment: via), "link" (the App Store's "Write a Review" tapped). Apple doesn't say whether its
-- sheet showed: "ask" is our request, not a sheet seen.
-- Counts and people per platform, action and via, and the milestones (moment). Our tests, dev checks and App Review
-- left out, as in contextflow.feature_events. A new function only: nothing else changes.

create or replace function public.cf_rate_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select greatest(1, least(coalesce(p_days, 28), 180)) as days),
  tests as (select id from contextflow.test_ids),
  -- The app's extension install, once the app reported it (as contextflow.feature_events).
  app_install as (
    select distinct on (data->>'app') data->>'app' as app, install_id::text as install
    from contextflow.events
    where kind = 'app_open' and install_id is not null and data ? 'app'
    order by data->>'app', created_at desc
  ),
  raw as (
    select ev.created_at, ev.data, coalesce(ev.install_id::text, ev.data->>'app') as uid
    from contextflow.events ev, d
    where ev.kind = 'use' and ev.data->>'f' = 'rate'
      and ev.created_at >= now() - make_interval(days => d.days)
      and not (ev.data ? 'legacy')
  ),
  e as (
    select coalesce(ai.install, r.uid) as person,
      coalesce(nullif(r.data->>'platform', ''), 'unknown') as platform,
      r.data->>'a' as a,
      coalesce(r.data->>'via', '') as via,
      case when r.data->>'moment' ~ '^[0-9]{1,4}$' then (r.data->>'moment')::integer end as moment
    from raw r
    left join app_install ai on ai.app = r.data->>'app'
    where r.uid is not null
      and coalesce(r.data->>'version', '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.id = r.uid)
      and not exists (select 1 from tests t where t.id = ai.install)
      and not contextflow.in_review_any(r.data->>'platform', r.data->>'version', r.created_at)
  )
  select jsonb_build_object(
    'days', (select days from d),
    'by_platform', coalesce((
      select jsonb_agg(jsonb_build_object('platform', platform, 'a', a, 'steps', steps, 'people', people) order by platform, a)
      from (select platform, a, count(*) as steps, count(distinct person) as people from e group by 1, 2) x
    ), '[]'::jsonb),
    'by_via', coalesce((
      select jsonb_agg(jsonb_build_object('platform', platform, 'a', a, 'via', via, 'steps', steps) order by platform, a, steps desc)
      from (select platform, a, via, count(*) as steps from e group by 1, 2, 3) x
    ), '[]'::jsonb),
    'by_moment', coalesce((
      select jsonb_agg(jsonb_build_object('a', a, 'via', via, 'moment', moment, 'steps', steps) order by a, via, moment)
      from (select a, via, moment, count(*) as steps from e where moment is not null group by 1, 2, 3) x
    ), '[]'::jsonb)
  )
$$;
revoke all on function public.cf_rate_report(integer) from public, anon, authenticated;
grant execute on function public.cf_rate_report(integer) to service_role;
