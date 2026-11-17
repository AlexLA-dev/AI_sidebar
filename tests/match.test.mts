// «Подходящий чат при открытии панели» (2.7, plan section 4, src/shared/match.ts): this page's chat; else a chat on the
// page's topic at 85 %+ in the space (by the title's words in Free, by meaning in Pro with organizing on); a site's chat
// only when it's about that site alone; else a new chat. A thin «Продолжаю «…» · Новый чат» line over it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { aboutSiteAlone, matchable, matchChat, matchScope, MATCH_TOPIC, SITE_MATCH, siteMatch, titleTopic, topicWords, wordMatch } from "../src/shared/match.ts"
import { addSpace, bindSite, emptySpaces, FIRST_SPACE } from "../src/shared/spaces.ts"
import type { Thread, Threads } from "../src/shared/threads.ts"
import { FEATURES, useFields } from "../src/shared/usage.ts"

let clock = 1_000
const q = (url: string, title: string, content: string) => ({ role: "user" as const, content, t: (clock += 10), id: `q${clock}`, page: { url, title, hash: "h", at: clock } })
const a = () => ({ role: "assistant" as const, content: "An answer about it.", t: (clock += 10), id: `a${clock}` })
const chat = (id: string, at: number, pages: Array<[string, string, string]>, extra: Partial<Thread> = {}): Thread =>
  ({ id, u: at, a: at, m: pages.flatMap(([url, title, question]) => [q(url, title, question), a()]), ...extra })

const threads: Threads = {
  japan: chat("japan", 5_000, [["https://travel.example/kyoto", "Kyoto in autumn: temples and maple leaves – Travel Example", "Which temples in Kyoto in November?"]]),
  amazon: chat("amazon", 9_000, [["https://www.amazon.com/robot-vacuum", "Robot Vacuum S7 – Amazon.com", "Is it worth it?"], ["https://shop.example/vacuums", "Vacuums", "Cheaper ones?"]]),
  docs: chat("docs", 7_000, [["https://docs.example/docs/api/payment-intents", "Create a payment intent | Paystack API Reference", "How do I page results?"], ["https://docs.example/docs/api/authentication", "Authentication | Paystack API Reference", "Which token?"]]),
  old: chat("old", 1_000, [["https://news.example/1", "Elections tonight", "Who leads?"]])
}
const open = { id: "old", at: 1 }

test("1. this page's chat, as before", () => {
  assert.deepEqual(matchChat(threads, open, "https://travel.example/kyoto#top", "Kyoto in autumn", emptySpaces(), true), { chat: "japan", space: FIRST_SPACE, bound: false, why: "page" })
})

test("2. a chat on the page's topic, by the title's words (its site's name off), at 85 % or more", () => {
  assert.equal(MATCH_TOPIC, 85)
  assert.equal(titleTopic("Kyoto temples in November | Japan Guide"), "Kyoto temples in November")
  // The site's name is the last part, whatever its length: it never stands for the page (#172 review).
  assert.equal(titleTopic("Errors | Paystack API Reference"), "Errors")
  assert.equal(titleTopic("Japan's tech firms test the four-day week"), "Japan's tech firms test the four-day week")
  assert.deepEqual([...topicWords("Kyoto temples in November 2026")], ["kyoto", "temples", "november"])
  // Every word of the title in the chat's name, pages and questions: 100 %.
  assert.equal(wordMatch("Kyoto temples in November | Japan Guide", threads.japan), 100)
  const m = matchChat(threads, open, "https://guide.example/kyoto-temples", "Kyoto temples in November | Japan Guide", emptySpaces(), true)
  assert.deepEqual(m, { chat: "japan", space: FIRST_SPACE, bound: false, why: "topic", match: 100 })
  // One of three words: 33 %, not enough.
  assert.equal(wordMatch("Kyoto ramen shops", threads.japan), 33)
  assert.equal(matchChat(threads, open, "https://food.example/ramen", "Kyoto ramen shops", emptySpaces(), true).why, "new")
  // One word says too little to judge.
  assert.equal(wordMatch("Kyoto", threads.japan), 0)
  // Accents and case don't matter.
  assert.equal(wordMatch("KYÓTO Témples", threads.japan), 100)
})

