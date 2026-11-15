// 2.7 «Подборки», part 2: the panel's «В подборку» and window, the AI's place, the PDF page, the site's /open-chat.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { addCard, addComparison, newCollection, placeBody, placeFromAi, setSummary, type Collection } from "../src/shared/collections.ts"
import { collectionHtml, openChatLink, SITE, type PageWords } from "../src/shared/collectionPage.ts"
import { useFields } from "../src/shared/usage.ts"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const WORDS: PageWords = {
  cards: "3 cards", date: "14 November 2026", madeWith: "made with", brand: "ContextFlow — AI for Safari", summary: "Summary",
  comparison: "Comparison", openChat: "Open chat in ContextFlow", footer: "Made with ContextFlow", lang: "en"
}

function trip(): Collection {
  let rec = newCollection("cf-col-1", "Trip <to> Japan", undefined, 1000, { id: "stay", name: "Stay" })
  rec = addCard(rec, { id: "a", sec: "stay", k: "answer", t: "Shinjuku is easy & busy", at: 1000, src: { url: "https://www.japan-guide.com/e/e3011.html", title: "Shinjuku" }, chat: "chat-1", msg: "k1", tags: ["trip"] }, 1001)
  rec = addCard(rec, { id: "b", sec: "stay", k: "answer", t: "Asakusa is quieter", at: 1002, src: { url: "https://jnto.go.jp/asakusa", title: "Asakusa" }, chat: "chat-2", msg: "k2" }, 1003)
  rec = addCard(rec, { id: "n", sec: "stay", k: "note", t: "Bring an adapter", at: 1004, src: { url: "javascript:alert(1)", title: "x" }, chat: "chat-3", msg: "k3" }, 1005)
  return rec
}

test("the PDF page: the site's link under the title, each card's source and «Открыть чат», the footer, all escaped", () => {
  const html = collectionHtml(setSummary(trip(), "Fly in late March", 2000), WORDS)
  assert.match(html, /<h1 dir="auto">Trip &lt;to&gt; Japan<\/h1>/)
  assert.match(html, new RegExp(`<p class="meta">3 cards · 14 November 2026 · made with <a href="${SITE}">ContextFlow — AI for Safari</a></p>`))
  assert.match(html, /<div class="sum"><b>Summary\.<\/b> <span dir="auto">Fly in late March<\/span><\/div>/)
  assert.match(html, /<h2 dir="auto">Stay<\/h2>/)
  assert.match(html, /Shinjuku is easy &amp; busy/)
  // The source by its host, the chat through the site's page.
  assert.match(html, /<a href="https:\/\/www\.japan-guide\.com\/e\/e3011\.html">japan-guide\.com&nbsp;↗<\/a>/)
  assert.match(html, /<a href="https:\/\/context-flow\.app\/open-chat\?id=chat-1&amp;m=k1">Open chat in ContextFlow&nbsp;↗<\/a>/)
  // A source that isn't a web page has no link; its chat still does.
  assert.doesNotMatch(html, /javascript:/)
  assert.match(html, /open-chat\?id=chat-3&amp;m=k3/)
  assert.match(html, /<footer>Made with ContextFlow · <a href="https:\/\/context-flow\.app">context-flow\.app<\/a><\/footer>/)
  assert.equal(openChatLink("a b", "m/1"), "https://context-flow.app/open-chat?id=a%20b&m=m%2F1")
})

test("a comparison in the PDF is its table, and it opens the first compared card's chat", () => {
  const rec = addComparison(trip(), "cmp", ["a", "b"], { h: ["Area", "Night"], r: [["Shinjuku", "¥22,000"], ["Asakusa", "¥14,000"]], note: "Asakusa is cheaper" }, 3000)
  const html = collectionHtml(rec, WORDS)
  assert.match(html, /<p class="gist"><b>Comparison\.<\/b> <span dir="auto">Asakusa is cheaper<\/span><\/p><table><thead><tr><th dir="auto">Area<\/th><th dir="auto">Night<\/th><\/tr><\/thead>/)
  assert.match(html, /<td dir="auto">¥14,000<\/td>/)
  // Its note is its gist: shown once.
  assert.equal(html.split("Asakusa is cheaper").length - 1, 1)
  const table = html.slice(html.indexOf("Comparison."))
  assert.match(table.slice(0, table.indexOf("</div>")), /open-chat\?id=chat-1&amp;m=k1/)
})

