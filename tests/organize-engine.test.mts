import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import {
  DEFAULT_ORGANIZE, embedText, judgedTags, looksMixed, matchPercent, movesAllowed, nameCheckKey, nameStateAfter, nameText, openMove, openName, openTags, organizeConfig, orgStateFor, packVector, refusedTags, suggestMove, tagCandidates, tagTargets, textSize, unpackVector, wantsNameCheck, type VectorOf
} from "../src/shared/organize.ts"
import type { Thread } from "../src/shared/threads.ts"

// Vectors by topic: every message's vector is its topic's direction plus a little of its own, so messages on
// one topic are alike (≈0.8) and on different topics are not (≈0.05).
const DIMS = 64
const topicAxis: Record<string, number> = {}
function vectorFor(topic: string, salt: number): Float32Array {
  topicAxis[topic] ??= Object.keys(topicAxis).length
  const v = new Float32Array(DIMS)
  v[topicAxis[topic]] = 1
  v[(topicAxis[topic] + 7 + salt) % DIMS] += 0.45
  let n = 0
  for (const x of v) n += x * x
  return v.map((x) => x / Math.sqrt(n))
}
const topicOf = new Map<string, string>()
let salt = 0
const vectorOf: VectorOf = (e) => {
  const topic = topicOf.get(e.content)
  return topic ? vectorFor(topic, (e.content.length + (e.role === "user" ? 1 : 3)) % 5) : null
}

let clock = 1_000
function qa(topic: string, url: string, extra: { tags?: string[]; question?: string } = {}): Entry[] {
  const q = extra.question ?? `${topic} question ${++salt} about something long enough`
  const a = `${topic} answer ${salt} with details`
  topicOf.set(q, topic)
  topicOf.set(a, topic)
  clock += 1_000
  return [
    { role: "user", content: q, page: { url, title: `${topic} page`, at: clock }, id: `q${salt}`, t: clock },
    { role: "assistant", content: a, id: `a${salt}`, t: clock + 10, ...(extra.tags ? { tags: extra.tags } : {}) }
  ]
}
const chat = (id: string, m: Entry[], extra: Partial<Thread> = {}): Thread => ({ id, u: 1, m, ...extra })

const japan = chat("japan", [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2"), ...qa("japan", "https://jg/3")])
const bread = chat("bread", [...qa("bread", "https://bread/1"), ...qa("bread", "https://bread/2")])
const cfg = DEFAULT_ORGANIZE

test("a block about another chat's topic is suggested there; a coherent chat gets nothing", () => {
  const pile = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...qa("japan", "https://travel-blog/9")])
  const s = suggestMove(pile, [pile, japan, bread], vectorOf, cfg)!
  assert.equal(s.to, "japan")
  assert.equal(s.why, "topic")
  assert.deepEqual([s.start, s.end], [6, 7])
  assert.equal(suggestMove(japan, [pile, japan, bread], vectorOf, cfg), null)
})

test("the same page in another chat is suggested without vectors; blocks in a row going to one chat are one suggestion", () => {
  const pile = chat("pile", [...qa("sofa", "https://ikea/sofa"), ...qa("misc", "https://x/1"), ...qa("japan", "https://jg/2", { question: "Different words entirely, same page" })])
  const s = suggestMove(pile, [pile, japan], () => null, cfg)!
  assert.equal(s.to, "japan")
  assert.equal(s.why, "page")
  const two = chat("pile2", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...qa("japan", "https://jg/7"), ...qa("japan", "https://jg/8")])
  const both = suggestMove(two, [two, japan, bread], vectorOf, cfg)!
  assert.equal(both.to, "japan")
  assert.deepEqual([both.start, both.end], [6, 9])
})

test("a block that fits no chat and not its own: a new chat, only when something stays", () => {
  const pile = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...qa("cars", "https://car/1")])
  const s = suggestMove(pile, [pile, japan, bread], vectorOf, cfg)!
  assert.equal(s.to, null)
  assert.equal(s.why, "apart")
  const small = chat("small", [...qa("react", "https://react/1"), ...qa("cars", "https://car/2")])
  assert.equal(suggestMove(small, [small, japan], vectorOf, cfg), null)
})