test("3. a shared site counts only when the chat is about that site alone, and about this page too (60 %+)", () => {
  assert.equal(SITE_MATCH, 60)
  // The vacuum chat was on amazon.com and another shop: another page on amazon.com isn't its.
  assert.equal(aboutSiteAlone(threads.amazon, "amazon.com"), false)
  assert.equal(matchChat(threads, open, "https://www.amazon.com/books/123", "Some book", emptySpaces(), true).why, "new")
  // The docs chat is about docs.example alone, and another page of the same docs shares the product and the section.
  assert.equal(aboutSiteAlone(threads.docs, "docs.example"), true)
  assert.equal(siteMatch("Errors | Paystack API Reference", "https://docs.example/docs/api/errors", threads.docs), 80)
  assert.deepEqual(matchChat(threads, open, "https://docs.example/docs/api/errors", "Errors | Paystack API Reference", emptySpaces(), true), { chat: "docs", space: FIRST_SPACE, bound: false, why: "site", match: 80 })
})

test("the same site: unrelated news articles and different products start a new chat; one product's docs continue (#172 review)", () => {
  // Two unrelated articles on one news site: the site's name and little else in common.
  const news: Threads = { n: chat("n", 5_000, [["https://planet.example/world/2026/elections-tonight", "Elections tonight: who leads | Daily Planet", "Who is ahead?"]]) }
  assert.ok(siteMatch("Japan's tech firms test the four-day week | Daily Planet", "https://planet.example/tech/2026/japan-four-day-week", news.n) < SITE_MATCH)
  assert.equal(matchChat(news, open, "https://planet.example/tech/2026/japan-four-day-week", "Japan's tech firms test the four-day week | Daily Planet", emptySpaces(), true).why, "new")
  // A long site name is never the page's topic: an unrelated short title doesn't match by it.
  const daily: Threads = { d: chat("d", 5_000, [["https://planet.example/weather", "Storm warning | The Daily Planet Morning Edition", "Will it rain?"]]) }
  assert.equal(matchChat(daily, open, "https://planet.example/sport", "Cup final | The Daily Planet Morning Edition", emptySpaces(), true).why, "new")
  // Two pages of one product's docs: the same chat.
  const docs: Threads = { k: chat("k", 5_000, [["https://help.example/docs/sync/setup", "Set up sync | Notely Help Center", "How do I turn sync on?"]]) }
  const m = matchChat(docs, open, "https://help.example/docs/sync/conflicts", "Resolve sync conflicts | Notely Help Center", emptySpaces(), true)
  assert.equal(m.chat, "k")
  assert.ok(m.why === "site" || m.why === "topic", m.why)
  // An app page of a single-purpose site: the same chat.
  const mail: Threads = { g: chat("g", 5_000, [["https://mail.example/mail/u/0/inbox", "Inbox (3) - Postbox", "Summarize my unread mail"]]) }
  assert.equal(matchChat(mail, open, "https://mail.example/mail/u/0/compose", "Compose - Postbox", emptySpaces(), true).chat, "g")
  // Two different products in one shop: a new chat.
  const shop: Threads = { s: chat("s", 5_000, [["https://soundhouse.example/p/robot-vacuum-s7", "Robot Vacuum S7 · Soundhouse", "Is it quiet?"]]) }
  assert.equal(matchChat(shop, open, "https://soundhouse.example/p/aero-2-headphones", "Aero 2 wireless headphones · Soundhouse", emptySpaces(), true).why, "new")
})

test("4. nothing fits: a new chat; one open, new and empty, stays", () => {
  assert.deepEqual(matchChat(threads, open, "https://other.example/x", "Something else entirely", emptySpaces(), true), { chat: null, space: FIRST_SPACE, bound: false, why: "new" })
  assert.deepEqual(matchChat(threads, { id: "fresh", at: 1 }, "https://other.example/x", "Something else entirely", emptySpaces(), true), { chat: "fresh", space: FIRST_SPACE, bound: false, why: "new" })
})

test("by meaning in Pro with organizing on: the background's answer; asked and none, the words don't count either", () => {
  const meaning = { matches: [{ chat: "old", match: 91 }], topic: 85 }
  assert.deepEqual(matchChat(threads, open, "https://elsewhere.example/poll", "Polls close at nine", emptySpaces(), true, meaning), { chat: "old", space: FIRST_SPACE, bound: false, why: "meaning", match: 91 })
  // Below the topic's threshold it's no topic, but a same-site chat about the site alone may continue from 60.
  assert.equal(matchChat(threads, open, "https://elsewhere.example/poll", "Polls close at nine", emptySpaces(), true, { matches: [{ chat: "old", match: 70 }], topic: 85 }).why, "new")
  assert.deepEqual(matchChat(threads, open, "https://news.example/2", "Results", emptySpaces(), true, { matches: [{ chat: "old", match: 70 }], topic: 85 }), { chat: "old", space: FIRST_SPACE, bound: false, why: "site", match: 70 })
  // The page's own chat still comes first.
  assert.equal(matchChat(threads, open, "https://travel.example/kyoto", "Kyoto in autumn", emptySpaces(), true, meaning).why, "page")
  // Asked, nothing at 85 %: no topic match by words either.
  assert.equal(matchChat(threads, open, "https://guide.example/kyoto-temples", "Kyoto temples in November", emptySpaces(), true, null).why, "new")
  // 107: a chat of another space from the background counts too; the panel goes there.
  const list = addSpace(emptySpaces(), "work", "Work", "green", 1)
  const spaced = { ...threads, old: { ...threads.old, sp: "work" } }
  assert.equal(matchChat(spaced, open, "https://elsewhere.example/poll", "Polls", list, true, meaning).chat, "old")
  assert.deepEqual(matchChat(spaced, { id: "japan", at: 1 }, "https://elsewhere.example/poll", "Polls", list, true, meaning), { chat: "old", space: "work", bound: false, from: FIRST_SPACE, why: "meaning", match: 91 })
})

