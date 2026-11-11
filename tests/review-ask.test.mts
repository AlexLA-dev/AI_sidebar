// 2.6 (100), the owner: «почему я в аналитике вижу, что никому не предлагалось оценить приложение? И я сам ни разу не
// видел рейтер. Оно вообще работает?» and «Это обязательно должно работать в 2.6». The rating request end to end:
// Safari's good answers reach a milestone (counted as "due", written to the App Group), the app asks Apple when it next
// comes to the front ("ask"), marks it asked, and asks at its own good moments too; "Rate in App Store" in the panel's
// "…" and in the app's Settings. Only Apple's own request (guideline 5.6.1): nothing of ours says "rate us".
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { FEATURES, sessionFields, useFields } from "../src/shared/usage.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const app = (f: string) => read(`ContextFlow/Shared (App)/${f}`)

// ------------------------------------------------------------ the events

test("the registry keeps rate's due, ask and link with why and the milestone, nothing else", () => {
  assert.deepEqual(useFields({ f: "rate", a: "due", via: "ext_moment", moment: 3, s: "panel" }), { f: "rate", a: "due", via: "ext_moment", moment: 3 })
  // The app sends its fields as strings.
  assert.deepEqual(useFields({ f: "rate", a: "due", via: "app_answer", moment: "10" }), { f: "rate", a: "due", via: "app_answer", moment: 10 })
  for (const via of ["ext_moment", "app_answer", "tour", "purchase", "similar", "listen", "whatsnew", "organize"]) {
    assert.deepEqual(useFields({ f: "rate", a: "ask", via, moment: "30" }), { f: "rate", a: "ask", via, moment: 30 }, via)
  }
  for (const via of ["settings", "footer", "menu"]) assert.deepEqual(useFields({ f: "rate", a: "link", via }), { f: "rate", a: "link", via })
  // Not a step of the registry, an unknown way, a moment that isn't a count, text: left out.
  assert.equal(useFields({ f: "rate", a: "shown" }), null)
  assert.deepEqual(useFields({ f: "rate", a: "ask", via: "banner", moment: "lots", what: "great app" }), { f: "rate", a: "ask" })
  // The moment isn't the session's step number ("n"): both are kept, apart.
  assert.deepEqual(sessionFields({ n: 4, s: "app" }), { n: 4, s: "app" })
  // In Safari and in the app, since 2.6.
  assert.equal(FEATURES.rate.on, undefined)
  assert.equal(FEATURES.rate.tracked, "2.6")
  assert.ok(FEATURES.menu.fields?.what && (FEATURES.menu.fields.what as readonly string[]).includes("rate"))
})

