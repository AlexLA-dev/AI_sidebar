-- Our own test installs marked at the source (contextflow.installs.is_test, with why), set from now on by triggers,
-- and left out of every report through one place: the views contextflow.test_installs and contextflow.test_ids.
-- Before this, each report had its own copy of the test filter (some without "calibrate", some without our own
-- subscriptions, cf_ads_funnel without any).
--
-- Order: apply after 20261108140000_contextflow_ultra_report.sql and 20261109120000_contextflow_memory_window.sql (and
-- 20261110120000_contextflow_mrr_retention.sql). Its cf_ultra_report and cf_limits_report are those migrations' latest
-- definitions with only the test filter replaced; the guard below stops it if either isn't applied yet, so a later
-- run of one of them can't drop the shared filter again. Every function it creates or replaces gets its grants set
-- here (reports: service_role only), so it's safe in any state of the database it accepts.
--
-- What the backfill touches: contextflow.installs only. Every row it changes, or adds for an install that has events
-- but no installs row yet, gets is_test = true, test_reason, test_since = now(); nothing else changes and nothing is
-- deleted. In this order, the first rule that fits gives the reason:
--   own      installs in contextflow.own_subscriptions (ours, by subscription)
--   version  version dev-check or calibrate: in an event, an install_days row, or installs.app_version (our scripts)
--   preview  an event marked audience test with a deploy context (deploy previews, branch deploys, netlify dev)
--   audience an event marked audience test (debug and TestFlight builds)
--   burst    first seen within 10 minutes of 3+ installs already marked, same platform and version, active on one
--            day only, at most one answer, never a paid plan (automation that didn't mark itself)
-- From now on the triggers below mark an install the moment such an event, install_days row or own subscription
-- arrives (the server already marks deploy previews and dev-check, and the apps mark debug and TestFlight builds).

do $guard$
begin
  if to_regprocedure('public.cf_ultra_report(integer)') is null then
    raise exception 'apply 20261108140000_contextflow_ultra_report.sql first: public.cf_ultra_report(integer) is missing';
  end if;
  if not exists (
    select 1 from pg_proc where oid = to_regprocedure('public.cf_limits_report(integer)') and prosrc like '%case when a.flagged then a.data->>''history_cut''%'
  ) then
    raise exception 'apply 20261109120000_contextflow_memory_window.sql first: cf_limits_report is not its build 92 version';
  end if;
  if to_regprocedure('public.cf_retention(integer)') is null then
    raise exception 'apply 20261110120000_contextflow_mrr_retention.sql first: public.cf_retention(integer) is missing';
  end if;
end
$guard$;

alter table contextflow.installs
  add column if not exists is_test boolean not null default false,
  add column if not exists test_reason text,
  add column if not exists test_since timestamptz;

-- Marks one install as ours (adding its row if it has none); the first reason stays.
create or replace function contextflow.mark_test_install(p_install uuid, p_reason text)
returns void language sql security definer set search_path = '' as $$
  insert into contextflow.installs as i (install_id, is_test, test_reason, test_since)
  values (p_install, true, p_reason, now())
  on conflict (install_id) do update set is_test = true,
    test_reason = coalesce(i.test_reason, excluded.test_reason),
    test_since = coalesce(i.test_since, excluded.test_since)
  where not i.is_test;
$$;
revoke all on function contextflow.mark_test_install(uuid, text) from public, anon, authenticated;

-- The shared filter. test_installs: every install of ours, with why. test_ids: the same as text, plus the ids of
-- ContextFlow apps that were ours (their events marked, or their extension install ours), for reports that count
-- an app before its extension.
create or replace view contextflow.test_installs as
  select install_id, coalesce(test_reason, 'test') as reason from contextflow.installs where is_test
  union
  select o.install_id, 'own' from contextflow.own_subscriptions o
  where o.install_id is not null
    and not exists (select 1 from contextflow.installs i where i.install_id = o.install_id and i.is_test);
revoke all on contextflow.test_installs from public, anon, authenticated;

create or replace view contextflow.test_ids as
  select install_id::text as id from contextflow.test_installs
  union
  select data->>'app' from contextflow.events
  where data ? 'app' and (data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate'))
  union
  select o.data->>'app' from contextflow.events o
  join contextflow.test_installs t on t.install_id = o.install_id
  where o.kind = 'app_open' and o.data ? 'app';
revoke all on contextflow.test_ids from public, anon, authenticated;

-- Backfill, rule by rule (each marks only installs not marked yet).
select contextflow.mark_test_install(x.install_id, 'own')
from (select distinct install_id from contextflow.own_subscriptions where install_id is not null) x;

select contextflow.mark_test_install(x.install_id, 'version')
from (
  select install_id from contextflow.events where install_id is not null and data->>'version' in ('dev-check', 'calibrate')
  union
  select install_id from contextflow.install_days where version in ('dev-check', 'calibrate')
  union
  select install_id from contextflow.installs where app_version in ('dev-check', 'calibrate')
) x;

select contextflow.mark_test_install(x.install_id, 'preview')
from (select distinct install_id from contextflow.events where install_id is not null and data->>'audience' = 'test' and data ? 'deploy') x;

select contextflow.mark_test_install(x.install_id, 'audience')
from (select distinct install_id from contextflow.events where install_id is not null and data->>'audience' = 'test') x;

with firsts as (
  select distinct on (install_id) install_id, platform, version, first_at
  from contextflow.install_days
  order by install_id, day, first_at
)
select contextflow.mark_test_install(f.install_id, 'burst')
from firsts f
where not exists (select 1 from contextflow.installs i where i.install_id = f.install_id and i.is_test)
  and (select count(*) from firsts g join contextflow.installs i on i.install_id = g.install_id and i.is_test
       where g.platform is not distinct from f.platform and g.version is not distinct from f.version
         and g.first_at between f.first_at - interval '10 minutes' and f.first_at + interval '10 minutes') >= 3
  and (select count(distinct d.day) from contextflow.install_days d where d.install_id = f.install_id) = 1
  and (select count(*) from contextflow.events c where c.install_id = f.install_id and c.kind = 'chat') <= 1
  and not exists (
    select 1 from contextflow.events c
    where c.install_id = f.install_id and c.kind = 'chat' and c.data->>'plan' in ('pro', 'byok', 'ultra')
  );

-- From now on.
create or replace function contextflow.events_mark_test()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform contextflow.mark_test_install(new.install_id,
    case when new.data->>'version' in ('dev-check', 'calibrate') then 'version'
         when new.data ? 'deploy' then 'preview'
         else 'audience' end);
  return null;
end $$;
drop trigger if exists events_mark_test on contextflow.events;
create trigger events_mark_test after insert on contextflow.events
  for each row when (new.install_id is not null
    and (new.data->>'audience' = 'test' or new.data->>'version' in ('dev-check', 'calibrate')))
  execute function contextflow.events_mark_test();

create or replace function contextflow.install_days_mark_test()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform contextflow.mark_test_install(new.install_id, 'version');
  return null;
end $$;
drop trigger if exists install_days_mark_test on contextflow.install_days;
create trigger install_days_mark_test after insert or update of version on contextflow.install_days
  for each row when (new.version in ('dev-check', 'calibrate'))
  execute function contextflow.install_days_mark_test();

create or replace function contextflow.installs_mark_test()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not new.is_test then
    new.is_test := true;
    new.test_reason := coalesce(new.test_reason, 'version');
    new.test_since := coalesce(new.test_since, now());
  end if;
  return new;
end $$;
drop trigger if exists installs_mark_test on contextflow.installs;
create trigger installs_mark_test before insert or update of app_version on contextflow.installs
  for each row when (new.app_version in ('dev-check', 'calibrate'))
  execute function contextflow.installs_mark_test();

create or replace function contextflow.own_subscriptions_mark_test()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform contextflow.mark_test_install(new.install_id, 'own');
  return null;
end $$;
drop trigger if exists own_subscriptions_mark_test on contextflow.own_subscriptions;
create trigger own_subscriptions_mark_test after insert or update of install_id on contextflow.own_subscriptions
  for each row when (new.install_id is not null)
  execute function contextflow.own_subscriptions_mark_test();

revoke all on function contextflow.events_mark_test() from public, anon, authenticated;
revoke all on function contextflow.install_days_mark_test() from public, anon, authenticated;
revoke all on function contextflow.installs_mark_test() from public, anon, authenticated;
revoke all on function contextflow.own_subscriptions_mark_test() from public, anon, authenticated;

-- Every report below is its latest version with only its test filter replaced by contextflow.test_installs (or
-- test_ids); cf_usage_report also counts the marked installs (test_installs, by why) for the page's «без тестов».

-- public.cf_usage_report: our test installs from contextflow.test_installs [latest version: 20261102150000_contextflow_subscription_terms.sql]
create or replace function public.cf_usage_report(p_days integer default 30)
returns jsonb language sql security definer set search_path = '' stable as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (select install_id from contextflow.test_installs),
  ev as (
    select
      (e.created_at at time zone 'utc')::date as day,
      e.install_id,
      e.kind,
      e.data,
      coalesce(e.data->>'key', 'ours') as key,
      -- Errors logged before mode/provider were recorded start with the model name ("gemini-…: 429 …").
      case when e.data->>'mode' = 'google' or e.data->>'message' like 'gemini%' then 'google' else 'ai' end as segment,
      coalesce(
        e.data->>'provider',
        case when e.data->>'model' like 'gemini%' or e.data->>'message' like 'gemini%' then 'gemini'
             when e.data->>'model' like 'claude%' then 'anthropic'
             else 'openai' end
      ) as provider,
      coalesce(e.data->>'model', 'unknown') as model,
      -- Own-key reports come from the device and carry no plan.
      coalesce(e.data->>'plan', case when e.data->>'key' = 'own' then 'own_key' else 'unknown' end) as plan,
      coalesce(nullif(e.data->>'prompt_tokens', '')::bigint, 0) as prompt_tokens,
      coalesce(nullif(e.data->>'completion_tokens', '')::bigint, 0) as completion_tokens,
      coalesce(nullif(e.data->>'search_queries', '')::bigint, 0) as search_queries,
      nullif(e.data->>'ms', '')::bigint as ms,
      coalesce(e.data->>'ok', 'true') <> 'false' as ok,
      case e.data->>'platform' when 'ios' then 'iPhone' when 'ipados' then 'iPad' when 'macos' then 'Mac'
                               when 'chrome' then 'Chrome' else 'unknown' end as device,
      case
        when e.data->>'audience' = 'test' or e.data->>'version' in ('dev-check', 'calibrate')
          or e.install_id in (select install_id from tests) then 'test'
        when contextflow.in_review(e.data->>'platform', e.data->>'version', e.created_at) then 'review'
        else 'real'
      end as audience,
      e.data->>'version' as version
    from contextflow.events e, d
    where e.created_at >= now() - make_interval(days => d.days)
      and e.kind in ('chat', 'limit', 'upstream_error')
  ),
  all_chats as (select * from ev where kind = 'chat'),
  chats as (select * from all_chats where audience = 'real'),
  real_ev as (select * from ev where audience = 'real'),
  -- Our own test devices, left out of the user counts entirely.
  test_installs as (select install_id from tests),
  first_days as (select install_id, min(day) as day from contextflow.install_days group by install_id),
  user_days as (
    select u.day, u.install_id, u.day = f.day as is_new
    from contextflow.install_days u
    join first_days f on f.install_id = u.install_id
    cross join d
    where u.day > d.today - d.days
      and coalesce(u.version, '') <> 'dev-check'
      and u.install_id not in (select install_id from test_installs)
      and not contextflow.in_review(u.platform, u.version, u.first_at)
  ),
  asked as (select distinct day, install_id from chats),
  subs as (
    select s.product_id, s.created_at, s.expires_at, t.terms, t.offer_id, t.paid_from, t.price, t.currency, t.estimated,
      case
        when s.revoked_at is not null then 'refunded'
        when s.last_notification like 'DID_FAIL_TO_RENEW%' then 'billing_retry'
        when s.expires_at is not null and s.expires_at < now() then 'expired'
        when s.last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED' then 'renewal_off'
        when s.last_notification = 'DID_CHANGE_RENEWAL_PREF:DOWNGRADE' then 'downgrade'
        else 'active'
      end as status,
      -- Everything App Store told us about this subscription (an upgrade keeps the original transaction).
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'at', e.created_at, 'type', e.data->>'type', 'subtype', e.data->>'subtype', 'product', e.data->>'product'
        ) order by e.created_at), '[]'::jsonb)
        from contextflow.events e
        where e.kind = 'appstore_notification' and e.data->>'otid' = s.original_transaction_id
      ) as history
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production'
  ),
  subs_x as (
    select *, (select count(distinct h->>'product') from jsonb_array_elements(history) h) > 1 as switched from subs
  )
  select jsonb_build_object(
    'days', (select days from d),
    'generated_at', now(),
    'users', (
      select jsonb_build_object(
        'active', count(distinct u.install_id),
        'new', count(distinct u.install_id) filter (where u.is_new),
        'active_today', count(*) filter (where u.day = d.today),
        'new_today', count(*) filter (where u.day = d.today and u.is_new),
        'asked', (select count(distinct install_id) from asked),
        'by_day', (
          select coalesce(jsonb_agg(row_to_json(s) order by s.day), '[]'::jsonb) from (
            select x.day,
              count(*) as active,
              count(*) filter (where x.is_new) as new,
              count(*) filter (where exists (select 1 from asked a where a.day = x.day and a.install_id = x.install_id)) as asked
            from user_days x group by x.day
          ) s
        )
      )
      from user_days u, d
    ),
    -- App Store subscriptions in production (App Review buys in the sandbox).
    'subscriptions', jsonb_build_object(
      'by_product', (
        select coalesce(jsonb_agg(row_to_json(s) order by s.product_id), '[]'::jsonb) from (
          select product_id,
            count(*) filter (where status in ('active', 'renewal_off', 'billing_retry', 'downgrade')) as active,
            count(*) filter (where status = 'renewal_off') as renewal_off,
            count(*) filter (where status = 'billing_retry') as billing_retry,
            count(*) filter (where status = 'expired') as expired,
            count(*) filter (where status = 'refunded') as refunded,
            count(*) filter (where switched) as switched,
            count(*) filter (where paid_from >= now() - make_interval(days => (select days from d))) as new
          from subs_x where paid_from is not null group by product_id
        ) s
      ),
      'list', (
        select coalesce(jsonb_agg(row_to_json(s) order by s.created_at desc), '[]'::jsonb) from (
          select product_id, created_at, expires_at, status, switched, history, terms, offer_id, paid_from, price, currency, estimated
          from subs_x order by created_at desc limit 200
        ) s
      ),
      -- Free ones nobody pays for (yet), by how they were taken; not in the counts above.
      'free', (
        select coalesce(jsonb_object_agg(terms, n), '{}'::jsonb) from (
          select terms, count(*) as n from subs_x
          where paid_from is null and status in ('active', 'renewal_off', 'billing_retry', 'downgrade')
          group by terms
        ) f
      ),
      'sandbox', (select count(*) from contextflow.entitlements where environment <> 'Production')
    ),
    'by_plan', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.requests desc), '[]'::jsonb) from (
        select p.plan, sum(p.n) as requests, count(distinct p.install_id) as installs, max(p.n) as max_per_day
        from (select plan, install_id, day, count(*) as n from chats group by plan, install_id, day) p
        group by p.plan
      ) s
    ),
    'segments', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.key desc, s.segment), '[]'::jsonb) from (
        select key, segment,
          count(*) as requests,
          count(*) filter (where not ok) as failed,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries,
          round(avg(ms)) as avg_ms
        from chats group by key, segment
      ) s
    ),
    'by_day', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.day, s.key desc, s.segment), '[]'::jsonb) from (
        select day, key, segment,
          count(*) as requests,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries
        from chats group by day, key, segment
      ) s
    ),
    'by_device', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.requests desc), '[]'::jsonb) from (
        select device, key, segment,
          count(*) as requests,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries
        from chats group by device, key, segment
      ) s
    ),
    -- Owner / App Review traffic while a version was in review, by device and version.
    'review', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.device, s.version, s.segment), '[]'::jsonb) from (
        select device, version, key, segment,
          count(*) as requests,
          count(distinct install_id) as installs,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries,
          min(day) as first_day,
          max(day) as last_day
        from all_chats where audience = 'review' group by device, version, key, segment
      ) s
    ),
    'excluded_tests', (select count(*) from ev where audience = 'test'),
    -- Our test installs left out of every report (contextflow.test_installs), by why.
    'test_installs', (select jsonb_object_agg(reason, n) from (select reason, count(*) as n from contextflow.test_installs group by reason) r),
    'by_model', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.requests desc), '[]'::jsonb) from (
        select key, segment, provider, model,
          count(*) as requests,
          count(*) filter (where not ok) as failed,
          sum(prompt_tokens) as prompt_tokens,
          sum(completion_tokens) as completion_tokens,
          sum(search_queries) as search_queries,
          round(avg(ms)) as avg_ms
        from chats group by key, segment, provider, model
      ) s
    ),
    'limits', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.hits desc), '[]'::jsonb) from (
        select segment, coalesce(data->>'reason', 'limit') as reason, plan, count(*) as hits
        from real_ev where kind = 'limit' group by 1, 2, 3
      ) s
    ),
    'upstream_errors', (
      select coalesce(jsonb_agg(row_to_json(s) order by s.errors desc), '[]'::jsonb) from (
        select segment, provider, count(*) as errors
        from real_ev where kind = 'upstream_error' group by 1, 2
      ) s
    )
  );
