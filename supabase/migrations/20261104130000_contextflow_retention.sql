-- Keep what the privacy policy promises (site/privacy.html): usage statistics, events and the per-day activity of an
-- installation up to 180 days; subscription data up to 180 days after the subscription ended or was refunded;
-- rate-limit counters 60 days. Replaces 20261023100200_contextflow_retention, which was never applied.
--
-- The backend calls cf_cleanup() now and then (netlify/shared/db.mts → maybeCleanup, about 1 in 200 answers).
-- On 2026-11-04 it would have deleted nothing: the oldest event is from 2026-10-23.
-- After an installation's first 180 days, reports that look for its first day see a later one.

create or replace function public.cf_cleanup()
returns void language sql security definer set search_path = '' as $$
  delete from contextflow.usage_counters where period_start < (now() at time zone 'utc')::date - 60;
  delete from contextflow.events where created_at < now() - interval '180 days';
  delete from contextflow.install_days where day < (now() at time zone 'utc')::date - 180;
  delete from contextflow.installs where last_seen_at < now() - interval '180 days';
  delete from contextflow.entitlements where coalesce(revoked_at, expires_at) < now() - interval '180 days';
$$;

revoke all on function public.cf_cleanup() from public, anon, authenticated;
grant execute on function public.cf_cleanup() to service_role;