test("Safari counts answers and, on a milestone, tells the app and returns it (counted as due)", async () => {
  const store: Record<string, unknown> = {}
  const native: Array<Record<string, unknown>> = []
  const g = globalThis as any
  const before = { chrome: g.chrome, browser: g.browser }
  g.chrome = {
    storage: { local: { get: async (key: string) => ({ [key]: store[key] }), set: async (items: Record<string, unknown>) => Object.assign(store, items) } },
    runtime: {}
  }
  g.browser = { runtime: { sendNativeMessage: async (_id: string, message: Record<string, unknown>) => { native.push(message); return { success: true } } } }
  try {
    const out = join(mkdtempSync(join(tmpdir(), "cf-review-sync-")), "sync.mjs")
    await build({ entryPoints: [join(root, "src/background/sync.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
    const { countValueMoment, REVIEW_MOMENTS } = await import(pathToFileURL(out).href)
    const due: number[] = []
    for (let i = 1; i <= 301; i++) {
      const moment = await countValueMoment()
      if (moment !== null) due.push(moment)
    }
    assert.deepEqual(due, [3, 10, 30, 100, 300])
    assert.deepEqual([...REVIEW_MOMENTS], [3, 10, 30, 100, 300])
    assert.deepEqual(native, due.map((count) => ({ command: "reviewMoment", count })))
    assert.equal(store["cf:valueMoments"], 301)
  } finally {
    g.chrome = before.chrome
    g.browser = before.browser
  }
})

test("the background counts only an answer that streamed to its end, and sends due from Safari with the milestone", () => {
  const bg = read("src/background/index.ts")
  assert.match(bg, /if \(event\.type === "done"\) \{\s*void countValueMoment\(\)\.then\(\(moment\) => \{\s*if \(moment && TARGET === "safari"\) void reportUse\(\{ type: "useEvent", f: "rate", a: "due", via: "ext_moment", moment \}\)/)
  // reportUse passes the milestone on (s "panel": Safari's side).
  assert.match(bg, /gap_s: message\.gap_s, moment: message\.moment, s: "panel"/)
  // An error, a refusal or a stop never emits "done" (chat.ts): only a finished answer counts.
  const chat = read("src/background/chat.ts")
  assert.match(chat, /else if \(event\.type === "done"\) \{\s*finished = true\s*emit\(\{ type: "done"/)
  // The extension's side writes it into the App Group for the app.
  const handler = read("ContextFlow/Shared (Extension)/SafariWebExtensionHandler.swift")
  assert.match(handler, /case "reviewMoment":\s*SharedDefaults\.shared\.recordReviewMoment\(\(message\["count"\] as\? NSNumber\)\?\.intValue \?\? 0\)/)
})

// ------------------------------------------------------------ the moment chain in the App Group

test("the App Group keeps Safari's moment until it's asked, then the next one; the app's answers count the same", () => {
  for (const copy of ["ContextFlow/Shared (App)/SharedDefaults.swift", "ContextFlow/Shared (Extension)/SharedDefaults.swift"]) {
    const s = read(copy)
    assert.match(s, /func recordReviewMoment\(_ count: Int\) \{\s*defaults\.set\(\["count": count, "at": Date\(\)\.timeIntervalSince1970\], forKey: reviewMomentKey\)/, copy)
    // Pending while it's newer than the last asked; asked: gone until the next milestone.
    assert.match(s, /return count > defaults\.integer\(forKey: reviewAskedKey\) \? count : nil/, copy)
    assert.match(s, /func markReviewAsked\(_ count: Int\) \{\s*defaults\.set\(count, forKey: reviewAskedKey\)/, copy)
    assert.match(s, /func countAppAnswer\(\) -> Int\? \{[\s\S]*?return \[3, 10, 30, 100, 300\]\.contains\(count\) \? count : nil/, copy)
    assert.match(s, /func goodAnswers\(\) -> Int \{[\s\S]*?max\(defaults\.integer\(forKey: appAnswersKey\), safari\)/, copy)
    assert.match(s, /func appFirstLaunch\(\) -> Double\? \{\s*defaults\.dictionary\(forKey: appKey\)\?\["firstLaunch"\] as\? Double/, copy)
  }
})

test("every ask goes through ReviewAsk: one requestReview, at the root, and each ask counted and marked", () => {
  const sources = readdirSync(join(root, "ContextFlow/Shared (App)")).filter((f) => f.endsWith(".swift"))
  const calls = sources.flatMap((f) => [...app(f).matchAll(/requestReview\(\)/g)].map(() => f))
  assert.deepEqual(calls, ["ContentView.swift"], "requestReview() only at the root view")
  assert.ok(!sources.some((f) => /askForReviewIfDue|askForReviewAfterAnswer|SKStoreReviewController/.test(app(f))), "no other way to ask")

  const content = app("ContentView.swift")
  assert.match(content, /\.onReceive\(ReviewAsk\.shared\.requests\) \{ askForReview\(\$0\) \}/)
  assert.match(content, /if ReviewAsk\.shared\.take\(request, busy: busy\) \{ requestReview\(\) \}/)
  // Not over something being done; Listen's player only unless its text was just heard to its end.
  assert.match(content, /var busy = tour\.run != nil \|\| showingSetup \|\| whatsNew \|\| \(listenShown\.visible && request\.via != \.listen\)/)
  assert.match(content, /if notify\.ask != nil \{ busy = true \}/)
  // Safari's moment: at launch and whenever the app comes to the front (iOS: twice over, one ask waits at a time).
  assert.equal([...content.matchAll(/ReviewAsk\.shared\.cameToFront\(\)/g)].length, 4)
  // A link from Safari to do something holds it.
  assert.match(content, /\["subscribe", "manage", "listen", "notifications"\]\.contains\(url\.host \?\? ""\) \{ ReviewAsk\.shared\.taskLink\(\) \}/)

  const ask = app("ReviewAsk.swift")
  assert.match(ask, /func take\(_ request: Request, busy: Bool\) -> Bool \{[\s\S]*?ReviewGate\.goesNow\(request\.via, state\)[\s\S]*?if let pending \{ SharedDefaults\.shared\.markReviewAsked\(pending\) \}[\s\S]*?ChatAI\.reportUse\("rate", "ask", fields\)/)
  // Marked only when Apple is asked: a held moment stays for the next time (before 2.6 (100) it was marked first).
  const take = ask.slice(ask.indexOf("func take("))
  assert.ok(take.indexOf("goesNow") < take.indexOf("markReviewAsked"))
  assert.match(ask, /func appAnswered\(\) \{\s*guard let moment = SharedDefaults\.shared\.countAppAnswer\(\) else \{ return \}\s*ChatAI\.reportUse\("rate", "due", \["via": ReviewGate\.Via\.appAnswer\.rawValue, "moment": String\(moment\)\]\)\s*ask\(\.appAnswer, moment: moment\)/)
  assert.match(ask, /guard let moment = SharedDefaults\.shared\.pendingReviewMoment\(\) else \{ return \}\s*ask\(\.extMoment, moment: moment\)/)
  // Apple doesn't say whether it showed: the comment says so.
  assert.match(ask, /Apple doesn't say\s*\/\/\/ whether its sheet showed/)
})

test("each good moment asks: the app's answers, the tour, a purchase, What's new, Listen to its end, Find similar, a suggestion", () => {
  const chats = app("ChatsView.swift")
  assert.equal([...chats.matchAll(/ReviewAsk\.shared\.appAnswered\(\)/g)].length, 2, "the chat's answers and Ask your chats")
  assert.match(chats, /private func won\(\) \{[\s\S]*?ReviewAsk\.shared\.ask\(\.organize, after: UndoClock\.move \+ UndoClock\.grace \+ 1\)/)
  // Undo takes it back.
  assert.match(chats, /private func undoMove\(_ undo: Organize\.MoveUndo\) \{\s*ReviewAsk\.shared\.cancel\(\.organize\)/)
  assert.match(chats, /undo: \{\s*ReviewAsk\.shared\.cancel\(\.organize\)/)
  const content = app("ContentView.swift")
  assert.match(content, /ReviewAsk\.shared\.ask\(\.tour, after: 1\)/)
  assert.match(content, /dismissButton: \.default\(Text\("OK"\)\) \{ ReviewAsk\.shared\.ask\(\.purchase, after: 0\.5\) \}/)
  assert.match(content, /if next != \.whatsNew \{\s*if whatsNewShown \{ ReviewAsk\.shared\.ask\(\.whatsNew\) \}/)
  assert.match(app("Listen.swift"), /if VoicedList\.shared\.mark\(id\) \{[\s\S]*?ReviewAsk\.shared\.ask\(\.listen\)/)
  assert.match(app("SimilarCards.swift"), /guard !close\.isEmpty, let at = answer\.at, Date\(\)\.timeIntervalSince1970 - at \/ 1000 < 2 \* 86_400 else \{ return \}\s*ReviewAsk\.shared\.ask\(\.similar, after: 2\)/)
})

test("both new files are in both apps", () => {
  const project = read("ContextFlow/ContextFlow.xcodeproj/project.pbxproj")
  for (const file of ["ReviewGate.swift", "ReviewAsk.swift"]) {
    assert.equal([...project.matchAll(new RegExp(`${file.replace(".", "\\.")} in Sources \\*/,`, "g"))].length, 2, file)
    assert.equal([...project.matchAll(new RegExp(`path = ${file.replace(".", "\\.")};`, "g"))].length, 1, file)
  }
})

// ------------------------------------------------------------ when it's asked (ReviewGate, built with swiftc)

const swiftc = spawnSync("which", ["swiftc"]).status === 0
const skip = process.platform !== "darwin" ? "the app's Foundation is Apple's: run on a Mac" : !swiftc && "no swiftc here"
const NOW = 1_800_000_000
const DAY = 86_400
const base = { firstSession: false, goodAnswers: 5, lastAsk: null as number | null, sinceTaskLink: null as number | null, busy: false, now: NOW }
const CASES: Array<{ name: string; via: string; goes: boolean } & Partial<typeof base>> = [
  { name: "Safari's milestone, back from Safari", via: "ext_moment", goes: true },
  { name: "Safari's milestone in the app's first session (Apple: never then)", via: "ext_moment", firstSession: true, goes: false },
  { name: "Safari's milestone, the app opened to buy a moment ago", via: "ext_moment", sinceTaskLink: 3, goes: false },
  { name: "Safari's milestone, that link long gone", via: "ext_moment", sinceTaskLink: 60, goes: true },
  { name: "Safari's milestone while the tour is up", via: "ext_moment", busy: true, goes: false },
  { name: "Safari's milestone a day after another ask (milestones aren't spaced)", via: "ext_moment", lastAsk: NOW - DAY, goes: true },
  { name: "the app's 3rd answer, in its first session", via: "app_answer", firstSession: true, goes: true },
  { name: "the app's answer while the player is up", via: "app_answer", busy: true, goes: false },
  { name: "the tour closed after a purchase", via: "tour", goes: true },
  { name: "You're all set", via: "purchase", sinceTaskLink: 2, goes: true },
  { name: "Listen heard to its end", via: "listen", goes: true },
  { name: "Listen, two good answers only", via: "listen", goodAnswers: 2, goes: false },
  { name: "Listen in the first session", via: "listen", firstSession: true, goes: false },
  { name: "Listen, asked three days ago", via: "listen", lastAsk: NOW - 3 * DAY, goes: false },
  { name: "Listen, asked eight days ago", via: "listen", lastAsk: NOW - 8 * DAY, goes: true },
  { name: "Listen handed over from Safari a moment ago", via: "listen", sinceTaskLink: 5, goes: false },
  { name: "Find similar's answer opened", via: "similar", goes: true },
  { name: "What's new left after an update", via: "whatsnew", goes: true },
  { name: "a suggestion taken", via: "organize", goes: true },
  { name: "a suggestion taken over a sheet", via: "organize", busy: true, goes: false }
]
const FIRST = [
  { name: "the very first launch (not recorded yet)", firstLaunch: null, now: NOW, left: false, first: true },
  { name: "first launched ten minutes ago, still here", firstLaunch: NOW - 600, now: NOW, left: false, first: true },
  { name: "first launched ten minutes ago, back from Safari", firstLaunch: NOW - 600, now: NOW, left: true, first: false },
  { name: "first launched yesterday", firstLaunch: NOW - DAY, now: NOW, left: false, first: false }
]

test("ReviewGate asks at the right moments and holds at the wrong ones", { skip }, () => {
  const bin = join(mkdtempSync(join(tmpdir(), "cf-review-")), "gate")
  execFileSync("swiftc", ["-O", "-swift-version", "6", "-default-isolation", "MainActor", join(root, "ContextFlow/Shared (App)/ReviewGate.swift"), join(root, "tests/review-gate/main.swift"), "-o", bin], { stdio: "pipe", timeout: 300_000, killSignal: "SIGKILL" })
  const input = JSON.stringify({
    cases: CASES.map(({ name: _n, goes: _g, ...c }) => ({ ...base, ...c })),
    first: FIRST.map(({ firstLaunch, now, left }) => ({ ...(firstLaunch === null ? {} : { firstLaunch }), now, left }))
  })
  const out = JSON.parse(execFileSync(bin, { input, timeout: 60_000, killSignal: "SIGKILL" }).toString()) as { goes: boolean[]; first: boolean[]; vias: string[]; milestones: number[] }
  CASES.forEach((c, i) => assert.equal(out.goes[i], c.goes, c.name))
  FIRST.forEach((c, i) => assert.equal(out.first[i], c.first, c.name))
  // The app's reasons are the registry's, and its milestones Safari's.
  for (const via of out.vias) assert.ok(FEATURES.rate.via?.includes(via), `${via} is in the registry`)
  assert.deepEqual(out.milestones, [3, 10, 30, 100, 300])
})

// ------------------------------------------------------------ "Rate in App Store"

test("Rate in App Store: in the panel's Other…, in the app's Settings; the App Store app on iPhone, the Mac App Store on a Mac", () => {
  const config = read("src/shared/config.ts")
  assert.match(config, /reviewApp: "itms-apps:\/\/apps\.apple\.com\/app\/id6759115793\?action=write-review"/)
  assert.match(config, /reviewMac: "macappstore:\/\/apps\.apple\.com\/app\/id6759115793\?action=write-review"/)
  const panel = read("src/content/App.tsx")
  assert.match(panel, /if \(TARGET === "safari" && touch\) followLink\(LINKS\.reviewApp\)\s*else if \(TARGET === "safari"\) void sendBackground\(\{ type: "rateApp" \}\)/)
  assert.match(panel, /void sendBackground\(\{ type: "useEvent", f: "rate", a: "link", via \}\)/)
  assert.match(panel, /onRate=\{TARGET === "safari" \? \(\) => \{/)
  // The panel's Settings link goes the same way.
  assert.match(panel, /onOpenUrl=\{\(url\) => \(url === LINKS\.review \? rateApp\("settings"\)/)
  const menu = read("src/content/ux/PageMenu.tsx")
  const other = menu.slice(menu.indexOf("cf-page-more-group"))
  assert.match(other, /\{onRate && <button type="button" role="menuitem" class="cf-page-rate" onClick=\{onRate\}><Icon\.Star size=\{16\} \/> \{t\("uxRate"\)\}<\/button>\}/)
  assert.match(read("src/background/index.ts"), /async function rateApp\(\): Promise<void> \{[\s\S]*?callNative<\{ opened\?: boolean \}>\("openApp", \{ url: LINKS\.reviewMac \}\)[\s\S]*?if \(!opened\) await chrome\.tabs\.create\(\{ url: LINKS\.review \}\)/)

  const content = app("ContentView.swift")
  assert.match(content, /#if os\(iOS\)\s*static let review = URL\(string: "https:\/\/apps\.apple\.com\/app\/id6759115793\?action=write-review"\)!\s*#else\s*static let review = URL\(string: "macappstore:\/\/apps\.apple\.com\/app\/id6759115793\?action=write-review"\)!/)
  assert.match(content, /ChatAI\.reportUse\("rate", "link", \["via": "settings"\]\)\s*openURL\(Links\.review\)\s*\} label: \{\s*Label\("Rate in App Store", systemImage: "star"\)/)
  assert.match(content, /ChatAI\.reportUse\("rate", "link", \["via": "footer"\]\)/)
})

test("the panel's Other… ends with Rate in App Store, and a tap on it rates", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>")
  const g = globalThis as any
  const saved = { window: g.window, document: g.document, Node: g.Node, Element: g.Element, ShadowRoot: g.ShadowRoot }
  Object.assign(g, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
  try {
    const dir = mkdtempSync(join(tmpdir(), "cf-review-menu-"))
    const out = join(dir, "menu.mjs")
    await build({
      stdin: { contents: `import { h, render } from "preact"\nimport { PageMenu } from ${JSON.stringify(join(root, "src/content/ux/PageMenu.tsx"))}\nexport const show = (el, onRate) => render(h(PageMenu, { reminders: 0, watches: 0, onReminders() {}, onWatching() {}, onSettings() {}, onRate, onClose() {} }), el)\nexport const hide = (el) => render(null, el)`, resolveDir: root, loader: "tsx" },
      bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
      jsx: "automatic", jsxImportSource: "preact", nodePaths: [join(root, "node_modules")], loader: { ".css": "empty" }
    })
    const ui = await import(pathToFileURL(out).href)
    const en = JSON.parse(read("src/locales/en.json")) as Record<string, string>
    const el = dom.document.createElement("div")
    dom.document.body.appendChild(el)
    let rated = 0
    ui.show(el, () => { rated++ })
    // Folded under Other… until it's tapped.
    assert.equal(el.querySelector(".cf-page-rate"), null)
    el.querySelector(".cf-page-other").dispatchEvent(new dom.window.Event("click", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const items = [...el.querySelectorAll(".cf-page-more-group [role=menuitem]")]
    assert.equal(items.at(-1)?.className, "cf-page-rate", "the last item")
    assert.equal(items.at(-1)?.textContent?.trim(), en.uxRate)
    items.at(-1)?.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
    assert.equal(rated, 1)
    // Without a way to rate (not Safari): no item.
    const plain = dom.document.createElement("div")
    ui.show(plain, undefined)
    plain.querySelector(".cf-page-other").dispatchEvent(new dom.window.Event("click", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(plain.querySelector(".cf-page-rate"), null)
    // Gone before the page is (its listeners are set a moment after it opens).
    ui.hide(el)
    ui.hide(plain)
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    Object.assign(g, saved)
  }
})

test("Rate in App Store is in all 14 languages, in the panel and the app", () => {
  const locales = join(root, "src/locales")
  const files = readdirSync(locales).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 14)
  for (const file of files) {
    const s = JSON.parse(readFileSync(join(locales, file), "utf8")) as Record<string, string>
    assert.ok(s.uxRate?.includes("App Store"), `${file}: uxRate`)
  }
  const catalog = JSON.parse(app("Localizable.xcstrings")).strings["Rate in App Store"].localizations as Record<string, { stringUnit: { value: string } }>
  assert.equal(Object.keys(catalog).length, 13)
  for (const [lang, v] of Object.entries(catalog)) assert.ok(v.stringUnit.value.includes("App Store"), lang)
})

// ------------------------------------------------------------ /analytics

test("/analytics shows due, ask and link per platform (cf_rate_report), and every way has its name", () => {
  const sql = read("supabase/migrations/20261111160000_contextflow_rate_report.sql")
  assert.match(sql, /create or replace function public\.cf_rate_report\(p_days integer default 28\)/)
  assert.match(sql, /ev\.kind = 'use' and ev\.data->>'f' = 'rate'/)
  // Our tests and App Review left out, as everywhere.
  assert.match(sql, /not exists \(select 1 from tests t where t\.id = r\.uid\)/)
  assert.match(sql, /not contextflow\.in_review_any/)
  assert.match(sql, /grant execute on function public\.cf_rate_report\(integer\) to service_role;/)
  assert.match(sql, /revoke all on function public\.cf_rate_report\(integer\) from public, anon, authenticated;/)
  assert.match(read("netlify/shared/db.mts"), /export const rateReport = \(days: number\) => rpc<Record<string, unknown>>\("cf_rate_report", \{ p_days: days \}\)/)
  const admin = read("netlify/functions/v2-admin-usage.mts")
  assert.match(admin, /rateReport\(days\)\.catch\(\(\) => null\)/)
  assert.match(admin, /rate_report: rate/)
  const page = read("site/analytics.html")
  assert.match(page, /ratePanel\(data\.rate_report\)/)
  assert.match(page, /"Устройство", "Момент наступил", "Попросили Apple", "«Оценить в App Store»", "Почему попросили"/)
  const via = page.slice(page.indexOf("const VIA_RU"), page.indexOf("}", page.indexOf("const VIA_RU")))
  for (const way of FEATURES.rate.via ?? []) assert.match(via, new RegExp(`\\b${way}: "`), way)
  const action = page.slice(page.indexOf("const ACTION_RU"), page.indexOf("}", page.indexOf("const ACTION_RU")))
  for (const a of FEATURES.rate.actions) assert.match(action, new RegExp(`\\b${a}: "`), a)
})
