-- 2.7 (plan section 8, «Активация»): the activation steps in /analytics → «Воронки функций».
--
-- The app sends "use" steps with f "activation" (src/shared/usage.ts): "video" (the guide over Settings started, iPhone
-- and iPad), "settings" (Settings opened from the app), "back" (the app in front again after that), "enabled" (the app
-- saw ContextFlow on, once an install), and "linked": once, from the extension's own side, the app's random id together
-- with the install's, when the panel first gives it the install id. Counts only; both ids are random.
--
-- 1. contextflow.feature_events: the app's id joins the install's through those activation steps too, not only through
--    app_open (sent once a day, so someone who switched it on and never opened the app again stayed two people).
-- 2. cf_feature_funnels: "activation" (app opened → video → Settings → back → on in the app → on in Safari → first
--    answer) and "activation_all" (the same without the video: every device, the Mac too). Both count only people whose
--    "app opened" came from 2.7 or later.
--
-- Order: after 20261110180000_contextflow_test_installs.sql (its feature_events is the one replaced here, with only the
-- app_install part changed) and 20261108120000_contextflow_ultra.sql (its cf_feature_funnels, with the two funnels and
-- the version filter for their first step added). Nothing is written or deleted; grants as before (service_role only).

do $$
begin
  if to_regclass('contextflow.test_ids') is null then
    raise exception 'apply 20261110180000_contextflow_test_installs.sql first';
  end if;
end $$;