test("short questions, moved-in and turned-down blocks, and \"Ask your chats\" get no suggestion; refusals switch moves off", () => {
  const thanks: Entry[] = [{ role: "user", content: "ok thanks", id: "ok", t: 99_999 }, { role: "assistant", content: "You're welcome", id: "ok2", t: 99_999 }]
  const pile = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...thanks])
  assert.equal(suggestMove(pile, [pile, japan], vectorOf, cfg), null)
  const moved = qa("japan", "https://jg/5").map((e) => ({ ...e, from: { chat: "x", at: 1 } }))
  assert.equal(suggestMove(chat("p", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...moved]), [japan], vectorOf, cfg), null)
  const refused = qa("japan", "https://jg/6").map((e) => ({ ...e, dismissed: { move: true as const } }))
  assert.equal(suggestMove(chat("p", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...refused]), [japan], vectorOf, cfg), null)
  assert.equal(suggestMove({ ...pile, kind: "history" }, [japan], vectorOf, cfg), null)
  // Three refused moves, none taken: no more in this chat; one taken after them switches them back on.
  const no = (topic: string, url: string) => qa(topic, url).map((e) => ({ ...e, dismissed: { move: true as const } }))
  const tired = chat("tired", [...qa("react", "https://react/1"), ...no("a", "https://a/1"), ...no("b", "https://b/1"), ...no("c", "https://c/1")])
  assert.equal(movesAllowed(tired, [tired], cfg), false)
  const taken = chat("t", qa("d", "https://d/1").map((e) => ({ ...e, from: { chat: "tired", at: 10_000_000 } })))
  assert.equal(movesAllowed(tired, [tired, taken], cfg), true)
})

test("short questions in Chinese, Japanese and Korean say enough: their characters count three times", () => {
  assert.equal(textSize("Kyoto tips?"), 11)
  assert.equal(textSize("京都哪里好玩？"), 19)
  assert.equal(textSize("교토 어디가 좋아요?"), 27)
  // Asked in the app (no page) about another chat's topic: a short Chinese, Japanese or Korean question moves, as short
  // a question in English doesn't.
  for (const [question, moves] of [["京都哪里好玩？", true], ["京都のおすすめは？", true], ["교토 어디가 좋아요?", true], ["Kyoto tips?", false]] as const) {
    const asked = qa("japan", "https://jg/1", { question }).map((e) => (e.role === "user" ? { ...e, page: undefined } : e))
    const pile = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...asked])
    assert.equal(suggestMove(pile, [pile, japan, bread], vectorOf, cfg)?.to ?? null, moves ? "japan" : null, question)
  }
})

test("tags: only the user's tags with two examples or more that are alike; not intentions; not the ones it has", () => {
  const work = chat("work", [...qa("work", "https://w/1", { tags: ["work"] }), ...qa("work", "https://w/2", { tags: ["work"] }), ...qa("work", "https://w/3")])
  // "later" on unrelated answers: its examples aren't alike.
  const misc = chat("misc", [...qa("bread", "https://b/1", { tags: ["later"] }), ...qa("japan", "https://j/1", { tags: ["later"] }), ...qa("cars", "https://c/1", { tags: ["later"] })])
  const once = chat("once", [...qa("garden", "https://g/1", { tags: ["garden"] }), ...qa("garden", "https://g/2")])
  const all = [work, misc, once, japan, bread]
  const target = tagCandidates(work, 5, all, vectorOf, cfg)
  assert.deepEqual(target.map((c) => c.tag), ["work"])
  assert.ok(target[0].examples.length >= 2)
  assert.deepEqual(tagCandidates(once, 3, all, vectorOf, cfg), [], "one example is not enough")
  assert.deepEqual(tagCandidates(misc, 1, all, vectorOf, cfg).map((c) => c.tag).includes("later"), false)
  assert.deepEqual(tagCandidates(work, 1, all, vectorOf, cfg), [], "it has the tag")
  // The judge decides: a confident yes only, at most two.
  assert.deepEqual(judgedTags(target, [{ tag: "#work", fits: true, confidence: 0.9 }], cfg), ["work"])
  assert.deepEqual(judgedTags(target, [{ tag: "work", fits: true, confidence: 0.5 }], cfg), [])
  // One tag per message: the best candidate the judge confirms.
  const two = [target[0], { ...target[0], tag: "dev" }]
  assert.deepEqual(judgedTags(two, [{ tag: "dev", fits: true, confidence: 0.95 }, { tag: "work", fits: true, confidence: 0.9 }], cfg), ["work"])
  assert.deepEqual(tagTargets(work, cfg), [1, 3, 5])
})

