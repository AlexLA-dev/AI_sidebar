-- Build 92: read aloud's minutes count what's heard, once a part per subscription (the owner: "a replay is free"). A
-- part's heard and made seconds are kept in counters with period 'ever' (one row each per part, never reset).
--
-- Apply this before the build 92 server goes out: until then the table refuses 'ever' rows, so the server can't count
-- what's heard (it answers "busy" and the devices keep the seconds to send again).
--
-- 1. The counters table takes the new period.
alter table contextflow.usage_counters drop constraint if exists usage_counters_period_check;
alter table contextflow.usage_counters add constraint usage_counters_period_check check (period in ('day', 'week', 'ever'));

-- 2. Its start: one fixed date, so the row is the same forever.
create or replace function contextflow.period_start(p_period text)
returns date language sql stable set search_path = '' as $$
  select case p_period
    when 'week' then date_trunc('week', now() at time zone 'utc')::date
    when 'ever' then date '1970-01-01'
    else (now() at time zone 'utc')::date
  end
$$;

revoke all on function contextflow.period_start(text) from public, anon, authenticated;

-- 3. The clean-up (where it has been set up) keeps those rows: it removes counters older than 60 days by their start,
--    which for 'ever' is 1970. It's only changed where it exists; this never creates it.
do $do$
begin
  if to_regprocedure('public.cf_cleanup()') is not null then
    execute $fn$
      create or replace function public.cf_cleanup()
      returns void language sql security definer set search_path = '' as $body$
        delete from contextflow.usage_counters where period <> 'ever' and period_start < (now() at time zone 'utc')::date - 60;
        delete from contextflow.events where created_at < now() - interval '180 days';
      $body$
    $fn$;
  end if;
end
$do$;
