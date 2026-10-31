-- Apple Ads: which campaign, ad group and keyword brought each install, and how far that install got.
-- ContextFlow 2.4+ sends the AdServices token with "app opened"; the server logs a positive answer as
-- event 'ads_attribution' (data: app, campaignId, adGroupId, keywordId, ...). The app's random id is
-- linked to the extension's install id through later 'app_open' events, and purchases carry the
-- install id (or the app id) as appAccountToken. tools/ads/asa.mjs reads this for its rules.

create or replace function public.cf_ads_funnel(p_from date, p_to date)
returns table (
  campaign_id bigint, ad_group_id bigint, keyword_id bigint,
  installs bigint, extension_on bigint, first_answer bigint, subscribed bigint
)
language sql stable security definer set search_path = '' as $$
  with ads as (
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
      ) or (i.install is not null and exists (
        select 1 from contextflow.events c
        where c.install_id = i.install and c.kind = 'chat' and c.data->>'plan' in ('pro', 'byok')
      )) as paid
    from installs i
  )
  select campaign_id, ad_group_id, keyword_id,
    count(*), count(*) filter (where on_), count(*) filter (where answered), count(*) filter (where paid)
  from steps
  group by 1, 2, 3
  order by 7 desc, 4 desc;
$$;
revoke all on function public.cf_ads_funnel(date, date) from public, anon, authenticated;
