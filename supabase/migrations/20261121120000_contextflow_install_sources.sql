-- 2.7.1 (the Apple Ads report of 2026-11-21, point 4): for every new install, where it came from (Apple Ads or not),
-- whether ContextFlow was switched on in Safari, and whether it was paid for.
--
-- The app makes a random id on its first launch ("app", sent with "app opened" and the Apple Ads answer); the extension
-- makes its own random install id (install_id on everything Safari's side counts; the app's purchases carry it, or the
-- app's id before the extension has given one, as appAccountToken). Until now the two met only through a later
-- "app opened" that carried both (once a day, and only if the app was opened again after switching it on), so of 627
-- app ids in 30 days 68 were joined that way: for an ad install, «never switched it on» and «switched it on, didn't
-- buy» looked the same. 2.7 added the "linked" activation step from the native side (once, unconfirmed); 2.7.1 sends it
-- from the extension's background until the server has it (src/background/link.ts), and the server keeps Apple's
-- «not an ad» answer as 'ads_organic' (netlify/functions/v2-event.mts).
--
-- 1. contextflow.app_links: every app id with every install id seen together in one event (app_open, the activation
--    steps, "linked" above all, the app's own steps that carry both, ads_attribution). A pair where both are the same
--    id is left out: the app's own chat requests use its id as the install before the extension has given one.
-- 2. public.cf_install_sources(from, to): the apps first opened in those days (UTC), by source and platform:
--    installs → linked (the two ids joined) → extension_on → panel_used → first_answer → paid.
--      source       apple_ads (Apple said an ad brought it), organic (Apple said not; 2.7.1 servers on), unknown (no
--                   answer: the Mac, a token that never resolved, or before the server kept organic answers)
--      extension_on an install id joined to it (only the extension makes one), or the app saw it on ("app opened" with
--                   extension on / in_use, or the activation step "enabled")
--      panel_used   the panel opened or a question asked in Safari (install_days), or the app saw it in use
--      first_answer an answer in Safari for a joined install
--      paid         as cf_ads_funnel: a Production subscription for the app id or a joined install, past any free
--                   start, or a paid plan on a joined install's answers
-- 3. public.cf_ads_funnel: the same columns as before (tools/ads/asa.mjs reads them), its install found through every
--    joined install instead of the first "app opened" that carried one, and "extension on" as in 2.
--
-- Our own installs are left out through contextflow.test_ids, as in every report. Nothing is written or deleted;
-- reports for service_role only.
--
-- Order: after 20261110180000_contextflow_test_installs.sql (test_ids; its cf_ads_funnel is the one replaced here) and
-- 20261102150000_contextflow_subscription_terms.sql (subscription_terms).

do $$
begin
  if to_regclass('contextflow.test_ids') is null or to_regclass('contextflow.test_installs') is null then
    raise exception 'apply 20261110180000_contextflow_test_installs.sql first';
  end if;
  if to_regprocedure('contextflow.subscription_terms()') is null then
    raise exception 'apply 20261102150000_contextflow_subscription_terms.sql first';
  end if;
end $$;

create or replace view contextflow.app_links as
  select e.data->>'app' as app, e.install_id as install, min(e.created_at) as first_at
  from contextflow.events e
  where e.install_id is not null and e.data ? 'app'
    and e.data->>'app' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and e.install_id::text <> e.data->>'app'
  group by 1, 2;
revoke all on contextflow.app_links from public, anon, authenticated;

create or replace function public.cf_install_sources(p_from date, p_to date)
returns table (
  source text, platform text,
  installs bigint, linked bigint, extension_on bigint, panel_used bigint, first_answer bigint, paid bigint
)
language sql stable security definer set search_path = '' as $$
  with tests as (select id from contextflow.test_ids where id is not null),
  unpaid as (select otid from contextflow.subscription_terms() where paid_from is null),
  first_open as (
    select distinct on (e.data->>'app') e.data->>'app' as app, e.created_at as at, nullif(e.data->>'platform', '') as platform
    from contextflow.events e
    where e.kind = 'app_open' and e.data ? 'app'
      and e.data->>'app' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    order by e.data->>'app', e.created_at
  ),
  cohort as (
    select f.* from first_open f
    where (f.at at time zone 'utc')::date between p_from and p_to
      and f.app not in (select id from tests)
  ),
  links as (
    select l.app, l.install from contextflow.app_links l
    where l.app in (select app from cohort)
  ),
  -- Ours by any joined install: left out whole.
  ours as (select distinct l.app from links l where l.install::text in (select id from tests)),
  app_seen as (
    select e.data->>'app' as app,
      bool_or(e.kind = 'ads_attribution') as ad,
      bool_or(e.kind = 'ads_organic') as organic,
      bool_or((e.kind = 'app_open' and e.data->>'extension' in ('on', 'in_use'))
        or (e.kind = 'use' and e.data->>'f' = 'activation' and e.data->>'a' = 'enabled')) as saw_on,
      bool_or(e.kind = 'app_open' and e.data->>'extension' = 'in_use') as saw_in_use
    from contextflow.events e
    where e.data ? 'app' and e.kind in ('ads_attribution', 'ads_organic', 'app_open', 'use')
      and e.data->>'app' in (select app from cohort)
    group by 1
  ),
  steps as (
    select c.app, c.platform,
      case when s.ad then 'apple_ads' when s.organic then 'organic' else 'unknown' end as source,
      exists (select 1 from links l where l.app = c.app) as linked,
      exists (select 1 from links l where l.app = c.app) or coalesce(s.saw_on, false) as on_,
      exists (select 1 from links l join contextflow.install_days d on d.install_id = l.install where l.app = c.app)
        or coalesce(s.saw_in_use, false) as panel,
      exists (
        select 1 from links l join contextflow.events ch on ch.install_id = l.install
        where l.app = c.app and ch.kind = 'chat' and coalesce(ch.data->>'ok', 'true') <> 'false'
      ) as answered,
      exists (
        select 1 from contextflow.entitlements en
        where en.environment = 'Production'
          and (en.app_account_token = c.app::uuid or en.app_account_token in (select l.install from links l where l.app = c.app))
          and not exists (select 1 from unpaid u where u.otid = en.original_transaction_id)
      ) or exists (
        select 1 from links l join contextflow.events ch on ch.install_id = l.install
        where l.app = c.app and ch.kind = 'chat' and ch.data->>'plan' in ('pro', 'byok', 'ultra')
          and not exists (select 1 from unpaid u where u.otid = ch.data->>'otid')
      ) as paid
    from cohort c
    left join app_seen s on s.app = c.app
    where c.app not in (select app from ours)
  )
  select source, coalesce(platform, 'unknown'),
    count(*), count(*) filter (where linked), count(*) filter (where on_), count(*) filter (where panel),
    count(*) filter (where answered), count(*) filter (where paid)
  from steps
  group by 1, 2
  order by 1, 2;
$$;
revoke all on function public.cf_install_sources(date, date) from public, anon, authenticated;
grant execute on function public.cf_install_sources(date, date) to service_role;

-- public.cf_ads_funnel: the install through every joined one, "extension on" as in cf_install_sources
-- [latest version: 20261110180000_contextflow_test_installs.sql]
create or replace function public.cf_ads_funnel(p_from date, p_to date)
returns table (
  campaign_id bigint, ad_group_id bigint, keyword_id bigint,
  installs bigint, extension_on bigint, first_answer bigint, subscribed bigint
)
language sql stable security definer set search_path = '' as $$
  with tests as (select id from contextflow.test_ids where id is not null),
  unpaid as (select otid from contextflow.subscription_terms() where paid_from is null),
  ads as (
    select distinct on (e.data->>'app')
      e.data->>'app' as app,
      (e.data->>'campaignId')::bigint as campaign_id,
      (e.data->>'adGroupId')::bigint as ad_group_id,
      nullif(e.data->>'keywordId', '')::bigint as keyword_id
    from contextflow.events e
    where e.kind = 'ads_attribution' and e.data ? 'app'
      and (e.created_at at time zone 'utc')::date between p_from and p_to
    order by e.data->>'app', e.created_at
  ),
  links as (
    select l.app, l.install from contextflow.app_links l
    where l.app in (select app from ads)
  ),
  steps as (
    select a.*,
      exists (select 1 from links l where l.app = a.app) or exists (
        select 1 from contextflow.events o
        where o.data->>'app' = a.app and (
          (o.kind = 'app_open' and o.data->>'extension' in ('on', 'in_use'))
          or (o.kind = 'use' and o.data->>'f' = 'activation' and o.data->>'a' = 'enabled'))
      ) as on_,
      exists (
        select 1 from links l join contextflow.events c on c.install_id = l.install
        where l.app = a.app and c.kind = 'chat' and coalesce(c.data->>'ok', 'true') <> 'false'
      ) as answered,
      exists (
        select 1 from contextflow.entitlements s
        where s.environment = 'Production'
          and (s.app_account_token in (select l.install from links l where l.app = a.app)
            or s.app_account_token = case when a.app ~ '^[0-9a-fA-F-]{36}$' then a.app::uuid end)
          and not exists (select 1 from unpaid u where u.otid = s.original_transaction_id)
      ) or exists (
        select 1 from links l join contextflow.events c on c.install_id = l.install
        where l.app = a.app and c.kind = 'chat' and c.data->>'plan' in ('pro', 'byok', 'ultra')
          and not exists (select 1 from unpaid u where u.otid = c.data->>'otid')
      ) as paid
    from ads a
  )
  select campaign_id, ad_group_id, keyword_id,
    count(*), count(*) filter (where on_), count(*) filter (where answered), count(*) filter (where paid)
  from steps
  -- Our own installs left out (contextflow.test_ids: by the app's id or any joined install).
  where app not in (select id from tests)
    and not exists (select 1 from links l where l.app = steps.app and l.install::text in (select id from tests))
  group by 1, 2, 3
  order by 7 desc, 4 desc;
$$;
revoke all on function public.cf_ads_funnel(date, date) from public, anon, authenticated;
grant execute on function public.cf_ads_funnel(date, date) to service_role;
