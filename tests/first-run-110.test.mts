// 2.7 (110): the owner's four notes on the first run of TestFlight 109.
//  1. The hint about dragging the panel and the ✦ button came a second time after «Got it»: every tab read the first
//     run's marks once, when its page loaded. Now each tab follows them, and «Got it» is written in the same tick.
//  2. «Open Safari» in the app led to a web search; now to the site's page in the person's language, only where that
//     page is in production.
//  3. The basics show the swipes (pin, delete; where tags are): a step of the tour and of the guided first request.
//  4. A test server in the app or in the committed extension is allowed on the TestFlight branch alone
//     (tests/test-build.test.mts has the app's half; the extension's and the archive's are here).
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import { STORAGE } from "../src/shared/types.ts"
import { FEATURES } from "../src/shared/usage.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const here = (path: string) => new URL(path, import.meta.url)

// ------------------------------------------------------------ 1. the first run's marks, in every tab

/** The panel's store as the build bundles it (its imports have no extensions: not Node's to load as they are). */
interface Store {
  hintsWith(known: readonly string[], add: readonly string[]): string[] | null
  markHintSeen(key: string | string[], known?: readonly string[]): Promise<void>
  onFirstRunChanged(listener: (change: { tourSeen?: boolean; hints?: string[] }) => void): () => void
}
let bundled: Promise<Store> | undefined
function store(): Promise<Store> {
  return (bundled ??= (async () => {
    const out = join(mkdtempSync(join(tmpdir(), "cf-first-run-110-")), "store.mjs")
    await build({ entryPoints: [here("../src/content/store.ts").pathname], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"] })
    return (await import(pathToFileURL(out).href)) as Store
  })())
}

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void
function fakeChrome(items: Record<string, unknown>) {
  const listeners: Listener[] = []
  const calls: string[] = []
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async (key: string) => {
          calls.push(`get ${key}`)
          return key in items ? { [key]: items[key] } : {}
        },
        set: async (more: Record<string, unknown>) => {
          calls.push(`set ${Object.keys(more).join(",")}`)
          Object.assign(items, more)
          for (const l of listeners) l(Object.fromEntries(Object.entries(more).map(([k, v]) => [k, { newValue: v }])), "local")
        }
      },
      onChanged: { addListener: (l: Listener) => listeners.push(l), removeListener: (l: Listener) => listeners.splice(listeners.indexOf(l), 1) }
    }
  }
  return { items, listeners, calls }
}

test("«Got it» is on its way to storage in the same tick as the tap, from what the panel knows", async () => {
  const { hintsWith, markHintSeen } = await store()
  const { items, calls } = fakeChrome({ [STORAGE.hintsSeen]: ["new27"] })
  const done = markHintSeen("side", ["new27"])
  // Before anything was awaited, the write has gone out (after the question about what was stored before it, which
  // nothing waits for). A page that goes away right after the tap (a link, Back) has still sent it.
  assert.deepEqual(calls, [`get ${STORAGE.hintsSeen}`, `set ${STORAGE.hintsSeen}`])
  await done
  assert.deepEqual(items[STORAGE.hintsSeen], ["new27", "side"])
  assert.equal(hintsWith(["new27", "side"], ["side"]), null)
  assert.deepEqual(hintsWith(["new27"], ["new27", "side", "side"]), ["new27", "side"])
})

test("what another tab added a moment ago isn't lost, and nothing is written when nothing changes", async () => {
  const { markHintSeen } = await store()
  // This tab still has the list without "chats" (its change is on the way); storage has it.
  const { items, calls } = fakeChrome({ [STORAGE.hintsSeen]: ["new27", "chats"] })
  await markHintSeen(["side"], ["new27"])
  assert.deepEqual([...(items[STORAGE.hintsSeen] as string[])].sort(), ["chats", "new27", "side"])
  calls.length = 0
  await markHintSeen("side", ["new27", "chats", "side"])
  assert.deepEqual(calls.filter((c) => c.startsWith("set")), [])
  // Without the panel's list (older callers): read, then written.
  const old = fakeChrome({})
  await markHintSeen("video")
  assert.deepEqual(old.items[STORAGE.hintsSeen], ["video"])
})

