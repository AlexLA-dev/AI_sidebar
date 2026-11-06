-- A long page costs more of the answer limit (2.5, the owner's rule): an answer about a page the model gets
-- 200 000 characters or more of counts as several (netlify/shared/weight.mts). Each item may now carry an
-- "amount" (how many answers it counts as, 1 when absent): it's allowed only when the whole amount fits under
-- the limit, and charged, or refunded, in full. Items without it work as before, so the server of 2.4 and this
-- function, or the 2.5 server and the function before it (which charges 1), go together either way.

create or replace function public.cf_consume(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  it jsonb;
  v_subject text;
  v_period text;
  v_limit integer;
  v_amount integer;
  v_start date;
  v_n integer;
  v_blocked text := null;
  v_rows jsonb := '[]'::jsonb;
begin
  for it in
    select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
    order by value->>'subject', value->>'period'
  loop
    v_subject := it->>'subject';
    v_period := coalesce(it->>'period', 'day');
    v_limit := (it->>'limit')::integer;
    v_amount := greatest(coalesce((it->>'amount')::integer, 1), 1);
    v_start := contextflow.period_start(v_period);

    insert into contextflow.usage_counters (subject, period, period_start)
    values (v_subject, v_period, v_start)
    on conflict do nothing;

    select c.n into v_n from contextflow.usage_counters c
    where c.subject = v_subject and c.period = v_period and c.period_start = v_start
    for update;

    if v_blocked is null and v_limit is not null and v_n + v_amount > v_limit then
      v_blocked := v_subject;
    end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'subject', v_subject, 'period', v_period, 'n', v_n, 'limit', v_limit, 'amount', v_amount));
  end loop;

  if v_blocked is null then
    update contextflow.usage_counters c
    set n = c.n + greatest(coalesce((x.value->>'amount')::integer, 1), 1)
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    where c.subject = x.value->>'subject'
      and c.period = coalesce(x.value->>'period', 'day')
      and c.period_start = contextflow.period_start(coalesce(x.value->>'period', 'day'));

    select coalesce(jsonb_agg((r.value - 'amount') || jsonb_build_object('n', (r.value->>'n')::integer + (r.value->>'amount')::integer)), '[]'::jsonb)
    into v_rows from jsonb_array_elements(v_rows) as r(value);
  else
    select coalesce(jsonb_agg(r.value - 'amount'), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) as r(value);
  end if;

  return jsonb_build_object('allowed', v_blocked is null, 'blocked', v_blocked, 'counters', v_rows);
end $$;

create or replace function public.cf_refund(p_items jsonb)
returns void language sql security definer set search_path = '' as $$
  update contextflow.usage_counters c
  set n = greatest(c.n - greatest(coalesce((x.value->>'amount')::integer, 1), 1), 0)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  where c.subject = x.value->>'subject'
    and c.period = coalesce(x.value->>'period', 'day')
    and c.period_start = contextflow.period_start(coalesce(x.value->>'period', 'day'));
$$;
