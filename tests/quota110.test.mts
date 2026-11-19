// 2.7 (110): what the answers went on. The owner on 109: «для пользователя может быть очень неочевидно, что перевод
// страниц расходует квоту <…> по тапу на счётчик в окне чата или в настройках раскрывалась детализация». The server
// counts answers by kind next to the counter they're charged to (no migration: the counters are generic), and
// /api/v2/status says it; the panel shows it on a tap on the count, in «+» and in Settings.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { before, beforeEach, test } from "node:test"

import { spentRows, USE_KINDS, useSubject } from "../src/shared/spent.ts"
import { FEATURES, useFields } from "../src/shared/usage.ts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const LANGS = ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]
const INSTALL = "44444444-4444-4444-8444-444444444444"

// ---- the database's counters, in memory (cf_consume / cf_peek / cf_refund as the migrations have them) --------------
let counters = new Map<string, number>()
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  const fn = url.startsWith("https://db.test/rest/v1/rpc/") ? url.split("/rpc/")[1].split("?")[0] : ""
  const key = (i: { subject: string; period?: string }) => `${i.subject}|${i.period ?? "day"}`
  switch (fn) {
    case "cf_consume": {
      const items = body.p_items as Array<{ subject: string; period: string; limit: number | null; amount?: number }>
      const blocked = items.find((i) => i.limit !== null && (counters.get(key(i)) ?? 0) + (i.amount ?? 1) > i.limit)
      if (!blocked) for (const i of items) counters.set(key(i), (counters.get(key(i)) ?? 0) + (i.amount ?? 1))
      return Response.json({ allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: counters.get(key(i)) ?? 0 })) })
    }
    case "cf_refund":
      for (const i of body.p_items as Array<{ subject: string; period: string; amount?: number }>) counters.set(key(i), Math.max(0, (counters.get(key(i)) ?? 0) - (i.amount ?? 1)))
      return Response.json(null)
    case "cf_peek":
      return Response.json((body.p_items as Array<{ subject: string; period: string }>).map((i) => ({ ...i, n: counters.get(key(i)) ?? 0 })))
    default:
      return Response.json(fn === "cf_limited_before" ? false : null)
  }
}) as typeof fetch

let plan: typeof import("../netlify/shared/plan.mts")
let db: typeof import("../netlify/shared/db.mts")
let status: (req: Request, ctx: any) => Promise<Response>
before(async () => {
  plan = await import("../netlify/shared/plan.mts")
  db = await import("../netlify/shared/db.mts")
  status = (await import("../netlify/functions/v2-status.mts")).default
})
beforeEach(() => {
  counters = new Map()
})

const free = { plan: "free", entitlement: null } as any
const pro = { plan: "pro", entitlement: { originalTransactionId: "2000000111", productId: "pro.monthly", expiresAt: null, environment: "Production" } } as any

