// Reminders and watching apart (2.5 (77), the owner: "Watching isn't the same as Reminders, I wouldn't have looked
// for it there"). The director's split: two words and two icons everywhere, never one list. The header's "…" has
// "Remind me about this page…", "Reminders · N", "Watching · N" (where watching works) and Settings; each list
// shows its own rows and, empty, says where its own are set.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { fakeClock, fakeTimers } from "./fake-clock.mts"

const locales = new URL("../src/locales/", import.meta.url)
const en = JSON.parse(readFileSync(new URL("en.json", locales), "utf8")) as Record<string, string>

test("every language has both lists' words, and none still sends watching to Reminders", () => {
  for (const file of readdirSync(locales).filter((f) => f.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(new URL(file, locales), "utf8")) as Record<string, string>
    for (const key of ["uxWatching", "uxWatchingN", "uxNoWatching", "uxNoWatchingHint", "uxLater", "uxLaterTitle", "uxWatchPage", "uxReminders", "uxRemindersN"]) {
      assert.ok(s[key]?.trim(), `${file}: ${key}`)
    }
    assert.match(s.uxWatchingN, /\{0\}/, file)
    // "You're already watching 5 pages. Stop one in …": the watching list, not Reminders.
    const watching = s.uxWatching.slice(0, Math.min(5, s.uxWatching.length))
    assert.ok(s.watchFull.includes(watching), `${file}: watchFull names ${s.uxWatching}`)
    assert.ok(!s.watchFull.includes(s.uxReminders), `${file}: watchFull doesn't name ${s.uxReminders}`)
    // The empty Reminders list points to the "…" item by its new name.
    assert.ok(s.uxNoRemindersHint.includes(s.uxLaterTitle), `${file}: uxNoRemindersHint names ${s.uxLaterTitle}`)
    assert.equal(s.uxLater.replace(/…$/, ""), s.uxLaterTitle, file)
    // The empty Watching list names both ways: the eye on a value, and "… → Watch this page" (the director, 2.5 (77)).
    assert.ok(s.uxNoWatchingHint.includes(s.uxWatchPage.replace(/…$/, "")), `${file}: uxNoWatchingHint names ${s.uxWatchPage}`)
    assert.ok(!("watchTipEye" in s), `${file}: one tip for the bell and the eye now`)
  }
})

// ------------------------------------------------------------ the lists and the "…", rendered

let ui: any
let dom: any
// The components' timers (Preact's effects) on a fake clock: a test moves it on, so a busy machine can't change
// what it sees.
const clock = fakeClock()
;(globalThis as any).__laterClock = clock
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
  dom.window.innerWidth = 375
  dom.window.innerHeight = 700
  dom.document.getSelection = () => null
  const dir = mkdtempSync(join(tmpdir(), "cf-later-split-"))
  const src = (p: string) => JSON.stringify(new URL(`../src/content/${p}`, import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { RemindersSheet } from ${src("ux/RemindersSheet.tsx")}
    import { PageMenu } from ${src("ux/PageMenu.tsx")}
    import { SelIconsTip } from ${src("ux/SelTip.tsx")}
    export function list(container: Element, kind: "remind" | "watch", items: unknown[]) {
      render(h(RemindersSheet, { kind, items, onOpen() {}, onCancel() {}, onReschedule: async () => null, onClose() {} } as never), container)
    }
    export function tip(container: Element, watching: boolean) {
      render(h("div", { class: "cf-bubble touch" }, h(SelIconsTip, { watching })), container)
    }
    export function menu(container: Element, reminders: number, watches: number | null, watchPage?: () => void) {
      render(h(PageMenu, { reminders, watches, onLater() {}, onWatchPage: watchPage, onReminders() {}, onWatching() {}, onSettings() {}, onClose() {} }), container)
    }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname],
    loader: { ".css": "empty" },
    define: fakeTimers("__laterClock")
  })
  ui = await import(pathToFileURL(out).href)
})

const rows = [
  { id: "remind:c1:k1", kind: "remind", title: "Car chat", status: "Tomorrow 9:00", sortAt: 2, at: 2, text: "Check the range" },
  { id: "watch:w1", kind: "watch", title: "Shop", url: "https://shop.example/x", status: "Watching: price · checked a minute ago", sortAt: 1 }
]
// A container of its own each time (Preact keeps what it rendered into one).
const root = () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  return el
}
const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ")

