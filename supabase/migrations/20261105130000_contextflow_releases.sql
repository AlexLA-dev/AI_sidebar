-- Releases (/analytics → the dashed version lines on the daily charts): when App Review approved each app version,
-- one row per platform and version. The approval is the end of the version's last review window
-- (contextflow.review_windows); a version whose last window is still open is in review and left out. A rejection
-- closes a window too, but the version then goes back with a new window, so the last one closed is the approval.
create or replace function public.cf_releases()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('platform', w.platform, 'version', w.version, 'approved_at', w.completed_at)
    order by w.completed_at), '[]'::jsonb)
  from (
    select distinct on (platform, version) platform, version, completed_at
    from contextflow.review_windows
    order by platform, version, submitted_at desc
  ) w
  where w.completed_at is not null
$$;
revoke all on function public.cf_releases() from public, anon, authenticated;
grant execute on function public.cf_releases() to service_role;
