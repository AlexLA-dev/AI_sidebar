-- ContextFlow 2.7: invite a friend (plan section 5; netlify/shared/invite.mts, netlify/functions/v2-invite.mts).
--
-- No account and nothing personal: an install's code, and which code a new install came with ("if you entered a
-- friend's code, we keep which code the install came with, to give the bonuses").
--
-- 1. invite_codes: one code per install (the extension's install id, or the app's own id before the extension ran).
-- 2. invites: one row per friend: the code, the friend's ids (the app's id and the extension's install, linked when
--    the code was entered in the app first), whether the device was checked (Apple DeviceCheck), until when the
--    friend's extra answers run, when the friend became active (answers on two different UTC days, read from the
--    install's daily free counters), and when the inviter took extra answers for this friend (the director's
--    proposal, off unless INVITE_INVITER_ANSWERS=on).
-- 3. cf_invite_* for the server, cf_invite_report for /analytics.
--
-- Applying it is the director's (tier 2). Until then /api/v2/invite answers UNAVAILABLE and answers count as before.

create table if not exists contextflow.invite_codes (
  code       text primary key check (code ~ '^[A-HJKMNP-Z2-9]{6}$'),
  install_id uuid not null unique,
  created_at timestamptz not null default now()
);

create table if not exists contextflow.invites (
  friend_id         uuid primary key,
  friend_install_id uuid unique,
  code              text not null references contextflow.invite_codes (code),
  device            text not null check (device in ('checked', 'unchecked')),
  bonus_until       timestamptz not null,
  created_at        timestamptz not null default now(),
  active_at         timestamptz,
  answers_at        timestamptz
);
create index if not exists invites_code_idx on contextflow.invites (code);

alter table contextflow.invite_codes enable row level security;
alter table contextflow.invites enable row level security;
revoke all on contextflow.invite_codes from public, anon, authenticated;
revoke all on contextflow.invites from public, anon, authenticated;