test("Reminders shows the bells only; Watching the eyes only", () => {
  const r = root()
  ui.list(r, "remind", rows)
  assert.match(text(r.querySelector(".cf-sheet-title")), new RegExp(en.uxReminders))
  assert.equal(r.querySelectorAll(".cf-later-item").length, 1)
  assert.ok(text(r).includes("Car chat"))
  assert.ok(!text(r).includes("Shop"))

  const w = root()
  ui.list(w, "watch", rows)
  assert.match(text(w.querySelector(".cf-sheet-title")), new RegExp(en.uxWatching))
  assert.equal(w.querySelectorAll(".cf-later-row").length, 1)
  assert.ok(text(w).includes("Shop"))
  assert.ok(!text(w).includes("Car chat"))
})

test("an empty list says where its own are set", () => {
  const r = root()
  ui.list(r, "remind", rows.filter((x) => x.kind === "watch"))
  assert.ok(text(r).includes(en.uxNoReminders))
  assert.ok(text(r).includes(en.uxNoRemindersHint))
  const w = root()
  ui.list(w, "watch", rows.filter((x) => x.kind === "remind"))
  assert.ok(text(w).includes(en.uxNoWatching))
  assert.ok(text(w).includes("Select a price, stock or a date and tap the eye. For the whole page: … → Watch this page."))
})

test("the header's \"…\" (2.6 (91), the owner): each pair together, Remind me / Reminders · N, Watch this page / Watching · N where watching works, then Other… with Settings, folded", async () => {
  const safari = root()
  let watched = 0
  ui.menu(safari, 2, 3, () => watched++)
  const items = [...safari.querySelectorAll("[role=menuitem]")] as Element[]
  assert.deepEqual(items.map((b) => text(b).trim()), [
    en.uxLater, en.uxRemindersN.replace("{0}", "2"), en.uxWatchPage, en.uxWatchingN.replace("{0}", "3"), en.uxOther
  ])
  // "Watch this page…" opens watching's window for the whole page.
  ;(items[2] as HTMLElement).dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  assert.equal(watched, 1)
  // "Other…" unfolds Settings.
  ;(items[4] as HTMLElement).dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual([...safari.querySelectorAll(".cf-page-more-group [role=menuitem]")].map((b: Element) => text(b).trim()), [en.settings])
  const chrome = root()
  ui.menu(chrome, 0, null)
  assert.deepEqual([...chrome.querySelectorAll("[role=menuitem]")].map((b: Element) => text(b).trim()), [en.uxLater, en.uxReminders, en.uxOther])
})

test("the bubble's tip: once, one for both icons (the eye's line where watching works)", async () => {
  const store: Record<string, unknown> = {}
  Object.assign(globalThis, { chrome: { storage: { local: {
    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
    set: async (values: Record<string, unknown>) => void Object.assign(store, values)
  } } } })
  // The tip's effect (the fake clock), then its storage and render.
  const wait = () => clock.advance(120)
  const first = root()
  ui.tip(first, true)
  await wait()
  const lines = [...first.querySelectorAll(".cf-sel-tip span")].map((el: Element) => text(el).trim())
  assert.deepEqual(lines, [en.watchTipBell, en.watchTipWatch])
  // The next bubble: no tip.
  const second = root()
  ui.tip(second, true)
  await wait()
  assert.equal(second.querySelector(".cf-sel-tip"), null)
  // Where there's no watching (not Safari): the bell's line only.
  for (const key of Object.keys(store)) delete store[key]
  const plain = root()
  ui.tip(plain, false)
  await wait()
  assert.deepEqual([...plain.querySelectorAll(".cf-sel-tip span")].map((el: Element) => text(el).trim()), [en.watchTipBell])
})

test("the bubble: the bell on every selection, before watching's eye, in both rows (touch and Mac)", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.equal(app.match(/\{remindButton\(bubble\)\}\n\s*\{bubbleExtras\}/g)?.length, 2)
  const css = readFileSync(new URL("../src/content/ux/ux.css", import.meta.url), "utf8")
  // On touch screens an icon (the row stays one line); the tip is out of the bubble's flow.
  assert.match(css, /\.cf-bubble\.touch \.cf-sel-remind-l \{ display: none; \}/)
  assert.match(css, /\.cf-bubble \.cf-sel-tip \{\n\s*position: absolute;/)
})

test("\"Watch this page…\": the whole page in watching's window, a page that can't be watched offers a reminder", () => {
  const reg = readFileSync(new URL("../src/content/watch/register.tsx", import.meta.url), "utf8")
  assert.match(reg, /setPageWatch\(\(page\) => openWatchSheet\(\{ url: page\.url, title: page\.title, selection: null, how: "later", remind: \(\) => openLater\(\) \}\)\)/)
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  // Only where watching works, as "Watching · N".
  assert.match(app, /onWatchPage=\{view === "chat" && listsKind\("watch"\) && pageWatcher\(\) \?/)
})
