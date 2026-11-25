// 2.8 growth plan, Б1 and Б2: one install cohort for the funnel reports (App Review out, a farm's batch tagged) and
// «the ladder» on it. The behaviour is checked against a database (PGlite, outside the repo); here, the migration's
// shape: what it filters, what it may write, who may call it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const sql = readFileSync(join(root, "supabase/migrations/20261124120000_contextflow_install_ladder.sql"), "utf8")
const fn = (name: string) => {
  const m = new RegExp(`create or replace function ${name.replace(".", "\\.")}\\(p_from date, p_to date\\)[\\s\\S]*?\\n\\$\\$;`).exec(sql)
  assert.ok(m, name)
  return m[0]
}

test("the cohort leaves out App Review, our installs and test builds, and tells the batch apart", () => {
  const cohort = fn("contextflow.install_cohort")
  assert.match(cohort, /not contextflow\.in_review_any\(f\.platform, f\.version, f\.at\)/)
  assert.match(cohort, /f\.app not in \(select id from tests\)/)
  assert.match(cohort, /l\.install in \(select t\.install_id from contextflow\.test_installs t\)/)
  assert.match(cohort, /coalesce\(e\.data->>'audience', ''\) <> 'test'/)
  assert.match(cohort, /not in \('dev-check', 'calibrate'\)/)
  // A batch install: in a batch's window, opened on one day, never met the extension, no ad, no purchase.
  assert.match(cohort, /when coalesce\(s\.ad, false\) then 'apple_ads'\s*when coalesce\(s\.open_days, 1\) <= 1/)
  assert.match(cohort, /not exists \(select 1 from contextflow\.app_links l where l\.app = c\.app\)\s*and not exists \(select 1 from contextflow\.entitlements/)
})

test("both reports read the one cohort; the install sources keep their columns", () => {
  for (const f of ["public.cf_install_sources", "public.cf_ladder"]) {
    assert.match(fn(f), /with cohort as \(select \* from contextflow\.install_cohort\(p_from, p_to\)\)/, f)
  }
  assert.match(sql, /returns table \(\s*source text, platform text,\s*installs bigint, linked bigint, extension_on bigint, panel_used bigint, first_answer bigint, paid bigint\s*\)/)
  // The ladder: every dimension without the batch, the sources with it.
  const ladder = fn("public.cf_ladder")
  assert.match(ladder, /where source <> 'batch'\s*group by grouping sets \(\(\), \(platform\), \(lang\), \(era\), \(variant\), \(platform, era\)\)/)
  assert.match(ladder, /select 'source', source,/)
})

test("reports for service_role only; the one write is the batch row, added once", () => {
  for (const f of ["cf_install_sources", "cf_ladder"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${f}\\(date, date\\) from public, anon, authenticated;\\s*grant execute on function public\\.${f}\\(date, date\\) to service_role;`), f)
  }
  assert.match(sql, /revoke all on function contextflow\.install_cohort\(date, date\) from public, anon, authenticated;/)
  assert.match(sql, /revoke all on contextflow\.install_batches from public, anon, authenticated;/)
  assert.equal(sql.match(/insert into /gi)?.length, 1)
  assert.match(sql, /insert into contextflow\.install_batches[\s\S]*?on conflict \(label\) do nothing;/)
  assert.doesNotMatch(sql, /\b(update contextflow|delete from|drop |truncate )/i)
})
