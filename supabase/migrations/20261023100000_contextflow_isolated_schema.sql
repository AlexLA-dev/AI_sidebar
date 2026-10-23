-- ContextFlow (Safari AI extension) on the shared Supabase project.
--
-- The project also hosts Baby Sleep Well (tables in `public`). Everything that
-- belongs to ContextFlow lives in its own schema `contextflow`, which is NOT
-- exposed through the Data API. The Netlify backend reaches it only through the
-- `public.cf_*` functions below, which are executable by `service_role` only.
-- Moving ContextFlow to its own project later = dump schema `contextflow` +
-- the `cf_*` functions; nothing in Baby Sleep Well depends on them.
--
-- ContextFlow no longer uses Supabase Auth: users are identified by an
-- anonymous install id, paid access by Apple-signed StoreKit transactions.

create schema if not exists contextflow;
revoke all on schema contextflow from public, anon, authenticated;

-- One row per extension install (random UUID generated on the device).
create table if not exists contextflow.installs (
  install_id     uuid primary key,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  platform       text,
  app_version    text,
  locale         text,
  requests_total integer not null default 0
);

-- Rate-limit counters. subject: install:<uuid> | ip:<hash> | tx:<originalTransactionId> | user:<uuid> | global:<name>
create table if not exists contextflow.usage_counters (
  subject      text not null,
  period       text not null check (period in ('day', 'week')),
  period_start date not null,
  n            integer not null default 0,
  primary key (subject, period, period_start)
);

-- App Store subscriptions seen by the backend (from devices and from App Store Server Notifications).
create table if not exists contextflow.entitlements (
  original_transaction_id text primary key,
  product_id              text not null,
  environment             text not null,
  expires_at              timestamptz,
  revoked_at              timestamptz,
  app_account_token       uuid,
  last_transaction_id     text,
  last_notification       text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists entitlements_app_account_token_idx
  on contextflow.entitlements (app_account_token) where app_account_token is not null;

-- Product analytics and audit trail (no page content, no chat text).
create table if not exists contextflow.events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null,
  install_id uuid,
  data       jsonb not null default '{}'::jsonb
);
create index if not exists events_created_at_idx on contextflow.events (created_at desc);
create index if not exists events_kind_created_at_idx on contextflow.events (kind, created_at desc);

alter table contextflow.installs enable row level security;
alter table contextflow.usage_counters enable row level security;
alter table contextflow.entitlements enable row level security;
alter table contextflow.events enable row level security;
revoke all on all tables in schema contextflow from public, anon, authenticated;

create or replace function contextflow.period_start(p_period text)
returns date language sql stable set search_path = '' as $$
  select case p_period
    when 'week' then date_trunc('week', now() at time zone 'utc')::date
    else (now() at time zone 'utc')::date
  end
$$;

revoke all on function contextflow.period_start(text) from public, anon, authenticated;

comment on schema contextflow is 'ContextFlow Safari extension (isolated from Baby Sleep Well). Accessed only via public.cf_* (service_role).';
