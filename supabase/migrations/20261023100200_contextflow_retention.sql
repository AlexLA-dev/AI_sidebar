-- NOT APPLIED YET (needs owner confirmation: contains DELETE).
-- Run once in the Supabase SQL editor, then call `select public.cf_cleanup();`
-- occasionally (the backend also calls it opportunistically if it exists).

-- Retention: counters 60 days, events 180 days.
create or replace function public.cf_cleanup()
returns void language sql security definer set search_path = '' as $$
  delete from contextflow.usage_counters where period_start < (now() at time zone 'utc')::date - 60;
  delete from contextflow.events where created_at < now() - interval '180 days';
$$;

revoke all on function public.cf_cleanup() from public, anon, authenticated;
grant execute on function public.cf_cleanup() to service_role;
