-- Subscriptions with their history on the analytics page: an upgrade from "Own key" to Pro (or a
-- downgrade) keeps the original transaction, so it is one subscription that changed plan, not two.
-- App Store notification events now carry the original transaction id (otid) and the price paid;
-- the six notifications received before that are linked here by their notification UUID.

update contextflow.events e
set data = e.data || jsonb_build_object('otid', m.otid)
from (values
  ('2d4b04ed-6a81-4048-9a4b-7d70eceecec3', '440003425112575'),
  ('f9cba390-96e5-434d-a7da-6c51dfdfdd78', '440003425112575'),
  ('5c5e3c48-57d7-4211-83b1-6a59abea7f51', '560002834426746'),
  ('bc460dca-7c8a-47c1-9234-efc3b7bf8341', '560002834426746'),
  ('294d7854-fc75-4227-9c7c-5cd29a4cf995', '560002834426746'),
  ('3efd7496-775e-4375-b1bd-b97dca2ded3a', '700002875614935')
) as m(uuid, otid)
where e.kind = 'appstore_notification' and e.data->>'uuid' = m.uuid and e.data->>'otid' is null;

create or replace function public.cf_usage_report(p_days integer default 30)
returns jsonb language sql security definer set search_path = '' stable as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
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
        when e.data->>'audience' = 'test' or e.data->>'version' = 'dev-check' then 'test'
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
  test_installs as (
    select distinct e.install_id from contextflow.events e
    where e.install_id is not null and (e.data->>'audience' = 'test' or e.data->>'version' = 'dev-check')
  ),
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
    select s.product_id, s.created_at, s.expires_at,
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
            count(*) filter (where created_at >= now() - make_interval(days => (select days from d))) as new
          from subs_x group by product_id
        ) s
      ),
      'list', (
        select coalesce(jsonb_agg(row_to_json(s) order by s.created_at desc), '[]'::jsonb) from (
          select product_id, created_at, expires_at, status, switched, history from subs_x order by created_at desc limit 200
        ) s
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
