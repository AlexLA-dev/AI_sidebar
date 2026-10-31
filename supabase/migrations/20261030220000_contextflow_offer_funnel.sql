-- 2.4: Pro's offer for people who ran out of free answers is an App Store offer code (first month 50% off,
-- code CONTEXTFLOW50 on pro.monthly), not a free trial. The funnel counts subscriptions started with an offer
-- code (App Store notification SUBSCRIBED with offerType 3) instead of trial starts; "subscribed" is the
-- first payment, the discounted one included.

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
      (select min(n.created_at) from notes n where n.otid = s.original_transaction_id and n.by_code) as code_at,
      coalesce(
        (select min(n.created_at) from notes n
          where n.otid = s.original_transaction_id and n.type in ('SUBSCRIBED', 'DID_RENEW')),
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
    'offer_redeemed', (select count(*) from subs s where (s.code_at at time zone 'utc')::date = d.day),
    'subscribed', (select count(*) from subs s where (s.paid_at at time zone 'utc')::date = d.day)
  ) order by d.day desc), '[]'::jsonb)
  from days d;
$$;