test("every space's chats (107); a bound site's space alone, a new chat there when nothing fits", () => {
  let list = addSpace(emptySpaces(), "work", "Work", "green", 1)
  const spaced: Threads = { ...threads, docs: { ...threads.docs, sp: "work" } }
  const errors = ["https://docs.example/docs/api/errors", "Errors | Paystack API Reference"] as const
  // In the first space the docs chat (Work's) is found, and the panel goes to Work: the line says where it came from.
  assert.deepEqual(matchChat(spaced, open, ...errors, list, true), { chat: "docs", space: "work", bound: false, from: FIRST_SPACE, why: "site", match: 80 })
  // In Work it's at home.
  assert.deepEqual(matchChat(spaced, { id: "docs", at: 1 }, ...errors, list, true), { chat: "docs", space: "work", bound: false, why: "site", match: 80 })
  // Bound: from the first space straight to Work's chat, or to a new chat in Work.
  list = bindSite(list, "docs.example", "work", 2)
  assert.deepEqual(matchChat(spaced, open, ...errors, list, true), { chat: "docs", space: "work", bound: true, why: "site", match: 80 })
  list = bindSite(list, "travel.example", "work", 3)
  assert.deepEqual(matchChat(spaced, open, "https://travel.example/kyoto", "Kyoto in autumn", list, true), { chat: null, space: "work", bound: true, why: "new" })
  // Spaces off: every chat, no bindings.
  assert.deepEqual(matchChat(spaced, open, ...errors, list, false), { chat: "docs", space: FIRST_SPACE, bound: false, why: "site", match: 80 })
})

test("the panel: matched on the circle, the line over the chat, its New chat and leaving at once counted", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /let place = pageChat \? matchChat\(threads, was, key, source\.title\(\), list, on\) : null/)
  // By meaning only with organizing on, and never longer than 1.2 s.
  assert.match(app, /if \(place && place\.why !== "page" && orgOnRef\.current\) \{[\s\S]*?type: "matchTopic"[\s\S]*?setTimeout\(\(\) => resolve\(undefined\), 1200\)/)
  // Only when it picked another chat than the one open.
  assert.match(app, /if \(place && active !== was\) \{\s*const fits = place\.why !== "new" && place\.chat !== null/)
  assert.match(app, /: <span class="cf-match-label">\{t\("matchContinue"\)\}<\/span>\)\}/)
  assert.match(app, /a: "line_new"/)
  // 107: every space's chats go to the background; a chat in another space names its space, «← <space>» goes back.
  assert.match(app, /matchable\(threads, list, matchScope\(list, key, on\), on\)/)
  assert.match(app, /else if \(place\?\.from && active !== was\) spacesRef\.current\?\.followMatch\(place\.space\)/)
  assert.match(app, /t\("matchContinueIn", spaces\.current\.name\)/)
  assert.match(app, /a: "line_back"[\s\S]*?spaces\.back\(matchFrom\.id\)/)
  const hook = readFileSync(new URL("../src/content/Spaces.tsx", import.meta.url), "utf8")
  assert.match(hook, /back: \(id: string\) => void switchTo\(id, "match_back"\)/)
  assert.match(app, /if \(line && id !== line\.chat && Date\.now\(\) - line\.at < 120_000\)/)
  // The background asks only with organizing's switch and consent.
  const bg = readFileSync(new URL("../src/background/index.ts", import.meta.url), "utf8")
  assert.match(bg, /case "matchTopic":[\s\S]*?matchTopic\(message\.title, message\.chats, \{ [^}]*on: prefs\.organize && agreed \}\)/)
  const organize = readFileSync(new URL("../src/background/organize.ts", import.meta.url), "utf8")
  assert.match(organize, /if \(match >= SITE_MATCH\) matches\.push\(\{ chat: id, match \}\)/)
  assert.match(organize, /topic: org\.config\.mergeTopic \}/)
})

