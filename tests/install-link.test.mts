// 2.7.1 (the Apple Ads report, point 4): the app's random id and the extension's install id reach the server together,
// so every download can be followed from its source (Apple Ads or not) to ContextFlow on in Safari and to a purchase.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { linkApp, type LinkDeps } from "../src/background/link.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const APP = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
const APP2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
const INSTALL = "11111111-2222-4333-8444-555555555555"

function stand(app: string | null, answer: { ok: boolean; status: number } | "offline" = { ok: true, status: 200 }) {
  const sent: Array<Record<string, unknown>> = []
  let linked: string | null = null
  const deps: LinkDeps = {
    appId: async () => app,
    installId: async () => INSTALL,
    client: async () => ({ version: "2.7.1", platform: "ios", locale: "en" }),
    linked: async () => linked,
    markLinked: async (id) => void (linked = id),
    post: async (body) => {
      sent.push(body)
      if (answer === "offline") throw new TypeError("Load failed")
      return answer
    }
  }
  return { deps, sent, linked: () => linked, setApp: (id: string | null) => void (app = id), setAnswer: (a: typeof answer) => void (answer = a) }
}

test("the two ids go together once, as the 2.7 activation step, with nothing else", async () => {
  const s = stand(APP.toUpperCase())
  assert.equal(await linkApp(s.deps), true)
  assert.deepEqual(s.sent, [{
    kind: "use", f: "activation", a: "linked", s: "app", appId: APP, installId: INSTALL,
    client: { version: "2.7.1", platform: "ios", locale: "en" }
  }])
  assert.equal(s.linked(), APP)
  // Already confirmed: nothing more is sent.
  assert.equal(await linkApp(s.deps), true)
  assert.equal(s.sent.length, 1)
})

test("not sent before the app has made its id, and sent once it has", async () => {
  const s = stand(null)
  assert.equal(await linkApp(s.deps), false)
  s.setApp("not-a-uuid")
  assert.equal(await linkApp(s.deps), false)
  assert.equal(s.sent.length, 0)
  s.setApp(APP)
  assert.equal(await linkApp(s.deps), true)
  assert.equal(s.sent.length, 1)
})

test("offline or a server error: asked again next time; a 400 is never asked again for that id", async () => {
  const s = stand(APP, "offline")
  assert.equal(await linkApp(s.deps), false)
  s.setAnswer({ ok: false, status: 503 })
  assert.equal(await linkApp(s.deps), false)
  s.setAnswer({ ok: false, status: 429 })
  assert.equal(await linkApp(s.deps), false)
  assert.equal(s.linked(), null)
  s.setAnswer({ ok: true, status: 200 })
  assert.equal(await linkApp(s.deps), true)
  assert.equal(s.sent.length, 4)

  const refused = stand(APP, { ok: false, status: 400 })
  assert.equal(await linkApp(refused.deps), false)
  assert.equal(refused.linked(), APP)
  await linkApp(refused.deps)
  assert.equal(refused.sent.length, 1)
})

test("an app reinstalled under an extension that kept its storage is linked again under its new id", async () => {
  const s = stand(APP)
  await linkApp(s.deps)
  s.setApp(APP2)
  assert.equal(await linkApp(s.deps), true)
  assert.deepEqual(s.sent.map((b) => b.appId), [APP, APP2])
})

test("the server keeps the link step as the registry allows it, with the app's id", async () => {
  const { useFields } = await import("../src/shared/usage.ts")
  assert.deepEqual(useFields({ f: "activation", a: "linked", s: "app" }), { f: "activation", a: "linked" })
  const event = read("netlify/functions/v2-event.mts")
  // appId goes into every step's data as "app" (the join the reports use), installId into install_id.
  assert.match(event, /\.\.\.\(appId \? \{ app: appId \} : \{\}\),/)
  assert.match(event, /logEvent\(s\.kind, installId, s\.data\)/)
})

test("one install id per extension install, however many ask for it at once", () => {
  const background = read("src/background/index.ts")
  assert.match(background, /let installIdAsk: Promise<string> \| null = null\s*function installId\(\): Promise<string> \{\s*installIdAsk \?\?= \(async \(\) => \{/)
  assert.match(background, /\}\)\(\)\.catch\(\(err\) => \{\s*installIdAsk = null\s*throw err\s*\}\)/)
})

test("the migration: links by any event with both ids, sources, the ads funnel's columns kept, read-only", () => {
  const sql = read("supabase/migrations/20261121120000_contextflow_install_sources.sql")
  // The app's own chat requests use its id as the install before the extension gave one: never a link.
  assert.match(sql, /create or replace view contextflow\.app_links as[\s\S]*?where e\.install_id is not null and e\.data \? 'app'[\s\S]*?and e\.install_id::text <> e\.data->>'app'/)
  assert.match(sql, /case when s\.ad then 'apple_ads' when s\.organic then 'organic' else 'unknown' end as source/)
  assert.match(sql, /bool_or\(e\.kind = 'ads_organic'\) as organic/)
  // tools/ads/asa.mjs reads these columns, in this order.
  assert.match(sql, /function public\.cf_ads_funnel\(p_from date, p_to date\)\s*returns table \(\s*campaign_id bigint, ad_group_id bigint, keyword_id bigint,\s*installs bigint, extension_on bigint, first_answer bigint, subscribed bigint\s*\)/)
  assert.match(sql, /returns table \(\s*source text, platform text,\s*installs bigint, linked bigint, extension_on bigint, panel_used bigint, first_answer bigint, paid bigint\s*\)/)
  // Our own installs out, as in every report; grants for service_role only.
  assert.equal(sql.match(/select id from contextflow\.test_ids where id is not null/g)?.length, 2)
  for (const f of ["cf_install_sources", "cf_ads_funnel"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${f}\\(date, date\\) from public, anon, authenticated;\\s*grant execute on function public\\.${f}\\(date, date\\) to service_role;`), f)
  }
  assert.match(sql, /revoke all on contextflow\.app_links from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /\b(insert into|update contextflow|delete from|drop |truncate )/i)
})

test("Apple's «not an ad» answer is kept as ads_organic, and nothing from Apple's record with it", () => {
  const event = read("netlify/functions/v2-event.mts")
  assert.match(event, /\} else \{[\s\S]{0,400}?context\.waitUntil\(logEvent\("ads_organic", installId, shared\)\)/)
})