$$;
revoke all on function public.cf_usage_report(integer) from public, anon, authenticated;
grant execute on function public.cf_usage_report(integer) to service_role;

-- public.cf_owner_insights: our test installs from contextflow.test_installs [latest version: 20261108120000_contextflow_ultra.sql]
create or replace function public.cf_owner_insights(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  -- Our own test devices, left out entirely.
  tests as (select install_id from contextflow.test_installs),
  -- The moment each install was first seen (panel opened or a question asked).
  first_seen as (
    select distinct on (install_id) install_id, first_at, platform, version
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, s.created_at, s.expires_at, s.revoked_at, s.app_account_token,
      s.last_notification, t.terms, t.offer_id, t.paid_from, t.price, t.currency, t.estimated,
      t.terms in ('trial', 'free_code', 'press', 'owner') as free_start
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production'
  ),
  -- Links 1 and 2.
  known as (
    select data->>'otid' as otid, install_id from contextflow.events
    where kind = 'chat' and install_id is not null and data->>'otid' is not null
    union
    select s.otid, i.install_id from subs s join contextflow.installs i on i.install_id = s.app_account_token
    union
    select s.otid, o.install_id from subs s
    join contextflow.events o on o.kind = 'app_open' and o.install_id is not null and o.data->>'app' = s.app_account_token::text
    union
    -- Our own subscriptions name their device.
    select o.otid, o.install_id from contextflow.own_subscriptions o where o.install_id is not null
  ),
  -- Link 3: each install's first paid answer from before answers carried the otid. App Review windows are
  -- not left out here: these are production purchases, and a window closed late would hide a subscriber.
  paid as (
    select e.install_id, min(e.created_at) as first_at
    from contextflow.events e
    where e.kind = 'chat' and e.install_id is not null and e.data->>'plan' in ('pro', 'byok', 'ultra') and e.data->>'otid' is null
      and coalesce(e.data->>'audience', '') <> 'test' and coalesce(e.data->>'version', '') <> 'dev-check'
    group by e.install_id
  ),
  -- The server records a subscription before the first answer it pays for, so that answer comes after it.
  candidates as (
    select s.otid, p.install_id, p.first_at - s.created_at as gap
    from subs s
    join paid p on p.first_at >= s.created_at and p.first_at < s.created_at + interval '1 day'
    where not exists (select 1 from known k where k.otid = s.otid)
      and not exists (select 1 from known k where k.install_id = p.install_id)
  ),
  links as (
    select k.otid, k.install_id, true as exact from known k
    union all
    select c.otid, c.install_id, false from candidates c
    where c.gap = (select min(x.gap) from candidates x where x.otid = c.otid)
      and c.gap = (select min(x.gap) from candidates x where x.install_id = c.install_id)
  ),
  converted as (
    select l.install_id, min(s.paid_from) as at from links l join subs s on s.otid = l.otid
    where s.paid_from is not null group by l.install_id
  ),
  -- Apple Ads: the first attribution of each app, tied to the extension's install through 'app_open'.
  ads as (
    select distinct on (e.data->>'app')
      e.data->>'app' as app,
      e.created_at,
      coalesce(e.install_id, (
        select o.install_id from contextflow.events o
        where o.kind = 'app_open' and o.data->>'app' = e.data->>'app' and o.install_id is not null
        order by o.created_at limit 1
      )) as install_id,
      nullif(e.data->>'campaignId', '')::bigint as campaign_id,
      nullif(e.data->>'adGroupId', '')::bigint as ad_group_id,
      nullif(e.data->>'keywordId', '')::bigint as keyword_id,
      e.data->>'countryOrRegion' as country
    from contextflow.events e
    -- Development and TestFlight builds get Apple's sample record (campaign 1234567890), not an ad.
    where e.kind = 'ads_attribution' and e.data ? 'app' and coalesce(e.data->>'campaignId', '') <> '1234567890'
    order by e.data->>'app', e.created_at
  ),
  -- Installs that opened the ContextFlow app (2.4+): the app asks Apple Ads about every download, so
  -- for these no attribution means the download didn't come from an ad.
  app_installs as (
    select distinct install_id from contextflow.events where kind = 'app_open' and install_id is not null
  ),
  -- New users of the period: installs first seen in it, without tests and App Review.
  cohort as (
    select f.install_id, f.first_at
    from first_seen f, d
    where (f.first_at at time zone 'utc')::date > d.today - d.days
      and coalesce(f.version, '') <> 'dev-check'
      and not exists (select 1 from tests t where t.install_id = f.install_id)
      and not contextflow.in_review(f.platform, f.version, f.first_at)
  ),
  -- Real users' questions in the period, the same ones as in cf_usage_report.
  chats as (
    select x.day, x.install_id, x.paid and not x.gift as paid, x.gift
    from (
      select (e.created_at at time zone 'utc')::date as day, e.install_id,
        coalesce(e.data->>'plan', '') in ('pro', 'byok', 'ultra') or e.data->>'key' = 'own' as paid,
        -- Pro on a free start (trial, gift code, ours) before anyone paid for it.
        exists (
          select 1 from subs s
          where s.otid = e.data->>'otid' and s.free_start and (s.paid_from is null or e.created_at < s.paid_from)
        ) as gift
      from contextflow.events e, d
    where e.kind = 'chat' and e.created_at >= now() - make_interval(days => d.days)
      and coalesce(e.data->>'audience', '') <> 'test' and coalesce(e.data->>'version', '') <> 'dev-check'
      and not contextflow.in_review(e.data->>'platform', e.data->>'version', e.created_at)
    ) x
  ),
  user_days as (
    select u.day, u.install_id
    from contextflow.install_days u, d
    where u.day > d.today - d.days
      and coalesce(u.version, '') <> 'dev-check'
      and not exists (select 1 from tests t where t.install_id = u.install_id)
      and not contextflow.in_review(u.platform, u.version, u.first_at)
  ),
  asked as (select day, install_id, count(*) as n, bool_or(paid) as paid, bool_or(gift) as gift from chats group by day, install_id),
  -- Each active user's day as free, paying or free Pro: such an answer that day, or such a subscription active then.
  plan_days as (
    select u.day, u.install_id, coalesce(a.n, 0) as n,
      coalesce(a.paid, false) or exists (
        select 1 from links l join subs s on s.otid = l.otid
        where l.install_id = u.install_id
          and u.day between (s.paid_from at time zone 'utc')::date
                        and coalesce((least(s.expires_at, s.revoked_at) at time zone 'utc')::date, u.day)
      ) as paid,
      coalesce(a.gift, false) or exists (
        select 1 from links l join subs s on s.otid = l.otid
        where l.install_id = u.install_id and s.free_start
          and u.day between (s.created_at at time zone 'utc')::date
                        and coalesce((least(s.paid_from, s.expires_at, s.revoked_at) at time zone 'utc')::date, u.day)
      ) as gift
    from user_days u
    left join asked a on a.day = u.day and a.install_id = u.install_id
  ),
  -- MRR at the end of each week (now for this one): every subscription active then, at the price of its transaction
  -- in effect, the latest Apple told us of by then, else its first one, else the estimate (subscription_terms).
  -- A yearly plan counts a twelfth; ours count as free. Amounts in milliunits of each currency.
  priced as (
    select n.data->>'otid' as otid, n.created_at as at, (n.data->>'price')::numeric as price, n.data->>'currency' as currency
    from contextflow.events n
    where n.kind = 'appstore_notification' and n.data ? 'otid' and n.data->>'price' is not null
  ),
  points as (
    select w::date as week, least((w + interval '7 days') at time zone 'utc', now()) as at, w = date_trunc('week', d.today::timestamp) as current
    from d, generate_series(date_trunc('week', (d.today - (d.days - 1))::timestamp), date_trunc('week', d.today::timestamp), interval '7 days') w
  ),
  mrr_subs as (
    select p.week, p.current, s.renewal_off,
      coalesce(x.currency, y.currency, s.currency) as currency,
      case when s.terms = 'owner' then 0
           else coalesce(x.price, y.price, s.price) / case when s.product_id like '%yearly%' then 12 else 1 end end as monthly,
      x.price is null and y.price is null and s.estimated as estimated
    from points p
    join (
      select *, last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED' as renewal_off from subs
    ) s on s.created_at <= p.at and coalesce(least(s.expires_at, s.revoked_at), 'infinity') > p.at
    left join lateral (select r.price, r.currency from priced r where r.otid = s.otid and r.at <= p.at order by r.at desc limit 1) x on true
    left join lateral (select r.price, r.currency from priced r where r.otid = s.otid order by r.at limit 1) y on true
  )
  select jsonb_build_object(
    'days', (select days from d),
    'subscribers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'created_at', s.created_at,
        'product_id', s.product_id,
        'terms', s.terms,
        'offer_id', s.offer_id,
        'paid_from', s.paid_from,
        'storefront', (
          select n.data->>'storefront' from contextflow.events n
          where n.kind = 'appstore_notification' and n.data->>'otid' = s.otid and n.data->>'storefront' is not null
          order by n.created_at desc limit 1
        ),
        'link', case when x.installs is null then null when x.exact then 'exact' else 'time' end,
        'installs', coalesce(x.installs, '[]'::jsonb),
        'ads', (
          select jsonb_build_object('campaign_id', a.campaign_id, 'ad_group_id', a.ad_group_id, 'keyword_id', a.keyword_id, 'country', a.country)
          from ads a
          where a.app = s.app_account_token::text or a.install_id in (select l.install_id from links l where l.otid = s.otid)
          order by a.created_at limit 1
        ),
        'app', exists (
          select 1 from contextflow.events o
          where o.kind = 'app_open'
            and (o.data->>'app' = s.app_account_token::text or o.install_id in (select l.install_id from links l where l.otid = s.otid))
        )
      ) order by s.created_at desc), '[]'::jsonb)
      from (select * from subs order by created_at desc limit 200) s
      left join lateral (
        select bool_and(l.exact) as exact,
          jsonb_agg(jsonb_build_object('platform', i.platform, 'locale', i.locale, 'first_seen', f.first_at) order by f.first_at) as installs
        from links l
        left join contextflow.installs i on i.install_id = l.install_id
        left join first_seen f on f.install_id = l.install_id
        where l.otid = s.otid
      ) x on true
    ),
    -- Questions per UTC day from installs first seen that same day vs everyone else.
    'requests_by_age', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.day), '[]'::jsonb) from (
        select c.day,
          count(*) filter (where c.day = (f.first_at at time zone 'utc')::date) as new,
          count(*) filter (where f.first_at is null or c.day <> (f.first_at at time zone 'utc')::date) as old
        from chats c
        left join first_seen f on f.install_id = c.install_id
        group by c.day
      ) x
    ),
    -- New users by the UTC day they were first seen, and how many of them subscribed: so far, and within
    -- 7 / 30 days among those first seen at least 7 / 30 days ago.
    'cohorts', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.day), '[]'::jsonb) from (
        select (c.first_at at time zone 'utc')::date as day,
          count(*) as users,
          count(v.at) as subscribed,
          count(*) filter (where c.first_at <= now() - interval '7 days') as ready_7,
          count(*) filter (where c.first_at <= now() - interval '7 days' and v.at < c.first_at + interval '7 days') as in_7,
          count(*) filter (where c.first_at <= now() - interval '30 days') as ready_30,
          count(*) filter (where c.first_at <= now() - interval '30 days' and v.at < c.first_at + interval '30 days') as in_30
        from cohort c
        left join converted v on v.install_id = c.install_id
        group by 1
      ) x
    ),
    'per_user', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.plan), '[]'::jsonb) from (
        select case when paid then 'paid' when gift then 'gift' else 'free' end as plan,
          count(distinct install_id) as users,
          count(*) as user_days,
          count(*) filter (where n > 0) as asked_days,
          sum(n) as requests,
          max(n) as max_per_day
        from plan_days
        group by 1
      ) x
    ),
    -- Per week and currency: paying subscriptions and what they pay a month; free ones; auto-renew off (this week).
    'mrr', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.week, x.currency), '[]'::jsonb) from (
        select week, currency,
          count(*) filter (where monthly > 0) as paying,
          coalesce(sum(monthly) filter (where monthly > 0), 0) as amount,
          count(*) filter (where monthly > 0 and estimated) as estimated,
          count(*) filter (where monthly = 0) as free,
          count(*) filter (where current and monthly > 0 and renewal_off) as renewal_off,
          coalesce(sum(monthly) filter (where current and monthly > 0 and renewal_off), 0) as renewal_off_amount
        from mrr_subs
        group by week, currency
      ) x
    ),
    'sources', jsonb_build_object(
      'new_users', (select count(*) from cohort),
      'apple_ads', (select count(*) from cohort c where exists (select 1 from ads a where a.install_id = c.install_id)),
      'not_ads', (
        select count(*) from cohort c
        where exists (select 1 from app_installs p where p.install_id = c.install_id)
          and not exists (select 1 from ads a where a.install_id = c.install_id)
      ),
      'campaigns', (
        select coalesce(jsonb_agg(row_to_json(x) order by x.apps desc), '[]'::jsonb) from (
          select a.campaign_id, a.ad_group_id, a.keyword_id,
            count(*) as apps,
            count(a.install_id) as users,
            count(*) filter (where exists (select 1 from converted v where v.install_id = a.install_id)
                                or exists (select 1 from subs s where s.app_account_token::text = a.app and s.paid_from is not null)) as subscribed
          from ads a, d
          where (a.created_at at time zone 'utc')::date > d.today - d.days
          group by 1, 2, 3
        ) x
      ),
      'app_store_connect', (
        select coalesce(jsonb_agg(row_to_json(x) order by x.day_from desc, x.downloads desc), '[]'::jsonb) from (
          select day_from, day_to, source, detail, impressions, page_views, downloads
          from contextflow.asc_sources
          order by day_from desc
          limit 200
        ) x
      )
    )
  );
