-- Build 92: the chat's memory window in /analytics (cf_limits_report's "memory_window") counted from the answer's own
-- history_cut flag. A free answer now remembers the last 5 answers and notes (a Pro answer without "whole chat" the last
-- 12 messages), so "history >= 12" no longer says whether earlier messages were left out; history_cut does. Events
-- from before the flags (no limits_v) keep the old count. Only that row changes; the rest is cf_limits_report as
-- 20261108120000_contextflow_ultra.sql left it.

create or replace function public.cf_limits_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 28), 180)) as days
  ),
  -- Our own test devices and installs, left out.
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' = 'dev-check')
    union
    select install_id from contextflow.own_subscriptions where install_id is not null
  ),
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