async function statusNow(): Promise<any> {
  const pending: Promise<unknown>[] = []
  const res = await status(new Request("https://aisidebar.netlify.app/api/v2/status", { method: "POST", body: JSON.stringify({ installId: INSTALL, client: { platform: "ios", version: "2.7" } }) }), { ip: "203.0.113.9", waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
  return res.json()
}

test("the rows: the most first, «Other» for what isn't split, never more than was used, none for an older server", () => {
  assert.equal(spentRows(3, undefined), null)
  assert.equal(spentRows(3, null), null)
  assert.deepEqual(spentRows(0, {}), [])
  assert.deepEqual(spentRows(9, { chat: 2, translate: 5, write: 1 }), [{ kind: "translate", n: 5 }, { kind: "chat", n: 2 }, { kind: "write", n: 1 }, { kind: "other", n: 1 }])
  // Equal counts keep the kinds' order.
  assert.deepEqual(spentRows(4, { google: 2, chat: 2 }), [{ kind: "chat", n: 2 }, { kind: "google", n: 2 }])
  // A refund read between the two counters: the rows are cut down to what was used, the smallest first.
  assert.deepEqual(spentRows(4, { chat: 3, similar: 2 }), [{ kind: "chat", n: 3 }, { kind: "similar", n: 1 }])
  assert.deepEqual(spentRows(2, { chat: "x" as never, write: -1, translate: 2 }), [{ kind: "translate", n: 2 }])
})

test("the kind's counter goes next to the answers' own: same subject under use:, same period and amount, no limit", () => {
  const ip = "ip:203.0.113.9"
  const freeCounters = plan.countersFor(free, INSTALL, ip)
  assert.deepEqual(plan.withUse(freeCounters, "translate").slice(freeCounters.length), [{ subject: `use:translate:install:${INSTALL}`, period: "day", limit: null }])
  const proCounters = plan.countersFor(pro, INSTALL, ip).map((c) => ({ ...c, amount: 3 }))
  assert.deepEqual(plan.withUse(proCounters, "chat").slice(proCounters.length), [{ subject: "use:chat:tx:2000000111", period: "week", limit: null, amount: 3 }])
  // A guided first answer isn't charged to the install: nothing next to it either.
  const tour = freeCounters.filter((c) => !c.subject.startsWith("install:"))
  assert.deepEqual(plan.withUse(tour, "chat"), tour)
  // Never "search:install:…" or "similarlight:…" taken for the answers' own.
  assert.equal(plan.withUse([...plan.searchCountersFor(free, INSTALL), ...freeCounters], "google").at(-1)?.subject, `use:google:install:${INSTALL}`)
  // Pro's Find similar: its answers (SIMILAR_PRO_ANSWERS each) are counted as Find similar's.
  const light = plan.similarLightCounters(pro, INSTALL, ip)
  const use = light.find((c) => c.subject.startsWith("use:"))
  assert.equal(use?.subject, "use:similar:tx:2000000111")
  assert.equal(use?.amount, light.find((c) => c.subject.startsWith("tx:"))?.amount)
  assert.equal(plan.similarLightCounters(free, INSTALL, ip).some((c) => c.subject.startsWith("use:")), false)
  assert.equal(useSubject("write", "tx:1"), "use:write:tx:1")
})

test("every path that takes an answer names its kind", () => {
  assert.match(read("netlify/functions/v2-chat.mts"), /const counters = withUse\(\[[\s\S]{0,260}\], history \? "chats" : google \? "google" : "chat"\)/)
  assert.match(read("netlify/shared/translate.mts"), /answer: withUse\(countersFor\(access, installId, ip, extra\), "translate"\)/)
  assert.match(read("netlify/functions/v2-write.mts"), /answer: withUse\(countersFor\(access, installId, ip, extra\), "write"\)/)
  assert.match(read("netlify/functions/v2-find.mts"), /const counters = withUse\(countersFor\([^)]*\), await inviteExtra\([^)]*\)\), "chats"\)/)
  // Where answers are charged with countersFor, it's one of those (status only reads).
  for (const file of ["netlify/functions/v2-chat.mts", "netlify/shared/translate.mts", "netlify/functions/v2-write.mts", "netlify/functions/v2-find.mts", "netlify/functions/v2-status.mts", "netlify/shared/plan.mts"]) assert.ok(read(file).includes("countersFor("), file)
  // The translation of a page's controls alone takes no answer, so it has no kind (build 107, PR #203).
  assert.doesNotMatch(read("netlify/shared/translate.mts").slice(read("netlify/shared/translate.mts").indexOf("export function controlsCounters")), /withUse|countersFor\(/)
})