test("print styles: the footer on every page, the save bar hidden on paper", () => {
  const css = read("src/shared/collectionPage.ts")
  assert.match(css, /@media print \{[\s\S]*\.bar \{ display: none; \}[\s\S]*footer \{ position: fixed; bottom: 0;/)
  assert.match(css, /\.card \{[^}]*break-inside: avoid;/)
})

test("the AI is shown the card and the space's collections; only its known ids are taken", () => {
  const rec = trip()
  const body = placeBody({ t: "Ueno park in spring", x: "Cherry blossom", src: { url: "https://www.jnto.go.jp/ueno", title: "Ueno" } }, [rec], "en")
  assert.deepEqual(body.card, { gist: "Ueno park in spring", text: "Cherry blossom", title: "Ueno", site: "jnto.go.jp" })
  assert.deepEqual((body.collections as Array<{ sections: unknown[] }>)[0].sections, [{ id: "stay", name: "Stay", cards: ["Shinjuku is easy & busy", "Asakusa is quieter", "Bring an adapter"] }])
  assert.deepEqual(placeFromAi({ collection: "cf-col-1", section: "stay" }, [rec]), { collection: "cf-col-1", section: "stay", by: "ai" })
  assert.deepEqual(placeFromAi({ collection: "cf-col-1", section: null, newSection: "See" }, [rec]), { collection: "cf-col-1", section: null, newSection: "See", by: "ai" })
  // A section it made up, or a collection that isn't there, isn't a place.
  assert.equal(placeFromAi({ collection: "cf-col-1", section: "nope" }, [rec]), null)
  assert.deepEqual(placeFromAi({ collection: "cf-col-9", section: null, newCollection: "Ski", newSection: "Gear" }, [rec]), { collection: null, section: null, newCollection: "Ski", newSection: "Gear", by: "ai" })
  assert.equal(placeFromAi({ collection: null, section: null }, [rec]), null)
})

test("the background asks /api/v2/collect only with Pro and the consent, and opens only a collection's page", () => {
  const collect = read("src/background/collect.ts")
  assert.match(collect, /if \(!hasPro\(ctx\.status\.plan\)\) return \{ ok: false, code: "PRO_ONLY" \}\s*if \(!ctx\.agreed\) return \{ ok: false, code: "CONSENT" \}/)
  assert.match(collect, /fetch\(`\$\{API_BASE\}\/api\/v2\/collect`/)
  const bg = read("src/background/index.ts")
  assert.match(bg, /case "collect":[\s\S]*?consented\(\)\][\s\S]*?collectAi\(message\.op, message\.body, \{ status: now, installId: id, jws: ent\?\.active \? ent\.jws : null, client, agreed \}\)/)
  assert.match(bg, /case "openCollection":\s*if \(\/\^cf-col-\[\\w-\]\{8,64\}\$\/\.test\(message\.id\)\) void chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\(`dist\/collection\.html\?id=/)
  const build = read("scripts/build-extension.mjs")
  assert.match(build, /cpSync\(join\(root, "src\/pages\/collection\.html"\), join\(out, "dist\/collection\.html"\)\)/)
  assert.match(build, /collection: "src\/pages\/collection\.ts"/)
})

test("the panel: «В подборку» under answers and notes, the sheet, the window's tabs and its Pro steps", () => {
  const app = read("src/content/App.tsx")
  // In the footer shared by answers and notes. 2.7 after build 107 (the owner: one row of buttons under a message):
  // in the tools' row where there's room (a pointer), in the message's «…» on the compact chat.
  assert.match(app, /\{!compact && !historyMode && \(\s*<button type="button" class="cf-collect-link" onClick=\{\(\) => setCollecting\(idx\)\}/)
  assert.match(app, /onCollect: historyMode \? undefined : \(\) => setCollecting\(idx\),/)
  assert.match(app, /<CollectSheet[\s\S]*?ai=\{hasPro\(plan\) && consent === "ok"\}/)
  assert.match(app, /view === "collections" \? \(\s*<div class="cf-col-tabs" role="tablist">/)
  assert.match(app, /onPdf=\{\(id\) => void sendBackground\(\{ type: "openCollection", id \}\)\}/)
  assert.match(app, /const collectPro: CollectPro = \(\) => \{\s*setCollecting\(null\)\s*openPlans\("pro", "collections"\)/)
  const ui = read("src/content/Collections.tsx")
  // Free's limits open Pro; «Сравнить» and «Сводка» need Pro, then the consent.
  assert.match(ui, /if \(!canAddCard\(rec, pro\)\) \{\s*setLimit\("card"\)/)
  assert.match(ui, /if \(!canAddCollection\(all, pro\)\) \{\s*setLimit\("collection"\)/)
  assert.match(ui, /if \(!pro\) return onPro\(what\)\s*if \(!\(await askConsent\(\)\)\) return/)
  // Without the AI the suggestion is by words, on the device.
  assert.match(ui, /const suggestion = aiPlace \?\? \(asking \? null : words\)/)
})

test("the counters take the panel's collect steps and never text", () => {
  assert.deepEqual(useFields({ f: "collect", a: "add", via: "suggested", cards: 4, name: "Trip" }), { f: "collect", a: "add", via: "suggested", cards: 4 })
  assert.deepEqual(useFields({ f: "collect", a: "limit", via: "panel", what: "card", cards: 10 }), { f: "collect", a: "limit", via: "panel", what: "card", cards: 10 })
  assert.deepEqual(useFields({ f: "plans", a: "open", via: "collections", plan: "pro" }), { f: "plans", a: "open", via: "collections", plan: "pro" })
  const ui = read("src/content/Collections.tsx")
  for (const [, fields] of ui.matchAll(/report\("[a-z_]+", \{([^}]*)\}\)/g)) assert.doesNotMatch(fields, /\b(n|t|name|gist|url|src|title)\s*:/, fields)
})

test("/open-chat opens the chat in the app, or the App Store without it; it isn't indexed", () => {
  const page = read("site/open-chat.html")
  assert.match(page, /<meta name="robots" content="noindex, nofollow" \/>/)
  assert.match(page, /var app = "contextflow:\/\/chat\?id=" \+ encodeURIComponent\(id\) \+ \(m \? "&m=" \+ encodeURIComponent\(m\) : ""\)/)
  assert.match(page, /setTimeout\(function \(\) \{ if \(!document\.hidden\) location\.href = document\.getElementById\("store"\)\.href; \}, 1800\)/)
  assert.match(page, /href="https:\/\/apps\.apple\.com\/app\/apple-store\/id6759115793\?pt=119037986&amp;ct=pdf_chat&amp;mt=8"/)
  // The app opens a chat by these two (ChatLinks.handle).
  assert.match(read("ContextFlow/Shared (App)/ChatUX.swift"), /guard url\.host == "chat"[\s\S]*?\$0\.name == "m"[\s\S]*?\$0\.name == "id"/)
})

test("every panel language has every collections string", () => {
  const en = JSON.parse(read("src/locales/en.json")) as Record<string, string>
  const keys = Object.keys(en).filter((k) => k.startsWith("col"))
  assert.ok(keys.length >= 45)
  for (const lang of ["ru", "uk", "de", "fr", "es", "it", "pt_BR", "ja", "ko", "zh_CN", "zh_TW", "vi", "ar"]) {
    const other = JSON.parse(read(`src/locales/${lang}.json`)) as Record<string, string>
    for (const k of keys) {
      assert.ok(other[k], `${lang}: ${k}`)
      for (const slot of en[k].match(/\{\d\}/g) ?? []) if (!k.startsWith("colCards_")) assert.ok(other[k].includes(slot), `${lang}: ${k} ${slot}`)
    }
  }
})

test("the app's PDF is the panel's page: the same styles word for word, the same links and footer", () => {
  const ts = read("src/shared/collectionPage.ts")
  const swift = read("ContextFlow/Shared (App)/BoardPDF.swift")
  const tsCss = ts.slice(ts.indexOf("export const PAGE_CSS = `") + "export const PAGE_CSS = `".length)
  const swiftCss = swift.slice(swift.indexOf('static let css = """') + 'static let css = """'.length)
  assert.equal(swiftCss.slice(0, swiftCss.indexOf('"""')).trim(), tsCss.slice(0, tsCss.indexOf("`")).trim())
  assert.match(swift, /static let site = "https:\/\/context-flow\.app"/)
  assert.match(swift, /return "\\\(site\)\/open-chat\?id=\\\(id\)&m=/)
  assert.match(swift, /<footer>\\\(esc\(footer\)\) · <a href=\\"\\\(site\)\\">context-flow\.app<\/a><\/footer>/)
  // The app lays the web view's page onto A4 pages itself: each keeps its links and has the footer (with its link).
  assert.match(swift, /try await render\(html\(board, native: true\)\)\.write\(to: url/)
  assert.match(swift, /for link in links where link\.rect\.minY >= slice\.top - 1 && link\.rect\.maxY <= slice\.bottom \+ 1 \{\s*ctx\.setURL\(link\.url as CFURL/)
  assert.match(swift, /ctx\.setURL\(URL\(string: BoardPDF\.site\)! as CFURL/)
  assert.match(ts, /body\.native footer \{ display: none; \}/)
  // The board's menu has it.
  assert.match(read("ContextFlow/Shared (App)/CollectionsView.swift"), /Button \{ Task \{ await exportPDF\(\) \} \} label: \{ Label\("PDF", systemImage: "doc\.richtext"\) \}/)
})
