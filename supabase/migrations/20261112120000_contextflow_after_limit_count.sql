-- /analytics «Упёрлись в лимит», column «До лимита» (cf_after_limit), counted right in two cases the owner saw:
--   1. An answer is logged when it ends. One still being written when the next question was refused (asked at the
--      5th slot, finished a second after the refusal) was left out, so the table said 4 answers before a limit of 5.
--      Now an answer counts by when it was asked: the event's time minus its ms.
--   2. Someone who hit the Google cap (3 a day) and later the daily one showed one count, before the first refusal,
--      next to both limits. Now each person also has "limits": every limit hit that day, at its first refusal, with
--      the free answers asked before it (Google among them).
--
-- Order: apply after 20261110180000_contextflow_test_installs.sql (this is its cf_after_limit with only these
-- changes; the guard below stops it otherwise). It replaces this one function and sets its grants; it changes no
-- table and writes no data. Reading only: safe to apply before the page that uses "limits" is deployed (today's page
-- reads before and google_before, which keep their meaning).

do $guard$
begin
  if not exists (
    select 1 from pg_proc where oid = to_regprocedure('public.cf_after_limit(integer)') and prosrc like '%contextflow.test_installs%'
  ) then
    raise exception 'apply 20261110180000_contextflow_test_installs.sql first: cf_after_limit is not its version';
  end if;
end
$guard$;

create or replace function public.cf_after_limit(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (select install_id from contextflow.test_installs),
  firsts as (
    select distinct on (install_id) install_id, day, platform, version, first_at
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  unpaid as (
    select otid from contextflow.subscription_terms() where paid_from is null
  ),
  answers as (
    -- started: when it was asked (the event is logged when the answer ends; ms is how long it took).
    select e.install_id, e.created_at, (e.created_at at time zone 'utc')::date as day,
      e.created_at - case when e.data->>'ms' ~ '^[0-9]+$' then (e.data->>'ms')::bigint else 0 end * interval '1 millisecond' as started,
      coalesce(e.data->>'plan', 'free') as plan, coalesce(e.data->>'mode', 'chat') as mode, e.data->>'otid' as otid
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and coalesce(e.data->>'ok', 'true') <> 'false'
      and not exists (select 1 from tests t where t.install_id = e.install_id)
  ),
  paid as (
    select * from answers a
    where a.plan in ('pro', 'byok', 'ultra') and (a.otid is null or not exists (select 1 from unpaid u where u.otid = a.otid))
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
  buys as (
    select * from contextflow.purchases()
  ),
  first_hit as (
    select distinct on (install_id) * from hits order by install_id, at
  ),
  people as (
    select h.*, f.day as first_day,
      (select jsonb_agg(distinct x.reason) from hits x where x.install_id = h.install_id and x.day = h.day) as reasons,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.started < h.at) as before,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.started < h.at and a.mode = 'google') as google_before,
      (select min(a.started) from answers a where a.install_id = h.install_id and a.day = h.day) as day_first,
      -- Each limit hit that day, at its first refusal: the free answers asked before it (Google among them).
      (select jsonb_agg(jsonb_build_object(
          'reason', x.reason, 'at', x.at,
          'before', (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.started < x.at),
          'google_before', (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.started < x.at and a.mode = 'google')
        ) order by x.at)
        from (select distinct on (y.reason) y.reason, y.at from hits y where y.install_id = h.install_id and y.day = h.day order by y.reason, y.at) x
      ) as limits,
      (select min(b.at) from buys b where b.install_id = h.install_id and b.at > h.at) as paid_at,
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
        'locale', (select i.locale from contextflow.installs i where i.install_id = p.install_id),
        'version', p.version,
        'offer', contextflow.version_num(p.version) >= contextflow.version_num('2.4'),
        'reasons', coalesce(p.reasons, '[]'::jsonb),
        'before', p.before,
        'google_before', p.google_before,
        'limits', coalesce(p.limits, '[]'::jsonb),
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
