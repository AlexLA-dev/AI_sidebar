-- cf_features: the "active" total left our test installs in. install_days rows written by the deploy-preview and
-- calibration checks (version "dev-check" / "calibrate") carry no test event of their own, so the tests list
-- didn't catch them, and /analytics said "активных за период — 99" while 71 real people were active (28 were
-- checks). The usage report has always dropped these versions; now the feature report does too. Shares per
-- feature were not affected: those versions have no number and never matched a feature's "since".
-- Same function as in 20261104120000 otherwise.

-- Per feature over the last p_days: people, people in the last 7 days, people who did more than look (not only
-- "shown", "blocked" or "hit"), steps, people on 2+ different weeks, by surface and device, by week, the main
-- way in, where they came from and what they did next (sessions only), and the base: real people active in the
-- period on versions that have it and report it (p_base: {feature: {since, on: app|ext|both}}, from
-- src/shared/usage.ts).
-- Plus sessions: how many, their median length and duration, and the commonest first five steps.
create or replace function public.cf_features(p_days integer default 28, p_base jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select greatest(1, least(coalesce(p_days, 28), 180)) as days),
  e as (select * from contextflow.feature_events(now() - make_interval(days => (select days from d)))),
  -- Who was active: installs with a panel day or an answer (install_days), apps that were opened; real only.
  tests as (
    select coalesce(install_id::text, data->>'app') as id from contextflow.events
    where data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate')
    union
    select install_id::text from contextflow.own_subscriptions where install_id is not null
  ),
  days_in as (
    select i.install_id::text as person, 'ext' as side, i.version
    from contextflow.install_days i, d
    where i.day > (now() at time zone 'utc')::date - d.days
      and coalesce(i.version, '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.id = i.install_id::text)
      and not contextflow.in_review_any(i.platform, i.version, i.first_at)
  ),
  active as (
    select person, side, max(contextflow.version_num(version)) as v from (
      select person, side, version from days_in
      union all
      select person, 'app', version from e where f = 'app' and a = 'open'
    ) x group by 1, 2
  ),
  base as (
    select k.f, k.spec->>'since' as since, count(distinct a.person) as base
    from jsonb_each(coalesce(p_base, '{}'::jsonb)) k(f, spec)
    left join active a on a.v >= contextflow.version_num(k.spec->>'since')
      and (coalesce(k.spec->>'on', 'both') = 'both' or a.side = k.spec->>'on')
    group by 1, 2
  ),
  per as (
    select f,
      count(distinct person) as people,
      count(distinct person) filter (where at >= now() - interval '7 days') as people_7d,
      count(distinct person) filter (where a not in ('shown', 'blocked', 'hit')) as acted,
      count(*) as steps
    from e group by 1
  ),
  weeks as (
    select f, person, count(distinct date_trunc('week', at)) as n from e group by 1, 2
  ),
  by_week as (
    select f, jsonb_agg(jsonb_build_object('week', w, 'people', p) order by w) as weeks
    from (select f, (date_trunc('week', at at time zone 'utc'))::date as w, count(distinct person) as p from e group by 1, 2) x
    group by 1
  ),
  by_s as (
    select f, jsonb_object_agg(coalesce(s, 'unknown'), p) as surfaces
    from (select f, s, count(distinct person) as p from e group by 1, 2) x group by 1
  ),
  by_device as (
    select f, jsonb_object_agg(device, p) as devices
    from (
      select f, case platform when 'ios' then 'iPhone' when 'ipados' then 'iPad' when 'macos' then 'Mac'
                              when 'chrome' then 'Chrome' else 'unknown' end as device,
        count(distinct person) as p
      from e group by 1, 2
    ) x group by 1
  ),
  by_via as (
    select f, jsonb_agg(jsonb_build_object('via', via, 'people', p, 'steps', c) order by c desc) as ways
    from (select f, via, count(distinct person) as p, count(*) as c from e where via is not null group by 1, 2) x
    group by 1
  ),
  by_action as (
    select f, jsonb_object_agg(a, c) as actions
    from (select f, coalesce(a, '') as a, count(*) as c from e group by 1, 2) x group by 1
  ),
  -- Inside sessions: the step before (as sent, the one logged before it, or, for a session's first step, the last
  -- step of the session on the other surface it came from) and the step after.
  seq as (
    select s1.f, s1.a,
      coalesce(s1.prev, lag(s1.f || '.' || s1.a) over w,
        (select s0.f || '.' || s0.a from e s0 where s0.sid = s1.psid and s0.at <= s1.at order by s0.at desc limit 1)) as before,
      lead(s1.f || '.' || s1.a) over w as after
    from e s1 where s1.sid is not null
    window w as (partition by s1.sid order by s1.n nulls last, s1.at)
  ),
  came as (
    select f, jsonb_agg(jsonb_build_object('step', step, 'n', c) order by c desc) as came_from
    from (
      select f, coalesce(before, 'start') as step, count(*) as c,
        row_number() over (partition by f order by count(*) desc) as r
      from seq where split_part(coalesce(before, ''), '.', 1) <> f group by 1, 2
    ) x where r <= 6 group by 1
  ),
  went as (
    select f, jsonb_agg(jsonb_build_object('step', step, 'n', c) order by c desc) as went_to
    from (
      select f, coalesce(after, 'end') as step, count(*) as c,
        row_number() over (partition by f order by count(*) desc) as r
      from seq where split_part(coalesce(after, ''), '.', 1) <> f group by 1, 2
    ) x where r <= 6 group by 1
  ),
  sessions as (
    select sid, count(*) as steps, coalesce(sum(dt) filter (where n > 1), 0) as secs,
      (array_agg(f || '.' || a order by n nulls last, at))[1:5] as path
    from e where sid is not null group by 1
  )
  select jsonb_build_object(
    'days', (select days from d),
    'active', (select count(distinct person) from active),
    'features', coalesce((
      select jsonb_agg(jsonb_build_object(
        'f', b.f,
        'since', b.since,
        'base', b.base,
        'people', coalesce(p.people, 0),
        'people_7d', coalesce(p.people_7d, 0),
        'acted', coalesce(p.acted, 0),
        'steps', coalesce(p.steps, 0),
        'repeat', (select count(*) from weeks w where w.f = b.f and w.n >= 2),
        'actions', coalesce(ba.actions, '{}'::jsonb),
        'surfaces', coalesce(bs.surfaces, '{}'::jsonb),
        'devices', coalesce(bd.devices, '{}'::jsonb),
        'ways', coalesce(bv.ways, '[]'::jsonb),
        'weeks', coalesce(bw.weeks, '[]'::jsonb),
        'came_from', coalesce(c.came_from, '[]'::jsonb),
        'went_to', coalesce(g.went_to, '[]'::jsonb)
      ) order by coalesce(p.people, 0) desc, b.f)
      from (
        select f, since, base from base
        union
        -- A feature that logged steps but isn't in p_base still shows (base 0).
        select distinct f, null, 0 from e where f is not null and not exists (select 1 from base x where x.f = e.f)
      ) b
      left join per p on p.f = b.f
      left join by_action ba on ba.f = b.f
      left join by_s bs on bs.f = b.f
      left join by_device bd on bd.f = b.f
      left join by_via bv on bv.f = b.f
      left join by_week bw on bw.f = b.f
      left join came c on c.f = b.f
      left join went g on g.f = b.f
    ), '[]'::jsonb),
    'sessions', jsonb_build_object(
      'count', (select count(*) from sessions),
      'median_steps', (select percentile_cont(0.5) within group (order by steps) from sessions),
      'median_secs', (select percentile_cont(0.5) within group (order by secs) from sessions),
      'paths', coalesce((
        select jsonb_agg(jsonb_build_object('path', path, 'n', c) order by c desc)
        from (select path, count(*) as c from sessions group by 1 order by 2 desc limit 15) x
      ), '[]'::jsonb)
    )
  )
$$;
revoke all on function public.cf_features(integer, jsonb) from public, anon, authenticated;
grant execute on function public.cf_features(integer, jsonb) to service_role;
