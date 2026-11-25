-- 2.8 growth plan, rows Б1 and Б2: one install cohort for the funnel reports, without App Review's installs and with
-- a known batch of installs that never were people told apart, and «the ladder» built on it.
--
-- 1. contextflow.install_batches: a window of installs that look like a device farm, not people. One row per batch.
--    An install falls in a batch when the app was first opened inside the window, on one of its platforms and its
--    version, was opened on that one day only, never met an extension install, had no Apple Ads attribution and no
--    purchase. The first row: 2.6.1 on iPhone and iPad while it was the App Store's version and 2.7 was in review;
--    new installs arrived a few minutes apart in rotating languages from one network address a day, opened the app
--    once, put off the notification question and never ran the extension in Safari.
--    A person who downloaded 2.6.1 then and gave up the same day matches the rule too: the report says «batch», not
--    «bot». A new batch is a new row in this table (a production write: the director, after the owner's yes).
-- 2. contextflow.install_cohort(from, to): every app first opened in those days (UTC), the base of every funnel report:
--    our own installs out (test_ids, an install joined to one, test_installs), test builds and dev checks out, and
--    App Review out (the first open on a version while that version was in review, contextflow.in_review_any, as
--    every other report since 20261104120000). Per app: when, platform, version, language (from the app's locale),
--    the test variant (app_open's "variant", 2.8) and the source: apple_ads, batch, organic, unknown.
-- 3. public.cf_install_sources(from, to): the same columns as 20261121120000, on that cohort (it counted App Review's
--    installs and the batch as people), with "batch" as a source of its own.
-- 4. public.cf_ladder(from, to): one table of rungs by dimension (dim, value): all, platform, lang, era (the first
--    open's major.minor), variant, platform+era, all without the batch; and source, with it.
--    Rungs: installs → enabled (the app saw it on, or the extension met the app) → linked (an extension install
--    joined to the app) → panel (Safari's side seen in use) → answer1, answer2 (answers in Safari for a joined install) → returned7 (Safari's side in use on two or more days
--    within the first open's day and the 7 after it) → hit_limit (the free answers' limit refused a request) → paid.
--
-- Nothing is deleted or changed in the events. Reports for service_role only.
--
-- Order: after 20261110180000_contextflow_test_installs.sql (test_ids, test_installs), 20261102150000
-- (subscription_terms) and 20261104120000_contextflow_feature_usage.sql (in_review_any). It defines contextflow.app_links
-- as 20261121120000_contextflow_install_sources.sql does, so it applies with or without that one.

do $$
begin
  if to_regclass('contextflow.test_ids') is null or to_regclass('contextflow.test_installs') is null then
    raise exception 'apply 20261110180000_contextflow_test_installs.sql first';
  end if;
  if to_regprocedure('contextflow.subscription_terms()') is null then
    raise exception 'apply 20261102150000_contextflow_subscription_terms.sql first';
  end if;
  if to_regprocedure('contextflow.in_review_any(text, text, timestamptz)') is null then
    raise exception 'apply 20261104120000_contextflow_feature_usage.sql first';
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

create table if not exists contextflow.install_batches (
  label text primary key,
  platforms text[] not null,
  version text not null,
  from_at timestamptz not null,
  to_at timestamptz not null,
  note text
);
revoke all on contextflow.install_batches from public, anon, authenticated;

insert into contextflow.install_batches (label, platforms, version, from_at, to_at, note)
values ('2026-11 2.6.1 farm', array['ios', 'ipados'], '2.6.1', '2026-11-14 10:31:17+00', '2026-11-22 05:58:20+00',
  '2.6.1 live, 2.7 in review: installs minutes apart, rotating languages, one network address a day, one open, never in Safari')
on conflict (label) do nothing;

create or replace function contextflow.install_cohort(p_from date, p_to date)
returns table (app text, at timestamptz, platform text, version text, lang text, variant text, source text)
language sql stable set search_path = '' as $$
  with tests as (select id from contextflow.test_ids where id is not null),
  opens as (
    select e.data->>'app' as app, e.created_at as at, nullif(e.data->>'platform', '') as platform,
      nullif(e.data->>'version', '') as version, nullif(e.data->>'locale', '') as locale, nullif(e.data->>'variant', '') as variant
    from contextflow.events e
    where e.kind = 'app_open' and e.data ? 'app'
      and e.data->>'app' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and coalesce(e.data->>'audience', '') <> 'test'
      and coalesce(e.data->>'version', '') not in ('dev-check', 'calibrate')
  ),
  first_open as (select distinct on (o.app) o.* from opens o order by o.app, o.at),
  cohort as (
    select f.* from first_open f
    where (f.at at time zone 'utc')::date between p_from and p_to
      and f.app not in (select id from tests)
      and not contextflow.in_review_any(f.platform, f.version, f.at)
      and not exists (
        select 1 from contextflow.app_links l
        where l.app = f.app
          and (l.install::text in (select id from tests) or l.install in (select t.install_id from contextflow.test_installs t))
      )
  ),
  seen as (
    select e.data->>'app' as app,
      bool_or(e.kind = 'ads_attribution') as ad,
      bool_or(e.kind = 'ads_organic') as organic,
      count(distinct (e.created_at at time zone 'utc')::date) filter (where e.kind = 'app_open') as open_days
    from contextflow.events e
    where e.kind in ('ads_attribution', 'ads_organic', 'app_open') and e.data ? 'app'
      and e.data->>'app' in (select c.app from cohort c)
    group by 1
  )
  select c.app, c.at, c.platform, c.version,
    case when c.locale is null then null
      when lower(c.locale) like 'zh%' then lower(c.locale)
      else lower(split_part(c.locale, '-', 1)) end,
    c.variant,
    case
      when coalesce(s.ad, false) then 'apple_ads'
      when coalesce(s.open_days, 1) <= 1
        and exists (
          select 1 from contextflow.install_batches b
          where c.at >= b.from_at and c.at < b.to_at and c.platform = any(b.platforms) and c.version = b.version
        )
        and not exists (select 1 from contextflow.app_links l where l.app = c.app)
        and not exists (select 1 from contextflow.entitlements en where en.app_account_token::text = c.app)
        then 'batch'
      when coalesce(s.organic, false) then 'organic'
      else 'unknown'
    end
  from cohort c
  left join seen s on s.app = c.app;
$$;
revoke all on function contextflow.install_cohort(date, date) from public, anon, authenticated;

-- public.cf_install_sources: App Review out, the batch a source of its own
-- [latest version: 20261121120000_contextflow_install_sources.sql]
create or replace function public.cf_install_sources(p_from date, p_to date)
returns table (
  source text, platform text,
  installs bigint, linked bigint, extension_on bigint, panel_used bigint, first_answer bigint, paid bigint
)
language sql stable security definer set search_path = '' as $$
  with cohort as (select * from contextflow.install_cohort(p_from, p_to)),
  unpaid as (select otid from contextflow.subscription_terms() where paid_from is null),
  links as (
    select l.app, l.install from contextflow.app_links l
    where l.app in (select app from cohort)
  ),
  app_seen as (
    select e.data->>'app' as app,
      bool_or((e.kind = 'app_open' and e.data->>'extension' in ('on', 'in_use'))
        or (e.kind = 'use' and e.data->>'f' = 'activation' and e.data->>'a' = 'enabled')) as saw_on,
      bool_or(e.kind = 'app_open' and e.data->>'extension' = 'in_use') as saw_in_use
    from contextflow.events e
    where e.data ? 'app' and e.kind in ('app_open', 'use')
      and e.data->>'app' in (select app from cohort)
    group by 1
  ),
  steps as (
    select c.app, c.platform, c.source,
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
  )
  select source, coalesce(platform, 'unknown') as platform,
    count(*) as installs, count(*) filter (where linked) as linked, count(*) filter (where on_) as extension_on,
    count(*) filter (where panel) as panel_used, count(*) filter (where answered) as first_answer,
    count(*) filter (where paid) as paid
  from steps
  group by 1, 2
  order by 1, 2;
$$;
revoke all on function public.cf_install_sources(date, date) from public, anon, authenticated;
grant execute on function public.cf_install_sources(date, date) to service_role;

create or replace function public.cf_ladder(p_from date, p_to date)
returns table (
  dim text, value text,
  installs bigint, enabled bigint, linked bigint, panel bigint, answer1 bigint, answer2 bigint,
  returned7 bigint, hit_limit bigint, paid bigint
)
language sql stable security definer set search_path = '' as $$
  with cohort as (select * from contextflow.install_cohort(p_from, p_to)),
  unpaid as (select otid from contextflow.subscription_terms() where paid_from is null),
  links as (
    select l.app, l.install from contextflow.app_links l
    where l.app in (select app from cohort)
  ),
  app_seen as (
    select e.data->>'app' as app,
      bool_or((e.kind = 'app_open' and e.data->>'extension' in ('on', 'in_use'))
        or (e.kind = 'use' and e.data->>'f' = 'activation' and e.data->>'a' in ('enabled', 'linked'))) as saw_on,
      bool_or(e.kind = 'app_open' and e.data->>'extension' = 'in_use') as saw_in_use
    from contextflow.events e
    where e.data ? 'app' and e.kind in ('app_open', 'use')
      and e.data->>'app' in (select app from cohort)
    group by 1
  ),
  answers as (
    select l.app, count(*) as n
    from links l join contextflow.events ch on ch.install_id = l.install
    where ch.kind = 'chat' and coalesce(ch.data->>'ok', 'true') <> 'false'
    group by 1
  ),
  active as (
    select c.app, count(distinct d.day) as days_7
    from cohort c
    join links l on l.app = c.app
    join contextflow.install_days d on d.install_id = l.install
    where d.day between (c.at at time zone 'utc')::date and (c.at at time zone 'utc')::date + 7
    group by 1
  ),
  used as (select distinct l.app from links l join contextflow.install_days d on d.install_id = l.install),
  limited as (
    select distinct l.app from links l join contextflow.events x on x.install_id = l.install
    where x.kind = 'limit' and coalesce(x.data->>'reason', 'limit') = 'limit'
  ),
  steps as (
    select c.app,
      coalesce(c.platform, 'unknown') as platform,
      coalesce(c.lang, 'unknown') as lang,
      coalesce(substring(c.version from '^[0-9]+\.[0-9]+'), 'unknown') as era,
      c.source,
      coalesce(c.variant, 'none') as variant,
      exists (select 1 from links l where l.app = c.app) as linked,
      exists (select 1 from links l where l.app = c.app) or coalesce(s.saw_on, false) as enabled,
      c.app in (select app from used) or coalesce(s.saw_in_use, false) as panel,
      coalesce(a.n, 0) as answers,
      coalesce(ac.days_7, 0) >= 2 as returned7,
      c.app in (select app from limited) as hit_limit,
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
    left join answers a on a.app = c.app
    left join active ac on ac.app = c.app
  ),
  counted as (
    select *, enabled as on_ from steps
  ),
  -- Every dimension without the batch, but the sources themselves, which show it.
  grouped as (
    select
      case
        when grouping(platform, lang, era, variant) = 15 then 'all'
        when grouping(platform) = 0 and grouping(era) = 0 then 'platform+era'
        when grouping(platform) = 0 then 'platform'
        when grouping(lang) = 0 then 'lang'
        when grouping(era) = 0 then 'era'
        else 'variant'
      end as dim,
      case
        when grouping(platform, lang, era, variant) = 15 then 'all'
        when grouping(platform) = 0 and grouping(era) = 0 then platform || ' ' || era
        when grouping(platform) = 0 then platform
        when grouping(lang) = 0 then lang
        when grouping(era) = 0 then era
        else variant
      end as value,
      count(*) as installs, count(*) filter (where on_) as enabled, count(*) filter (where linked) as linked,
      count(*) filter (where panel) as panel, count(*) filter (where answers >= 1) as answer1,
      count(*) filter (where answers >= 2) as answer2, count(*) filter (where returned7) as returned7,
      count(*) filter (where hit_limit) as hit_limit, count(*) filter (where paid) as paid
    from counted
    where source <> 'batch'
    group by grouping sets ((), (platform), (lang), (era), (variant), (platform, era))
    union all
    select 'source', source,
      count(*), count(*) filter (where on_), count(*) filter (where linked),
      count(*) filter (where panel), count(*) filter (where answers >= 1),
      count(*) filter (where answers >= 2), count(*) filter (where returned7),
      count(*) filter (where hit_limit), count(*) filter (where paid)
    from counted
    group by source
  )
  select * from grouped
  order by array_position(array['all', 'platform', 'era', 'platform+era', 'source', 'lang', 'variant'], dim), installs desc, value;
$$;
revoke all on function public.cf_ladder(date, date) from public, anon, authenticated;
grant execute on function public.cf_ladder(date, date) to service_role;
