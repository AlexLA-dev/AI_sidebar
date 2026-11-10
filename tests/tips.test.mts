// Tips 2.5c (the owner's notes on 2.5 (78)): the app's Tips fold by block, "On all your devices" stands before the
// blocks, the last block is "Privacy & personalization"; the panel's "…" → Tips shows the same blocks, texts and
// Pro badges (read from the app's code and catalog when the extension is built), and /features keeps their order.
// Tips 2.5d (2.5 (81)): "Deeper work"; a block's title stays at the top while its cards scroll; the sheet plays the
// app's clips from the extension's own files, each loaded once its card is on screen.
// Tips 2.6 (91), the owner: «в Tips не добавлен новый функционал»: the selection's quick actions, Find similar and
// Listen (Ultra, with Ultra's badge), and a block of its own for the plan (monthly or yearly, the plan's tour).

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

// @ts-expect-error: a plain .mjs module (the build's own)
import { CATALOG_LANG, tipClips, tipKey, tipsData, tipsMessages, tipTexts } from "../scripts/tips-source.mjs"

const root = new URL("..", import.meta.url).pathname
const data = tipsData(root)
const locales = new URL("../src/locales/", import.meta.url)
const en = JSON.parse(readFileSync(new URL("en.json", locales), "utf8")) as Record<string, string>
const PRO = ["Ask about a video", "PDFs on the page", "AI search", "Ask your chats", "Where it belongs", "Your tags, suggested"]
const ULTRA = ["Find similar", "Listen"]

test("the app's Tips, as the build reads them: seven blocks in order, iCloud before them, the renamed last block", () => {
  assert.deepEqual(data.groups.map((g: any) => g.id), ["get-started", "deeper-work", "quick-insert", "watch-and-remind", "chats-in-order", "your-plan", "privacy-and-personalization"])
  assert.equal(data.groups.at(-1).title.en, "Privacy & personalization")
  assert.equal(data.lead.title.en, "On all your devices")
  const titles = data.groups.flatMap((g: any) => g.tips.map((t: any) => t.title.en))
  assert.ok(!titles.includes("On all your devices"), "iCloud isn't in a block any more")
  assert.deepEqual(data.groups.flatMap((g: any) => g.tips.filter((t: any) => t.pro).map((t: any) => t.title.en)), PRO)
  // 2.6: Ultra's own, with its badge (never both), at the end of "Deeper work".
  assert.deepEqual(data.groups.flatMap((g: any) => g.tips.filter((t: any) => t.ultra).map((t: any) => t.title.en)), ULTRA)
  assert.ok(data.groups.every((g: any) => g.tips.every((t: any) => !(t.pro && t.ultra))))
  assert.deepEqual(data.groups[1].tips.slice(-2).map((t: any) => t.title.en), ULTRA)
  // A Mac's own words where they differ.
  const swipes = data.groups[1].tips.find((t: any) => t.title.en === "Swipe to pin or delete")
  assert.equal(swipes.mac.title.en, "Pin or delete with a click")
  // The selection's quick actions: touch first, and a Mac's own words for the same field.
  const chips = data.groups[0].tips.find((t: any) => t.title.en === "Quick actions under a selection")
  // Since 92 a Mac's pop-up has the same field and chips: the same title, its own words (trackpad, wheel, click).
  assert.equal(chips.mac.title.en, "Quick actions under a selection")
  assert.match(chips.mac.text.en, /trackpad or the mouse wheel and click/)
  // The plan's own block, before the last one: monthly or yearly, then the plan's tour.
  assert.deepEqual(data.groups.at(-2).tips.map((t: any) => t.title.en), ["Monthly or yearly", "What your plan adds"])
  assert.equal(data.groups.at(-2).title.en, "Your plan")
  assert.equal(data.heading.en, "Tips")
  assert.equal(data.groups[1].title.en, "Deeper work")
})

