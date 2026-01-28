-- =============================================
-- ContextFlow Supabase Database Setup
-- Run this in your Supabase SQL Editor
-- =============================================

-- Create a table for user subscriptions/licenses
create table if not exists public.user_subscriptions (
  user_id uuid references auth.users not null primary key,
  plan_type text check (plan_type in ('free', 'byok_license', 'pro_subscription')) default 'free',
  credits_balance int default 5, -- For free tier (5 trial requests)
  subscription_status text check (subscription_status in ('active', 'cancelled', 'expired', 'past_due')) default 'active',
  stripe_customer_id text unique,
  stripe_subscription_id text,
  current_period_end timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

-- Create index for faster lookups
create index if not exists idx_user_subscriptions_stripe_customer
  on public.user_subscriptions(stripe_customer_id);

-- Enable Row Level Security
alter table public.user_subscriptions enable row level security;

-- Policy: Users can read their own subscription data
create policy "Users can read own subscription data"
  on public.user_subscriptions
  for select
  using (auth.uid() = user_id);

-- Policy: Users can insert their own subscription (for initial creation)
create policy "Users can create own subscription"
  on public.user_subscriptions
  for insert
  with check (auth.uid() = user_id);

-- Policy: Service role can do everything (for webhooks)
-- Note: Service role bypasses RLS by default, but this is explicit
create policy "Service role has full access"
  on public.user_subscriptions
  for all
  using (auth.role() = 'service_role');

-- Function to automatically create subscription record on user signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_subscriptions (user_id, plan_type, credits_balance)
  values (new.id, 'free', 5);
  return new;
end;
$$ language plpgsql security definer;

-- Trigger to create subscription on new user
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Function to update the updated_at timestamp
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql;

-- Trigger to auto-update updated_at
drop trigger if exists update_user_subscriptions_updated_at on public.user_subscriptions;
create trigger update_user_subscriptions_updated_at
  before update on public.user_subscriptions
  for each row execute procedure public.update_updated_at_column();

-- =============================================
-- Usage tracking table (optional, for analytics)
-- =============================================
create table if not exists public.usage_logs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  action text not null, -- 'chat_request', 'subscription_created', etc.
  tokens_used int,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- Enable RLS on usage_logs
alter table public.usage_logs enable row level security;

-- Users can read their own usage logs
create policy "Users can read own usage logs"
  on public.usage_logs
  for select
  using (auth.uid() = user_id);

-- Service role can insert usage logs
create policy "Service can insert usage logs"
  on public.usage_logs
  for insert
  with check (true);

-- Index for faster user queries
create index if not exists idx_usage_logs_user_id
  on public.usage_logs(user_id);

create index if not exists idx_usage_logs_created_at
  on public.usage_logs(created_at desc);