$$;
revoke all on function public.cf_owner_insights(integer) from public, anon, authenticated;
grant execute on function public.cf_owner_insights(integer) to service_role;

-- public.cf_limits_report: our test installs from contextflow.test_installs [latest version: 20261109120000_contextflow_memory_window.sql]
create or replace function public.cf_limits_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 28), 180)) as days
  ),
  -- Our own test devices and installs, left out.
  tests as (select install_id from contextflow.test_installs),
  ev as (
    select e.created_at, (e.created_at at time zone 'utc')::date as day, e.kind, e.install_id, e.data
    from contextflow.events e, d
    where e.kind in ('chat', 'limit')
      and e.created_at >= now() - make_interval(days => d.days)
      and e.install_id is not null
      and not exists (select 1 from tests t where t.install_id = e.install_id)
  ),
  answers as (
    select created_at, day, install_id, data,
      case when data->>'plan' in ('pro', 'ultra') then 'pro' else 'free' end as grp,
      coalesce(data->>'mode', 'chat') as mode,
      data->>'limits_v' is not null as flagged,
      coalesce((data->>'history')::int, 0) as history,
      (data->>'chat_turns')::int as chat_turns,
      (data->>'chat_pages')::int as chat_pages,
      (data->>'chats')::int as chats,
      coalesce((data->>'other_pages')::int, 0) as other_pages,
      coalesce((data->>'page_chars')::int, 0) as page_chars,
      coalesce(data->>'whole_chat' = 'true', false) as whole_chat
    from ev
    where kind = 'chat' and coalesce(data->>'ok', 'true') = 'true'
  ),
  -- Which answers each limit could touch (base) and which it did (hit).
  touched as (
    select 'page_cut' as key, a.*, a.data->>'page' in ('page', 'selection') as base,
      case when a.flagged then a.data->>'page_cut' = 'true'
           else (a.data->>'page' = 'page' and a.data->>'media' is null and a.page_chars >= 24000)
             or (a.data->>'page' = 'selection' and a.page_chars >= 12000)
             or (a.data->>'media' is not null and a.page_chars >= 99000) end as hit
    from answers a
    union all
    select 'answer_cut', a.*, true, a.data->>'answer_cut' = 'true' from answers a
    union all
    -- The usual chat's memory (build 92): free, the last 5 answers and notes; Pro without "whole chat", the last 12
    -- messages. history_cut says earlier messages were left out; events from before the flags keep "history >= 12".
    select 'memory_window', a.*, a.mode = 'chat' and not a.whole_chat,
      case when a.flagged then a.data->>'history_cut' = 'true' else a.history >= 12 end from answers a
    union all
    -- "Whole chat": up to 48,000 characters of it; ContextFlow 2.4 says how long the chat was.
    select 'whole_chat_cut', a.*, a.whole_chat,
      a.data->>'history_cut' = 'true' or a.chat_turns > a.history from answers a
    union all
    -- "Whole chat" and the app: 3 other pages (the app 9), each up to 8,000 characters.
    select 'other_pages', a.*, a.whole_chat,
      coalesce((a.data->>'other_pages_cut')::int, 0) > 0 or a.chat_pages - 1 > a.other_pages from answers a
    union all
    select 'digest_cut', a.*, a.mode in ('history', 'find'), a.data->>'digest_cut' = 'true' from answers a
    union all
    -- Storage on the device (ContextFlow 2.4 sends the sizes): 40 messages a chat, 50 chats, 10 pages' texts.
    select 'turns_40', a.*, a.chat_turns is not null, a.chat_turns > 40 from answers a
    union all
    select 'chats_50', a.*, a.chats is not null, a.chats >= 50 from answers a
    union all
    select 'pages_10', a.*, a.chat_pages is not null, a.chat_pages > 10 from answers a
  ),
  -- Answers per Pro subscription per week, against the weekly 375 (300+ counts as close to it).
  pro_weeks as (
    select a.data->>'otid' as otid, date_trunc('week', a.created_at at time zone 'utc')::date as week,
      count(*) as n, max(a.day) as last_day
    from answers a where a.grp = 'pro' and a.data->>'otid' is not null
    group by 1, 2
  ),
  refused as (
    select case data->>'reason'
             when 'ip' then 'ip_daily'
             when 'busy' then 'busy'
             when 'search' then 'search'
             else case when data->>'plan' in ('pro', 'ultra') then 'pro_weekly' else 'free_daily' end
           end as key,
           case when data->>'plan' in ('pro', 'ultra') then 'pro' else 'free' end as grp,
           install_id, day
    from ev where kind = 'limit'
  ),
  active as (
    select grp, install_id from answers
    union select grp, install_id from refused
  ),
  group_users as (
    select grp, count(distinct install_id) as n from active group by grp
    union all
    select 'all', count(distinct install_id) from active
  ),
  answer_limits as (
    select k.key, k.grp,
      (select count(*) from refused r where r.key = k.key) as hits,
      null::bigint as base,
      (select count(distinct r.install_id) from refused r where r.key = k.key) as users,
      (select count(*) from (select r.install_id from refused r where r.key = k.key group by r.install_id having count(distinct r.day) >= 2) x) as repeat_users,
      (select max(r.day) from refused r where r.key = k.key) as last_day
    from (values ('free_daily', 'free'), ('ip_daily', 'free'), ('busy', 'all'), ('search', 'all'), ('pro_weekly', 'pro')) as k(key, grp)
  ),
  pro_near as (
    select 'pro_near' as key, 'pro' as grp,
      count(*) filter (where n >= 300) as hits,
      count(*) as base,
      count(distinct otid) filter (where n >= 300) as users,
      (select count(*) from (select otid from pro_weeks where n >= 300 group by otid having count(*) >= 2) x) as repeat_users,
      max(last_day) filter (where n >= 300) as last_day
    from pro_weeks
  ),
  answer_rows as (
    select t.key, 'all' as grp,
      count(*) filter (where t.base and t.hit) as hits,
      count(*) filter (where t.base) as base,
      count(distinct t.install_id) filter (where t.base and t.hit) as users,
      (select count(*) from (
         select x.install_id from touched x where x.key = t.key and x.base and x.hit
         group by x.install_id having count(distinct x.day) >= 2) r) as repeat_users,
      max(t.day) filter (where t.base and t.hit) as last_day,
      count(distinct t.install_id) filter (where t.base) as users_base
    from touched t group by t.key
  ),
  all_rows as (
    select l.key, l.grp, l.hits, l.base, l.users, l.repeat_users, l.last_day,
      (select n from group_users g where g.grp = l.grp) as users_base
    from answer_limits l
    union all
    select p.key, p.grp, p.hits, p.base, p.users, p.repeat_users, p.last_day,
      (select count(distinct otid) from pro_weeks)
    from pro_near p
    union all
    select r.key, r.grp, r.hits, r.base, r.users, r.repeat_users, r.last_day, r.users_base from answer_rows r
  )
  select jsonb_build_object(
    'days', (select days from d),
    -- Since when answers carry the flags and the chat sizes (the server with limits_v, ContextFlow 2.4).
    'flags_since', (select min(day) from answers where flagged),
    'sizes_since', (select min(day) from answers where chat_turns is not null),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'key', key, 'group', grp, 'hits', hits, 'base', base, 'users', users,
        'users_base', coalesce(users_base, 0), 'repeat_users', repeat_users, 'last_day', last_day,
        'status', case
          when coalesce(hits, 0) = 0 then 'none'
          when repeat_users >= 3 or (users >= 3 and coalesce(users_base, 0) > 0 and users::numeric / users_base >= 0.10) then 'systematic'
          else 'occasional' end
      ) order by key) from all_rows), '[]'::jsonb)
  )