test("every card's clip, as the app shows it: on iPhone and iPad, on a Mac only where the app has one there", () => {
  const app = (lang: string) => readdirSync(join(root, "ContextFlow/Shared (App)/TipClips", lang)).filter((f) => f.endsWith(".mp4")).map((f) => f.replace(/\.mp4$/, "")).sort()
  // Every app clip is shown by a card, and every card's clip is there in both languages.
  assert.deepEqual(tipClips(data), app("en"))
  assert.deepEqual(tipClips(data), app("ru"))
  const tip = (title: string) => data.groups.flatMap((g: any) => g.tips).find((t: any) => t.title.en === title)
  assert.equal(tip("Share what you found").clip, "share")
  // 2.6 (93): moving ✦ aside is a first-block card with the clip; hiding it, under personalization, has none.
  assert.equal(tip("Move ✦ out of the way").clip, "button")
  assert.ok(data.groups[0].tips.some((t: any) => t.title.en === "Move ✦ out of the way"), "in Get started")
  assert.ok(!tip("Hide ✦ when you don't need it").clip)
  // No clip on a Mac where the app shows none: the touch ones and the button by a field.
  for (const title of ["Open it on any page", "Swipe to pin or delete", "Insert into any field", "Copied, kept for a day", "Quick actions under a selection", "Find similar"]) {
    assert.ok(tip(title).clip, title)
    assert.ok(tip(title).mac && !tip(title).mac.clip, `${title}: none on a Mac`)
  }
  // Listen: iPhone and iPad hand it to the app, so the panel's player (the clip) is a Mac's only.
  assert.ok(!tip("Listen").clip && tip("Listen").mac.clip === "listen")
  assert.equal(tip("Monthly or yearly").clip, "yearly")
  assert.ok(!tip("What your plan adds").clip, "the tour's card has no clip yet")
  // The site's web versions (/features): English, each with its still.
  for (const name of tipClips(data)) {
    for (const ext of ["mp4", "jpg"]) assert.ok(existsSync(join(root, "site/clips", `${name}.${ext}`)), `site/clips/${name}.${ext}`)
  }
})

test("every Tips text is translated in the app's catalog, in every language the extension has", () => {
  const catalog = JSON.parse(readFileSync(join(root, "ContextFlow/Shared (App)/Localizable.xcstrings"), "utf8")).strings
  for (const t of tipTexts(data)) {
    for (const code of Object.values(CATALOG_LANG) as string[]) {
      const unit = catalog[t.en]?.localizations?.[code]?.stringUnit
      assert.ok(unit?.state === "translated" && unit.value, `${code}: ${t.en.slice(0, 50)}`)
    }
  }
  for (const word of ["Expanded", "Collapsed"]) {
    for (const code of Object.values(CATALOG_LANG) as string[]) assert.ok(catalog[word]?.localizations?.[code]?.stringUnit?.value, `${code}: ${word}`)
  }
  assert.ok(!("Settings & privacy" in catalog), "the old block name is gone")
  assert.ok(!("Every day" in catalog), "the old block name is gone")
  assert.equal(catalog["Deeper work"].localizations.ru.stringUnit.value, "Вникать глубже")
})

test("each extension language gets every Tips text, under keys no panel string uses, and its clips' language", () => {
  const keys = [...tipTexts(data).map((t: any) => t.key), data.clipLang.key]
  for (const file of readdirSync(locales).filter((f) => f.endsWith(".json"))) {
    const lang = file.replace(/\.json$/, "")
    const own = JSON.parse(readFileSync(new URL(file, locales), "utf8")) as Record<string, string>
    const tips = tipsMessages(root, data, lang)
    assert.deepEqual(Object.keys(tips).sort(), [...keys].sort(), lang)
    for (const key of keys) assert.ok(!(key in own), `${lang}: ${key} is a panel string too`)
    // The clips are in the extension now: no "With videos: in the app" line.
    assert.ok(!("tipsVideos" in own), `${lang}: tipsVideos`)
    assert.equal(tips[data.clipLang.key], lang === "ru" ? "ru" : "en", lang)
    if (lang !== "en") assert.notEqual(tips[data.groups[0].title.key], "Get started", `${lang}: translated`)
  }
  assert.equal(tipsMessages(root, data, "ru")[data.groups.at(-1).title.key], "Приватность и персонализация")
  assert.equal(tipKey("Tips"), data.heading.key)
})