test("a tab hears the marks change: a hint put away elsewhere, the tour seen, the first run started over", async () => {
  const { onFirstRunChanged } = await store()
  const { listeners } = fakeChrome({})
  const heard: unknown[] = []
  const stop = onFirstRunChanged((change) => heard.push(change))
  const fire = (changes: Record<string, { newValue?: unknown }>, area = "local") => listeners.forEach((l) => l(changes, area))
  fire({ [STORAGE.hintsSeen]: { newValue: ["new27", "side"] } })
  fire({ [STORAGE.tourSeen]: { newValue: true } })
  // «Start as a new user» (src/shared/firstRun.ts): the tour's mark removed, the hints back to a new install's.
  fire({ [STORAGE.tourSeen]: {} })
  fire({ [STORAGE.hintsSeen]: { newValue: ["new27"] } })
  // Not ours: another key, another storage area, a list that isn't one.
  fire({ [STORAGE.settings]: { newValue: {} } })
  fire({ [STORAGE.hintsSeen]: { newValue: ["side"] } }, "sync")
  fire({ [STORAGE.hintsSeen]: { newValue: "side" } })
  assert.deepEqual(heard, [{ hints: ["new27", "side"] }, { tourSeen: true }, { tourSeen: false }, { hints: ["new27"] }, { hints: [] }])
  stop()
  fire({ [STORAGE.tourSeen]: { newValue: true } })
  assert.equal(heard.length, 5)
})

test("the panel keeps its hints and the tour's mark the same as the stored ones, and hands its list to the write", () => {
  const app = read("../src/content/App.tsx")
  assert.match(app, /return onFirstRunChanged\(\(change\) => \{\n\s+if \(change\.hints\) setHints\(change\.hints\)\n\s+if \(change\.tourSeen !== undefined\) setTourSeen\(change\.tourSeen\)\n\s+\}\)/)
  assert.match(app, /const known = hintsRef\.current \?\? \[\]\n\s+setHints\(\(seen\) => hintsWith\(seen \?\? \[\], add\) \?\? seen \?\? \[\]\)\n\s+void markHintSeen\(add, known\)/)
  // One place shows the hint, and one mark puts it away.
  assert.equal(app.split('hintDue("side")').length - 1, 1)
  assert.equal(app.split('doneHint("side")').length - 1, 1)
})

// ------------------------------------------------------------ 2. the page Safari opens on from the app

