-- Organizing the chats, 2.5 (/analytics → "Подсказки"): how the suggestions do, from counts only (no text).
-- select public.cf_organize_report(28);  (service role; also GET /api/v2/admin/usage → organize_report)
--
-- Over the last p_days (UTC), test devices and our own installs left out:
--   suggestions  per kind (move / new / tag) and reason (page / site / topic / apart): shown, accepted,
--                dismissed, undone, and the installs that saw them; accepted / shown is the share taken
--   promo        what organizing does, shown or tapped, by where (Pro card and screen, the pile card, after the
--                third tag, tips, What's new)
--   optin        suggestions turned on or declined, by where
--   api          /api/v2/organize: embedding requests and texts, tag checks, how often OpenAI checked tags
--                instead of Claude, and what it cost us

create or replace function public.cf_organize_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 28), 180)) as days
  ),
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' = 'dev-check')
    union
    select install_id from contextflow.own_subscriptions where install_id is not null
  ),
  ev as (
    select e.kind, e.install_id, e.data
    from contextflow.events e, d
    where e.kind in ('organize', 'organize_promo', 'organize_optin', 'organize_api')
      and e.created_at >= now() - make_interval(days => d.days)
      and (e.install_id is null or not exists (select 1 from tests t where t.install_id = e.install_id))
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