-- contextflow.feature_events: the app's id also from the activation steps [latest version: 20261110180000_contextflow_test_installs.sql]
create or replace function contextflow.feature_events(p_from timestamptz)
returns table (
  at timestamptz, person text, uid text, platform text, version text, s text,
  f text, a text, via text, what text, sid text, n integer, prev text, dt integer, psid text
)
language sql stable set search_path = '' as $$
  with tests as (select id from contextflow.test_ids),
  -- The app's extension install, once the app reported it (the latest one, if it changed).
  -- 2.7: also the activation steps that carry both ids, above all "linked" (the extension's side, once, when the panel
  -- first gives it the install id), so the app's steps join Safari's without waiting for the app's next day's open.
  app_install as (
    select distinct on (data->>'app') data->>'app' as app, install_id::text as install
    from contextflow.events
    where (kind = 'app_open' or (kind = 'use' and data->>'f' = 'activation')) and install_id is not null and data ? 'app'
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

-- cf_feature_funnels: the activation funnels [latest version: 20261108120000_contextflow_ultra.sql]
create or replace function public.cf_feature_funnels(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with recursive d as (select greatest(1, least(coalesce(p_days, 28), 180)) as days),
  e as (select * from contextflow.feature_events(now() - make_interval(days => (select days from d)))),
  defs(funnel, k, f, acts, via, what) as (values
    ('consent', 1, 'consent', '{shown}'::text[], null, null),
    ('consent', 2, 'consent', '{accepted}', null, null),
    ('consent', 3, 'ask', '{answer}', null, null),
    ('purchase', 1, 'upsell', '{shown}', null, null),
    ('purchase', 2, 'upsell', '{tap}', null, null),
    ('purchase', 3, 'paywall', '{shown}', null, null),
    ('purchase', 4, 'paywall', '{plan}', null, null),
    ('purchase', 5, 'paywall', '{buy_ok}', null, null),
    ('quick_insert', 1, 'qi_list', '{open}', null, null),
    ('quick_insert', 2, 'insert', '{copied,template,answer}', null, null),
    ('templates', 1, 'insert', '{tpl_new}', null, null),
    ('templates', 2, 'insert', '{template}', null, null),
    ('reminders', 1, 'remind', '{set}', null, null),
    ('reminders', 2, 'notif', '{tap}', null, 'remind'),
    ('reminders', 3, 'chat', '{open}', 'reminder', null),
    ('organize', 1, 'organize', '{shown}', null, null),
    ('organize', 2, 'organize', '{accepted}', null, null),
    ('watch', 1, 'watch', '{create}', null, null),
    ('watch', 2, 'watch', '{alert}', null, null),
    ('watch', 3, 'notif', '{tap}', null, 'watch'),
    ('watch', 4, 'page_open', '{tap}', 'watch', null),
    -- 2.6: the guided first request (src/content/Guide.tsx): started, its first answer, off to select text on the
    -- page, Ask AI tapped, the question about the selection asked, all the way to its last card.
    ('guided', 1, 'tour', '{start}', null, null),
    ('guided', 2, 'ask', '{answer}', null, null),
    ('guided', 3, 'tour', '{step}', null, 'pick'),
    ('guided', 4, 'tour', '{step}', null, 'askSel'),
    ('guided', 5, 'tour', '{step}', null, 'answer2'),
    ('guided', 6, 'tour', '{done}', null, null),
    -- 2.6 Ultra: Listen tapped without Ultra, the plans sheet it opened, a plan chosen there, bought in the app.
    ('listen_ultra', 1, 'listen', '{ultra}', null, null),
    ('listen_ultra', 2, 'plans', '{open}', 'listen', null),
    ('listen_ultra', 3, 'plans', '{choose}', null, null),
    ('listen_ultra', 4, 'paywall', '{buy_ok}', null, null),
    -- 2.6: the plans sheet from anywhere (Settings, a full watch list, Listen), to a plan chosen, to a purchase.
    ('plans', 1, 'plans', '{open}', null, null),
    ('plans', 2, 'plans', '{choose}', null, null),
    ('plans', 3, 'paywall', '{buy_ok}', null, null),
    -- 2.7 (plan section 8, «Активация»): the app opened, the guide's video over Settings (iPhone, iPad), Settings opened
    -- from the app, back in the app, the app sees ContextFlow on, Safari's side ran it (ext_on), the first answer.
    ('activation', 1, 'app', '{open}', null, null),
    ('activation', 2, 'activation', '{video}', null, null),
    ('activation', 3, 'activation', '{settings}', null, null),
    ('activation', 4, 'activation', '{back}', null, null),
    ('activation', 5, 'activation', '{enabled}', null, null),
    ('activation', 6, 'ext', '{on}', null, null),
    ('activation', 7, 'ask', '{answer}', null, null),
    -- The same without the video: everyone, the Mac too (no video there) and devices where it didn't start.
    ('activation_all', 1, 'app', '{open}', null, null),
    ('activation_all', 2, 'activation', '{settings}', null, null),
    ('activation_all', 3, 'activation', '{back}', null, null),
    ('activation_all', 4, 'activation', '{enabled}', null, null),
    ('activation_all', 5, 'ext', '{on}', null, null),
    ('activation_all', 6, 'ask', '{answer}', null, null)
  ),
  -- Funnels that count only people whose first step came from this version or later (the version that sends the rest).
  since(funnel, ver) as (values ('activation', '2.7'), ('activation_all', '2.7')),
  reach(funnel, k, person, at, gap) as (
    select d1.funnel, 1, e.person, min(e.at), null::double precision
    from defs d1 join e on e.f = d1.f and e.a = any(d1.acts)
      and (d1.via is null or e.via = d1.via) and (d1.what is null or e.what = d1.what)
    left join since s on s.funnel = d1.funnel
    where d1.k = 1 and (s.ver is null or contextflow.version_num(e.version) >= contextflow.version_num(s.ver))
    group by 1, 2, 3
    union all
    select r.funnel, d2.k, r.person, x.at, extract(epoch from x.at - r.at)
    from reach r
    join defs d2 on d2.funnel = r.funnel and d2.k = r.k + 1
    cross join lateral (
      select min(e.at) as at from e
      where e.person = r.person and e.f = d2.f and e.a = any(d2.acts) and e.at >= r.at
        and (d2.via is null or e.via = d2.via) and (d2.what is null or e.what = d2.what)
    ) x
    where x.at is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('funnel', funnel, 'steps', steps) order by funnel), '[]'::jsonb)
  from (
    select df.funnel, jsonb_agg(jsonb_build_object(
      'k', df.k, 'step', df.f || '.' || array_to_string(df.acts, '|') || coalesce(' ' || df.via, '') || coalesce(' ' || df.what, ''),
      'people', (select count(*) from reach r where r.funnel = df.funnel and r.k = df.k),
      'median_secs', (select percentile_cont(0.5) within group (order by gap) from reach r where r.funnel = df.funnel and r.k = df.k)
    ) order by df.k) as steps
    from defs df group by 1
  ) x
$$;
revoke all on function public.cf_feature_funnels(integer) from public, anon, authenticated;
grant execute on function public.cf_feature_funnels(integer) to service_role;