-- The install's code: the one it (or its other id) has, else p_new. Null when p_new is taken (the server tries another).
create or replace function public.cf_invite_code(p_install uuid, p_other uuid, p_new text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
begin
  select c.code into v_code from contextflow.invite_codes c
  where c.install_id = p_install or c.install_id = p_other order by c.created_at limit 1;
  if v_code is not null then return v_code; end if;
  insert into contextflow.invite_codes (code, install_id) values (upper(p_new), p_install)
  on conflict do nothing returning code into v_code;
  if v_code is null then
    -- Another request made this install's code meanwhile.
    select c.code into v_code from contextflow.invite_codes c where c.install_id = p_install;
  end if;
  return v_code;
end $$;

-- A friend's code on a new install. p_friend: the app's id (or the extension's install from the panel); p_install: the
-- extension's install when known. 'ok' | 'unknown' | 'own' | 'already' | 'old' (not a new install) | 'full' (the cap).
create or replace function public.cf_invite_redeem(
  p_friend uuid, p_install uuid, p_code text, p_device text, p_until timestamptz, p_cap integer, p_new_days integer)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_first timestamptz;
  v_ok boolean;
begin
  select c.install_id into v_owner from contextflow.invite_codes c where c.code = upper(p_code);
  if v_owner is null then return 'unknown'; end if;
  if v_owner = p_friend or v_owner = p_install then return 'own'; end if;
  if exists (
    select 1 from contextflow.invites v
    where v.friend_id in (p_friend, p_install) or v.friend_install_id in (p_friend, p_install)
  ) then return 'already'; end if;
  select min(i.created_at) into v_first from contextflow.installs i where i.install_id in (p_friend, p_install);
  if v_first is not null and v_first < now() - make_interval(days => greatest(coalesce(p_new_days, 7), 1)) then return 'old'; end if;
  -- One at a time per code, so the cap holds.
  perform 1 from contextflow.invite_codes c where c.code = upper(p_code) for update;
  if (select count(*) from contextflow.invites v where v.code = upper(p_code)) >= coalesce(p_cap, 20) then return 'full'; end if;
  insert into contextflow.invites (friend_id, friend_install_id, code, device, bonus_until)
  values (p_friend, p_install, upper(p_code), p_device, p_until)
  on conflict do nothing returning true into v_ok;
  return case when v_ok then 'ok' else 'already' end;
end $$;

-- A code entered in the app before the extension ran: the extension's install takes it over.
create or replace function public.cf_invite_link(p_app uuid, p_install uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if exists (select 1 from contextflow.invites v where v.friend_install_id = p_install or v.friend_id = p_install) then
    return false;
  end if;
  update contextflow.invites set friend_install_id = p_install
  where friend_id = p_app and friend_install_id is null
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- Whether one of the ids has extra answers now: a friend's first days, or an inviter's week of answers (the proposal).
create or replace function public.cf_invite_bonus(p_ids uuid[], p_answer_days integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from contextflow.invites v
    where (v.friend_id = any(p_ids) or v.friend_install_id = any(p_ids)) and v.bonus_until > now()
  ) or exists (
    select 1 from contextflow.invites v join contextflow.invite_codes c on c.code = v.code
    where c.install_id = any(p_ids) and v.answers_at > now() - make_interval(days => greatest(coalesce(p_answer_days, 7), 1))
  )
$$;

-- Friends with free answers on p_days different UTC days since they entered the code (their daily counters).
create or replace function contextflow.invite_active(v contextflow.invites, p_days integer)
returns boolean language sql stable set search_path = '' as $$
  select count(distinct u.period_start) >= greatest(coalesce(p_days, 2), 1)
  from contextflow.usage_counters u
  where u.period = 'day' and u.n > 0
    and u.subject in ('install:' || v.friend_id::text, 'install:' || coalesce(v.friend_install_id, v.friend_id)::text)
    and u.period_start >= (v.created_at at time zone 'utc')::date
$$;

-- The install's code, friends (joined, active), the inviter's answers, and its own friend's bonus. Friends who became
-- active since the last look are marked now (new_active).
create or replace function public.cf_invite_state(p_ids uuid[], p_days integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_new integer := 0;
begin
  select c.code into v_code from contextflow.invite_codes c where c.install_id = any(p_ids) order by c.created_at limit 1;
  if v_code is not null then
    with act as (
      update contextflow.invites v set active_at = now()
      where v.code = v_code and v.active_at is null and contextflow.invite_active(v, p_days)
      returning 1
    )
    select count(*) into v_new from act;
  end if;
  return jsonb_build_object(
    'code', v_code,
    'joined', (select count(*) from contextflow.invites v where v.code = v_code),
    'active', (select count(*) from contextflow.invites v where v.code = v_code and v.active_at is not null),
    'new_active', v_new,
    'answers_taken', (select count(*) from contextflow.invites v where v.code = v_code and v.answers_at is not null),
    'answers_last', (select max(v.answers_at) from contextflow.invites v where v.code = v_code),
    'entered_until', (select max(v.bonus_until) from contextflow.invites v where v.friend_id = any(p_ids) or v.friend_install_id = any(p_ids)),
    'first_seen', (select min(i.created_at) from contextflow.installs i where i.install_id = any(p_ids))
  );
end $$;

-- The inviter takes extra answers for one active friend (the proposal behind INVITE_INVITER_ANSWERS).
create or replace function public.cf_invite_take_answers(p_ids uuid[])
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  update contextflow.invites set answers_at = now()
  where friend_id = (
    select v.friend_id from contextflow.invites v join contextflow.invite_codes c on c.code = v.code
    where c.install_id = any(p_ids) and v.active_at is not null and v.answers_at is null
    order by v.active_at limit 1 for update of v skip locked
  )
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- /analytics: invites over the last p_days. Codes made, invite pages opened (the site counter, page "invite"), codes
-- entered and refused (by reason), friends active (two days with answers, read now), friends who later subscribed, and
-- inviters who subscribed after their first active friend. Rows marked as tests are left out of the events.
create or replace function public.cf_invite_report(p_days integer default 28)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 28), 365))) as since),
  ev as (
    select e.kind, e.data from contextflow.events e, d
    where e.created_at >= d.since and coalesce(e.data->>'audience', '') <> 'test'
      and e.kind in ('site_visit', 'site_click', 'invite_redeem', 'invite_refused', 'invite_active', 'invite_answers')
  ),
  inv as (select v.* from contextflow.invites v, d where v.created_at >= d.since),
  subs as (
    select s.app_account_token as token, min(s.created_at) as at from contextflow.entitlements s
    where s.app_account_token is not null and s.product_id not like '%byok%' group by 1
  )
  select jsonb_build_object(
    'codes', (select count(*) from contextflow.invite_codes c, d where c.created_at >= d.since),
    'page_opens', (select count(*) from ev where kind = 'site_visit' and data->>'page' = 'invite'),
    'page_app_store', (select count(*) from ev where kind = 'site_click' and data->>'label' = 'invite_app_store'),
    'entered', (select count(*) from inv),
    'entered_checked', (select count(*) from inv where device = 'checked'),
    'refused', (select coalesce(jsonb_object_agg(code, n), '{}'::jsonb) from (
      select data->>'code' as code, count(*) as n from ev where kind = 'invite_refused' group by 1) r),
    'active', (select count(*) from inv v where v.active_at is not null or contextflow.invite_active(v, 2)),
    'friends_subscribed', (select count(*) from inv v where exists (
      select 1 from subs s where s.token in (v.friend_id, v.friend_install_id) and s.at >= v.created_at)),
    'inviters_subscribed', (select count(distinct c.install_id) from inv v
      join contextflow.invite_codes c on c.code = v.code
      join subs s on s.token = c.install_id
      where v.active_at is not null and s.at >= v.active_at),
    'inviter_answers', (select count(*) from inv where answers_at is not null)
  )
$$;

revoke all on function public.cf_invite_code(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cf_invite_redeem(uuid, uuid, text, text, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.cf_invite_link(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cf_invite_bonus(uuid[], integer) from public, anon, authenticated;
revoke all on function contextflow.invite_active(contextflow.invites, integer) from public, anon, authenticated;
revoke all on function public.cf_invite_state(uuid[], integer) from public, anon, authenticated;
revoke all on function public.cf_invite_take_answers(uuid[]) from public, anon, authenticated;
revoke all on function public.cf_invite_report(integer) from public, anon, authenticated;
grant execute on function public.cf_invite_code(uuid, uuid, text) to service_role;
grant execute on function public.cf_invite_redeem(uuid, uuid, text, text, timestamptz, integer, integer) to service_role;
grant execute on function public.cf_invite_link(uuid, uuid) to service_role;
grant execute on function public.cf_invite_bonus(uuid[], integer) to service_role;
grant execute on function public.cf_invite_state(uuid[], integer) to service_role;
grant execute on function public.cf_invite_take_answers(uuid[]) to service_role;
grant execute on function public.cf_invite_report(integer) to service_role;