test("a tag refused on three messages without one taken isn't suggested again", () => {
  const no = (tag: string) => (e: Entry) => (e.role === "assistant" ? { ...e, dismissed: { tags: [tag] } } : e)
  const c = chat("c", [...qa("x", "https://x/1").map(no("work")), ...qa("x", "https://x/2").map(no("work")), ...qa("x", "https://x/3").map(no("Work"))])
  assert.deepEqual([...refusedTags([c], cfg)], ["work"])
  const yes = chat("y", qa("x", "https://x/4").map((e) => (e.role === "assistant" ? { ...e, t: 99_999_999, accepted: { tags: ["work"] } } : e)))
  assert.deepEqual([...refusedTags([c, yes], cfg)], [])
})

test("texts, packed vectors, thresholds and the pile signal", () => {
  assert.equal(embedText({ role: "user", content: "Summarize this page in five points, plain words…", label: "Summarize", page: { url: "u", title: "Kyoto temples" } }), "Summarize\nKyoto temples")
  assert.equal(embedText({ role: "assistant", content: "**Bold** [1](https://a.b/c) text" }), "Bold text")
  const v = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i))
  const back = unpackVector(packVector(v))!
  let dotv = 0
  let n = 0
  for (let i = 0; i < 256; i++) { dotv += back[i] * v[i]; n += v[i] * v[i] }
  assert.ok(dotv / Math.sqrt(n) > 0.999)
  assert.equal(unpackVector("%%%"), null)
  assert.deepEqual(organizeConfig({ moveT: 0.6, window: "5", nope: 1 }), { ...DEFAULT_ORGANIZE, moveT: 0.6 })
  const sites = chat("s", [...qa("a", "https://a.com/1"), ...qa("b", "https://b.com/1"), ...qa("c", "https://c.com/1")])
  assert.equal(looksMixed(sites, cfg), true)
  assert.equal(looksMixed(japan, cfg), false)
})

// 2.6 (90): notes count, and moves make chats more about one thing, in one direction.
function note(topic: string, url: string, text: string): Entry {
  topicOf.set(text, topic)
  clock += 1_000
  return { role: "user", content: text, note: true, page: { url, title: `${topic} page`, at: clock }, id: `n${++salt}`, t: clock }
}

test("a chat with only a note on a page joins the chat with questions about that page, not the other way", () => {
  const site = chat("site", [...qa("cf", "https://context-flow.app/"), ...qa("cf", "https://context-flow.app/")])
  // Too short to be judged by its words, but the page says where it belongs.
  const memo = chat("memo", [note("cf", "https://context-flow.app/", "FAQ for pricing")])
  const s = suggestMove(memo, [site, memo], vectorOf, cfg)!
  assert.equal(s.to, "site")
  assert.equal(s.why, "page")
  assert.deepEqual([s.start, s.end], [0, 0])
  assert.equal(suggestMove(site, [site, memo], vectorOf, cfg), null)
  // A longer note on another page of the topic joins by topic.
  const memo2 = chat("memo2", [note("cf", "https://context-flow.app/blog", "Write the post about sorting chats by topic, with the before and after")])
  assert.equal(suggestMove(memo2, [site, memo2], vectorOf, cfg)?.to, "site")
})

test("off-topic messages leave a mixed chat for the single-topic one; the single-topic chat never goes into the mix", () => {
  const mix = chat("mix", [...qa("cars", "https://cars/1"), ...qa("cars", "https://cars/2"), ...qa("analytics", "https://stats/1"), ...qa("analytics", "https://stats/2")])
  const one = chat("one", qa("analytics", "https://stats/3"))
  const s = suggestMove(mix, [mix, one], vectorOf, cfg)!
  assert.equal(s.to, "one")
  assert.deepEqual([s.start, s.end], [4, 7], "both analytics blocks, together")
  assert.equal(suggestMove(one, [mix, one], vectorOf, cfg), null, "not into the mix")
  // Mostly that analytics site (three of four): the one-topic chat joins it (where the mix is narrower), and its cars
  // leave for a chat of their own.
  const most = chat("most", [...qa("analytics", "https://stats/1"), ...qa("analytics", "https://stats/2"), ...qa("analytics", "https://stats/4"), ...qa("cars", "https://cars/1")])
  assert.deepEqual([suggestMove(one, [most, one], vectorOf, cfg)?.to, suggestMove(one, [most, one], vectorOf, cfg)?.why], ["most", "site"])
  const out = suggestMove(most, [most, one], vectorOf, cfg)!
  assert.deepEqual([out.to, out.start, out.end], [null, 6, 7], "its analytics are at home; the cars leave")
  const clean = chat("most", most.m.slice(0, 6))
  assert.equal(suggestMove(one, [clean, one], vectorOf, cfg)?.to, "most")
})

