-- ContextFlow 2.6: the guided first request (src/content/Guide.tsx, netlify/shared/tour.mts).
--
-- 1. Its answers don't count against the free ones (the owner, 2026-11-07: "onboarding requests must not count
--    against the user's limit"), for an install's first few only: a count kept with the install, never reset
--    (usage_counters have only day and week, and cf_cleanup removes them after 60 days). The server asks
--    cf_tour_take before charging a request marked `tour`; while this migration isn't applied, the call fails
--    and the answer counts as before. cf_tour_give_back returns one when the answer was refused or failed.
-- 2. Its funnel in cf_feature_funnels ("guided"), from the "use" steps the panel sends (f "tour").
--
-- Applying it is the director's (tier 2); the server's code works with or without it.

alter table contextflow.installs add column if not exists tour_answers integer not null default 0;

create or replace function public.cf_tour_take(p_install uuid, p_max integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  insert into contextflow.installs (install_id) values (p_install) on conflict do nothing;
  update contextflow.installs set tour_answers = tour_answers + 1
  where install_id = p_install and tour_answers < greatest(coalesce(p_max, 0), 0)
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

create or replace function public.cf_tour_give_back(p_install uuid)
returns void language sql security definer set search_path = '' as $$
  update contextflow.installs set tour_answers = greatest(tour_answers - 1, 0) where install_id = p_install;
$$;

revoke all on function public.cf_tour_take(uuid, integer) from public, anon, authenticated;
revoke all on function public.cf_tour_give_back(uuid) from public, anon, authenticated;
grant execute on function public.cf_tour_take(uuid, integer) to service_role;
grant execute on function public.cf_tour_give_back(uuid) to service_role;

-- Funnels over the last p_days: for each step, the people who reached it after reaching the step before (any
-- session, any surface: the app counts under its extension install), and the median time from the step before.
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
    ('guided', 6, 'tour', '{done}', null, null)
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
revoke all on function public.cf_feature_funnels(integer) from public, anon, authenticated;
grant execute on function public.cf_feature_funnels(integer) to service_role;
