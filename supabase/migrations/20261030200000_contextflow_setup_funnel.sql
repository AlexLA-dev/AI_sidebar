-- 2.4: the setup funnel and the App Store free trial for people who hit the free limit.
--
-- The Pro trial is Apple's introductory offer (set in App Store Connect): it starts a real
-- subscription that renews by itself. The panel offers it at the free limit and, once more, to
-- installs that hit the limit on an earlier day (cf_limited_before). Funnel events from the app
-- ("app_open") and the extension ("ext_on") go to contextflow.events through cf_log; cf_setup_funnel
-- counts them, with trial starts and first payments from App Store notifications, for /analytics.

create index if not exists events_limit_install_idx
  on contextflow.events (install_id, created_at) where kind = 'limit';

-- True once the install has run out of free answers (or free Google answers) on an earlier UTC day.
create or replace function public.cf_limited_before(p_install uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from contextflow.events e
    where e.kind = 'limit' and e.install_id = p_install
      and e.data->>'plan' = 'free' and e.data->>'reason' in ('limit', 'search')
      and e.created_at < date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  );
$$;

-- The way from opening the app to paying, by UTC day: each app, install or subscription counted on the
-- day it first reached the step. Our own test installs are left out. App and switch-on events exist
-- from 2.4 on. A trial is a subscription that started with the App Store free trial; "subscribed" is
-- its first payment (the first renewal after a trial, or a purchase without one).
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
      coalesce(data->>'type' = 'SUBSCRIBED' and data->>'offer' = '1'
        and coalesce(data->>'discount', case when data->>'price' = '0' then 'FREE_TRIAL' end) = 'FREE_TRIAL', false) as trial
    from contextflow.events where kind = 'appstore_notification' and data ? 'otid'
  ),
  subs as (
    select
      (select min(n.created_at) from notes n where n.otid = s.original_transaction_id and n.trial) as trial_at,
      coalesce(
        (select min(n.created_at) from notes n
          where n.otid = s.original_transaction_id and n.type in ('SUBSCRIBED', 'DID_RENEW') and not n.trial),
        -- Subscriptions App Store never told us about count from when the app first sent them.
        case when not exists (select 1 from notes n where n.otid = s.original_transaction_id) then s.created_at end
      ) as paid_at
    from contextflow.entitlements s
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
    'trial_started', (select count(*) from subs s where (s.trial_at at time zone 'utc')::date = d.day),
    'subscribed', (select count(*) from subs s where (s.paid_at at time zone 'utc')::date = d.day)
  ) order by d.day desc), '[]'::jsonb)
  from days d;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.cf_limited_before(uuid)', 'public.cf_setup_funnel(integer)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
