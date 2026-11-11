-- ContextFlow 2.6: read aloud and find similar on /analytics («Голос и поиск похожего»): requests, people, tokens by
-- model, cost now and at the 2027 TTS prices, failures, by day and for the period. Applied after
-- 20261108120000_contextflow_ultra.sql; it replaces that file's cf_speak_report (nothing reads it; this report
-- covers it).
-- select public.cf_ultra_report(30);  (service role; also GET /api/v2/admin/usage → ultra_report)
--
-- Over the last p_days UTC days (today included, as the page's charts), left out like the rest of the page: test
-- devices and our own installs (an event of theirs marked test, our subscriptions), rows marked test, and a version's
-- events while its App Review window is open (contextflow.in_review_any).
--
-- Events read (netlify/functions):
--   speak         one spoken part (v2-speak): model, kind lite/full, part/parts, audio_s, input_tokens (text),
--                 output_tokens (audio), cost_usd, cost_usd_2027, first_audio_ms, ok
--   speak_script  a text rewritten for the ear by Claude Haiku (v2-speak-script): prompt/completion tokens, cost_usd, ok
--   similar       one search (v2-similar): engine a — spend {plan, search, write}: model, input, output, searches, usd
--                 (logged since this change; older rows have the total only), searches (web searches), checked, kept,
--                 items, ms; engine b — prompt/completion tokens, search_queries; cost_usd, ok
--   upstream_error with mode speak / speak_script: the provider failed before anything was spoken or written
--   limit         with mode speak / similar: refused, reason speak / similar = the week's allowance (limit_hits),
--                 busy = a global daily cap (busy)
-- failed: a part, rewrite or search that broke off or came back empty (ok false), or the provider failing first.
--
-- voice:   total, by_day, by_model (TTS per model, the rewrite per model), weeks (minutes per install and UTC week,
--          Monday first, as the weekly counter; the top 100)
-- similar: total, by_day, by_model (engine a per step and model, engine b per model, older rows unsplit), weeks
--          (searches per install and week; the top 100)
-- The allowances (30 minutes, 10 searches a week) are per subscription; the page gets them from the server's config.

drop function if exists public.cf_speak_report(integer);

create or replace function public.cf_ultra_report(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (
    select greatest(1, least(coalesce(p_days, 30), 180)) as days,
           (now() at time zone 'utc')::date as today
  ),
  tests as (
    select distinct install_id from contextflow.events
    where install_id is not null and (data->>'audience' = 'test' or data->>'version' in ('dev-check', 'calibrate'))
    union
    select install_id from contextflow.own_subscriptions where install_id is not null
  ),
  ev as (
    select (e.created_at at time zone 'utc')::date as day, e.kind, e.install_id, e.data,
      case when e.kind in ('speak', 'speak_script') or e.data->>'mode' in ('speak', 'speak_script') then 'voice' else 'similar' end as feature
    from contextflow.events e, d
    where e.created_at >= (d.today - (d.days - 1))::timestamp at time zone 'utc'
      and (e.kind in ('speak', 'speak_script', 'similar')
           or (e.kind in ('upstream_error', 'limit') and e.data->>'mode' in ('speak', 'speak_script', 'similar')))
      and coalesce(e.data->>'audience', '') <> 'test'
      and coalesce(e.data->>'version', '') not in ('dev-check', 'calibrate')
      and (e.install_id is null or not exists (select 1 from tests t where t.install_id = e.install_id))
      and not contextflow.in_review_any(e.data->>'platform', e.data->>'version', e.created_at)
  ),
  -- One row per event with its numbers: what it counts as, its tokens and cost.
  r as (
    select ev.*,
      ev.kind = 'speak' and coalesce(ev.data->>'part', '0') = '0' as text_start,
      ev.kind = 'upstream_error' or (ev.kind in ('speak', 'speak_script', 'similar') and ev.data->>'ok' = 'false') as failed,
      ev.kind = 'limit' and ev.data->>'reason' in ('speak', 'similar') as limit_hit,
      ev.kind = 'limit' and ev.data->>'reason' = 'busy' as busy,
      coalesce((ev.data->>'audio_s')::numeric, 0) as audio_s,
      coalesce((ev.data->>'cost_usd')::numeric, 0) as usd,
      coalesce((ev.data->>'cost_usd_2027')::numeric, (ev.data->>'cost_usd')::numeric, 0) as usd_2027,
      case ev.kind
        when 'speak' then coalesce((ev.data->>'input_tokens')::numeric, 0)
        when 'speak_script' then coalesce((ev.data->>'prompt_tokens')::numeric, 0)
        when 'similar' then coalesce(sp.input, (ev.data->>'prompt_tokens')::numeric, 0)
        else 0
      end as tokens_in,
      case ev.kind
        when 'speak' then coalesce((ev.data->>'output_tokens')::numeric, 0)
        when 'speak_script' then coalesce((ev.data->>'completion_tokens')::numeric, 0)
        when 'similar' then coalesce(sp.output, (ev.data->>'completion_tokens')::numeric, 0)
        else 0
      end as tokens_out,
      -- Web searches: Anthropic's for engine a, Google's queries for engine b.
      -- (from the steps when logged: a search that stopped halfway has its web searches there only).
      case when ev.kind = 'similar'
        then coalesce(sp.searches, (ev.data->>'searches')::numeric, (ev.data->>'search_queries')::numeric, 0) else 0 end as web
    from ev
    left join lateral (
      select sum((v->>'input')::numeric) as input, sum((v->>'output')::numeric) as output, sum((v->>'searches')::numeric) as searches
      from jsonb_each(case when jsonb_typeof(ev.data->'spend') = 'object' then ev.data->'spend' else '{}'::jsonb end) s(k, v)
    ) sp on ev.kind = 'similar'
  ),
  voice_days as (
    select day,
      count(*) filter (where text_start) as texts,
      count(*) filter (where kind = 'speak') as parts,
      count(distinct install_id) filter (where kind in ('speak', 'speak_script')) as people,
      round(sum(audio_s) filter (where kind = 'speak') / 60, 1) as minutes,
      sum(tokens_in) filter (where kind = 'speak') as tts_in,
      sum(tokens_out) filter (where kind = 'speak') as tts_out,
      count(*) filter (where kind = 'speak_script') as scripts,
      sum(tokens_in) filter (where kind = 'speak_script') as script_in,
      sum(tokens_out) filter (where kind = 'speak_script') as script_out,
      round(sum(usd) filter (where kind = 'speak'), 4) as tts_usd,
      round(sum(usd_2027) filter (where kind = 'speak'), 4) as tts_usd_2027,
      round(sum(usd) filter (where kind = 'speak_script'), 4) as script_usd,
      count(*) filter (where failed and (kind = 'speak' or data->>'mode' = 'speak')) as failed,
      count(*) filter (where failed and (kind = 'speak_script' or data->>'mode' = 'speak_script')) as script_failed,
      count(*) filter (where limit_hit) as limit_hits,
      count(*) filter (where busy) as busy
    from r where feature = 'voice'
    group by day
  ),
  voice_total as (
    select
      count(*) filter (where text_start) as texts,
      count(*) filter (where kind = 'speak') as parts,
      count(distinct install_id) filter (where kind in ('speak', 'speak_script')) as people,
      round(sum(audio_s) filter (where kind = 'speak') / 60, 1) as minutes,
      round(sum((data->>'charged_s')::numeric) filter (where kind = 'speak') / 60, 1) as charged_minutes,
      sum(tokens_in) filter (where kind = 'speak') as tts_in,
      sum(tokens_out) filter (where kind = 'speak') as tts_out,
      count(*) filter (where kind = 'speak_script') as scripts,
      sum(tokens_in) filter (where kind = 'speak_script') as script_in,
      sum(tokens_out) filter (where kind = 'speak_script') as script_out,
      round(sum(usd) filter (where kind = 'speak'), 4) as tts_usd,
      round(sum(usd_2027) filter (where kind = 'speak'), 4) as tts_usd_2027,
      round(sum(usd) filter (where kind = 'speak_script'), 4) as script_usd,
      count(*) filter (where failed and (kind = 'speak' or data->>'mode' = 'speak')) as failed,
      count(*) filter (where failed and (kind = 'speak_script' or data->>'mode' = 'speak_script')) as script_failed,
      count(*) filter (where limit_hit) as limit_hits,
      count(distinct install_id) filter (where limit_hit) as limit_people,
      count(*) filter (where busy) as busy,
      percentile_cont(0.5) within group (order by (data->>'first_audio_ms')::numeric)
        filter (where text_start and coalesce(data->>'ok', 'true') <> 'false' and data->>'first_audio_ms' is not null) as first_audio_p50,
      percentile_cont(0.9) within group (order by (data->>'first_audio_ms')::numeric)
        filter (where text_start and coalesce(data->>'ok', 'true') <> 'false' and data->>'first_audio_ms' is not null) as first_audio_p90
    from r where feature = 'voice'
  ),
  voice_models as (
    select case kind when 'speak' then 'tts' else 'script' end as step, coalesce(data->>'model', '?') as model,
      count(*) as requests, count(*) filter (where failed) as failed,
      sum(tokens_in) as input, sum(tokens_out) as output,
      round(sum(usd), 4) as usd, round(sum(usd_2027), 4) as usd_2027,
      round(sum(audio_s) / 60, 1) as minutes,
      percentile_cont(0.5) within group (order by (data->>'first_audio_ms')::numeric)
        filter (where text_start and coalesce(data->>'ok', 'true') <> 'false' and data->>'first_audio_ms' is not null) as first_audio_p50
    from r where kind in ('speak', 'speak_script')
    group by 1, 2
  ),
  -- Per install and UTC week (Monday first, as the weekly counter), with the device it reported.
  voice_weeks as (
    select date_trunc('week', day)::date as week, install_id,
      round(sum(audio_s) filter (where kind = 'speak') / 60, 1) as minutes,
      count(*) filter (where text_start) as texts,
      count(*) filter (where limit_hit) as limit_hits
    from r where feature = 'voice' and install_id is not null
    group by 1, 2
  ),
  similar_days as (
    select day,
      count(*) filter (where kind = 'similar') as searches,
      count(distinct install_id) filter (where kind = 'similar') as people,
      count(*) filter (where kind = 'similar' and failed) as failed,
      sum(web) as web,
      sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,
      sum((data->>'checked')::numeric) as checked, sum((data->>'kept')::numeric) as kept,
      sum((data->>'items')::numeric) as items,
      round(sum(usd), 4) as usd,
      count(*) filter (where limit_hit) as limit_hits,
      count(*) filter (where busy) as busy
    from r where feature = 'similar'
    group by day
  ),
  similar_total as (
    select
      count(*) filter (where kind = 'similar') as searches,
      count(distinct install_id) filter (where kind = 'similar') as people,
      count(*) filter (where kind = 'similar' and failed) as failed,
      count(*) filter (where kind = 'similar' and data->>'engine' = 'b') as engine_b,
      sum(web) as web,
      sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,
      sum((data->>'candidates')::numeric) as candidates,
      sum((data->>'checked')::numeric) as checked, sum((data->>'kept')::numeric) as kept,
      sum((data->>'items')::numeric) as items,
      round(sum(usd), 4) as usd,
      count(*) filter (where limit_hit) as limit_hits,
      count(distinct install_id) filter (where limit_hit) as limit_people,
      count(*) filter (where busy) as busy,
      percentile_cont(0.5) within group (order by (data->>'ms')::numeric) filter (where kind = 'similar' and not failed) as ms_p50,
      percentile_cont(0.9) within group (order by (data->>'ms')::numeric) filter (where kind = 'similar' and not failed) as ms_p90
    from r where feature = 'similar'
  ),
  similar_models as (
    -- Engine a, per step: Claude Haiku plans, Haiku searches the web, Claude Sonnet writes the list.
    select s.k as step, coalesce(s.v->>'model', '?') as model, count(*) as calls,
      sum((s.v->>'input')::numeric) as input, sum((s.v->>'output')::numeric) as output,
      sum(coalesce((s.v->>'searches')::numeric, 0)) as web, round(sum((s.v->>'usd')::numeric), 4) as usd
    from r, jsonb_each(case when r.kind = 'similar' and jsonb_typeof(r.data->'spend') = 'object' then r.data->'spend' else '{}'::jsonb end) s(k, v)
    group by 1, 2
    union all
    -- Engine b: Gemini with Google Search.
    select 'google', coalesce(data->>'model', '?'), count(*), sum(tokens_in), sum(tokens_out), sum(web), round(sum(usd), 4)
    from r where kind = 'similar' and data->>'engine' = 'b'
    group by 2
    union all
    -- Engine a before the per-step log: the total only.
    select 'unsplit', coalesce(data->>'model', '?'), count(*), null, null, sum(web), round(sum(usd), 4)
    from r where kind = 'similar' and coalesce(data->>'engine', 'a') = 'a' and jsonb_typeof(data->'spend') is distinct from 'object'
    group by 2
  ),
  similar_weeks as (
    select date_trunc('week', day)::date as week, install_id,
      count(*) filter (where kind = 'similar') as searches,
      count(*) filter (where kind = 'similar' and failed) as failed,
      count(*) filter (where limit_hit) as limit_hits
    from r where feature = 'similar' and install_id is not null
    group by 1, 2
  ),
  weeks_out as (
    select 'voice' as feature, w.week, w.install_id, jsonb_build_object('minutes', w.minutes, 'texts', w.texts, 'limit_hits', w.limit_hits) as nums,
      row_number() over (order by w.minutes desc nulls last, w.texts desc) as n
    from voice_weeks w
    union all
    select 'similar', w.week, w.install_id, jsonb_build_object('searches', w.searches, 'failed', w.failed, 'limit_hits', w.limit_hits),
      row_number() over (order by w.searches desc, w.limit_hits desc)
    from similar_weeks w
  ),
  weeks as (
    select w.feature, w.n, jsonb_build_object('week', w.week, 'platform', i.platform, 'locale', i.locale) || w.nums as row
    from weeks_out w left join contextflow.installs i on i.install_id = w.install_id
    where w.n <= 100
  )
  select jsonb_build_object(
    'days', (select days from d),
    'today', (select today from d),
    'voice', jsonb_build_object(
      'total', (select to_jsonb(t) from voice_total t),
      'by_day', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from voice_days x), '[]'::jsonb),
      'by_model', coalesce((select jsonb_agg(to_jsonb(x) order by x.step desc, x.requests desc) from voice_models x), '[]'::jsonb),
      'weeks', coalesce((select jsonb_agg(w.row order by w.n) from weeks w where w.feature = 'voice'), '[]'::jsonb)
    ),
    'similar', jsonb_build_object(
      'total', (select to_jsonb(t) from similar_total t),
      'by_day', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from similar_days x), '[]'::jsonb),
      'by_model', coalesce((select jsonb_agg(to_jsonb(x) order by array_position(array['plan', 'search', 'write', 'google', 'unsplit'], x.step), x.calls desc) from similar_models x), '[]'::jsonb),
      'weeks', coalesce((select jsonb_agg(w.row order by w.n) from weeks w where w.feature = 'similar'), '[]'::jsonb)
    )
  )
$$;

revoke all on function public.cf_ultra_report(integer) from public, anon, authenticated;
grant execute on function public.cf_ultra_report(integer) to service_role;
