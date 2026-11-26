-- Our simulator installs caught on the server, with nothing from the app (2.7 and older branches don't mark
-- themselves; 2.8 and 2.7.1 send audience "test" from debug and simulator builds), and the reports that still counted
-- our own installs closed.
--
-- A simulator build without -CFApiBase sends its "app opened" to production as a new app. Such an app never meets an
-- extension install, so the reports that count an app before its extension counted it as a person.
--
-- 1. public.cf_event_guard: one call per /api/v2/event request, given the request's daily address subject
--    (ipSubject, salted by the day) and what the request is. It keeps two day counters per address, the same kind of
--    rows as every rate limit already keeps (contextflow.usage_counters): nothing new is stored per event, and no
--    app or install is ever written next to an address.
--    - ours:ip:<h> — a request of ours came from this address today: marked as a test by the app or the server
--      (audience "test" — debug and simulator builds, and TestFlight builds where the app says so —, our scripts'
--      versions, a non-production deploy), or from an install already marked (contextflow.installs.is_test, the
--      owner's own subscriptions included). So the owner's phone on mobile data or in a café teaches that address for
--      the day too: fine while TestFlight is ours alone; to revisit if it ever opens to outside testers.
--    - new:<platform>:ip:<h> — first opens of new apps on this platform from this address today.
--    It answers for an app's first open only (an app that has no app_open yet), in a request without an extension
--    install, so an old app opened on our network and anything joined to an extension is never touched:
--    - 'address' when the address was ours earlier today: the server marks the app as a test (audience "test",
--      audience_set "address"), so it goes into contextflow.test_ids and out of every report; audience_set undoes it.
--      Its wrong marks are people on our own network.
--    - 'burst' when this is the third or later new app on one platform from the address today. Only a hint
--      (net_hint "burst", no audience): a carrier's shared address, a campus or an office can give three real new
--      iPhones in a day once installs grow, and a wrongly hidden person who leaves the same day leaves no trace to
--      find the mistake by. Such apps stay in every report; contextflow.net_burst lists them by day and platform, to
--      be compared with App Store Connect's first downloads before anything is marked by hand.
-- 2. contextflow.net_marks: the apps marked by 'address', with any sign of a person that came later (an Apple Ads
--    attribution, a purchase with the app's token, an extension install joined to it): a row with a sign is a wrong
--    mark to look at. contextflow.net_burst: the 'burst' suspects, one row per day and platform.
-- 3. Reports that still counted our installs:
--    - public.cf_setup_funnel: "app opened" counted every app (ours and the review windows' too); now
--      contextflow.install_cohort without the batch, as public.cf_ladder.
--    - public.cf_onboarding: an app's people were left out only when its own app_open events were marked; now an app
--      outside the same cohort is ours (an app joined to one of our installs, an app first opened in a review window).
--    - contextflow.v_daily, v_summary, v_audience, v_funnel_30d (read in Supabase, not by the owner's page): our
--      installs out through contextflow.test_installs, our own subscriptions out of the subscription counts. v_daily's
--      tokens and estimated cost stay on all answers: that is money spent, tests included.
-- 4. An index on the app of app_open events (the guard's "is this app new", the reports' joins from an app).
--
-- Order: after 20261124120000_contextflow_install_ladder.sql (install_cohort).

do $$
begin
  if to_regprocedure('contextflow.install_cohort(date, date)') is null then
    raise exception 'apply 20261124120000_contextflow_install_ladder.sql first';
  end if;
end $$;

create index if not exists events_app_open_app_idx on contextflow.events ((data->>'app'), created_at)
  where kind = 'app_open';

create or replace function public.cf_event_guard(
  p_subject text, p_app uuid, p_install uuid, p_platform text, p_first_open boolean, p_marked boolean)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := contextflow.period_start('day');
  v_ours boolean;
  v_new integer;
begin
  if p_subject is null or p_subject !~ '^ip:[0-9a-f]{32}$' then
    return null;
  end if;
  v_ours := coalesce(p_marked, false)
    or (p_install is not null and exists (select 1 from contextflow.installs i where i.install_id = p_install and i.is_test));
  if v_ours then
    insert into contextflow.usage_counters as c (subject, period, period_start, n)
    values ('ours:' || p_subject, 'day', v_day, 1)
    on conflict (subject, period, period_start) do update set n = c.n + 1;
    return null;
  end if;
  if p_install is not null or p_app is null or not coalesce(p_first_open, false) then
    return null;
  end if;
  if exists (select 1 from contextflow.events e where e.kind = 'app_open' and e.data->>'app' = p_app::text) then
    return null;
  end if;
  if exists (
    select 1 from contextflow.usage_counters c
    where c.subject = 'ours:' || p_subject and c.period = 'day' and c.period_start = v_day and c.n > 0
  ) then
    return 'address';
  end if;
  insert into contextflow.usage_counters as c (subject, period, period_start, n)
  values ('new:' || left(coalesce(nullif(p_platform, ''), 'unknown'), 20) || ':' || p_subject, 'day', v_day, 1)
  on conflict (subject, period, period_start) do update set n = c.n + 1
  returning n into v_new;
  return case when v_new >= 3 then 'burst' end;
end $$;
revoke all on function public.cf_event_guard(text, uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.cf_event_guard(text, uuid, uuid, text, boolean, boolean) to service_role;

create or replace view contextflow.net_marks as
  with marked as (
    select e.data->>'app' as app, min(e.created_at) as at, min(nullif(e.data->>'platform', '')) as platform
    from contextflow.events e
    where e.kind = 'app_open' and e.data->>'audience_set' = 'address'
    group by 1
  )
  select m.app, m.at, m.platform,
    exists (select 1 from contextflow.events e where e.kind = 'ads_attribution' and e.data->>'app' = m.app) as ad,
    exists (select 1 from contextflow.entitlements en where en.app_account_token::text = m.app and en.environment = 'Production') as bought,
    exists (select 1 from contextflow.app_links l where l.app = m.app) as linked
  from marked m;
revoke all on contextflow.net_marks from public, anon, authenticated;

create or replace view contextflow.net_burst as
  with hinted as (
    select e.data->>'app' as app, min(e.created_at) as at, min(nullif(e.data->>'platform', '')) as platform
    from contextflow.events e
    where e.kind = 'app_open' and e.data->>'net_hint' = 'burst'
    group by 1
  )
  select (h.at at time zone 'utc')::date as day, coalesce(h.platform, 'unknown') as platform,
    count(*) as suspects,
    count(*) filter (where h.app in (select id from contextflow.test_ids)) as marked_since,
    count(*) filter (where exists (select 1 from contextflow.app_links l where l.app = h.app)) as linked,
    count(*) filter (where exists (select 1 from contextflow.events e where e.kind = 'ads_attribution' and e.data->>'app' = h.app)) as ad,
    array_agg(h.app order by h.at) as apps
  from hinted h
  group by 1, 2;
revoke all on contextflow.net_burst from public, anon, authenticated;

-- public.cf_setup_funnel [latest version: 20261110180000_contextflow_test_installs.sql]: only "apps" changes.
create or replace function public.cf_setup_funnel(p_days integer default 30)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with tests as (select install_id from contextflow.test_installs),
  apps as (
    select c.app, c.at,
      exists (
        select 1 from contextflow.events e
        where e.kind = 'app_open' and e.data->>'app' = c.app and e.data->>'notifications' = 'granted'
      ) as notified
    from contextflow.install_cohort((now() at time zone 'utc')::date - (greatest(1, least(p_days, 180)) - 1),
                                    (now() at time zone 'utc')::date) c
    where c.source <> 'batch'
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

-- public.cf_onboarding [latest version: production's definition on 2026-11-25]: "cohort" and "apps" (the old "apps"
-- is now "app_opens") are new; an app outside the cohort is a test app.
create or replace function public.cf_onboarding(p_days integer default 30)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (select install_id from contextflow.test_installs),
  cohort as (
    select c.app from contextflow.install_cohort((now() at time zone 'utc')::date - 180, (now() at time zone 'utc')::date) c
    where c.source <> 'batch'
  ),
  app_opens as (
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
  apps as (
    select a.app, a.at, a.platform, a.version, a.notified, a.install_id,
      a.test or not exists (select 1 from cohort c where c.app = a.app) as test
    from app_opens a
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

-- The Supabase views [latest versions: production's definitions on 2026-11-25]: our installs out; same columns.
create or replace view contextflow.v_audience as
  select coalesce(i.platform, 'unknown') as platform,
    coalesce(i.locale, 'unknown') as locale,
    count(*) as installs,
    count(*) filter (where i.last_seen_at >= now() - interval '7 days') as active_7d,
    sum(i.requests_total) as answers_total
  from contextflow.installs i
  where not exists (select 1 from contextflow.test_installs t where t.install_id = i.install_id)
  group by coalesce(i.platform, 'unknown'), coalesce(i.locale, 'unknown')
  order by count(*) desc;

create or replace view contextflow.v_daily as
  with days as (
    select generate_series((current_date - 89)::timestamptz, current_date::timestamptz, interval '1 day')::date as day
  ),
  chats as (
    select (e.created_at at time zone 'utc')::date as day, e.install_id, e.data,
      coalesce(e.install_id in (select t.install_id from contextflow.test_installs t), false) as ours
    from contextflow.events e
    where e.kind = 'chat' and e.created_at >= current_date - 89
  ),
  chat_days as (
    select day,
      count(*) filter (where not ours and coalesce(data->>'legacy', 'false') <> 'true') as answers,
      count(*) filter (where not ours and data->>'plan' = 'pro') as answers_pro,
      count(*) filter (where not ours and data->>'legacy' = 'true') as answers_old_builds,
      count(distinct install_id) filter (where not ours) as active_installs,
      round(avg((data->>'ms')::numeric) filter (where not ours) / 1000, 1) as avg_seconds,
      -- Money spent: every answer, ours included.
      sum(coalesce((data->>'prompt_tokens')::bigint, 0)) as tokens_in,
      sum(coalesce((data->>'completion_tokens')::bigint, 0)) as tokens_out,
      round(sum(case when data->>'model' like 'gpt-4o-mini%'
        then coalesce((data->>'prompt_tokens')::numeric, 0) * 0.15 + coalesce((data->>'completion_tokens')::numeric, 0) * 0.60
        else coalesce((data->>'prompt_tokens')::numeric, 0) * 0.40 + coalesce((data->>'completion_tokens')::numeric, 0) * 1.60
      end) / 1000000, 3) as est_cost_usd
    from chats
    group by day
  ),
  install_days as (
    select (i.created_at at time zone 'utc')::date as day, count(*) as new_installs
    from contextflow.installs i
    where i.created_at >= current_date - 89
      and not exists (select 1 from contextflow.test_installs t where t.install_id = i.install_id)
    group by 1
  ),
  limit_days as (
    select (e.created_at at time zone 'utc')::date as day, count(*) as limit_hits
    from contextflow.events e
    where e.kind = 'limit' and e.created_at >= current_date - 89
      and not coalesce(e.install_id in (select t.install_id from contextflow.test_installs t), false)
    group by 1
  )
  select d.day,
    coalesce(i.new_installs, 0) as new_installs,
    coalesce(c.active_installs, 0) as active_installs,
    coalesce(c.answers, 0) as answers,
    coalesce(c.answers_pro, 0) as answers_pro,
    coalesce(c.answers_old_builds, 0) as answers_old_builds,
    coalesce(l.limit_hits, 0) as limit_hits,
    c.avg_seconds,
    coalesce(c.tokens_in, 0) as tokens_in,
    coalesce(c.tokens_out, 0) as tokens_out,
    coalesce(c.est_cost_usd, 0) as est_cost_usd
  from days d
  left join chat_days c using (day)
  left join install_days i using (day)
  left join limit_days l using (day)
  order by d.day desc;

create or replace view contextflow.v_funnel_30d as
  with cohort as (
    select i.install_id from contextflow.installs i
    where i.created_at >= now() - interval '30 days'
      and not exists (select 1 from contextflow.test_installs t where t.install_id = i.install_id)
  ),
  answered as (
    select install_id, count(distinct (created_at at time zone 'utc')::date) as days
    from contextflow.events
    where kind = 'chat' and install_id in (select install_id from cohort)
    group by install_id
  ),
  limited as (
    select distinct install_id from contextflow.events
    where kind = 'limit' and install_id in (select install_id from cohort)
  )
  select (select count(*) from cohort) as opened_panel,
    (select count(*) from answered) as got_answer,
    (select count(*) from answered where days >= 2) as came_back,
    (select count(*) from limited) as hit_free_limit;

create or replace view contextflow.v_summary as
  select p.period,
    (select count(*) from contextflow.installs i
      where i.created_at >= now() - p.span
        and not exists (select 1 from contextflow.test_installs t where t.install_id = i.install_id)) as new_installs,
    (select count(distinct e.install_id) from contextflow.events e
      where e.kind = 'chat' and e.install_id is not null and e.created_at >= now() - p.span
        and not exists (select 1 from contextflow.test_installs t where t.install_id = e.install_id)) as active_installs,
    (select count(*) from contextflow.events e
      where e.kind = 'chat' and coalesce(e.data->>'legacy', 'false') <> 'true' and e.created_at >= now() - p.span
        and not coalesce(e.install_id in (select t.install_id from contextflow.test_installs t), false)) as answers,
    (select count(*) from contextflow.events e
      where e.kind = 'limit' and e.created_at >= now() - p.span
        and not coalesce(e.install_id in (select t.install_id from contextflow.test_installs t), false)) as limit_hits,
    (select count(*) from contextflow.entitlements en
      where en.environment = 'Production' and en.created_at >= now() - p.span
        and en.original_transaction_id not in (select o.otid from contextflow.own_subscriptions o where o.otid is not null)) as new_subscriptions,
    (select count(*) from contextflow.entitlements en
      where en.environment = 'Production' and en.revoked_at is null and en.expires_at > now()
        and en.original_transaction_id not in (select o.otid from contextflow.own_subscriptions o where o.otid is not null)) as active_subscriptions
  from (values ('7 days', interval '7 days'), ('30 days', interval '30 days')) p(period, span);
