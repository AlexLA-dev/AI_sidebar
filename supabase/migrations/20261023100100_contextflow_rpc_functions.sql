-- ContextFlow RPC layer. Executable by service_role only (Netlify functions).

-- Atomically check and consume one request against every counter in p_items:
-- [{"subject": "install:…", "period": "day", "limit": 5}, …]. Either all counters
-- are incremented or none. A null limit means "count, never block".
create or replace function public.cf_consume(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  it jsonb;
  v_subject text;
  v_period text;
  v_limit integer;
  v_start date;
  v_n integer;
  v_blocked text := null;
  v_rows jsonb := '[]'::jsonb;
begin
  for it in
    select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
    order by value->>'subject', value->>'period'
  loop
    v_subject := it->>'subject';
    v_period := coalesce(it->>'period', 'day');
    v_limit := (it->>'limit')::integer;
    v_start := contextflow.period_start(v_period);

    insert into contextflow.usage_counters (subject, period, period_start)
    values (v_subject, v_period, v_start)
    on conflict do nothing;

    select c.n into v_n from contextflow.usage_counters c
    where c.subject = v_subject and c.period = v_period and c.period_start = v_start
    for update;

    if v_blocked is null and v_limit is not null and v_n >= v_limit then
      v_blocked := v_subject;
    end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'subject', v_subject, 'period', v_period, 'n', v_n, 'limit', v_limit));
  end loop;

  if v_blocked is null then
    update contextflow.usage_counters c
    set n = c.n + 1
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    where c.subject = x.value->>'subject'
      and c.period = coalesce(x.value->>'period', 'day')
      and c.period_start = contextflow.period_start(coalesce(x.value->>'period', 'day'));

    select coalesce(jsonb_agg(r.value || jsonb_build_object('n', (r.value->>'n')::integer + 1)), '[]'::jsonb)
    into v_rows from jsonb_array_elements(v_rows) as r(value);
  end if;

  return jsonb_build_object('allowed', v_blocked is null, 'blocked', v_blocked, 'counters', v_rows);
end $$;

-- Give back a request that failed upstream (e.g. the model provider errored).
create or replace function public.cf_refund(p_items jsonb)
returns void language sql security definer set search_path = '' as $$
  update contextflow.usage_counters c
  set n = greatest(c.n - 1, 0)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  where c.subject = x.value->>'subject'
    and c.period = coalesce(x.value->>'period', 'day')
    and c.period_start = contextflow.period_start(coalesce(x.value->>'period', 'day'));
$$;

-- Read current counters without consuming.
create or replace function public.cf_peek(p_items jsonb)
returns jsonb language sql security definer set search_path = '' stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'subject', x.value->>'subject',
    'period', coalesce(x.value->>'period', 'day'),
    'limit', (x.value->>'limit')::integer,
    'n', coalesce((
      select c.n from contextflow.usage_counters c
      where c.subject = x.value->>'subject'
        and c.period = coalesce(x.value->>'period', 'day')
        and c.period_start = contextflow.period_start(coalesce(x.value->>'period', 'day'))
    ), 0)
  )), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;
$$;

create or replace function public.cf_touch_install(
  p_install uuid, p_platform text, p_version text, p_locale text, p_requests integer default 0)
returns void language sql security definer set search_path = '' as $$
  insert into contextflow.installs (install_id, platform, app_version, locale, requests_total)
  values (p_install, left(p_platform, 20), left(p_version, 20), left(p_locale, 12), greatest(p_requests, 0))
  on conflict (install_id) do update set
    last_seen_at   = now(),
    platform       = coalesce(excluded.platform, contextflow.installs.platform),
    app_version    = coalesce(excluded.app_version, contextflow.installs.app_version),
    locale         = coalesce(excluded.locale, contextflow.installs.locale),
    requests_total = contextflow.installs.requests_total + greatest(p_requests, 0);
$$;