test("two one-topic chats of one block each: only the smaller joins the larger", () => {
  const a = chat("a", [...qa("bread", "https://bread/9"), { role: "user", content: "and rye?", id: "x1", t: 1 }, { role: "assistant", content: "rye too", id: "x2", t: 2 }])
  const b = chat("b", qa("bread", "https://bread/8"))
  topicOf.set("and rye?", "bread")
  topicOf.set("rye too", "bread")
  assert.equal(suggestMove(b, [a, b], vectorOf, cfg)?.to, "a")
  assert.equal(suggestMove(a, [a, b], vectorOf, cfg), null)
})

test("naming (2.6): what the AI reads, when a name gets checked by itself, never over a name the user typed", () => {
  const site = chat("site", [...qa("cf", "https://context-flow.app/"), note("cf", "https://context-flow.app/", "**Ask** about [1](https://x.example/a) the FAQ")])
  const text = nameText(site.m)
  assert.match(text, /^Page: cf page\nQuestion: cf question \d+ about something long enough\nAnswer: cf answer \d+ with details\nNote: Ask about the FAQ$/)
  assert.equal(wantsNameCheck(site), true)
  assert.equal(wantsNameCheck(chat("one", qa("cf", "https://context-flow.app/"))), false, "one question names it well enough")
  assert.equal(wantsNameCheck({ ...site, title: "Mine" }), false, "typed by the user")
  assert.equal(wantsNameCheck({ ...site, title: "Theirs", aiTitle: "Theirs" }), true, "the AI's own name")
  assert.equal(wantsNameCheck({ ...site, title: "Mine", aiTitle: "Theirs" }), false, "renamed by the user after the AI")
  assert.equal(wantsNameCheck({ ...site, kind: "history" }), false)
  // Checked again when a page is added or the name changed; not for another answer on the same page.
  const key = nameCheckKey(site)
  const more = chat("site", [...site.m, ...qa("cars", "https://cars/1")])
  assert.notEqual(nameCheckKey(more), key)
  assert.notEqual(nameCheckKey(site, "Other"), key)
  assert.equal(nameCheckKey({ ...site, m: [...site.m, { role: "assistant", content: "more", id: "z", t: 1 }] }), key)
  // A long chat: its first page and the latest that fit.
  const long = chat("long", Array.from({ length: 40 }, (_, i) => qa(`t${i}`, `https://long/${i}`, { question: `Question ${i} ${"words ".repeat(50)}` })).flat())
  const cut = nameText(long.m)
  assert.ok(cut.length <= 6_000)
  assert.match(cut, /^Page: t0 page/)
  assert.match(cut, /Question 39/)
  assert.doesNotMatch(cut, /Question 20 /)
})

test("2.6 (91): a chat with one short note on a page of a site joins the chat with the most questions on that site", () => {
  const site = chat("site", [...qa("cf", "https://context-flow.app/"), ...qa("cf", "https://context-flow.app/pricing"), ...qa("cf", "https://context-flow.app/support")])
  const other = chat("other", [...qa("cf", "https://context-flow.app/blog"), ...qa("cars", "https://cars/9")])
  // Its page isn't in either chat, and it's too short to be judged by its words.
  const memo = chat("memo", [note("cf", "https://context-flow.app/changelog", "Release notes")])
  const s = suggestMove(memo, [site, other, memo], vectorOf, cfg)!
  assert.deepEqual([s.to, s.why, s.start, s.end], ["site", "site", 0, 0])
  // The site's chat doesn't go into the note's chat.
  assert.equal(suggestMove(site, [site, other, memo], vectorOf, cfg), null)
  // A site chat about something else entirely (one video site, every topic) doesn't take a note on another topic.
  const videos = chat("videos", [...qa("cars", "https://video.example/1"), ...qa("cars", "https://video.example/2")])
  const cooking = chat("cooking", [note("borsch", "https://video.example/3", "Try this borsch recipe with smoked pears on Sunday, for the guests")])
  assert.equal(suggestMove(cooking, [videos, cooking], vectorOf, cfg), null)
})