test("/features: the app's blocks in the app's order, the same cards and Pro and Ultra badges, iCloud first", () => {
  const html = readFileSync(join(root, "site/features.html"), "utf8")
  const plain = (s: string) => s.replace(/<span class="(pro|ultra)-badge">(Pro|Ultra)<\/span>/, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()
  const sections = [...html.matchAll(/<section id="([a-z-]+)">\s*<h2>([^<]+)<\/h2>([\s\S]*?)<\/section>/g)]
  assert.deepEqual(sections.map((m) => m[1]), data.groups.map((g: any) => g.id))
  sections.forEach((m, i) => {
    const group = data.groups[i]
    assert.equal(plain(m[2]), group.title.en)
    const cards = [...m[3].matchAll(/<h3>(.*?)<\/h3>/g)].map((c) => c[1])
    assert.deepEqual(cards.map(plain), group.tips.map((t: any) => t.title.en), group.id)
    assert.deepEqual(cards.map((c) => c.includes("pro-badge")), group.tips.map((t: any) => Boolean(t.pro)), `${group.id}: Pro badges`)
    assert.deepEqual(cards.map((c) => c.includes("ultra-badge")), group.tips.map((t: any) => Boolean(t.ultra)), `${group.id}: Ultra badges`)
  })
  const lead = /<article class="feat feat-lead"[^>]*><h3>(.*?)<\/h3>/.exec(html)
  assert.equal(lead?.[1], data.lead.title.en)
  assert.ok(lead!.index < html.indexOf("<section id="), "before the blocks")
  // The jump links name the blocks the same way.
  const jump = [...(/<div class="jump">(.*?)<\/div>/.exec(html)?.[1] ?? "").matchAll(/href="#([a-z-]+)">([^<]+)</g)]
  assert.deepEqual(jump.map((j) => [j[1], plain(j[2])]), data.groups.map((g: any) => [g.id, g.title.en]))
  // Each card plays the app's clip (as on iPhone, or a Mac's where only a Mac has one: Listen), cards without one have
  // none.
  sections.forEach((m, i) => {
    const clips = [...m[3].matchAll(/<article class="feat">(.*?)<\/article>/g)].map((a) => /data-src="\/clips\/([\w-]+)\.mp4"/.exec(a[1])?.[1] ?? null)
    assert.deepEqual(clips, data.groups[i].tips.map((t: any) => t.clip ?? t.mac?.clip ?? null), `${data.groups[i].id}: clips`)
  })
})

test("a block's title stays at the top while its cards scroll: in the sheet and on /features (the app pins its section headers)", () => {
  const sheet = readFileSync(join(root, "src/content/tips/tips.css"), "utf8")
  assert.match(sheet, /\.cf-tips-head \{ position: sticky;/)
  const site = readFileSync(join(root, "site/style.css"), "utf8")
  assert.match(site, /\.feat-head ~ section\[id\] > h2 \{ position: sticky;/)
  const swift = readFileSync(join(root, "ContextFlow/Shared (App)/ContentView.swift"), "utf8")
  assert.match(swift, /LazyVStack\(alignment: \.leading, spacing: 16, pinnedViews: \[\.sectionHeaders\]\)/)
})

// ------------------------------------------------------------ the panel's sheet and its menu item, rendered

let ui: any
let dom: any
let stored: Record<string, unknown> = {}
let messages: Record<string, string> = {}
// The sheet's IntersectionObserver, driven by hand: `seen(el)` puts an element on screen.
const watched: Array<{ el: Element; call: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void }> = []
const seen = (el: Element, on = true) => watched.filter((w) => w.el === el).forEach((w) => w.call([{ isIntersecting: on, target: el }]))
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
  dom.window.innerWidth = 375
  dom.window.innerHeight = 700
  Object.assign(globalThis, {
    IntersectionObserver: class {
      call: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void
      constructor(call: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) { this.call = call }
      observe(el: Element) { watched.push({ el, call: this.call }) }
      disconnect() {}
    },
    chrome: {
      i18n: { getMessage: (key: string) => messages[key] ?? "" },
      runtime: { getURL: (path: string) => `ext://cf/${path}` },
      storage: { local: { get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}), set: async (o: Record<string, unknown>) => void Object.assign(stored, o) } }
    }
  })
  const dir = mkdtempSync(join(tmpdir(), "cf-tips-"))
  const src = (p: string) => JSON.stringify(new URL(`../src/content/${p}`, import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { TipsSheet } from ${src("tips/TipsSheet.tsx")}
    import { PageMenu } from ${src("ux/PageMenu.tsx")}
    export function sheet(container: Element, mac: boolean) {
      render(h(TipsSheet, { mac, onClose() {} }), container)
    }
    export function close(container: Element) {
      render(null, container)
    }
    export function menu(container: Element, onTips?: () => void) {
      render(h(PageMenu, { reminders: 0, watches: 0, onLater() {}, onWatchPage() {}, onReminders() {}, onWatching() {}, onTips, onSettings() {}, onClose() {} }), container)
    }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname],
    loader: { ".css": "empty" }, define: { __TIPS__: JSON.stringify(data), __TARGET__: JSON.stringify("safari") }
  })
  ui = await import(pathToFileURL(out).href)
})

