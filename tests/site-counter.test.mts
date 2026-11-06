import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { before, beforeEach, test } from "node:test"
import vm from "node:vm"

import { SITE_LABELS, SITE_PAGES, SITE_SOURCES } from "../src/shared/site.ts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

// ---- in-memory stand-in for cf_consume / cf_log ---------------------------
type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let events: { kind: string; install: string | null; data: Record<string, unknown> }[] = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  const fn = url.startsWith("https://db.test/rest/v1/rpc/") ? url.split("/rpc/")[1].split("?")[0] : ""
  if (fn === "cf_consume") {
    const items = body.p_items as Item[]
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) >= i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + 1))
    return Response.json({ allowed: !blocked, blocked: blocked?.subject ?? null, counters: [] })
  }
  if (fn === "cf_log") {
    events.push({ kind: body.p_kind, install: body.p_install, data: body.p_data })
    return Response.json(null)
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let site: (req: Request, ctx: any) => Promise<Response>
let serverConfig: { siteDailyLimit: number; siteGlobalDailyLimit: number }

before(async () => {
  serverConfig = (await import("../netlify/shared/config.mts")).config
  site = (await import("../netlify/functions/v2-site.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  serverConfig.siteDailyLimit = 300
  serverConfig.siteGlobalDailyLimit = 20000
})

function ctx(ip = "203.0.113.7") {
  const pending: Promise<unknown>[] = []
  return { ip, waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1"
async function send(body: unknown, { ua = SAFARI, ip = "203.0.113.7" } = {}) {
  const c = ctx(ip)
  // sendBeacon posts a string body as text/plain.
  const res = await site(new Request("https://context-flow.app/api/v2/site", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain;charset=UTF-8", "User-Agent": ua } }), c)
  await Promise.all(c.pending)
  return res
}

test("a visit and an App Store tap are logged with their two values only, without an install id", async () => {
  assert.equal((await send({ kind: "site_visit", src: "chatgpt", page: "home", installId: "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01", referrer: "https://chatgpt.com/c/123" })).status, 200)
  assert.equal((await send({ kind: "site_click", src: "chatgpt", label: "site_hero", page: "home" })).status, 200)
  assert.deepEqual(events, [
    { kind: "site_visit", install: null, data: { src: "chatgpt", page: "home" } },
    { kind: "site_click", install: null, data: { src: "chatgpt", label: "site_hero" } }
  ])
})

test("values outside the lists, other kinds and other methods are refused", async () => {
  for (const body of [
    { kind: "site_visit", src: "chatgpt.com", page: "home" },
    { kind: "site_visit", src: "chatgpt", page: "analytics" },
    { kind: "site_click", src: "google", label: "site_banner" },
    { kind: "site_click", src: "google", page: "home" },
    { kind: "app_open", src: "google", page: "home" },
    "not an object"
  ]) assert.equal((await send(body)).status, 400, JSON.stringify(body))
  const get = await site(new Request("https://context-flow.app/api/v2/site"), ctx())
  assert.equal(get.status, 405)
  assert.equal(events.length, 0)
})

test("crawlers and link previews are not counted", async () => {
  for (const ua of [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.80 Safari/537.36",
    "facebookexternalhit/1.1"
  ]) assert.equal((await send({ kind: "site_visit", src: "direct", page: "home" }, { ua })).status, 200)
  assert.equal(events.length, 0)
})

test("visits are capped per address and in all per day", async () => {
  serverConfig.siteDailyLimit = 2
  const visit = { kind: "site_visit", src: "google", page: "notes" }
  assert.equal((await send(visit)).status, 200)
  assert.equal((await send(visit)).status, 200)
  assert.equal((await send(visit)).status, 429)
  assert.equal((await send(visit, { ip: "198.51.100.4" })).status, 200)
  serverConfig.siteGlobalDailyLimit = 3
  assert.equal((await send(visit, { ip: "192.0.2.9" })).status, 429)
  assert.equal(events.length, 3)
})

// ---- the page script ------------------------------------------------------
const dir = new URL("../site/", import.meta.url)
const script = readFileSync(new URL("visit.js", dir), "utf8")

function load({ path = "/", search = "", referrer = "", userAgent = "", maxTouchPoints = 0, links = [] as unknown[] } = {}) {
  const sent: Record<string, unknown>[] = []
  let onClick: ((e: { target: unknown }) => void) | undefined
  class Element {}
  class Link extends Element {
    href: string
    constructor(href: string) { super(); this.href = href }
    closest() { return this.href.startsWith("https://apps.apple.com/") ? this : null }
  }
  vm.runInNewContext(script, {
    location: { pathname: path, search },
    document: { referrer, querySelectorAll: () => links, addEventListener: (type: string, fn: typeof onClick) => { if (type === "click") onClick = fn } },
    navigator: { userAgent, maxTouchPoints, sendBeacon: (url: string, data: string) => { assert.equal(url, "/api/v2/site"); sent.push(JSON.parse(data)); return true } },
    fetch: () => Promise.resolve(),
    URL, URLSearchParams, Element
  })
  return { sent, tap: (href: string) => onClick?.({ target: new Link(href) }) }
}

test("the page script names the source from utm_source first, then the referrer's host", () => {
  const cases: [Parameters<typeof load>[0], string][] = [
    [{ search: "?utm_source=chatgpt.com" }, "chatgpt"],
    [{ search: "?utm_source=perplexity" }, "perplexity"],
    [{ search: "?utm_source=newsletter" }, "other"],
    [{ referrer: "https://chatgpt.com/" }, "chatgpt"],
    [{ referrer: "https://www.perplexity.ai/search/abc" }, "perplexity"],
    [{ referrer: "https://copilot.microsoft.com/" }, "copilot"],
    [{ referrer: "https://gemini.google.com/app" }, "gemini"],
    [{ referrer: "https://claude.ai/" }, "claude"],
    [{ referrer: "https://www.bing.com/" }, "bing"],
    [{ referrer: "https://www.google.co.uk/" }, "google"],
    [{ referrer: "https://duckduckgo.com/" }, "duckduckgo"],
    [{ referrer: "https://forums.macrumors.com/threads/2493453/" }, "other"],
    [{ referrer: "https://context-flow.app/" }, "site"],
    [{ referrer: "https://aisidebar.netlify.app/support" }, "site"],
    [{ referrer: "" }, "direct"]
  ]
  for (const [where, src] of cases) {
    const { sent } = load(where)
    assert.deepEqual(sent, [{ kind: "site_visit", src, page: "home" }], JSON.stringify(where))
  }
})

test("the page script knows every indexable page by name and skips the rest", () => {
  const names: Record<string, string> = {
    "/": "home", "/index.html": "home", "/features": "features", "/safari-ai-extension-iphone": "safari_ai", "/notes-while-reading-safari.html": "notes",
    "/safari-summary-vs-chatgpt": "compare", "/support": "support", "/support/": "support", "/privacy": "privacy", "/terms": "terms",
    "/cases": "cases", "/cases/": "cases", "/cases/replies-and-forms": "case_fill", "/cases/studying.html": "case_study", "/cases/shopping": "case_shop", "/cases/planning": "case_plan"
  }
  for (const [path, page] of Object.entries(names)) assert.equal(load({ path }).sent[0]?.page, page, path)
  assert.deepEqual(load({ path: "/analytics" }).sent, [])
  assert.deepEqual([...new Set(Object.values(names))].sort(), [...SITE_PAGES].sort())
})

test("a tap on an App Store button sends its ct label with the visit's source", () => {
  const { sent, tap } = load({ path: "/notes-while-reading-safari", referrer: "https://chatgpt.com/" })
  tap("https://apps.apple.com/app/apple-store/id6759115793?pt=119037986&ct=page_notes&mt=8")
  tap("https://context-flow.app/support")
  assert.deepEqual(sent, [{ kind: "site_visit", src: "chatgpt", page: "notes" }, { kind: "site_click", src: "chatgpt", label: "page_notes" }])
})

test("the script is on every indexable page and not on /analytics; its lists match the server's", () => {
  // The case pages live in site/cases/.
  const pages = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".html"))
  for (const file of pages) {
    const html = readFileSync(new URL(file, dir), "utf8")
    const indexable = !/<meta name="robots" content="noindex/.test(html)
    assert.equal(html.includes('<script src="/visit.js" defer></script>'), indexable, file)
  }
  const labels = new Set(pages.flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/href="https:\/\/apps\.apple\.com[^"]*ct=([a-z0-9_]+)/g)].map((m) => m[1])))
  assert.deepEqual([...labels].sort(), [...SITE_LABELS].sort())
  const named = [...script.matchAll(/\["([a-z]+)", \//g)].map((m) => m[1])
  assert.deepEqual([...named, "other", "direct", "site"].sort(), [...SITE_SOURCES].sort())
})

test("on a Mac the App Store buttons open the Mac App Store and say so; an iPad (touch) keeps them", () => {
  // The owner, 2.5: a Mac visitor was sent to the iPhone and iPad app.
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
  const text = (t: string) => ({ nodeType: 3, textContent: t })
  const buttons = () => {
    const small = { nodeType: 1, textContent: "Download on the" }
    const span = { childNodes: [small, text("App Store")] }
    const hero = { href: "https://apps.apple.com/app/apple-store/id6759115793?pt=119037986&ct=site_hero&mt=8", querySelector: () => span, childNodes: [span], span }
    const footer = { href: "https://apps.apple.com/app/apple-store/id6759115793?pt=119037986&ct=site_footer&mt=8", querySelector: () => null, childNodes: [text("App Store")] }
    return { hero, footer }
  }
  const mac = buttons()
  load({ path: "/features", userAgent: MAC, links: [mac.hero, mac.footer] })
  assert.equal(mac.hero.href, "https://apps.apple.com/app/apple-store/id6759115793?pt=119037986&ct=site_hero&mt=12")
  assert.equal(mac.hero.span.childNodes[1].textContent, "Mac App Store")
  assert.equal(mac.hero.span.childNodes[0].textContent, "Download on the")
  assert.deepEqual([mac.footer.href.endsWith("&mt=12"), mac.footer.childNodes[0].textContent], [true, "Mac App Store"])
  const ipad = buttons()
  load({ path: "/features", userAgent: MAC, maxTouchPoints: 5, links: [ipad.hero, ipad.footer] })
  assert.deepEqual([ipad.hero.href.endsWith("&mt=8"), ipad.hero.span.childNodes[1].textContent, ipad.footer.childNodes[0].textContent], [true, "App Store", "App Store"])
})
