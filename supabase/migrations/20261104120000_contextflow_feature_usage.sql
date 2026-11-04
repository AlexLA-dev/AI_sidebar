-- Which features people use, where they come from, what they do next and where they stop (/analytics → «Функции»).
--
-- Every step is one row of contextflow.feature_events(): the "use" events (src/shared/usage.ts) and, under the same
-- feature/action names, the older kinds (answers, limits, Pro refusals, upsells, the app opened, the extension
-- switched on, quick insert, chat UX, organizing). Steps sent from 2.5 on carry their session (sid, n, prev, dt, s,
-- psid), so sequences can be read; older steps count for "who uses it" only.
--
-- One person = the extension's install, with the app counted under it once the app knows that install (app_open
-- carries it); an app that never did is a person of its own. Tests (audience "test", versions "dev-check" and
-- "calibrate", our own subscriptions) and App Review / our builds before a version's review ends
-- (contextflow.in_review) are left out, as in every other block.

-- "2.4.0" → {2,4,0}, so a version compares with a feature's first version ({2,4} ≤ {2,4,0}).
create or replace function contextflow.version_num(p_version text)
returns integer[] language sql immutable set search_path = '' as $$
  select coalesce(string_to_array(substring(coalesce(p_version, '') from '^[0-9]+(?:\.[0-9]+)*'), '.')::integer[], '{0}')
$$;
revoke all on function contextflow.version_num(text) from public, anon, authenticated;

-- contextflow.in_review for a step whose device isn't known yet ("other" or empty: the extension before its panel
-- first opened): counted as App Review / ours if either the iOS or the Mac version is.
create or replace function contextflow.in_review_any(p_platform text, p_version text, p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select case
    when p_platform in ('ios', 'ipados', 'macos', 'chrome') then contextflow.in_review(p_platform, p_version, p_at)
    else contextflow.in_review('ios', p_version, p_at) or contextflow.in_review('macos', p_version, p_at)
  end
$$;
revoke all on function contextflow.in_review_any(text, text, timestamptz) from public, anon, authenticated;

-- Real people's steps since p_from, oldest first.
create or replace function contextflow.feature_events(p_from timestamptz)
returns table (
  at timestamptz, person text, uid text, platform text, version text, s text,
  f text, a text, via text, what text, sid text, n integer, prev text, dt integer, psid text
)
language sql stable set search_path = '' as $$
  with tests as (
    select coalesce(install_id::text, data->>'app') as id from contextflow.events
    where data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate')
    union
    select data->>'app' from contextflow.events
    where data ? 'app' and (data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate'))
    union
    select install_id::text from contextflow.own_subscriptions where install_id is not null
  ),
  -- The app's extension install, once the app reported it (the latest one, if it changed).
  app_install as (
    select distinct on (data->>'app') data->>'app' as app, install_id::text as install
    from contextflow.events
    where kind = 'app_open' and install_id is not null and data ? 'app'
    order by data->>'app', created_at desc
  ),
  e as (
    select ev.created_at, ev.kind, ev.data, coalesce(ev.install_id::text, ev.data->>'app') as uid
    from contextflow.events ev
    where ev.created_at >= p_from
      and ev.kind in ('use', 'chat', 'limit', 'pro_only', 'media_notice', 'media_notice_pro', 'byok_upsell', 'renewal_off',
        'app_open', 'ext_on', 'social_open', 'insert_copied', 'insert_template', 'insert_answer', 'insert_tpl_new',
        'insert_fill', 'insert_fill_edit', 'insert_manual', 'insert_ai', 'ux_mark', 'ux_pin', 'ux_delete', 'ux_remind',
        'organize', 'organize_promo', 'organize_optin', 'organize_api')
      and not (ev.data ? 'legacy')
  )
  select e.created_at,
    coalesce(ai.install, e.uid),
    e.uid,
    nullif(e.data->>'platform', ''),
    nullif(e.data->>'version', ''),
    coalesce(e.data->>'s', e.data->>'surface',
      case when e.data->>'from' in ('app', 'panel') then e.data->>'from' end,
      case when e.kind = 'app_open' or (e.data ? 'app' and e.kind <> 'chat') then 'app' end),
    case e.kind
      when 'use' then e.data->>'f'
      when 'chat' then case e.data->>'mode' when 'find' then 'ai_search' when 'history' then 'ask_chats' else 'ask' end
      when 'pro_only' then 'upsell'
      when 'media_notice' then 'upsell'
      when 'media_notice_pro' then 'upsell'
      when 'byok_upsell' then 'upsell'
      when 'organize_promo' then 'upsell'
      when 'renewal_off' then 'renewal'
      when 'app_open' then 'app'
      when 'ext_on' then 'ext'
      when 'social_open' then 'social'
      when 'organize_optin' then 'organize'
      when 'organize_api' then 'organize'
      else case when e.kind like 'insert\_%' then 'insert' when e.kind like 'ux\_%' then substr(e.kind, 4) else e.kind end
    end,
    case e.kind
      when 'use' then e.data->>'a'
      when 'chat' then case when e.data->>'ok' = 'false' then 'error' else 'answer' end
      when 'limit' then 'hit'
      when 'pro_only' then 'blocked'
      when 'media_notice' then 'shown'
      when 'media_notice_pro' then 'tap'
      when 'renewal_off' then 'answer'
      when 'app_open' then 'open'
      when 'ext_on' then 'on'
      when 'social_open' then 'open'
      when 'insert_ai' then 'ai_' || coalesce(e.data->>'action', '')
      when 'organize_optin' then 'optin_' || coalesce(e.data->>'action', '')
      when 'organize_api' then 'api_' || coalesce(e.data->>'op', '')
      else case when e.kind like 'insert\_%' then substr(e.kind, 8) else e.data->>'action' end
    end,
    coalesce(e.data->>'via',
      case e.kind
        when 'byok_upsell' then e.data->>'where'
        when 'organize_promo' then e.data->>'where'
        when 'media_notice' then 'media'
        when 'media_notice_pro' then 'media'
        when 'pro_only' then 'pro_only'
        when 'limit' then e.data->>'mode'
        when 'organize_optin' then e.data->>'from'
      end,
      e.data->>'how'),
    coalesce(e.data->>'what', e.data->>'key',
      case e.kind
        when 'chat' then e.data->>'mode'
        when 'limit' then e.data->>'reason'
        when 'pro_only' then case e.data->>'feature' when 'find' then 'ai' when 'history' then 'ai' else e.data->>'feature' end
        when 'byok_upsell' then 'byok'
        when 'organize_promo' then case e.data->>'where' when 'pro_card' then 'ai' else 'organize' end
        when 'media_notice' then 'media'
        when 'media_notice_pro' then 'media'
        when 'renewal_off' then e.data->>'reason'
        when 'social_open' then e.data->>'network'
      end,
      e.data->>'feature'),
    e.data->>'sid',
    (e.data->>'n')::integer,
    e.data->>'prev',
    (e.data->>'dt')::integer,
    e.data->>'psid'
  from e
  left join app_install ai on ai.app = e.data->>'app'
  where e.uid is not null
    and coalesce(e.data->>'version', '') not in ('dev-check', 'calibrate')
    and not exists (select 1 from tests t where t.id = e.uid)
    and not exists (select 1 from tests t where t.id = ai.install)
    and not contextflow.in_review_any(e.data->>'platform', e.data->>'version', e.created_at)
  order by e.created_at
$$;
revoke all on function contextflow.feature_events(timestamptz) from public, anon, authenticated;

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
    ('watch', 4, 'page_open', '{tap}', 'watch', null)
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