const setup = read("../ContextFlow/Shared (App)/Setup.swift")
const view = read("../ContextFlow/Shared (App)/ContentView.swift")
const firstPage = setup.match(/enum FirstPage \{\n[\s\S]*?\n\}\n/)?.[0] ?? ""
const list = (name: string) => [...(firstPage.match(new RegExp(`static let ${name}: Set<String> = \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
const SITE_LANGS = readdirSync(here("../site-i18n")).filter((f) => f.endsWith(".json") && f !== "source.json").map((f) => f.replace(".json", "").toLowerCase())

test("«Open Safari» leads to the site, nowhere to a web search", () => {
  assert.ok(firstPage, "enum FirstPage is in Setup.swift")
  for (const file of [setup, view]) assert.doesNotMatch(file, /x-web-search|www\.apple\.com/)
  assert.match(view, /private func openSafari\(\) \{\n[^}]*FirstPage\.open\(\)\n\s+\}/)
  assert.match(view, /static func openSafari\(\) \{\n\s+#if os\(iOS\)\n[^#]*FirstPage\.open\(\)\n\s+#else/)
  // Safari itself where the system can be told so, the plain address otherwise.
  assert.match(firstPage, /if #available\(iOS 17, \*\), let safari = URL\(string: "x-safari-\\\(page\.absoluteString\)"\)/)
  assert.match(firstPage, /static let site = "https:\/\/context-flow\.app"/)
})

test("every language the app opens without asking has that page on the site, and no site language is forgotten", () => {
  const live = list("live")
  const later = list("later")
  assert.ok(live.length >= 13)
  const page = firstPage.match(/static let page = "([^"]+)"/)?.[1]
  assert.equal(page, "features")
  for (const lang of [...live, ...later]) assert.ok(existsSync(here(`../site/${lang}/${page}.html`)), `site/${lang}/${page}.html`)
  assert.ok(existsSync(here(`../site/${page}.html`)), "the English page")
  assert.deepEqual([...live, ...later].sort(), [...SITE_LANGS].sort(), "the site's languages, each in one of the two lists")
  assert.deepEqual(live.filter((l) => later.includes(l)), [])
  // The site's own counter knows the page under this name in every language.
  assert.match(read("../site/visit.js"), /"\/features": "features"/)
})

test("the address, compiled and run: the person's language where it's in production, English otherwise", { skip: process.platform !== "darwin" || spawnSync("xcrun", ["--find", "swiftc"]).status !== 0 ? "needs a Mac's Swift compiler" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-first-page-"))
  const main = join(dir, "main.swift")
  // The app's own lists and functions; what touches the system (the defaults, the request, UIKit) is left out.
  const pure = firstPage.slice(0, firstPage.indexOf("    private static let confirmedKey")) + "}\n"
  writeFileSync(main, `import Foundation\n${pure}\nlet a = CommandLine.arguments\nprint(FirstPage.address(localization: a[1], confirmed: Set(a.dropFirst(2))))\n`)
  execFileSync("xcrun", ["swiftc", "-O", "-o", join(dir, "page"), main], { stdio: "pipe" })
  const address = (...args: string[]) => execFileSync(join(dir, "page"), args, { encoding: "utf8" }).trim()
  assert.equal(address("en"), "https://context-flow.app/features?utm_source=app")
  assert.equal(address("en-GB"), "https://context-flow.app/features?utm_source=app")
  assert.equal(address("de"), "https://context-flow.app/de/features?utm_source=app")
  assert.equal(address("ru"), "https://context-flow.app/ru/features?utm_source=app")
  assert.equal(address("pt-BR"), "https://context-flow.app/pt-br/features?utm_source=app")
  assert.equal(address("zh-Hans"), "https://context-flow.app/zh-hans/features?utm_source=app")
  assert.equal(address("zh-Hant"), "https://context-flow.app/zh-hant/features?utm_source=app")
  assert.equal(address("ar"), "https://context-flow.app/ar/features?utm_source=app")
  // Turkish isn't in production yet: English until its page has answered, then its own.
  assert.equal(address("tr"), "https://context-flow.app/features?utm_source=app")
  assert.equal(address("tr", "tr"), "https://context-flow.app/tr/features?utm_source=app")
  // A language the site doesn't have, and a confirmation that isn't for a `later` language.
  assert.equal(address("nl"), "https://context-flow.app/features?utm_source=app")
  assert.equal(address("nl", "nl"), "https://context-flow.app/features?utm_source=app")
})

// ------------------------------------------------------------ 3. the swipes in the basics

const LOCALES = ["en", "ar", "de", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]
const SWIPE_KEYS = ["tourSwipeTitle", "tourSwipeBody", "tourSwipeTitleMouse", "tourSwipeBodyMouse"] as const

test("the tour and the guided first request both have the step, before the chats, with the app's clip", () => {
  const tour = read("../src/content/Tour.tsx")
  const guide = read("../src/content/Guide.tsx")
  const app = read("../src/content/App.tsx")
  assert.match(tour, /\? \{ targets: \[\], always: true, icon: <Icon\.Pin \/>, title: "tourSwipeTitle", body: "tourSwipeBody", clip: "swipes" \}\n\s+: \{ targets: \[\], always: true, icon: <Icon\.Pin \/>, title: "tourSwipeTitleMouse", body: "tourSwipeBodyMouse", clip: "mac-pin" \}/)
  assert.match(tour, /swipeStep\(touch\),\n\s+chatsStep\(sync\),\n\s+MENU_STEP\n/)
  // Nothing of its own to light up (a first chat may be empty), and still shown.
  assert.match(tour, /all\.filter\(\(s\) => s\.always \|\| hasTarget\(panel, s\.targets\)\)/)
  assert.match(tour, /\{step\.clip && <TourClip key=\{step\.clip\} name=\{step\.clip\} \/>\}/)
  assert.match(guide, /"askSel", "answer2", "swipe", "chats", "chatList", "menu",/)
  assert.match(guide, /case "swipe":\n\s+return \{ \.\.\.swipeStep\(touch\), next: "tourNext", holds: false \}/)
  // After the second answer, then on to the chats (or the "…" before there's a chat list).
  assert.match(app, /guide === "answer2" && !streaming && !error && lastRole === "assistant"\) guideTo\("swipe"\)/)
  assert.match(app, /else if \(guide === "swipe"\) guideTo\(threadList\.length > 0 \? "chats" : "menu"\)/)
  assert.ok((FEATURES.tour.fields?.what as readonly string[]).includes("swipe"), "the step is counted like the others")
  // The clips are the app's own, in its Tips.
  for (const clip of ["swipes", "mac-pin"]) assert.ok(existsSync(here(`../ContextFlow/Shared (App)/TipClips/en/${clip}.mp4`)), clip)
})

test("its words, in all 15 languages, name the panel's own buttons", () => {
  const en = JSON.parse(read("../src/locales/en.json")) as Record<string, string>
  for (const locale of LOCALES) {
    const messages = JSON.parse(read(`../src/locales/${locale}.json`)) as Record<string, string>
    for (const key of SWIPE_KEYS) {
      assert.ok(messages[key]?.trim(), `${locale} ${key}`)
      if (locale !== "en") assert.notEqual(messages[key], en[key], `${locale} ${key} is translated`)
    }
    // Undo after a swipe, and the menu's three for a mouse, as the panel calls them.
    assert.ok(messages.tourSwipeBody.includes(messages.orgUndo), `${locale}: Undo`)
    for (const name of ["uxPin", "tagsButton", "uxDelete", "orgUndo"]) assert.ok(messages.tourSwipeBodyMouse.includes(messages[name]), `${locale}: ${name}`)
    for (const key of ["tourSwipeBody", "tourSwipeBodyMouse"]) assert.ok(messages[key].includes("…"), `${locale} ${key}: the "…"`)
    assert.ok(messages.tourSwipeBody.includes("🏷"), `${locale}: the tag button`)
  }
})

// ------------------------------------------------------------ 4. a test server stays on the TestFlight branch

/** The branch under test: a pull request's head, a pushed branch, or the one checked out here. */
function branch(): { head: string; base: string | null } {
  const env = process.env
  let head = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || ""
  if (!head) {
    try {
      head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", cwd: here("..") }).trim()
    } catch {
      head = ""
    }
  }
  return { head, base: env.GITHUB_BASE_REF || null }
}
const TESTFLIGHT_BRANCH = /^claude\/release-[\d.]+-tf$/

test("the committed extension talks to production, except on the TestFlight branch, which is never a pull request into another", () => {
  const production = read("../ContextFlow/Shared (App)/ChatAI.swift").match(/static let productionHost = "([^"]+)"/)?.[1] ?? ""
  assert.equal(production, "aisidebar.netlify.app")
  const background = read("../ContextFlow/Shared (Extension)/Resources/dist/background.js")
  // A deploy's own address (a permalink, a preview, a branch deploy) or a local stand.
  const other = background.match(/https:\/\/[a-z0-9-]+--aisidebar\.netlify\.app|http:\/\/localhost:\d+/g) ?? []
  const { head, base } = branch()
  if (other.length === 0) {
    assert.ok(background.includes(`https://${production}`), "the production address is in the bundle")
    return
  }
  assert.match(head, TESTFLIGHT_BRANCH, `the extension in ${head || "this checkout"} talks to ${other[0]}: a test server is for the TestFlight branch alone`)
  assert.ok(base === null || TESTFLIGHT_BRANCH.test(base), `the TestFlight branch's test server must not be merged into ${base}`)
})

test("what goes to the App Store and TestFlight is a Release build: a Debug one would be a test build whatever its server", () => {
  for (const scheme of ["ContextFlow (iOS)", "ContextFlow (macOS)"]) {
    const xml = read(`../ContextFlow/ContextFlow.xcodeproj/xcshareddata/xcschemes/${scheme}.xcscheme`)
    assert.match(xml, /<ArchiveAction\s+buildConfiguration = "Release"/, scheme)
  }
  // A stand's address is read in a Debug build only.
  const base = read("../ContextFlow/Shared (App)/ChatAI.swift").match(/static var base: URL \{\n[\s\S]*?\n    \}\n/)?.[0] ?? ""
  assert.match(base, /#if DEBUG\n\s+if let custom = UserDefaults\.standard\.string\(forKey: "CFApiBase"\)[^\n]*\n\s+#endif\n\s+return URL\(string: "https:/)
  // The row and its way back show under the one decision, and the mode can't start or count without it.
  assert.match(view, /if TestBuild\.isTest \{ NewUserPreviewSection\(\) \}/)
  assert.match(setup, /nonisolated static var isOn: Bool \{\n\s+TestBuild\.isTest && UserDefaults\.standard\.double\(forKey: key\) > 0\n\s+\}/)
  assert.match(setup, /func start\(\) \{\n\s+guard TestBuild\.isTest, !on else \{ return \}/)
})
