// Tips 2.5c (the owner's notes on 2.5 (78)): the app's Tips fold by block, "On all your devices" stands before the
// blocks, the last block is "Privacy & personalization"; the panel's "…" → Tips shows the same blocks, texts and
// Pro badges (read from the app's code and catalog when the extension is built), and /features keeps their order.

import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

// @ts-expect-error: a plain .mjs module (the build's own)
import { CATALOG_LANG, tipKey, tipsData, tipsMessages, tipTexts } from "../scripts/tips-source.mjs"

const root = new URL("..", import.meta.url).pathname
const data = tipsData(root)
const locales = new URL("../src/locales/", import.meta.url)
const en = JSON.parse(readFileSync(new URL("en.json", locales), "utf8")) as Record<string, string>
const PRO = ["Ask about a video", "PDFs on the page", "AI search", "Ask your chats", "Where it belongs", "Your tags, suggested"]

test("the app's Tips, as the build reads them: six blocks in order, iCloud before them, the renamed last block", () => {
  assert.deepEqual(data.groups.map((g: any) => g.id), ["get-started", "every-day", "quick-insert", "watch-and-remind", "chats-in-order", "privacy-and-personalization"])
  assert.equal(data.groups.at(-1).title.en, "Privacy & personalization")
  assert.equal(data.lead.title.en, "On all your devices")
  const titles = data.groups.flatMap((g: any) => g.tips.map((t: any) => t.title.en))
  assert.ok(!titles.includes("On all your devices"), "iCloud isn't in a block any more")
  assert.deepEqual(data.groups.flatMap((g: any) => g.tips.filter((t: any) => t.pro).map((t: any) => t.title.en)), PRO)
  // A Mac's own words where they differ.
  const swipes = data.groups[1].tips.find((t: any) => t.title.en === "Swipe to pin or delete")
  assert.equal(swipes.mac.title.en, "Pin or delete with a click")
  assert.equal(data.heading.en, "Tips")
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
})

test("each extension language gets every Tips text, under keys no panel string uses, and the videos line", () => {
  const keys = tipTexts(data).map((t: any) => t.key)
  for (const file of readdirSync(locales).filter((f) => f.endsWith(".json"))) {
    const lang = file.replace(/\.json$/, "")
    const own = JSON.parse(readFileSync(new URL(file, locales), "utf8")) as Record<string, string>
    const tips = tipsMessages(root, data, lang)
    assert.deepEqual(Object.keys(tips).sort(), [...keys].sort(), lang)
    for (const key of keys) assert.ok(!(key in own), `${lang}: ${key} is a panel string too`)
    assert.match(own.tipsVideos ?? "", /\{0\}/, `${lang}: tipsVideos`)
    if (lang !== "en") assert.notEqual(tips[data.groups[0].title.key], "Get started", `${lang}: translated`)
  }
  assert.equal(tipsMessages(root, data, "ru")[data.groups.at(-1).title.key], "Приватность и персонализация")
  assert.equal(tipKey("Tips"), data.heading.key)
})