const box = () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  return el
}
const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ")
// Preact runs effects after a frame, or 100 ms without requestAnimationFrame (as here).
const tick = () => new Promise((resolve) => setTimeout(resolve, 150))
// Not bubbling: linkedom calls a target's listener again on the way up when an ancestor listens too (the sheet's
// backdrop does); a browser doesn't.
const click = (el: Element) => el.dispatchEvent(new dom.window.Event("click"))

test("the sheet: iCloud first, seven blocks, Get started open and the rest folded with their counts", async () => {
  stored = {}
  const r = box()
  ui.sheet(r, false)
  await tick()
  assert.match(text(r.querySelector(".cf-sheet-title")), /Tips/)
  const blocks = [...r.querySelectorAll(".cf-tips-block")] as Element[]
  assert.equal(blocks.length, 7)
  assert.deepEqual(blocks.map((b) => b.querySelector(".cf-tips-head")!.getAttribute("aria-expanded")), ["true", "false", "false", "false", "false", "false", "false"])
  assert.deepEqual(blocks.slice(1).map((b) => text(b.querySelector(".cf-tips-count")!)), data.groups.slice(1).map((g: any) => String(g.tips.length)))
  // The lead card and Get started's seven.
  const cards = [...r.querySelectorAll(".cf-tip-title")].map((c) => text(c as Element))
  assert.deepEqual(cards, [data.lead.title.en, ...data.groups[0].tips.map((t: any) => t.title.en)])
  // The clips are here now: no line sending to the app for them.
  assert.equal(r.querySelector(".cf-tips-app"), null)
})

test("a tap opens or folds a block, and the sheet opens next time as it was left", async () => {
  stored = {}
  const r = box()
  ui.sheet(r, false)
  await tick()
  click(r.querySelectorAll(".cf-tips-head")[4])
  await tick()
  assert.equal(r.querySelectorAll(".cf-tips-block")[4].getAttribute("class")?.includes("open"), true)
  click(r.querySelectorAll(".cf-tips-head")[0])
  await tick()
  assert.deepEqual(stored["cf:tipsOpen"], ["chats-in-order"])
  const again = box()
  ui.sheet(again, false)
  await tick()
  assert.deepEqual([...again.querySelectorAll(".cf-tips-head")].map((h: any) => h.getAttribute("aria-expanded")), ["false", "false", "false", "false", "true", "false", "false"])
})

test("Pro and Ultra badges on the app's Pro and Ultra cards; a Mac gets the Mac's words", async () => {
  stored = { "cf:tipsOpen": data.groups.map((g: any) => g.id) }
  const touch = box()
  ui.sheet(touch, false)
  await tick()
  const badged = [...touch.querySelectorAll(".cf-tip-title")].filter((c: any) => c.querySelector(".cf-pro-badge")).map((c: any) => text(c).replace(/Pro$/, "").trim())
  assert.deepEqual(badged, PRO)
  // 2.6: Ultra's badge (the panel's own .cf-ultra-badge) on Find similar and Listen.
  const ultra = [...touch.querySelectorAll(".cf-tip-title")].filter((c: any) => c.querySelector(".cf-ultra-badge")).map((c: any) => text(c).replace(/Ultra$/, "").trim())
  assert.deepEqual(ultra, ULTRA)
  assert.ok(text(touch).includes("Swipe to pin or delete"))
  const mac = box()
  ui.sheet(mac, true)
  await tick()
  assert.ok(text(mac).includes("Pin or delete with a click"))
  assert.ok(!text(mac).includes("Swipe to pin or delete"))
})

