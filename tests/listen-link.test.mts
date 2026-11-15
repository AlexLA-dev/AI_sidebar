// 2.7, the owner on TestFlight 107: Listen asked about notifications that were on, opened the app, and the app said
// «This text is no longer here. Tap Listen in Safari again.», in a loop. The text and the answer about notifications
// came only through the extension's native messages, which wait their turn behind a long one. Now the link carries the
// text, the app sends its word back in the page's address, and no answer about notifications isn't read as "off".
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { base64Url, LISTEN_LINK_MAX, listenLink, listenMark, notifyAnswer } from "../src/shared/listenLink.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const ID = "3f2b8c1e-0d4a-4b7e-9c55-12ab34cd56ef"
const item = { text: "**Итог:** поезд экономит треть энергии.\n\n| a | b |\n|---|---|\n| 1 | 2 |", what: "answer" as const, lang: "ru", title: "Поезда & энергия", url: "https://example.com/trains?a=1#top" }

/** The link's fields as the app reads them (URLComponents' queryItems). */
function fields(link: string): Record<string, string> {
  const query = link.slice(link.indexOf("?") + 1)
  return Object.fromEntries(query.split("&").map((pair) => {
    const at = pair.indexOf("=")
    return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))]
  }))
}

const decode = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")

test("the link carries the text and what it is: the app has it without the native message", () => {
  const link = listenLink("listen", ID, item)
  assert.ok(link.startsWith(`contextflow://listen?id=${ID}&`))
  const f = fields(link)
  assert.equal(f.w, "a")
  assert.equal(f.l, "ru")
  assert.equal(f.n, item.title)
  assert.equal(f.u, item.url)
  assert.equal(decode(f.t), item.text)
  // Only what a link's value may hold: no padding, no "+", "/" or "&" from the text.
  assert.match(link.slice(link.indexOf("&t=") + 3), /^[A-Za-z0-9_-]+$/)
})

test("the question about notifications gets the same text: the app plays it or sends the person back for it", () => {
  const link = listenLink("notifications", ID, { ...item, what: "page" })
  assert.ok(link.startsWith(`contextflow://notifications?listen=${ID}&`))
  const f = fields(link)
  assert.equal(f.w, "p")
  assert.equal(decode(f.t), item.text)
})

test("base64url of UTF-8, as the app decodes it: every length, Cyrillic, CJK, emoji", () => {
  for (const text of ["", "a", "ab", "abc", "abcd", "Привет, мир", "日本語のテキスト", "👍🏽 ok", "x".repeat(1001)]) {
    assert.equal(decode(base64Url(text)), text)
    assert.doesNotMatch(base64Url(text), /[=+/]/)
  }
})

test("a text too long for a link goes without it (the native message brings it, as before), never cut in the middle", () => {
  const long = { ...item, text: "Длинная страница. ".repeat(4000) }
  const link = listenLink("listen", ID, long)
  assert.ok(link.length <= LISTEN_LINK_MAX)
  const f = fields(link)
  // 24,000 characters of Cyrillic fit; they come whole.
  assert.equal(decode(f.t), long.text.slice(0, 24_000))
  const short = listenLink("listen", ID, long, 5_000)
  assert.equal(fields(short).t, undefined)
  assert.equal(fields(short).u, item.url)
  assert.ok(short.length <= 5_000)
})

test("an address that isn't a page's isn't sent", () => {
  assert.equal(fields(listenLink("listen", ID, { ...item, url: "chat:abc" })).u, undefined)
})

test("the app's word back in the page's address: taken out, the page's own fragment stays", () => {
  assert.deepEqual(listenMark(`#cf-listen=${ID}`), { id: ID, rest: "" })
  assert.deepEqual(listenMark(`#specs&cf-listen=${ID}`), { id: ID, rest: "#specs" })
  assert.deepEqual(listenMark(`#cf-listen=${ID.toUpperCase()}&specs`), { id: ID, rest: "#specs" })
  assert.equal(listenMark("#specs"), null)
  assert.equal(listenMark(""), null)
  assert.equal(listenMark("#cf-listen=<script>"), null)
  assert.equal(listenMark(`#xcf-listen=${ID}`), null)
})

test("no answer about notifications isn't 'off': only an answer changes what's known", () => {
  assert.equal(notifyAnswer("authorized"), true)
  assert.equal(notifyAnswer("provisional"), true)
  assert.equal(notifyAnswer("ephemeral"), true)
  assert.equal(notifyAnswer("denied"), false)
  assert.equal(notifyAnswer("notDetermined"), false)
  // The native message timed out (the background says "unknown"), or nothing came at all.
  assert.equal(notifyAnswer("unknown"), null)
  assert.equal(notifyAnswer(undefined), null)
  assert.equal(notifyAnswer(""), null)
})

test("the panel and the app use them: the link in the tap, the mark on the way back, the text kept from the link", () => {
  const panel = read("../src/content/listen/useListen.tsx")
  assert.match(panel, /follow\(listenLink\(to, id, item\)\)/)
  assert.match(panel, /const on = notifyAnswer\(r\?\.status\)\n[\s\S]{0,400}if \(on === null\) return null/)
  assert.match(panel, /const mark = takeListenMark\(\)/)
  assert.match(panel, /window\.addEventListener\("hashchange", onHash\)/)
  const app = read("../ContextFlow/Shared (App)/Listen.swift")
  assert.match(app, /func open\(_ url: URL\) \{\n[^\n]*\n\s+ListenLink\.keep\(url\)/)
  assert.match(read("../ContextFlow/Shared (App)/SpeechText.swift"), /parts\.fragment = "cf-listen=\\\(id\)"/)
  assert.match(read("../ContextFlow/Shared (App)/Setup.swift"), /let url = ListenLink\.marked\(page, id: id\)/)
  assert.match(read("../ContextFlow/Shared (App)/ContentView.swift"), /ListenLink\.keep\(url\)\n\s+Task \{ await NotifyAsk\.shared\.show\(\.listen, listen: id\) \}/)
})
