-- X App Conversion API (netlify/shared/xconversions.mts): which of an app's conversions X hasn't had yet.
-- The app checks in ("app_open", "ads_sync" in /api/v2/event) with its ATT answer and, after "authorized", its IDFA;
-- the server asks cf_x_due what to send with it, sends it, and logs an "x_conversion" event per conversion sent
-- (data: app, event, at, platform; never the IDFA). The IDFA itself is never stored.
--
-- A conversion, for an app (p_app: its random id) and its extension (p_install: its install id, once the app knows
-- it), each the first one ever, sent only when it happened in the last p_days and only once:
--   install       the app's first launch as a new install ("app_open" with new_install)
--   first_answer  the first answer that came, in Safari or in the app (a "chat" event with ok, at the time it was
--                 asked: the event is logged when the answer ends, ms after)
--   limit         the first time out of free answers ("limit", plan free, reason limit; not the Google cap)
--   subscribe     the first subscription or free trial the App Store told us about (contextflow.entitlements, by
--                 the app account token the app sets on a purchase: the extension's install id, else the app's id;
--                 production only, not refunded)
-- Our test installs and apps (contextflow.test_ids) get nothing.
--
-- Order: apply after 20261110180000_contextflow_test_installs.sql (contextflow.test_ids; the guard below checks).
-- It adds two partial indexes on contextflow.events and one function with its grants (service_role only). It
-- changes no row. Until it's applied the server sends nothing to X (the RPC call fails and is logged).

do $guard$
begin
  if to_regclass('contextflow.test_ids') is null then
    raise exception 'apply 20261110180000_contextflow_test_installs.sql first: contextflow.test_ids is missing';
  end if;
end
$guard$;

create index if not exists events_chat_install_idx
  on contextflow.events (install_id, created_at) where kind = 'chat';
create index if not exists events_app_kind_idx
  on contextflow.events ((data->>'app'), kind) where kind in ('app_open', 'x_conversion');

create or replace function public.cf_x_due(p_app uuid, p_install uuid default null, p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with ids as (
    select id from (values (p_app), (p_install)) v(id) where id is not null
  ),
  d as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 90))) as since),
  ours as (
    select exists (
      select 1 from contextflow.test_ids t where t.id = p_app::text or t.id = p_install::text
    ) as yes
  ),
  sent as (
    select distinct e.data->>'event' as event
    from contextflow.events e
    where e.kind = 'x_conversion'
      and (e.data->>'app' = p_app::text or (p_install is not null and e.install_id = p_install))
  ),
  firsts as (
    select 'install' as event, (
      select min(e.created_at) from contextflow.events e
      where e.kind = 'app_open' and e.data->>'app' = p_app::text and e.data->>'new_install' = 'true'
    ) as at
    union all
    select 'first_answer', (
      select min(e.created_at - make_interval(secs => coalesce((e.data->>'ms')::numeric, 0) / 1000))
      from contextflow.events e
      where e.kind = 'chat' and e.install_id in (select id from ids) and e.data->>'ok' = 'true'
    )
    union all
    select 'limit', (
      select min(e.created_at) from contextflow.events e
      where e.kind = 'limit' and e.install_id in (select id from ids)
        and e.data->>'plan' = 'free' and e.data->>'reason' = 'limit'
    )
    union all
    select 'subscribe', (
      select min(s.created_at) from contextflow.entitlements s
      where s.app_account_token in (select id from ids) and s.environment = 'Production' and s.revoked_at is null
    )
  )
  select coalesce(jsonb_agg(jsonb_build_object('event', f.event, 'at', f.at) order by f.at), '[]'::jsonb)
  from firsts f, d, ours o
  where not o.yes and f.at is not null and f.at >= d.since
    and f.event not in (select event from sent where event is not null)
$$;
revoke all on function public.cf_x_due(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.cf_x_due(uuid, uuid, integer) to service_role;