test("2.6 (93): the questions about a site may all be on one page (one block): a lone note there joins them, one way", () => {
  const home = chat("home", [...qa("cf", "https://context-flow.app/"), ...qa("cf", "https://context-flow.app/"), ...qa("cf", "https://context-flow.app/")])
  const memo = chat("memo", [note("cf", "https://context-flow.app/changelog", "Release notes")])
  const s = suggestMove(memo, [home, memo], vectorOf, cfg)!
  assert.deepEqual([s.to, s.why], ["home", "site"])
  assert.equal(suggestMove(home, [home, memo], vectorOf, cfg), null)
  // Two lone notes on one site: neither has more, nothing joins.
  const blog = chat("blog", [note("cf", "https://context-flow.app/blog", "Post about sorting")])
  assert.equal(suggestMove(blog, [blog, memo], vectorOf, cfg), null)
  // One video's question doesn't take a note on another topic from the same video site.
  const car = chat("car", qa("cars", "https://video.example/7"))
  const cooking = chat("cooking", [note("borsch", "https://video.example/8", "Try this borsch recipe with smoked pears on Sunday, for the guests")])
  assert.equal(suggestMove(cooking, [car, cooking], vectorOf, cfg), null)
})

// ------------------------------------------------------------ the match % (2.6 (93))

test("the match %: 0 at what unrelated chats score, 100 at what a chat's own messages score; moveT is 78 %", () => {
  assert.equal(matchPercent(0.17, cfg), 0)
  assert.equal(matchPercent(0.66, cfg), 100)
  assert.equal(matchPercent(0.55, cfg), 78)
  assert.equal(matchPercent(0.05, cfg), 0)
  assert.equal(matchPercent(0.9, cfg), 100)
})

test("a move to another chat says how well it matches; under the minimum it doesn't go there; a new chat has no %", () => {
  const pile = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...qa("japan", "https://travel-blog/9")])
  const s = suggestMove(pile, [pile, japan, bread], vectorOf, cfg)!
  assert.equal(s.to, "japan")
  assert.ok(s.match !== undefined && s.match >= cfg.minMatch && s.match <= 100, String(s.match))
  // Under the minimum it doesn't go there (the block, not like its own chat either, is offered a new one).
  assert.equal(suggestMove(pile, [pile, japan, bread], vectorOf, { ...cfg, minMatch: 100.5 })?.to, null)
  const apart = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...qa("cars", "https://car/1")])
  assert.equal(suggestMove(apart, [apart, japan, bread], vectorOf, cfg)!.match, undefined)
})

// ------------------------------------------------------------ organizing's state, kept with the chat (2.6 (93))

test("the kept move shows while the chat is as it was, and goes when it changes, is turned down or its chat is gone", () => {
  const pile = chat("pile", [...qa("react", "https://react/1"), ...qa("react", "https://react/2"), ...qa("react", "https://react/3"), ...qa("japan", "https://travel-blog/9")])
  const s = suggestMove(pile, [pile, japan, bread], vectorOf, cfg)!
  const kept = { ...pile, org: orgStateFor(pile, s, [], undefined) }
  assert.deepEqual(openMove(kept, [kept, japan, bread]), { s: 6, e: 7, to: "japan", why: "topic", mt: s.match })
  // Another device, a message later: not this one any more (its own run says what now).
  const more = { ...kept, m: [...kept.m, ...qa("react", "https://react/4")] }
  assert.equal(openMove(more, [more, japan, bread]), undefined)
  const refused = { ...kept, m: kept.m.map((e, i) => (i >= 6 ? { ...e, dismissed: { move: true as const } } : e)) }
  assert.equal(openMove(refused, [refused, japan, bread]), undefined)
  assert.equal(openMove(kept, [kept, { ...japan, deleted: true }, bread]), undefined)
})