$$;
revoke all on function public.cf_limits_report(integer) from public, anon, authenticated;
grant execute on function public.cf_limits_report(integer) to service_role;

-- public.cf_onboarding: our test installs from contextflow.test_installs [latest version: 20261106120000_contextflow_funnel_to_paid.sql]
create or replace function public.cf_onboarding(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (select install_id from contextflow.test_installs),
  -- Each copy of the app: its first opening, notifications allowed on any opening, its extension's install
  -- once the app knew it.
  apps as (
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
      -- Until the panel tells it, the extension doesn't know the device ("other").
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
        -- An answer can be logged a moment before the panel's first day.
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

-- public.cf_new_user_outcomes: our test installs from contextflow.test_installs [latest version: 20261110120000_contextflow_mrr_retention.sql]
create or replace function public.cf_new_user_outcomes(p_days integer default 30)
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
  fresh as (
    select f.install_id, f.day
    from firsts f, d
    where f.day > d.today - d.days
      and coalesce(f.version, '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.install_id = f.install_id)
      and not contextflow.in_review(f.platform, f.version, f.first_at)
  ),
  limited as (
    select distinct f.install_id, f.day
    from fresh f
    join contextflow.events e on e.kind = 'limit' and e.install_id = f.install_id
      and e.data->>'reason' in ('limit', 'search') and (e.created_at at time zone 'utc')::date = f.day
  ),
  -- Every paid subscription on the day of its first payment, by the plan it was bought as (Own key's upgrade to Pro
  -- an hour later stays Own key here).
  bought as (
    select (t.paid_from at time zone 'utc')::date as day,
      split_part(coalesce((
        select n.data->>'product' from contextflow.events n
        where n.kind = 'appstore_notification' and n.data->>'otid' = s.original_transaction_id and n.data->>'product' is not null
        order by n.created_at limit 1
      ), s.product_id), '.', 3) as plan
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.paid_from is not null and t.terms <> 'owner'
  ),
  days as (
    select generate_series(d.today - (d.days - 1), d.today, interval '1 day')::date as day from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', x.day,
    'new', (select count(*) from fresh f where f.day = x.day),
    'limit_d0', (select count(*) from limited l where l.day = x.day),
    'bought', (select count(*) from bought b where b.day = x.day),
    'bought_pro', (select count(*) from bought b where b.day = x.day and b.plan = 'pro'),
    'bought_ultra', (select count(*) from bought b where b.day = x.day and b.plan = 'ultra'),
    'bought_byok', (select count(*) from bought b where b.day = x.day and b.plan = 'byok'),
    'pro_bought', (select count(*) from bought b where b.day = x.day and b.plan in ('pro', 'ultra'))
  ) order by x.day), '[]'::jsonb)
  from days x
$$;
revoke all on function public.cf_new_user_outcomes(integer) from public, anon, authenticated;
grant execute on function public.cf_new_user_outcomes(integer) to service_role;

-- public.cf_retention: our test installs from contextflow.test_installs [latest version: 20261110120000_contextflow_mrr_retention.sql]
create or replace function public.cf_retention(p_days integer default 90)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(7, least(coalesce(p_days, 90), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (select install_id from contextflow.test_installs),
  firsts as (
    select distinct on (install_id) install_id, day, platform, version, first_at
    from contextflow.install_days
    order by install_id, day, first_at
  ),
  cohort as (
    select f.install_id, f.day as first_day, date_trunc('week', f.day)::date as week
    from firsts f, d
    where f.day > d.today - d.days
      and coalesce(f.version, '') not in ('dev-check', 'calibrate')
      and not exists (select 1 from tests t where t.install_id = f.install_id)
      and not contextflow.in_review(f.platform, f.version, f.first_at)
  ),
  seen as (
    select distinct c.install_id, (u.day - c.first_day) / 7 as k
    from cohort c
    join contextflow.install_days u on u.install_id = c.install_id and u.day >= c.first_day
  ),
  ks as (select generate_series(0, 26) as k),
  user_cells as (
    select c.week, ks.k, count(*) as eligible, count(s.install_id) as active
    from cohort c
    cross join ks
    cross join d
    left join seen s on s.install_id = c.install_id and s.k = ks.k
    where ks.k = 0 or c.first_day + 7 * ks.k + 6 < d.today
    group by 1, 2
  ),
  subs as (
    select s.original_transaction_id as otid, s.product_id, t.paid_from, s.revoked_at, s.last_notification,
      least(s.expires_at, s.revoked_at) as ends,
      coalesce((
        select n.data->>'product' from contextflow.events n
        where n.kind = 'appstore_notification' and n.data->>'otid' = s.original_transaction_id and n.data->>'product' is not null
        order by n.created_at limit 1
      ), s.product_id) as first_product
    from contextflow.entitlements s
    join contextflow.subscription_terms() t on t.otid = s.original_transaction_id
    where s.environment = 'Production' and t.paid_from is not null and t.terms <> 'owner'
      and not exists (select 1 from contextflow.own_subscriptions o where o.otid = s.original_transaction_id)
  ),
  sx as (
    select x.*,
      date_trunc('month', x.paid_from at time zone 'utc')::date as month,
      split_part(x.first_product, '.', 3) as plan0,
      split_part(x.product_id, '.', 3) as plan,
      split_part(x.product_id, '.', 4) = 'yearly' as yearly,
      x.paid_from + case when split_part(x.product_id, '.', 4) = 'yearly' then interval '12 months' else interval '1 month' end
        + interval '2 days' as renewal_check
    from subs x
  ),
  ms as (select generate_series(0, 24) as m),
  sub_cells as (
    select x.month, ms.m, count(*) as eligible,
      count(*) filter (where ms.m = 0 or coalesce(x.ends, 'infinity') > x.paid_from + make_interval(months => ms.m) + interval '2 days') as paying
    from sx x
    cross join ms
    where ms.m = 0 or x.paid_from + make_interval(months => ms.m) + interval '2 days' <= now()
    group by 1, 2
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'users', jsonb_build_object(
      'cohorts', coalesce((select jsonb_agg(jsonb_build_object('week', c.week, 'size', c.size) order by c.week) from (
        select week, count(*) as size from cohort group by week) c), '[]'::jsonb),
      'cells', coalesce((select jsonb_agg(to_jsonb(x) order by x.week, x.k) from user_cells x), '[]'::jsonb)
    ),
    'subscribers', jsonb_build_object(
      'cohorts', coalesce((select jsonb_agg(to_jsonb(c) order by c.month) from (
        select month, count(*) as size,
          count(*) filter (where plan0 = 'pro') as pro, count(*) filter (where plan0 = 'ultra') as ultra,
          count(*) filter (where plan0 = 'byok') as byok,
          count(*) filter (where split_part(first_product, '.', 4) = 'yearly') as yearly
        from sx group by month) c), '[]'::jsonb),
      'cells', coalesce((select jsonb_agg(to_jsonb(x) order by x.month, x.m) from sub_cells x), '[]'::jsonb),
      'renewals', coalesce((select jsonb_agg(to_jsonb(r) order by r.plan, r.yearly) from (
        select plan, yearly,
          count(*) as paid,
          count(*) filter (where renewal_check <= now()) as due,
          count(*) filter (where renewal_check <= now() and coalesce(ends, 'infinity') > renewal_check) as renewed,
          count(*) filter (where renewal_check <= now() and coalesce(ends, 'infinity') <= renewal_check) as churned,
          count(*) filter (where coalesce(ends, 'infinity') > now()
            and last_notification is distinct from 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED') as active,
          count(*) filter (where coalesce(ends, 'infinity') > now()
            and last_notification = 'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED') as leaving,
          count(*) filter (where revoked_at is not null) as refunded,
          min(renewal_check - interval '2 days') filter (where renewal_check - interval '2 days' > now()) as next_due
        from sx group by plan, yearly) r), '[]'::jsonb)
    )
  )
$$;
revoke all on function public.cf_retention(integer) from public, anon, authenticated;
grant execute on function public.cf_retention(integer) to service_role;

-- public.cf_after_limit: our test installs from contextflow.test_installs [latest version: 20261108120000_contextflow_ultra.sql]
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
    select e.install_id, e.created_at, (e.created_at at time zone 'utc')::date as day,
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
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.created_at < h.at) as before,
      (select count(*) from answers a where a.install_id = h.install_id and a.day = h.day and a.plan = 'free' and a.created_at < h.at and a.mode = 'google') as google_before,
      (select min(a.created_at) from answers a where a.install_id = h.install_id and a.day = h.day) as day_first,
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

-- public.cf_setup_funnel: our test installs from contextflow.test_installs [latest version: 20261102150000_contextflow_subscription_terms.sql]
create or replace function public.cf_setup_funnel(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with tests as (select install_id from contextflow.test_installs),
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
      case when t.terms = 'discount' then
        (select min(n.created_at) from notes n where n.otid = s.original_transaction_id and n.by_code) end as code_at,
      -- Free starts (trials, gift codes, ours) count from their first paid transaction, if any.
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

-- public.cf_organize_report: our test installs from contextflow.test_installs [latest version: 20261104100000_contextflow_organize_report.sql]
create or replace function public.cf_organize_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 28), 180)) as days
  ),
  tests as (select install_id from contextflow.test_installs),
  test_apps as (select id as app from contextflow.test_ids),
  ev as (
    select e.kind, e.install_id, e.data
    from contextflow.events e, d
    where e.kind in ('organize', 'organize_promo', 'organize_optin', 'organize_api')
      and e.created_at >= now() - make_interval(days => d.days)
      and (e.install_id is null or not exists (select 1 from tests t where t.install_id = e.install_id))
      and (e.data->>'app' is null or not exists (select 1 from test_apps a where a.app = e.data->>'app'))
      and not contextflow.in_review(e.data->>'platform', e.data->>'version', e.created_at)
  ),
  suggestions as (
    select data->>'what' as what, coalesce(data->>'why', '') as why,
      count(*) filter (where data->>'action' = 'shown') as shown,
      count(*) filter (where data->>'action' = 'accepted') as accepted,
      count(*) filter (where data->>'action' = 'dismissed') as dismissed,
      count(*) filter (where data->>'action' = 'undone') as undone,
      count(distinct coalesce(install_id::text, data->>'app')) filter (where data->>'action' = 'shown') as users
    from ev where kind = 'organize' and data->>'what' is not null
    group by 1, 2
  ),
  promo as (
    select data->>'where' as place,
      count(*) filter (where data->>'action' = 'shown') as shown,
      count(*) filter (where data->>'action' = 'tap') as tap
    from ev where kind = 'organize_promo' and data->>'where' is not null
    group by 1
  ),
  optin as (
    select data->>'from' as place,
      count(*) filter (where data->>'action' = 'accepted') as accepted,
      count(*) filter (where data->>'action' = 'declined') as declined
    from ev where kind = 'organize_optin' and data->>'from' is not null
    group by 1
  ),
  api as (
    select
      count(*) filter (where data->>'op' = 'embed') as embed_requests,
      coalesce(sum((data->>'n')::int) filter (where data->>'op' = 'embed'), 0) as texts,
      count(*) filter (where data->>'op' = 'tags') as tag_checks,
      count(*) filter (where data->>'op' = 'tags' and data->>'provider' = 'openai') as tag_checks_openai,
      coalesce(round(sum((data->>'cost_usd')::numeric), 4), 0) as cost_usd
    from ev where kind = 'organize_api'
  )
  select jsonb_build_object(
    'days', (select days from d),
    'suggestions', coalesce((select jsonb_agg(to_jsonb(s) order by s.what, s.why) from suggestions s), '[]'::jsonb),
    'promo', coalesce((select jsonb_agg(to_jsonb(p) order by p.place) from promo p), '[]'::jsonb),
    'optin', coalesce((select jsonb_agg(to_jsonb(o) order by o.place) from optin o), '[]'::jsonb),
    'api', (select to_jsonb(a) from api a)
  )
