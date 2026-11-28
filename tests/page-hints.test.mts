// 2.7, plan section 6 «Подсказки по странице в первые дни»: the page's kind from its markup (nothing leaves the device),
// the hint by plan (Free toward spending answers and the paid features, Pro toward Ultra's, Ultra toward what it hasn't
// tried; Free has no Find similar now, so its line offers Ultra), and the rules: only features not used yet, one line a
// page and one a day, the first 10 days or 5 lines, two ✕ in a row turn them off.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-page-hints-"))
  const src = new URL("../src/content/pagehints/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${src}detect.ts"\nexport * from "${src}rules.ts"\nexport { usedFrom } from "${src}store.ts"\nexport { similarAllowed } from "${new URL("../src/shared/similar.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const doc = (head: string, body = "") => parseHTML(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).document as unknown as Document
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const words = (n: number) => Array.from({ length: n }, () => `<p>${"Ein langer Absatz über die Stadt und ihre neue Brücke. ".repeat(6)}</p>`).join("")

test("the page's kind, from its markup and its words", () => {
  assert.equal(lib.pageKind(doc(ld({ "@type": "Product", name: "Desk", offers: { price: 199 } })), "https://shop.example/desk"), "product")
  assert.equal(lib.pageKind(doc(ld({ "@graph": [{ "@type": "WebPage" }, { "@type": "Product" }] })), "https://shop.example/x"), "product")
  assert.equal(lib.pageKind(doc('<meta property="og:type" content="product">'), "https://shop.example/x"), "product")
  assert.equal(lib.pageKind(doc("", '<span itemprop="price">19.99</span>'), "https://shop.example/x"), "product")
  assert.equal(lib.pageKind(doc(ld({ "@type": "MusicEvent", name: "Concert" })), "https://tickets.example/c"), "event")
  assert.equal(lib.pageKind(doc(ld({ "@type": "Recipe", name: "Borscht" })), "https://food.example/r"), "stay")
  assert.equal(lib.pageKind(doc(""), "https://www.youtube.com/watch?v=abc"), "video")
  assert.equal(lib.pageKind(doc("", '<form><input type="text"><input type="email"><textarea></textarea></form>'), "https://site.example/contact"), "form")
  assert.equal(lib.pageKind(doc("", '<form role="search"><input type="text"><input type="text"><input type="text"></form>'), "https://site.example/"), null, "a search form isn't a form to write in")
  assert.equal(lib.pageKind(doc("", `<article>${words(14)}</article>`), "https://news.example/a"), "article")
  assert.equal(lib.pageKind(doc("", `<nav>${words(40)}</nav><p>Kurz.</p>`), "https://site.example/"), null, "menus aren't prose")
  assert.equal(lib.pageKind(doc('<script type="application/ld+json">{broken</script>', "<p>Kurz.</p>"), "https://site.example/"), null)
})

test("the hint by plan: Free toward spending answers and the paid features, Pro toward Ultra's, Ultra toward the rest", () => {
  assert.deepEqual(lib.candidates("product", "free"), ["similar", "watch"])
  assert.deepEqual(lib.candidates("article", "free"), ["summary", "listen"])
  assert.deepEqual(lib.candidates("article", "pro"), ["listen", "summary"])
  assert.deepEqual(lib.candidates("article", "ultra"), ["listen", "summary"])
  assert.deepEqual(lib.candidates("video", "free"), ["video"])
  assert.deepEqual(lib.candidates("event", "free"), ["calendar", "remind"])
  // Free has no Find similar now: its line offers Ultra (the how-to says so).
  // Who has Find similar is its own rule (src/shared/similar.ts): Ultra; with #167 also Pro and Own key (light).
  assert.equal(lib.hasFeature("similar", "free"), false)
  assert.equal(lib.hasFeature("similar", "pro"), lib.similarAllowed("pro"))
  assert.equal(lib.hasFeature("similar", "ultra"), true)
  // Free's offer names both plans once Pro has the light search («В Pro — быстрый поиск, в Ultra — полный»).
  assert.equal(lib.offerKey("similar"), lib.similarAllowed("pro") ? "phSimilarBodyUpBoth" : "phSimilarBodyUp")
  assert.equal(lib.offerKey("video"), "phVideoBodyUp")
  assert.equal(lib.hasFeature("video", "pro"), true)
  assert.equal(lib.hasFeature("video", "free"), false)
  assert.equal(lib.hasFeature("summary", "free"), true)
  for (const id of Object.keys(lib.HINTS)) if (lib.HINTS[id].needs) assert.ok(lib.HINTS[id].bodyUp, `${id} offers its plan`)
})

const DAY = 86_400_000
const T0 = Date.UTC(2026, 10, 14, 9)

test("the rules: only what isn't used, one a day, 10 days or 5 lines, two ✕ in a row turn them off", () => {
  let s = lib.freshState(T0)
  assert.equal(lib.pickHint("product", "free", s, T0), "similar")
  s = lib.afterShown(s, "similar", T0)
  assert.equal(lib.pickHint("article", "free", s, T0 + 3_600_000), null, "one line a day")
  assert.equal(lib.pickHint("product", "free", s, T0 + DAY), "similar", "next day; shown once, not used")
  s = lib.afterShown(s, "similar", T0 + DAY)
  assert.equal(lib.pickHint("product", "free", s, T0 + 2 * DAY), "watch", "shown twice and never used: the next one")
  assert.equal(lib.pickHint("product", "free", lib.afterUsed(lib.freshState(T0), "similar"), T0), "watch", "used: never offered")
  assert.equal(lib.pickHint(null, "free", lib.freshState(T0), T0), null)
  assert.equal(lib.pickHint("product", "free", lib.freshState(T0), T0 + 11 * DAY), null, "after 10 days, none")
  let five = lib.freshState(T0)
  for (let i = 0; i < 5; i++) five = lib.afterShown(five, "summary", T0 + i * DAY)
  assert.equal(lib.mayShow(five, T0 + 6 * DAY), false, "after 5 lines, none")
  let x = lib.afterClose(lib.freshState(T0))
  assert.equal(x.off, false)
  assert.equal(lib.afterClose(lib.afterTap(x)).off, false, "a tap between them: not in a row")
  x = lib.afterClose(x)
  assert.equal(x.off, true, "two ✕ in a row: off")
  assert.equal(lib.pickHint("product", "free", x, T0 + DAY), null)
})

test("one line a day by the device's clock, not UTC's", () => {
  const tz = process.env.TZ
  process.env.TZ = "Asia/Tokyo"
  try {
    const lateEvening = Date.UTC(2026, 10, 14, 14) // 23:00 in Tokyo on the 14th
    const pastMidnight = Date.UTC(2026, 10, 14, 16) // 01:00 in Tokyo on the 15th, the same UTC day
    const morning = Date.UTC(2026, 10, 14, 0) // 09:00 in Tokyo on the 14th, the same local day as the evening
    assert.equal(lib.dayOf(pastMidnight), "2026-11-15")
    const s = lib.afterShown(lib.freshState(morning), "similar", lateEvening)
    assert.equal(lib.pickHint("article", "free", s, pastMidnight), "summary", "a new day in Tokyo")
    const t = lib.afterShown(lib.freshState(morning), "similar", morning)
    assert.equal(lib.pickHint("article", "free", t, lateEvening), null, "still the 14th in Tokyo")
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
})

test("a long read in Chinese, Japanese or Korean is an article too, by how much it says", () => {
  const para = (text: string, n: number) => Array.from({ length: n }, () => `<p>${text}</p>`).join("")
  // About 1,800 characters of Chinese and of Japanese, 2,000 of Korean (it has spaces) in <article>: long reads (the
  // audit: CJK articles of 800 to 2,000 characters never were).
  const zh = "北京市政府今天宣布，明年将大幅增加公共交通投资，以缓解城市交通拥堵问题。专家认为这一举措将改善市民的出行体验。"
  const ja = "東京都は来年度予算案を発表した。防災対策費を大幅に増額し、首都直下地震への備えを強化する方針だ。都民の安全を守るため、"
  const ko = "서울시는 내년부터 대중교통 투자를 크게 늘리겠다고 밝혔다. 전문가들은 이번 조치가 시민들의 이동 편의를 높일 것이라고 평가했다. "
  assert.equal(lib.pageKind(doc("", `<article>${para(zh, 34)}</article>`), "https://news.example/zh"), "article")
  assert.equal(lib.pageKind(doc("", `<article>${para(ja, 30)}</article>`), "https://news.example/ja"), "article")
  assert.equal(lib.pageKind(doc("", `<article>${para(ko, 28)}</article>`), "https://news.example/ko"), "article")
  assert.equal(lib.pageKind(doc("", `<article>${para(zh, 6)}</article>`), "https://news.example/short"), null, "a short note isn't")
  assert.equal(lib.readLength("abc"), 3)
  assert.equal(lib.readLength("东京"), 5)
})

test("earlier use, read once from what the device keeps: Find similar and reminders in chats, watches, templates, Listen", () => {
  assert.deepEqual(lib.usedFrom({}), [])
  const used = lib.usedFrom({
    "cf:threads": { a: { m: [{ role: "user", content: "x", similarAsk: "" }, { role: "assistant", content: "y", remind: { at: 1 } }] } },
    "cf:watches": { w1: {} },
    "cf:templates": { t1: { deleted: true } },
    "cf:voiced": { abc: 1 }
  }).sort()
  assert.deepEqual(used, ["listen", "remind", "similar", "watch"], "a deleted template isn't one")
  assert.deepEqual(lib.usedFrom({ "cf:templates": { t1: { title: "Hi" } } }), ["templates"])
})

test("every hint's line, how-to and offer is in all 14 languages; the switch too", () => {
  const keys = new Set<string>(["phClose", "setPageHints", "setPageHintsHint", "phSimilarBodyUpBoth"])
  for (const spec of Object.values(lib.HINTS) as any[]) for (const k of [spec.bubble, spec.title, spec.body, spec.bodyUp]) if (k) keys.add(k)
  const dir = new URL("../src/locales/", import.meta.url)
  for (const file of readdirSync(dir)) {
    const strings = JSON.parse(readFileSync(new URL(file, dir), "utf8"))
    for (const k of keys) assert.ok(typeof strings[k] === "string" && strings[k].trim(), `${file}: ${k}`)
    assert.doesNotMatch(strings.phSummaryBody, /\{sum\}/, `${file}: the button's own name filled in`)
  }
})

test("wiring: never on a page in another language, the glow on the right button, the line on the circle's side", () => {
  const hook = readFileSync(new URL("../src/content/pagehints/PageHints.tsx", import.meta.url), "utf8")
  assert.match(hook, /if \(pageIsForeign\(\)\) return/)
  assert.match(hook, /FIRST_LOOK_MS = 6_500/, "not right as the page opens")
  assert.match(hook, /typing\(\)/, "not while typing")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /data-glow=\{pageHints\.glow \?\? undefined\}/)
  assert.match(app, /<div ref=\{revealOnce\}><Hint/, "the how-to scrolled into full view (it came under the question field on iPhone)")
  assert.match(app, /<HintLine id=\{pageHints\.line\} side=\{side\} top=\{fabTop\}/)
  // One hint at a time: the video's or PDF's waits (2.8: the coordinator's slot, src/content/coach).
  assert.match(app, /const chatFree = open && view === "chat" && !historyMode && partial === null && !pending && !pageHints\.chat/)
  assert.match(app, /const mediaDue = contextKind === "page" && source\.kind\(\) !== "page" && hintDue\(source\.kind\(\) as HintKey\)/)
  assert.match(app, /wantIf\("media_tip", chatFree && mediaDue\)/)
  const css = readFileSync(new URL("../src/content/pagehints/hints.css", import.meta.url), "utf8")
  for (const target of ["summarize", "similar", "menu", "composer"]) assert.match(css, new RegExp(`\\.cf\\[data-glow="${target}"\\]`), target)
  assert.match(css, /\.cf-ph\.left \{ left:/)
  const settings = readFileSync(new URL("../src/content/Settings.tsx", import.meta.url), "utf8")
  assert.match(settings, /<PageHintsSwitch \/>/)
  const index = readFileSync(new URL("../src/content/index.tsx", import.meta.url), "utf8")
  assert.match(index, /\$\{pageHintStyles\}/)
})
