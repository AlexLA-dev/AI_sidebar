-- Our simulator installs caught on the server, with nothing from the app (2.7 and older branches don't mark
-- themselves; 2.8 and 2.7.1 send audience "test" from debug and simulator builds).
--
-- A simulator build without -CFApiBase sends its "app opened" to production as a new app. Such an app never meets an
-- extension install, so the reports that count an app before its extension counted it as a person.
--
-- 1. public.cf_event_guard: one call per /api/v2/event request, given the request's daily address subject
--    (ipSubject, salted by the day) and what the request is. It keeps two day counters per address, the same kind of
--    rows as every rate limit already keeps (contextflow.usage_counters): nothing new is stored per event, and no
--    app or install is ever written next to an address.
--    - ours:ip:<h> — a request of ours came from this address today: marked as a test by the app or the server
--      (audience "test", our scripts' versions, a non-production deploy), or from an install already marked
--      (contextflow.installs.is_test).
--    - new:<platform>:ip:<h> — first opens of new apps on this platform from this address today.
--    It answers for an app's first open only (an app that has no app_open yet), in a request without an extension
--    install, so an old app opened on our network and anything joined to an extension is never touched:
--    - 'address' when the address was ours earlier today;
--    - 'burst' when this is the third or later new app on the same platform from the address today (a person setting
--      up an iPhone, an iPad and a Mac is three platforms; the simulator stands make one platform every few minutes).
--    The server then writes audience "test" with audience_set = the answer on that request's events, so the app goes
--    into contextflow.test_ids and out of every report, like any other test app; audience_set says why, and undoes it.
-- 2. contextflow.net_marks: the apps the guard marked, with any sign of a person that came later (an Apple Ads
--    attribution, a purchase with the app's token, an extension install joined to it). A row with a sign is a wrong
--    mark to look at by hand.
-- 3. public.cf_setup_funnel: its "app opened" counted every app (ours and App Review's too); now it counts
--    contextflow.install_cohort without the batch, as the ladder does.
-- 4. An index on the app of app_open events (the guard's "is this app new" and every report that joins apps).
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
    select e.data->>'app' as app, min(e.data->>'audience_set') as why, min(e.created_at) as at,
      min(nullif(e.data->>'platform', '')) as platform
    from contextflow.events e
    where e.kind = 'app_open' and e.data->>'audience_set' in ('address', 'burst')
    group by 1
  )
  select m.app, m.why, m.at, m.platform,
    exists (select 1 from contextflow.events e where e.kind = 'ads_attribution' and e.data->>'app' = m.app) as ad,
    exists (select 1 from contextflow.entitlements en where en.app_account_token::text = m.app and en.environment = 'Production') as bought,
    exists (select 1 from contextflow.app_links l where l.app = m.app) as linked
  from marked m;
revoke all on contextflow.net_marks from public, anon, authenticated;

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