$$;
revoke all on function public.cf_organize_report(integer) from public, anon, authenticated;
grant execute on function public.cf_organize_report(integer) to service_role;

-- public.cf_ultra_report: our test installs from contextflow.test_installs [latest version: 20261108140000_contextflow_ultra_report.sql]
create or replace function public.cf_ultra_report(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (select install_id from contextflow.test_installs),
  ev as (
    select (e.created_at at time zone 'utc')::date as day, e.kind, e.install_id, e.data,
      case when e.kind in ('speak', 'speak_script') or e.data->>'mode' in ('speak', 'speak_script') then 'voice' else 'similar' end as feature
    from contextflow.events e, d
    where e.created_at >= (d.today - (d.days - 1))::timestamp at time zone 'utc'
      and (e.kind in ('speak', 'speak_script', 'similar')
           or (e.kind in ('upstream_error', 'limit') and e.data->>'mode' in ('speak', 'speak_script', 'similar')))
      and coalesce(e.data->>'audience', '') <> 'test'
      and coalesce(e.data->>'version', '') not in ('dev-check', 'calibrate')
      and (e.install_id is null or not exists (select 1 from tests t where t.install_id = e.install_id))
      and not contextflow.in_review_any(e.data->>'platform', e.data->>'version', e.created_at)
  ),
  -- One row per event with its numbers: what it counts as, its tokens and cost.
  r as (
    select ev.*,
      ev.kind = 'speak' and coalesce(ev.data->>'part', '0') = '0' as text_start,
      ev.kind = 'upstream_error' or (ev.kind in ('speak', 'speak_script', 'similar') and ev.data->>'ok' = 'false') as failed,
      ev.kind = 'limit' and ev.data->>'reason' in ('speak', 'similar') as limit_hit,
      ev.kind = 'limit' and ev.data->>'reason' = 'busy' as busy,
      coalesce((ev.data->>'audio_s')::numeric, 0) as audio_s,
      coalesce((ev.data->>'cost_usd')::numeric, 0) as usd,
      coalesce((ev.data->>'cost_usd_2027')::numeric, (ev.data->>'cost_usd')::numeric, 0) as usd_2027,
      case ev.kind
        when 'speak' then coalesce((ev.data->>'input_tokens')::numeric, 0)
        when 'speak_script' then coalesce((ev.data->>'prompt_tokens')::numeric, 0)
        when 'similar' then coalesce(sp.input, (ev.data->>'prompt_tokens')::numeric, 0)
        else 0
      end as tokens_in,
      case ev.kind
        when 'speak' then coalesce((ev.data->>'output_tokens')::numeric, 0)
        when 'speak_script' then coalesce((ev.data->>'completion_tokens')::numeric, 0)
        when 'similar' then coalesce(sp.output, (ev.data->>'completion_tokens')::numeric, 0)
        else 0
      end as tokens_out,
      -- Web searches: Anthropic's for engine a, Google's queries for engine b.
      -- (from the steps when logged: a search that stopped halfway has its web searches there only).
      case when ev.kind = 'similar'
        then coalesce(sp.searches, (ev.data->>'searches')::numeric, (ev.data->>'search_queries')::numeric, 0) else 0 end as web
    from ev
    left join lateral (
      select sum((v->>'input')::numeric) as input, sum((v->>'output')::numeric) as output, sum((v->>'searches')::numeric) as searches
      from jsonb_each(case when jsonb_typeof(ev.data->'spend') = 'object' then ev.data->'spend' else '{}'::jsonb end) s(k, v)
    ) sp on ev.kind = 'similar'
  ),
  voice_days as (
    select day,
      count(*) filter (where text_start) as texts,
      count(*) filter (where kind = 'speak') as parts,
      count(distinct install_id) filter (where kind in ('speak', 'speak_script')) as people,
      round(sum(audio_s) filter (where kind = 'speak') / 60, 1) as minutes,
      sum(tokens_in) filter (where kind = 'speak') as tts_in,
      sum(tokens_out) filter (where kind = 'speak') as tts_out,
      count(*) filter (where kind = 'speak_script') as scripts,
      sum(tokens_in) filter (where kind = 'speak_script') as script_in,
      sum(tokens_out) filter (where kind = 'speak_script') as script_out,
      round(sum(usd) filter (where kind = 'speak'), 4) as tts_usd,
      round(sum(usd_2027) filter (where kind = 'speak'), 4) as tts_usd_2027,
      round(sum(usd) filter (where kind = 'speak_script'), 4) as script_usd,
      count(*) filter (where failed and (kind = 'speak' or data->>'mode' = 'speak')) as failed,
      count(*) filter (where failed and (kind = 'speak_script' or data->>'mode' = 'speak_script')) as script_failed,
      count(*) filter (where limit_hit) as limit_hits,
      count(*) filter (where busy) as busy
    from r where feature = 'voice'
    group by day
  ),
  voice_total as (
    select
      count(*) filter (where text_start) as texts,
      count(*) filter (where kind = 'speak') as parts,
      count(distinct install_id) filter (where kind in ('speak', 'speak_script')) as people,
      round(sum(audio_s) filter (where kind = 'speak') / 60, 1) as minutes,
      round(sum((data->>'charged_s')::numeric) filter (where kind = 'speak') / 60, 1) as charged_minutes,
      sum(tokens_in) filter (where kind = 'speak') as tts_in,
      sum(tokens_out) filter (where kind = 'speak') as tts_out,
      count(*) filter (where kind = 'speak_script') as scripts,
      sum(tokens_in) filter (where kind = 'speak_script') as script_in,
      sum(tokens_out) filter (where kind = 'speak_script') as script_out,
      round(sum(usd) filter (where kind = 'speak'), 4) as tts_usd,
      round(sum(usd_2027) filter (where kind = 'speak'), 4) as tts_usd_2027,
      round(sum(usd) filter (where kind = 'speak_script'), 4) as script_usd,
      count(*) filter (where failed and (kind = 'speak' or data->>'mode' = 'speak')) as failed,
      count(*) filter (where failed and (kind = 'speak_script' or data->>'mode' = 'speak_script')) as script_failed,
      count(*) filter (where limit_hit) as limit_hits,
      count(distinct install_id) filter (where limit_hit) as limit_people,
      count(*) filter (where busy) as busy,
      percentile_cont(0.5) within group (order by (data->>'first_audio_ms')::numeric)
        filter (where text_start and coalesce(data->>'ok', 'true') <> 'false' and data->>'first_audio_ms' is not null) as first_audio_p50,
      percentile_cont(0.9) within group (order by (data->>'first_audio_ms')::numeric)
        filter (where text_start and coalesce(data->>'ok', 'true') <> 'false' and data->>'first_audio_ms' is not null) as first_audio_p90
    from r where feature = 'voice'
  ),
  voice_models as (
    select case kind when 'speak' then 'tts' else 'script' end as step, coalesce(data->>'model', '?') as model,
      count(*) as requests, count(*) filter (where failed) as failed,
      sum(tokens_in) as input, sum(tokens_out) as output,
      round(sum(usd), 4) as usd, round(sum(usd_2027), 4) as usd_2027,
      round(sum(audio_s) / 60, 1) as minutes,
      percentile_cont(0.5) within group (order by (data->>'first_audio_ms')::numeric)
        filter (where text_start and coalesce(data->>'ok', 'true') <> 'false' and data->>'first_audio_ms' is not null) as first_audio_p50
    from r where kind in ('speak', 'speak_script')
    group by 1, 2
  ),
  -- Per install and UTC week (Monday first, as the weekly counter), with the device it reported.
  voice_weeks as (
    select date_trunc('week', day)::date as week, install_id,
      round(sum(audio_s) filter (where kind = 'speak') / 60, 1) as minutes,
      count(*) filter (where text_start) as texts,
      count(*) filter (where limit_hit) as limit_hits
    from r where feature = 'voice' and install_id is not null
    group by 1, 2
  ),
  similar_days as (
    select day,
      count(*) filter (where kind = 'similar') as searches,
      count(distinct install_id) filter (where kind = 'similar') as people,
      count(*) filter (where kind = 'similar' and failed) as failed,
      sum(web) as web,
      sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,
      sum((data->>'checked')::numeric) as checked, sum((data->>'kept')::numeric) as kept,
      sum((data->>'items')::numeric) as items,
      round(sum(usd), 4) as usd,
      count(*) filter (where limit_hit) as limit_hits,
      count(*) filter (where busy) as busy
    from r where feature = 'similar'
    group by day
  ),
  similar_total as (
    select
      count(*) filter (where kind = 'similar') as searches,
      count(distinct install_id) filter (where kind = 'similar') as people,
      count(*) filter (where kind = 'similar' and failed) as failed,
      count(*) filter (where kind = 'similar' and data->>'engine' = 'b') as engine_b,
      sum(web) as web,
      sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,
      sum((data->>'candidates')::numeric) as candidates,
      sum((data->>'checked')::numeric) as checked, sum((data->>'kept')::numeric) as kept,
      sum((data->>'items')::numeric) as items,
      round(sum(usd), 4) as usd,
      count(*) filter (where limit_hit) as limit_hits,
      count(distinct install_id) filter (where limit_hit) as limit_people,
      count(*) filter (where busy) as busy,
      percentile_cont(0.5) within group (order by (data->>'ms')::numeric) filter (where kind = 'similar' and not failed) as ms_p50,
      percentile_cont(0.9) within group (order by (data->>'ms')::numeric) filter (where kind = 'similar' and not failed) as ms_p90
    from r where feature = 'similar'
  ),
  similar_models as (
    -- Engine a, per step: Claude Haiku plans, Haiku searches the web, Claude Sonnet writes the list.
    select s.k as step, coalesce(s.v->>'model', '?') as model, count(*) as calls,
      sum((s.v->>'input')::numeric) as input, sum((s.v->>'output')::numeric) as output,
      sum(coalesce((s.v->>'searches')::numeric, 0)) as web, round(sum((s.v->>'usd')::numeric), 4) as usd
    from r, jsonb_each(case when r.kind = 'similar' and jsonb_typeof(r.data->'spend') = 'object' then r.data->'spend' else '{}'::jsonb end) s(k, v)
    group by 1, 2
    union all
    -- Engine b: Gemini with Google Search.
    select 'google', coalesce(data->>'model', '?'), count(*), sum(tokens_in), sum(tokens_out), sum(web), round(sum(usd), 4)
    from r where kind = 'similar' and data->>'engine' = 'b'
    group by 2
    union all
    -- Engine a before the per-step log: the total only.
    select 'unsplit', coalesce(data->>'model', '?'), count(*), null, null, sum(web), round(sum(usd), 4)
    from r where kind = 'similar' and coalesce(data->>'engine', 'a') = 'a' and jsonb_typeof(data->'spend') is distinct from 'object'
    group by 2
  ),
  similar_weeks as (
    select date_trunc('week', day)::date as week, install_id,
      count(*) filter (where kind = 'similar') as searches,
      count(*) filter (where kind = 'similar' and failed) as failed,
      count(*) filter (where limit_hit) as limit_hits
    from r where feature = 'similar' and install_id is not null
    group by 1, 2
  ),
  weeks_out as (
    select 'voice' as feature, w.week, w.install_id, jsonb_build_object('minutes', w.minutes, 'texts', w.texts, 'limit_hits', w.limit_hits) as nums,
      row_number() over (order by w.minutes desc nulls last, w.texts desc) as n
    from voice_weeks w
    union all
    select 'similar', w.week, w.install_id, jsonb_build_object('searches', w.searches, 'failed', w.failed, 'limit_hits', w.limit_hits),
      row_number() over (order by w.searches desc, w.limit_hits desc)
    from similar_weeks w
  ),
  weeks as (
    select w.feature, w.n, jsonb_build_object('week', w.week, 'platform', i.platform, 'locale', i.locale) || w.nums as row
    from weeks_out w left join contextflow.installs i on i.install_id = w.install_id
    where w.n <= 100
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'voice', jsonb_build_object(
      'total', (select to_jsonb(t) from voice_total t),
      'by_day', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from voice_days x), '[]'::jsonb),
      'by_model', coalesce((select jsonb_agg(to_jsonb(x) order by x.step desc, x.requests desc) from voice_models x), '[]'::jsonb),
      'weeks', coalesce((select jsonb_agg(w.row order by w.n) from weeks w where w.feature = 'voice'), '[]'::jsonb)
    ),
    'similar', jsonb_build_object(
      'total', (select to_jsonb(t) from similar_total t),
      'by_day', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from similar_days x), '[]'::jsonb),
      'by_model', coalesce((select jsonb_agg(to_jsonb(x) order by array_position(array['plan', 'search', 'write', 'google', 'unsplit'], x.step), x.calls desc) from similar_models x), '[]'::jsonb),
      'weeks', coalesce((select jsonb_agg(w.row order by w.n) from weeks w where w.feature = 'similar'), '[]'::jsonb)
    )
  )