test("/features: the app's blocks in the app's order, the same cards and Pro badges, iCloud first", () => {
  const html = readFileSync(join(root, "site/features.html"), "utf8")
  const plain = (s: string) => s.replace(/<span class="pro-badge">Pro<\/span>/, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()
  const sections = [...html.matchAll(/<section id="([a-z-]+)">\s*<h2>([^<]+)<\/h2>([\s\S]*?)<\/section>/g)]
  assert.deepEqual(sections.map((m) => m[1]), data.groups.map((g: any) => g.id))
  sections.forEach((m, i) => {
    const group = data.groups[i]
    assert.equal(plain(m[2]), group.title.en)
    const cards = [...m[3].matchAll(/<h3>(.*?)<\/h3>/g)].map((c) => c[1])
    assert.deepEqual(cards.map(plain), group.tips.map((t: any) => t.title.en), group.id)
    assert.deepEqual(cards.map((c) => c.includes("pro-badge")), group.tips.map((t: any) => Boolean(t.pro)), `${group.id}: Pro badges`)
  })
  const lead = /<article class="feat feat-lead"[^>]*><h3>(.*?)<\/h3>/.exec(html)
  assert.equal(lead?.[1], data.lead.title.en)
  assert.ok(lead!.index < html.indexOf("<section id="), "before the blocks")
  // The jump links name the blocks the same way.
  const jump = [...(/<div class="jump">(.*?)<\/div>/.exec(html)?.[1] ?? "").matchAll(/href="#([a-z-]+)">([^<]+)</g)]
  assert.deepEqual(jump.map((j) => [j[1], plain(j[2])]), data.groups.map((g: any) => [g.id, g.title.en]))
})

// ------------------------------------------------------------ the panel's sheet and its menu item, rendered

let ui: any
let dom: any
let stored: Record<string, unknown> = {}
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
  dom.window.innerWidth = 375
  dom.window.innerHeight = 700
  Object.assign(globalThis, {
    chrome: {
      i18n: { getMessage: () => "" },
      storage: { local: { get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}), set: async (o: Record<string, unknown>) => void Object.assign(stored, o) } }
    }
  })
  const dir = mkdtempSync(join(tmpdir(), "cf-tips-"))
  const src = (p: string) => JSON.stringify(new URL(`../src/content/${p}`, import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { TipsSheet } from ${src("tips/TipsSheet.tsx")}
    import { PageMenu } from ${src("ux/PageMenu.tsx")}
    export function sheet(container: Element, mac: boolean, onOpenApp?: () => void) {
      render(h(TipsSheet, { mac, onOpenApp, onClose() {} }), container)
    }
    export function menu(container: Element, onTips?: () => void) {
      render(h(PageMenu, { reminders: 0, watches: 0, onLater() {}, onWatchPage() {}, onReminders() {}, onWatching() {}, onTips, onSettings() {}, onClose() {} }), container)
    }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname],
    loader: { ".css": "empty" }, define: { __TIPS__: JSON.stringify(data) }
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

test("the sheet: iCloud first, six blocks, Get started open and the rest folded with their counts", async () => {
  stored = {}
  const r = box()
  ui.sheet(r, false)
  await tick()
  assert.match(text(r.querySelector(".cf-sheet-title")), /Tips/)
  const blocks = [...r.querySelectorAll(".cf-tips-block")] as Element[]
  assert.equal(blocks.length, 6)
  assert.deepEqual(blocks.map((b) => b.querySelector(".cf-tips-head")!.getAttribute("aria-expanded")), ["true", "false", "false", "false", "false", "false"])
  assert.deepEqual(blocks.slice(1).map((b) => text(b.querySelector(".cf-tips-count")!)), data.groups.slice(1).map((g: any) => String(g.tips.length)))
  // The lead card and Get started's six.
  const cards = [...r.querySelectorAll(".cf-tip-title")].map((c) => text(c as Element))
  assert.deepEqual(cards, [data.lead.title.en, ...data.groups[0].tips.map((t: any) => t.title.en)])
  assert.ok(text(r).includes(en.tipsVideos.replace("{0}", "Tips")))
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
  assert.deepEqual([...again.querySelectorAll(".cf-tips-head")].map((h: any) => h.getAttribute("aria-expanded")), ["false", "false", "false", "false", "true", "false"])
})

test("Pro badges on the app's Pro cards; a Mac gets the Mac's words", async () => {
  stored = { "cf:tipsOpen": data.groups.map((g: any) => g.id) }
  const touch = box()
  ui.sheet(touch, false)
  await tick()
  const badged = [...touch.querySelectorAll(".cf-tip-title")].filter((c: any) => c.querySelector(".cf-pro-badge")).map((c: any) => text(c).replace(/Pro$/, "").trim())
  assert.deepEqual(badged, PRO)
  assert.ok(text(touch).includes("Swipe to pin or delete"))
  const mac = box()
  ui.sheet(mac, true)
  await tick()
  assert.ok(text(mac).includes("Pin or delete with a click"))
  assert.ok(!text(mac).includes("Swipe to pin or delete"))
})

test("the videos line opens the app's Tips where it can, and is plain text where it can't", async () => {
  let opened = 0
  const safari = box()
  ui.sheet(safari, false, () => opened++)
  await tick()
  click(safari.querySelector("button.cf-tips-app"))
  assert.equal(opened, 1)
  const chrome = box()
  ui.sheet(chrome, false)
  await tick()
  assert.equal(chrome.querySelector("button.cf-tips-app"), null)
  assert.ok(chrome.querySelector("p.cf-tips-app"))
})

test("the header's \"…\": Tips right before Settings", () => {
  const r = box()
  let tips = 0
  ui.menu(r, () => tips++)
  const items = [...r.querySelectorAll("[role=menuitem]")] as Element[]
  assert.deepEqual(items.map((b) => text(b).trim()).slice(-2), ["Tips", en.settings])
  click(items.at(-2)!)
  assert.equal(tips, 1)
  const without = box()
  ui.menu(without)
  assert.ok(![...without.querySelectorAll("[role=menuitem]")].some((b: any) => text(b).trim() === "Tips"))
})