test("the usage events: counts only", () => {
  const spec = FEATURES.match
  assert.equal(spec.since, "2.7")
  assert.deepEqual(useFields({ f: "match", a: "shown", why: "topic", match: 92, title: "Kyoto" }), { f: "match", a: "shown", why: "topic", match: 92 })
  assert.deepEqual(useFields({ f: "match", a: "line_new", why: "site" }), { f: "match", a: "line_new", why: "site" })
})

test("every language has the line's word", () => {
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "uk", "vi", "zh_CN", "zh_TW"]) {
    const s = JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8")) as Record<string, string>
    assert.ok(s.matchContinue?.trim(), lang)
    assert.match(s.matchContinueIn ?? "", /\{0\}/, lang)
    assert.match(s.matchBackTo ?? "", /\{0\}/, lang)
  }
})

test("107: the chat that fits is looked for in every space, the space the panel is in first at each step", () => {
  const list = addSpace(emptySpaces(), "work", "Work", "green", 1)
  const kyoto = ["https://travel.example/kyoto", "Kyoto in autumn"] as const
  // The owner's case: this page's chat lives in Personal, the panel is in Work (a new chat there): it opens in Personal.
  const inWork = { id: "fresh", at: 1, sp: "work" }
  assert.deepEqual(matchChat(threads, inWork, ...kyoto, list, true), { chat: "japan", space: FIRST_SPACE, bound: false, from: "work", why: "page" })
  // The topic by words across spaces, too.
  assert.deepEqual(matchChat(threads, inWork, "https://guide.example/kyoto-temples", "Kyoto temples in November | Japan Guide", list, true), { chat: "japan", space: FIRST_SPACE, bound: false, from: "work", why: "topic", match: 100 })
  // The same page in both spaces: the one in the space the panel is in, even if older.
  const both: Threads = { ...threads, japan2: { ...chat("japan2", 99_000, [[kyoto[0], kyoto[1], "Where to eat?"]]), sp: "work" } }
  assert.equal(matchChat(both, inWork, ...kyoto, list, true).chat, "japan2")
  assert.equal(matchChat(both, open, ...kyoto, list, true).chat, "japan")
  // A topic chat in the panel's space beats a better one elsewhere; a page's chat elsewhere beats a topic here.
  const topicHere: Threads = { ...threads, here: { ...chat("here", 2_000, [["https://b.example/1", "Kyoto temples", "November?"]]), sp: "work" } }
  assert.equal(matchChat(topicHere, inWork, "https://guide.example/kyoto-temples", "Kyoto temples in November | Japan Guide", list, true).chat, "here")
  assert.equal(matchChat(topicHere, inWork, ...kyoto, list, true).chat, "japan")
  // «Open this site here» still wins: travel.example bound to Work → Work alone, a new chat there.
  const bound = bindSite(list, "travel.example", "work", 2)
  assert.deepEqual(matchChat(threads, open, ...kyoto, bound, true), { chat: null, space: "work", bound: true, why: "new" })
  // Nothing fits anywhere: a new chat where the panel is, no way back to show.
  assert.deepEqual(matchChat(threads, inWork, "https://other.example/x", "Something else entirely", list, true), { chat: "fresh", space: "work", bound: false, why: "new" })
  // Every language's word handling (#189) applies across spaces: a Japanese title finds its chat in Personal.
  const ja: Threads = { ...threads, tokyo: chat("tokyo", 3_000, [["https://weather.example/tokyo", "東京の天気 - 日本気象協会", "東京の天気は？"]]) }
  assert.equal(matchChat(ja, inWork, "https://tenki.example/tokyo", "東京の天気｜tenki.jp", list, true).chat, "tokyo")
  // The background is asked about every space's chats, or a bound site's space's alone.
  assert.deepEqual(matchable(threads, list, matchScope(list, kyoto[0], true), true).map((t) => t.id).sort(), Object.keys(threads).sort())
  assert.deepEqual(matchable(threads, bound, matchScope(bound, kyoto[0], true), true).map((t) => t.id), [])
  // The usage events: where it was found, and the line's way back, counts only.
  assert.deepEqual(useFields({ f: "match", a: "shown", why: "page", where: "other" }), { f: "match", a: "shown", why: "page", where: "other" })
  assert.deepEqual(useFields({ f: "match", a: "line_back", why: "page" }), { f: "match", a: "line_back", why: "page" })
  assert.deepEqual(useFields({ f: "space", a: "switch", via: "match" }), { f: "space", a: "switch", via: "match" })
})