$$;
revoke all on function public.cf_ultra_report(integer) from public, anon, authenticated;
grant execute on function public.cf_ultra_report(integer) to service_role;

-- public.cf_features: our test installs from contextflow.test_installs [latest version: 20261104210000_contextflow_features_real_active.sql]
create or replace function public.cf_features(p_days integer default 28, p_base jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select greatest(1, least(coalesce(p_days, 28), 180)) as days),
  e as (select * from contextflow.feature_events(now() - make_interval(days => (select days from d)))),
  -- Who was active: installs with a panel day or an answer (install_days), apps that were opened; real only.
  tests as (select id from contextflow.test_ids),
  days_in as (
    select i.install_id::text as person, 'ext' as side, i.version
    from contextflow.install_days i, d
    where i.day > (now() at time zone 'utc')::date - d.days
      and coalesce(i.version, '') not in ('dev-check', 'calibrate')
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

-- contextflow.feature_events: our test installs from contextflow.test_installs [latest version: 20261104120000_contextflow_feature_usage.sql]
create or replace function contextflow.feature_events(p_from timestamptz)
returns table (
  at timestamptz, person text, uid text, platform text, version text, s text,
  f text, a text, via text, what text, sid text, n integer, prev text, dt integer, psid text
)
language sql stable set search_path = '' as $$
  with tests as (select id from contextflow.test_ids),
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

-- public.cf_ads_funnel: our test installs from contextflow.test_installs [latest version: 20261108120000_contextflow_ultra.sql]
create or replace function public.cf_ads_funnel(p_from date, p_to date)
returns table (
  campaign_id bigint, ad_group_id bigint, keyword_id bigint,
  installs bigint, extension_on bigint, first_answer bigint, subscribed bigint
)
language sql stable security definer set search_path = '' as $$
  with unpaid as (select otid from contextflow.subscription_terms() where paid_from is null),
  ads as (
    select distinct on (e.data->>'app')
      e.data->>'app' as app,
      (e.data->>'campaignId')::bigint as campaign_id,
      (e.data->>'adGroupId')::bigint as ad_group_id,
      nullif(e.data->>'keywordId', '')::bigint as keyword_id,
      e.install_id
    from contextflow.events e
    where e.kind = 'ads_attribution' and e.data ? 'app'
      and (e.created_at at time zone 'utc')::date between p_from and p_to
    order by e.data->>'app', e.created_at
  ),
  installs as (
    select a.*,
      coalesce(a.install_id, (
        select o.install_id from contextflow.events o
        where o.kind = 'app_open' and o.data->>'app' = a.app and o.install_id is not null
        order by o.created_at limit 1
      )) as install
    from ads a
  ),
  steps as (
    select i.*,
      i.install is not null and exists (select 1 from contextflow.install_days d where d.install_id = i.install) as on_,
      i.install is not null and exists (
        select 1 from contextflow.events c
        where c.install_id = i.install and c.kind = 'chat' and coalesce(c.data->>'ok', 'true') <> 'false'
      ) as answered,
      exists (
        select 1 from contextflow.entitlements s
        where s.environment = 'Production'
          and s.app_account_token in (i.install, case when i.app ~ '^[0-9a-fA-F-]{36}$' then i.app::uuid end)
          and not exists (select 1 from unpaid u where u.otid = s.original_transaction_id)
      ) or (i.install is not null and exists (
        select 1 from contextflow.events c
        where c.install_id = i.install and c.kind = 'chat' and c.data->>'plan' in ('pro', 'byok', 'ultra')
          and not exists (select 1 from unpaid u where u.otid = c.data->>'otid')
      )) as paid
    from installs i
  )
  select campaign_id, ad_group_id, keyword_id,
    count(*), count(*) filter (where on_), count(*) filter (where answered), count(*) filter (where paid)
  from steps
  -- Our own test installs left out (contextflow.test_installs).
  where install is null or install not in (select install_id from contextflow.test_installs)
  group by 1, 2, 3
  order by 7 desc, 4 desc;
$$;
revoke all on function public.cf_ads_funnel(date, date) from public, anon, authenticated;
grant execute on function public.cf_ads_funnel(date, date) to service_role;
