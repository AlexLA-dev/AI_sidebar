-- After the limit (/analytics → «После лимита»): what the people who ran out of free answers did next, and whether
-- the people who pay still use ContextFlow.
--
-- people: one row per install whose first refusal of the free allowance (a "limit" event, reason "limit" = the 5
--   answers a day, or "search" = Google answers a day) fell in the last p_days (UTC). Tests, our installs and App
--   Review / our builds (contextflow.in_review_any) left out. Per row: the day and moment, the install's first day,
--   device, version (2.4+ shows the −50 % code at the limit), which limits it ran into that day, free answers before
--   the refusal and how long they took, a subscription bought after it (the first paid answer, Pro or Own key, or a
--   paid Pro subscription carrying this install as its account token), and what came after the limit day: days in
--   the panel, days with answers, days with refusals, the last day seen.
-- paying: one row per real install on a paid subscription (Pro or Own key; press, owner, trial and free codes are
--   not paid until their first payment): first seen (the same moment cf_owner_insights gives its subscribers'
--   installs, so the page can put the two together), first and last paid answer, days with paid answers, the last
--   day in the panel and the days in the panel since the first paid answer.

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
  first_hit as (
    select distinct on (install_id) * from hits order by install_id, at
  ),
  people as (
    select h.*, f.day as first_day,
      (select jsonb_agg(distinct x.reason) from hits x where x.install_id = h.install_id and x.day = h.day) as reasons,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.created_at < h.at) as before,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.created_at < h.at and a.mode = 'google') as google_before,
      (select min(a.created_at) from answers a where a.install_id = h.install_id and a.day = h.day) as day_first,
      least(
        (select min(p.created_at) from paid p where p.install_id = h.install_id and p.created_at > h.at),
        (select min(s.created_at) from contextflow.entitlements s
         where s.environment = 'Production' and s.app_account_token = h.install_id and s.created_at > h.at
           and s.product_id in ('com.contextflow.pro.monthly', 'com.contextflow.pro.yearly')
           and not exists (select 1 from unpaid u where u.otid = s.original_transaction_id))
      ) as paid_at,
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