test("status says what this period's answers went on, and refunds come off them too", async () => {
  const ip = "ip:203.0.113.9"
  // Free: a page translated, two chat answers (one given back after it failed), a Google answer.
  await db.consume(plan.withUse(plan.countersFor(free, INSTALL, ip), "translate"))
  await db.consume(plan.withUse(plan.countersFor(free, INSTALL, ip), "chat"))
  const failed = plan.withUse(plan.countersFor(free, INSTALL, ip), "chat")
  await db.consume(failed)
  await db.refund(failed)
  await db.consume(plan.withUse([...plan.countersFor(free, INSTALL, ip), ...plan.searchCountersFor(free, INSTALL)], "google"))
  const body = await statusNow()
  assert.equal(body.usage.used, 3)
  assert.deepEqual(body.usage.by, { chat: 1, google: 1, translate: 1 })
  assert.deepEqual(spentRows(body.usage.used, body.usage.by)?.map((r) => r.kind), ["chat", "google", "translate"])
  // An answer charged before the breakdown existed: «Other».
  await db.consume(plan.countersFor(free, INSTALL, ip))
  const later = await statusNow()
  assert.deepEqual(spentRows(later.usage.used, later.usage.by)?.at(-1), { kind: "other", n: 1 })
})

test("the panel: a tap on the count in «+» or in Settings opens the details; the number by the field opens «+» with them", () => {
  const app = read("src/content/App.tsx")
  const plus = read("src/content/quiet/Plus.tsx")
  assert.match(plus, /\{usage && spent \? \(\s*<SpentCount cls="cf-plus-usage" text=\{usage\} after=\{after\} load=\{spent\.load\} paid=\{spent\.paid\} startOpen=\{spent\.open\}/)
  assert.match(app, /spent=\{ownKeyActive \|\| !usage \? undefined : \{\s*load: loadSpent,\s*paid: hasPro\(plan\),\s*open: spentAsk,/)
  assert.match(app, /a: "spent", via: "number" \}\)\s*setSpentAsk\(true\)\s*setPlusOpen\(true\)/)
  // Read fresh: the subscription's other devices count too.
  assert.match(app, /const loadSpent = useCallback\(async \(\): Promise<Usage \| null> => \{\s*const next = await sendBackground<StatusInfo>\(\{ type: "status", refresh: true, fresh: true, platform \}\)/)
  const settings = read("src/content/Settings.tsx")
  assert.match(settings, /<SpentCount\s*cls="cf-set-spent"\s*text=\{usageText\(usage, plan\)\}\s*load=\{props\.loadSpent\}\s*paid=\{hasPro\(plan\)\}/)
  assert.match(app, /loadSpent=\{loadSpent\}/)
  const spent = read("src/content/quiet/Spent.tsx")
  // What's free, and whose answers these are.
  assert.match(spent, /<p class="cf-spent-note">\{t\("spentFree"\)\}<\/p>\s*<p class="cf-spent-note">\{t\(paid \? "spentAllDevices" : "spentThisDevice"\)\}<\/p>/)
  assert.match(spent, /t\(period === "week" \? "spentTitleWeek" : "spentTitleDay"\)/)
  assert.deepEqual(useFields({ f: "quiet", a: "spent", via: "settings" }), { f: "quiet", a: "spent", via: "settings" })
  assert.ok(FEATURES.quiet.actions.includes("spent"))
  assert.deepEqual([...USE_KINDS], ["chat", "google", "translate", "write", "chats", "similar"])
})

test("the details' words, in all 15 languages, translated", () => {
  const en = JSON.parse(read("src/locales/en.json"))
  const keys = ["spentShow", "spentTitleDay", "spentTitleWeek", "spentChat", "spentGoogle", "spentTranslate", "spentOther", "spentNone", "spentFree", "spentAllDevices", "spentThisDevice", "spentError"]
  for (const lang of LANGS) {
    const m = JSON.parse(read(`src/locales/${lang}.json`))
    for (const key of keys) {
      assert.ok(typeof m[key] === "string" && m[key].length > 1, `${lang} ${key}`)
      if (lang !== "en") assert.notEqual(m[key], en[key], `${lang} ${key} is translated`)
    }
    // The rows named by the panel's own words.
    for (const key of ["writeCheck", "writeRewrite", "writeCompose", "upsellHistoryName", "actSimilar"]) assert.ok(m[key], `${lang} ${key}`)
  }
})