test("the clips' loading rule: nothing before Tips opens, then the open block's first three, the rest on screen", async () => {
  // Before Tips opens there is no sheet: the panel renders it only while it's open.
  const app = readFileSync(join(root, "src/content/App.tsx"), "utf8")
  assert.match(app, /\{view === "chat" && tipsOpen && \(\s*<TipsSheet /)
  assert.ok(!/<video|<iframe/.test(app), "no clip anywhere else in the panel")
  stored = {}
  messages = {}
  const r = box()
  ui.sheet(r, false)
  await tick()
  // 2.6 (91): each clip a frame of the extension's clip page, the app's clip from the App Group (no copies in the
  // extension): `still=1` waits on a frame, without it plays.
  const boxes = [...r.querySelectorAll(".cf-tip-clip")] as Element[]
  const clips = data.groups[0].tips.filter((t: any) => t.clip).map((t: any) => t.clip)
  assert.equal(boxes.length, clips.length, "Get started's cards; the folded blocks have none in the page")
  const src = (b: Element) => b.querySelector("iframe")?.getAttribute("src") ?? null
  const page = (name: string, lang = "en", still = false) => `ext://cf/dist/clip.html?name=${name}&lang=${lang}${still ? "&still=1" : ""}`
  // Opening Tips prepares three: the first plays, the next two wait on their still frame.
  assert.equal(boxes.filter(src).length, 3)
  assert.equal(src(boxes[0]), page(clips[0]))
  for (const i of [1, 2]) assert.equal(src(boxes[i]), page(clips[i], "en", true))
  assert.ok(boxes.slice(3).every((b) => !src(b)), "the rest: nothing yet")
  assert.ok(!r.querySelector("video"), "no clip from the extension's own files")
  // On screen: it loads and plays.
  seen(boxes[4])
  await tick()
  assert.equal(src(boxes[4]), page(clips[4]))
  assert.ok(!src(boxes[3]) && !src(boxes[5]))
  // A folded block opened: its cards come, still nothing loads until one is seen (or tapped).
  click(r.querySelectorAll(".cf-tips-head")[1])
  await tick()
  const deeper = [...r.querySelectorAll(".cf-tips-block")[1].querySelectorAll(".cf-tip-clip")] as Element[]
  assert.ok(deeper.length > 0 && deeper.every((b) => !src(b)))
  click(deeper[0])
  await tick()
  assert.ok(src(deeper[0])?.startsWith(page(data.groups[1].tips[0].clip)))
  // Tips closed: every clip let go (their frames gone).
  assert.ok(r.querySelectorAll("iframe").length >= 5)
  ui.close(r)
  await tick()
  assert.equal(r.querySelectorAll("iframe").length, 0)
})

test("the clips: in the panel's language; a Mac's own; the open block's first three wherever it is", async () => {
  const src = (b: Element | null) => b?.querySelector("iframe")?.getAttribute("src") ?? null
  // Russian: the Russian clips (the language chrome.i18n picks for every text).
  stored = {}
  messages = { [data.clipLang.key]: "ru" }
  const ru = box()
  ui.sheet(ru, false)
  await tick()
  assert.equal(src(ru.querySelector(".cf-tip-clip")), "ext://cf/dist/clip.html?name=open&lang=ru")
  messages = {}
  // A Mac: no clip where the app has none (opening it by a tap), so the first three start a card later.
  const mac = box()
  ui.sheet(mac, true)
  await tick()
  const macClips = data.groups[0].tips.map((t: any) => (t.mac ?? t).clip).filter(Boolean)
  assert.equal(mac.querySelectorAll(".cf-tip-clip").length, macClips.length)
  assert.equal(src(mac.querySelector(".cf-tip-clip")), `ext://cf/dist/clip.html?name=${macClips[0]}&lang=en`)
  // Left with Deeper work open (Get started folded): its first three, nothing of Get started.
  stored = { "cf:tipsOpen": ["deeper-work"] }
  const deeper = box()
  ui.sheet(deeper, false)
  await tick()
  const loaded = [...deeper.querySelectorAll(".cf-tip-clip")].map((b: any) => src(b)).filter(Boolean) as string[]
  assert.deepEqual(loaded.map((u) => new URL(u.replace("ext://cf/", "https://x/")).searchParams.get("name")), data.groups[1].tips.slice(0, 3).map((t: any) => t.clip))
  assert.equal(deeper.querySelectorAll(".cf-tips-block")[0].querySelectorAll("iframe").length, 0)
})

test("the header's \"…\": Tips under Other… (2.6 (91)), right after Settings", async () => {
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const r = box()
  let tips = 0
  ui.menu(r, () => tips++)
  const items = [...r.querySelectorAll("[role=menuitem]")] as Element[]
  assert.equal(text(items.at(-1)!).trim(), en.uxOther)
  assert.ok(!items.some((b) => text(b).trim() === "Tips"), "folded under Other…")
  click(items.at(-1)!)
  await flush()
  const group = [...r.querySelectorAll(".cf-page-more-group [role=menuitem]")] as Element[]
  assert.deepEqual(group.map((b) => text(b).trim()), [en.settings, "Tips"])
  click(group[1])
  assert.equal(tips, 1)
  const without = box()
  ui.menu(without)
  click([...without.querySelectorAll("[role=menuitem]")].at(-1) as Element)
  await flush()
  assert.ok(![...without.querySelectorAll("[role=menuitem]")].some((b: any) => text(b).trim() === "Tips"))
})