test("kept tags show until taken or turned down", () => {
  const m = [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2")]
  const keys = m.map((e) => e.id!)
  const c = chat("c", m, { org: { n: m.length, k: keys[3], tg: [[keys[1], "Travel"], [keys[3], "Food"]] } })
  assert.deepEqual(openTags(c).map((t) => t.tag), ["Travel", "Food"])
  const taken = { ...c, m: c.m.map((e, i) => (i === 1 ? { ...e, tags: ["travel"] } : i === 3 ? { ...e, dismissed: { tags: ["food"] } } : e)) }
  assert.deepEqual(openTags(taken), [])
})

test("a name turned down never comes back; a fitting name, or one the user typed, gets none", () => {
  const m = [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2")]
  const c = chat("c", m)
  const first = nameStateAfter(undefined, "k1", { fits: false, title: "Japan trip" }, "q")
  assert.deepEqual(first, { k: "k1", t: "Japan trip" })
  assert.equal(openName({ ...c, org: { n: 4, k: "", nm: first } }), "Japan trip")
  // Turned down (store.settleNameSuggestion keeps it in `no`): the next check suggesting it again changes nothing.
  const after = nameStateAfter({ k: "k1", no: ["Japan trip"] }, "k2", { fits: false, title: "japan trip" }, "q")
  assert.deepEqual(after, { k: "k2", no: ["Japan trip"] })
  assert.equal(openName({ ...c, org: { n: 4, k: "", nm: { k: "k2", t: "Japan trip", no: ["Japan trip"] } } }), undefined)
  assert.deepEqual(nameStateAfter(undefined, "k1", { fits: true, title: "Japan trip" }, "q"), { k: "k1" })
  assert.equal(openName({ ...c, title: "Mine", org: { n: 4, k: "", nm: first } }), undefined)
})

// 2.6 (94): an answer off its chat's topic at the end of a page block gets a suggestion of its own; chats on one topic
// and the same pages merge, the older one into the newer one.
test("an answer off the chat's topic on the same page goes to the chat about it, else to a new chat", () => {
  const page = "https://react/1"
  const off = chat("off", [...qa("react", page), ...qa("react", page), ...qa("react", page), ...qa("japan", page)])
  const there = suggestMove(off, [off, japan, bread], vectorOf, cfg)!
  assert.deepEqual([there.to, there.why, there.start, there.end], ["japan", "topic", 6, 7])
  assert.ok(there.match! >= cfg.minMatch)
  const apart = suggestMove(off, [off, bread], vectorOf, cfg)!
  assert.deepEqual([apart.to, apart.why, apart.start, apart.end], [null, "apart", 6, 7])
  // Two off-topic answers alike go together; three on the topic stay; one staying is too little.
  const two = chat("two", [...qa("react", page), ...qa("react", page), ...qa("japan", page), ...qa("japan", page)])
  assert.deepEqual([suggestMove(two, [two, bread], vectorOf, cfg)?.start, suggestMove(two, [two, bread], vectorOf, cfg)?.end], [4, 7])
  assert.equal(suggestMove(chat("fine", [...qa("react", page), ...qa("react", page), ...qa("react", page)]), [bread], vectorOf, cfg), null)
  assert.equal(suggestMove(chat("short", [...qa("react", page), ...qa("japan", page)]), [bread], vectorOf, cfg), null)
  // Asked in the app (no page): the same.
  const inApp = qa("japan", page).map((e) => (e.role === "user" ? { ...e, page: undefined } : e))
  assert.equal(suggestMove(chat("app", [...qa("react", page), ...qa("react", page), ...inApp]), [bread], vectorOf, cfg)?.why, "apart")
  // Turned down: not again.
  const refused = qa("japan", page).map((e) => ({ ...e, dismissed: { move: true as const } }))
  assert.equal(suggestMove(chat("no", [...qa("react", page), ...qa("react", page), ...refused]), [bread], vectorOf, cfg), null)
})

test("a chat on the topic and pages of a newer one joins it whole; never the other way, nor into a lone note", () => {
  const older = chat("older", [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2")])
  const newer = chat("newer", [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2"), ...qa("japan", "https://jg/4")])
  const s = suggestMove(older, [older, newer], vectorOf, cfg)!
  assert.deepEqual([s.to, s.why, s.start, s.end], ["newer", "merge", 0, 3])
  assert.ok(s.match! >= cfg.minMatch)
  // 2.6 (95): the newer chat, where the person is, shows it too: the older one joins it here.
  const into = suggestMove(newer, [older, newer], vectorOf, cfg)!
  assert.deepEqual([into.why, into.from, into.to, into.start, into.end], ["merge", "older", "newer", 5, 5])
  assert.deepEqual(orgStateFor(newer, into, [], undefined).mv, { s: 5, e: 5, to: "newer", why: "merge", mt: into.match, fr: "older" })
  // Turned down (kept with the chat, on every device): not again, and carried by the next run's state.
  const no = { ...older, org: { n: 4, k: "x", mx: ["newer"] } }
  assert.equal(suggestMove(no, [no, newer], vectorOf, cfg), null)
  assert.equal(suggestMove(newer, [no, newer], vectorOf, cfg), null)
  assert.deepEqual(orgStateFor(no, null, [], undefined).mx, ["newer"])
  // Other pages, another topic on the same pages: no merge.
  const elsewhere = chat("elsewhere", [...qa("japan", "https://other/1"), ...qa("japan", "https://other/2")])
  assert.notEqual(suggestMove(older, [older, elsewhere], vectorOf, cfg)?.why, "merge")
  const breadOnJg = chat("breadjg", [...qa("bread", "https://jg/1"), ...qa("bread", "https://jg/2")])
  assert.notEqual(suggestMove(older, [older, breadOnJg], vectorOf, cfg)?.why, "merge")
  // A newer chat of one note joins the older one, as before (2.6 (91)).
  const memo = chat("memo", [note("japan", "https://jg/1", "Rail pass: buy it before the trip, it costs less at home")])
  assert.equal(suggestMove(memo, [older, memo], vectorOf, cfg)?.to, "older")
  assert.equal(suggestMove(older, [older, memo], vectorOf, cfg), null)
})

// 2.6 (95): an exchange whose question and answer are on different topics (the question carries its page's title).
function qa2(qTopic: string, aTopic: string, url: string): Entry[] {
  const q = `${qTopic} question ${++salt} on the ${aTopic} subject, long enough`
  const a = `${aTopic} answer ${salt} with details`
  topicOf.set(q, qTopic)
  topicOf.set(a, aTopic)
  clock += 1_000
  return [{ role: "user", content: q, page: { url, title: `${qTopic} page`, at: clock }, id: `q${salt}`, t: clock }, { role: "assistant", content: a, id: `a${salt}`, t: clock + 10 }]
}

test("2.6 (95): chats on a shared page merge when their answers are on one topic, not when only the page's title is", () => {
  // The questions of both are mostly the page's title (japan); the newer chat's answers are about bread.
  const older = chat("older", [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2")])
  const sameTopic = chat("same", [...qa2("japan", "japan", "https://jg/1"), ...qa2("japan", "japan", "https://jg/5")])
  assert.equal(suggestMove(older, [older, sameTopic], vectorOf, cfg)?.to, "same")
  const otherTopic = chat("other", [...qa2("japan", "bread", "https://jg/1"), ...qa2("japan", "bread", "https://jg/5")])
  assert.notEqual(suggestMove(older, [older, otherTopic], vectorOf, cfg)?.why, "merge")
  assert.notEqual(suggestMove(otherTopic, [older, otherTopic], vectorOf, cfg)?.why, "merge")
  // One shared page of two is enough, and the newer chat may be one block.
  const oneBlock = chat("oneblock", [...qa("japan", "https://jg/2"), ...qa("japan", "https://jg/2")])
  assert.deepEqual([suggestMove(older, [older, oneBlock], vectorOf, cfg)?.why, suggestMove(older, [older, oneBlock], vectorOf, cfg)?.to], ["merge", "oneblock"])
})

test("2.6 (95): a merge needs the match it shows, by questions and answers, from minMatch % too", () => {
  // The newer chat's questions are on another topic and its answers partly on the older chat's: the answers fit each
  // other (mergeA), the questions and answers don't, and that is the % a merge shows.
  const blend = (a: Float32Array, b: Float32Array) => { const v = a.map((x, i) => x * 0.6 + b[i] * 0.8); let n = 0; for (const x of v) n += x * x; return v.map((x) => x / Math.sqrt(n)) }
  const custom = new Map<string, Float32Array>()
  const vo: VectorOf = (e) => custom.get(e.content) ?? vectorOf(e)
  const halfOn = (url: string) => { const m = qa2("bread", "japan", url); custom.set(m[1].content, blend(vectorFor("japan", 0), vectorFor("bread", 1))); return m }
  const older = chat("older", [...qa("japan", "https://jg/1"), ...qa("japan", "https://jg/2")])
  const newer = chat("newer", [...halfOn("https://jg/1"), ...halfOn("https://jg/5")])
  const ungated = suggestMove(older, [older, newer], vo, { ...cfg, minMatch: 0 })!
  assert.deepEqual([ungated.why, ungated.to], ["merge", "newer"])
  assert.ok(ungated.match! < cfg.minMatch)
  assert.notEqual(suggestMove(older, [older, newer], vo, cfg)?.why, "merge")
  assert.notEqual(suggestMove(newer, [older, newer], vo, cfg)?.why, "merge")
})

test("2.6 (95): a chat of two pages on two topics: the newer page goes", () => {
  const tents = chat("tents", [...qa("tents", "https://outdoor/tents"), ...qa("tents", "https://campshop/2p")])
  const camera = chat("camera", [...qa("camera", "https://shop/camera-x"), ...qa("camera", "https://shop/camera-x"), ...qa("tents", "https://other/tent-y")])
  const s = suggestMove(camera, [camera, tents, bread], vectorOf, cfg)!
  assert.deepEqual([s.start, s.end, s.to, s.why], [4, 5, "tents", "topic"])
  // No chat for it: a new chat, as two questions stay.
  const alone = suggestMove(camera, [camera, bread], vectorOf, cfg)!
  assert.deepEqual([alone.start, alone.end, alone.to, alone.why], [4, 5, null, "apart"])
  // A block on a page the chat has elsewhere is that chat's.
  const back = chat("back", [...qa("camera", "https://shop/camera-x"), ...qa("kombucha", "https://kitchn/k"), ...qa2("camera", "kombucha", "https://shop/camera-x")])
  assert.ok(suggestMove(back, [back, bread], vectorOf, cfg)?.start !== 4)
})

test("2.6 (95): the end of a block whose answer fits another chat far better goes there, though its question has the page's title", () => {
  const monitors = chat("monitors", [...qa("monitor", "https://rtings/dell"), ...qa("monitor", "https://lg/27up850")])
  const vacuum = chat("vacuum", [...qa("vacuum", "https://roborock/s8"), ...qa("vacuum", "https://roborock/s8"), ...qa("vacuum", "https://roborock/s8"), ...qa2("vacuum", "monitor", "https://roborock/s8")])
  const s = suggestMove(vacuum, [vacuum, monitors, bread], vectorOf, cfg)!
  assert.deepEqual([s.start, s.end, s.to, s.why], [6, 7, "monitors", "topic"])
  // Without that chat its question, with the page's title, keeps it with the page's chat (tailQA and tailA together).
  assert.equal(suggestMove(vacuum, [vacuum, bread], vectorOf, cfg), null)
})

test("2.6 (95): a site's chat takes a chat of questions on that site only on its topic; a note's chat by its site as before", () => {
  const headphones = chat("headphones", [...qa("headphones", "https://rtings/xm5"), ...qa("headphones", "https://rtings/airpods"), ...qa("headphones", "https://apple/airpods")])
  const monitor = chat("monitor", [...qa("monitor", "https://rtings/dell"), ...qa("monitor", "https://rtings/dell")])
  assert.equal(suggestMove(monitor, [monitor, headphones], vectorOf, cfg), null)
})

test("2.6 (95): a Find similar request and answer are embedded by what they're about, not by the condition and caveats", () => {
  const page = { url: "https://shop.example/earbuds-x", title: "Earbuds X - Example Shop", at: 1 }
  assert.equal(embedText({ role: "user", content: "Cheaper", label: "Cheaper", similarAsk: "", page }), "Earbuds X - Example Shop")
  assert.equal(embedText({ role: "user", content: "Cheaper", label: "Cheaper", similarAsk: "", similarSel: "the pro model", page }), "the pro model\nEarbuds X - Example Shop")
  const list = "Wireless earbuds like the Earbuds X.\n\n1. **[Buds One](https://a.example/1)** (a.example) — Noise cancelling. The page states no price, so it's unclear whether it is cheaper than 99 EUR; it is not a local shop. _(Not confirmed)_\n2. **[Sound Pod 2](https://b.example/2)** (b.example) — Long battery. _(59.00 USD · Not confirmed)_\n\nCheck the price and delivery before buying."
  assert.equal(embedText({ role: "assistant", content: list }), "Wireless earbuds like the Earbuds X.\nBuds One; Sound Pod 2")
  // An answer that only has a numbered list of its own is embedded as before.
  assert.equal(embedText({ role: "assistant", content: "1. Boil water\n2. Add pasta" }), "1. Boil water 2. Add pasta")
})

test("2.6 (95): a page with a question on the chat's topic and then one on another: only the latter goes", () => {
  const sleep = chat("sleepchat", [...qa("sleep", "https://sleep/caffeine"), ...qa("sleep", "https://sleep/caffeine"), ...qa("sleep", "https://sleep/light"), ...qa("kombucha", "https://sleep/light")])
  const s = suggestMove(sleep, [sleep, bread], vectorOf, cfg)!
  assert.deepEqual([s.start, s.end, s.to], [6, 7, null])
  // A page whose questions are all off the chat goes whole.
  const two = chat("twoff", [...qa("sleep", "https://sleep/caffeine"), ...qa("sleep", "https://sleep/caffeine"), ...qa("kombucha", "https://k/1"), ...qa("kombucha", "https://k/1")])
  const w = suggestMove(two, [two, bread], vectorOf, cfg)!
  assert.deepEqual([w.start, w.end, w.to], [4, 7, null])
})