-- Upsert a verified App Store transaction. Expiry only moves forward unless the
-- transaction is revoked (refund / family sharing removal).
create or replace function public.cf_entitlement_upsert(p jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  insert into contextflow.entitlements as e (
    original_transaction_id, product_id, environment, expires_at, revoked_at,
    app_account_token, last_transaction_id, last_notification)
  values (
    p->>'original_transaction_id', p->>'product_id', coalesce(p->>'environment', 'Production'),
    (p->>'expires_at')::timestamptz, (p->>'revoked_at')::timestamptz,
    nullif(p->>'app_account_token', '')::uuid, p->>'last_transaction_id', p->>'last_notification')
  on conflict (original_transaction_id) do update set
    product_id          = excluded.product_id,
    environment         = excluded.environment,
    expires_at          = case when excluded.revoked_at is not null then excluded.expires_at
                               else greatest(e.expires_at, excluded.expires_at) end,
    revoked_at          = case when excluded.revoked_at is not null then excluded.revoked_at
                               when excluded.expires_at > coalesce(e.revoked_at, '-infinity') then null
                               else e.revoked_at end,
    app_account_token   = coalesce(excluded.app_account_token, e.app_account_token),
    last_transaction_id = coalesce(excluded.last_transaction_id, e.last_transaction_id),
    last_notification   = coalesce(excluded.last_notification, e.last_notification),
    updated_at          = now()
  returning to_jsonb(e);
$$;

create or replace function public.cf_entitlement_get(p_original_transaction_id text)
returns jsonb language sql security definer set search_path = '' stable as $$
  select to_jsonb(e) from contextflow.entitlements e
  where e.original_transaction_id = p_original_transaction_id;
$$;

-- Used only by the legacy (build <= 40) clients that still send a Supabase user id.
create or replace function public.cf_entitlement_by_token(p_token uuid)
returns jsonb language sql security definer set search_path = '' stable as $$
  select to_jsonb(e) from contextflow.entitlements e
  where e.app_account_token = p_token and e.revoked_at is null
  order by e.expires_at desc nulls last
  limit 1;
$$;

create or replace function public.cf_log(p_kind text, p_install uuid, p_data jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into contextflow.events (kind, install_id, data)
  values (left(p_kind, 64), p_install, coalesce(p_data, '{}'::jsonb));
$$;

-- Owner analytics: select public.cf_stats(30); (SQL editor / service role only)
create or replace function public.cf_stats(p_days integer default 30)
returns jsonb language sql security definer set search_path = '' stable as $$
  with d as (select greatest(1, least(coalesce(p_days, 30), 365)) as days),
  chats as (
    select (e.created_at at time zone 'utc')::date as day, e.install_id, e.data
    from contextflow.events e, d
    where e.kind = 'chat' and e.created_at >= now() - make_interval(days => d.days)
  )
  select jsonb_build_object(
    'installs_total', (select count(*) from contextflow.installs),
    'installs_new', (select count(*) from contextflow.installs, d where created_at >= now() - make_interval(days => d.days)),
    'active_installs', (select count(distinct install_id) from chats),
    'requests', (select count(*) from chats),
    'requests_by_plan', (select coalesce(jsonb_object_agg(plan, n), '{}'::jsonb)
                         from (select coalesce(data->>'plan', 'unknown') plan, count(*) n from chats group by 1) x),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'requests', n, 'installs', u) order by day), '[]'::jsonb)
               from (select day, count(*) n, count(distinct install_id) u from chats group by day) x),
    'limit_hits', (select count(*) from contextflow.events e, d where e.kind = 'limit' and e.created_at >= now() - make_interval(days => d.days)),
    'platforms', (select coalesce(jsonb_object_agg(coalesce(platform, 'unknown'), n), '{}'::jsonb)
                  from (select platform, count(*) n from contextflow.installs group by 1) x),
    'active_subscriptions', (select coalesce(jsonb_object_agg(product_id, n), '{}'::jsonb)
                             from (select product_id, count(*) n from contextflow.entitlements
                                   where revoked_at is null and expires_at > now() and environment = 'Production' group by 1) x)
  );
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.cf_consume(jsonb)', 'public.cf_refund(jsonb)', 'public.cf_peek(jsonb)',
    'public.cf_touch_install(uuid, text, text, text, integer)', 'public.cf_entitlement_upsert(jsonb)',
    'public.cf_entitlement_get(text)', 'public.cf_entitlement_by_token(uuid)',
    'public.cf_log(text, uuid, jsonb)', 'public.cf_stats(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
