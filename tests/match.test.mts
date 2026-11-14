// «Подходящий чат при открытии панели» (2.7, plan section 4, src/shared/match.ts): this page's chat; else a chat on the
// page's topic at 85 %+ in the space (by the title's words in Free, by meaning in Pro with organizing on); a site's chat
// only when it's about that site alone; else a new chat. A thin «Продолжаю «…» · Новый чат» line over it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { aboutSiteAlone, matchChat, MATCH_TOPIC, titleTopic, topicWords, wordMatch } from "../src/shared/match.ts"
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
  docs: chat("docs", 7_000, [["https://docs.example/a", "API reference", "How do I page results?"], ["https://docs.example/b", "Auth guide", "Which token?"]]),
  old: chat("old", 1_000, [["https://news.example/1", "Elections tonight", "Who leads?"]])
}
const open = { id: "old", at: 1 }

test("1. this page's chat, as before", () => {
  assert.deepEqual(matchChat(threads, open, "https://travel.example/kyoto#top", "Kyoto in autumn", emptySpaces(), true), { chat: "japan", space: FIRST_SPACE, bound: false, why: "page" })
})

test("2. a chat on the page's topic, by the title's words (its site's name off), at 85 % or more", () => {
  assert.equal(MATCH_TOPIC, 85)
  assert.equal(titleTopic("Kyoto temples in November | Japan Guide"), "Kyoto temples in November")
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

test("3. a shared site counts only when the chat is about that site alone", () => {
  // The vacuum chat was on amazon.com and another shop: another page on amazon.com isn't its.
  assert.equal(aboutSiteAlone(threads.amazon, "amazon.com"), false)
  assert.equal(matchChat(threads, open, "https://www.amazon.com/books/123", "Some book", emptySpaces(), true).why, "new")
  // The docs chat is about docs.example alone: another page there opens it.
  assert.equal(aboutSiteAlone(threads.docs, "docs.example"), true)
  assert.deepEqual(matchChat(threads, open, "https://docs.example/c", "Errors", emptySpaces(), true), { chat: "docs", space: FIRST_SPACE, bound: false, why: "site" })
})

test("4. nothing fits: a new chat; one open, new and empty, stays", () => {
  assert.deepEqual(matchChat(threads, open, "https://other.example/x", "Something else entirely", emptySpaces(), true), { chat: null, space: FIRST_SPACE, bound: false, why: "new" })
  assert.deepEqual(matchChat(threads, { id: "fresh", at: 1 }, "https://other.example/x", "Something else entirely", emptySpaces(), true), { chat: "fresh", space: FIRST_SPACE, bound: false, why: "new" })
})

test("by meaning in Pro with organizing on: the background's answer; asked and none, the words don't count either", () => {
  const meaning = { chat: "old", match: 91 }
  assert.deepEqual(matchChat(threads, open, "https://elsewhere.example/poll", "Polls close at nine", emptySpaces(), true, meaning), { chat: "old", space: FIRST_SPACE, bound: false, why: "meaning", match: 91 })
  // The page's own chat still comes first.
  assert.equal(matchChat(threads, open, "https://travel.example/kyoto", "Kyoto in autumn", emptySpaces(), true, meaning).why, "page")
  // Asked, nothing at 85 %: no topic match by words either.
  assert.equal(matchChat(threads, open, "https://guide.example/kyoto-temples", "Kyoto temples in November", emptySpaces(), true, null).why, "new")
  // A chat of another space from the background doesn't count.
  const list = addSpace(emptySpaces(), "work", "Work", "green", 1)
  const spaced = { ...threads, old: { ...threads.old, sp: "work" } }
  assert.equal(matchChat(spaced, open, "https://elsewhere.example/poll", "Polls", list, true, meaning).chat, "old")
  assert.equal(matchChat(spaced, { id: "japan", at: 1 }, "https://elsewhere.example/poll", "Polls", list, true, meaning).why, "new")
})

test("inside the space it's in; a bound site's space first, a new chat there when nothing fits", () => {
  let list = addSpace(emptySpaces(), "work", "Work", "green", 1)
  const spaced: Threads = { ...threads, docs: { ...threads.docs, sp: "work" } }
  // In the first space the docs chat (Work's) isn't found.
  assert.equal(matchChat(spaced, open, "https://docs.example/c", "Errors", list, true).why, "new")
  // In Work it is.
  assert.equal(matchChat(spaced, { id: "docs", at: 1 }, "https://docs.example/c", "Errors", list, true).chat, "docs")
  // Bound: from the first space straight to Work's chat, or to a new chat in Work.
  list = bindSite(list, "docs.example", "work", 2)
  assert.deepEqual(matchChat(spaced, open, "https://docs.example/c", "Errors", list, true), { chat: "docs", space: "work", bound: true, why: "site" })
  list = bindSite(list, "travel.example", "work", 3)
  assert.deepEqual(matchChat(spaced, open, "https://travel.example/kyoto", "Kyoto in autumn", list, true), { chat: null, space: "work", bound: true, why: "new" })
  // Spaces off: every chat, no bindings.
  assert.deepEqual(matchChat(spaced, open, "https://docs.example/c", "Errors", list, false), { chat: "docs", space: FIRST_SPACE, bound: false, why: "site" })
})

test("the panel: matched on the circle, the line over the chat, its New chat and leaving at once counted", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /let place = pageChat \? matchChat\(threads, was, key, source\.title\(\), list, on\) : null/)
  // By meaning only with organizing on, and never longer than 1.2 s.
  assert.match(app, /if \(place && place\.why !== "page" && orgOnRef\.current\) \{[\s\S]*?type: "matchTopic"[\s\S]*?setTimeout\(\(\) => resolve\(undefined\), 1200\)/)
  // Only when it picked another chat than the one open.
  assert.match(app, /if \(place && active !== was\) \{\s*const fits = place\.why !== "new" && place\.chat !== null/)
  assert.match(app, /\{matchShown && <span class="cf-match-label">\{t\("matchContinue"\)\}<\/span>\}/)
  assert.match(app, /a: "line_new"/)
  assert.match(app, /if \(line && id !== line\.chat && Date\.now\(\) - line\.at < 120_000\)/)
  // The background asks only with organizing's switch and consent.
  const bg = readFileSync(new URL("../src/background/index.ts", import.meta.url), "utf8")
  assert.match(bg, /case "matchTopic":[\s\S]*?matchTopic\(message\.title, message\.chats, \{ [^}]*on: prefs\.organize && agreed \}\)/)
  const organize = readFileSync(new URL("../src/background/organize.ts", import.meta.url), "utf8")
  assert.match(organize, /if \(match >= org\.config\.mergeTopic && \(!best \|\| match > best\.match\)\) best = \{ chat: id, match \}/)
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
  }
})
