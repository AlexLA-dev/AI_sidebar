// Our simulator installs caught on the server (20261125120000_contextflow_sim_net.sql): builds that don't mark
// themselves wrote "app opened" to production as new people; /api/v2/event now asks cf_event_guard first.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const migration = read("supabase/migrations/20261125120000_contextflow_sim_net.sql")

test("the guard keeps only day counters per address, and marks only an app's first open without an extension install", () => {
  const guard = /create or replace function public\.cf_event_guard[\s\S]*?\nend \$\$;/.exec(migration)?.[0] ?? ""
  assert.ok(guard, "cf_event_guard is defined")
  // Nothing but usage_counters rows is written, and only under the daily address subject.
  assert.deepEqual([...guard.matchAll(/insert into ([a-z_.]+)/g)].map((m) => m[1]), ["contextflow.usage_counters", "contextflow.usage_counters"])
  assert.match(guard, /p_subject !~ '\^ip:\[0-9a-f\]\{32\}\$'/)
  assert.match(guard, /'ours:' \|\| p_subject/)
  assert.match(guard, /'new:' \|\| left\(coalesce\(nullif\(p_platform, ''\), 'unknown'\), 20\) \|\| ':' \|\| p_subject/)
  // An extension install or an app seen before is never marked by the address.
  assert.match(guard, /if p_install is not null or p_app is null or not coalesce\(p_first_open, false\) then\s+return null;/)
  assert.match(guard, /e\.kind = 'app_open' and e\.data->>'app' = p_app::text\) then\s+return null;/)
  assert.match(guard, /when v_new >= 3 then 'burst'/)
  assert.match(migration, /grant execute on function public\.cf_event_guard\(text, uuid, uuid, text, boolean, boolean\) to service_role;/)
})

test("the setup funnel's app opened counts the install cohort, as the ladder does", () => {
  const funnel = /create or replace function public\.cf_setup_funnel[\s\S]*?\n\$\$;/.exec(migration)?.[0] ?? ""
  assert.match(funnel, /from contextflow\.install_cohort\(/)
  assert.match(funnel, /where c\.source <> 'batch'/)
})

test("/api/v2/event asks the guard and writes its reason with audience test; a token-carrying open is never asked", () => {
  const event = read("netlify/functions/v2-event.mts")
  assert.match(event, /const firstOpen = has\(FIRST_OPEN\) && typeof body\.adToken !== "string"/)
  assert.match(event, /eventGuard\(address, appId, installId, shared\.platform, firstOpen, steps\.some\(\(s\) => isOurRequest\(s\.data\)\)\)/)
  assert.match(event, /if \(why\) for \(const s of steps\) s\.data = \{ \.\.\.s\.data, audience: "test", audience_set: why \}/)
  // The address subject for the counters is the same one the rate limit uses.
  assert.match(event, /\{ subject: `\$\{bucket\}:\$\{address\}`, period: "day", limit: limit \* 10 \}/)
  const db = read("netlify/shared/db.mts")
  assert.match(db, /why === "address" \|\| why === "burst" \? why : null\), \(\) => null\)/)
})
