import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import {
  DEFAULT_ORGANIZE, embedText, judgedTags, looksMixed, movesAllowed, nameCheckKey, nameText, organizeConfig, packVector, refusedTags, suggestMove, tagCandidates, tagTargets, unpackVector, wantsNameCheck, type VectorOf
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

// The owner's notes on 2.6 (90): notes count, and moves make chats more about one thing, in one direction.
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
  // Mostly analytics (three of four) but still a mix: its cars go first (a new chat), then the one-topic chat joins it.
  const most = chat("most", [...qa("analytics", "https://stats/1"), ...qa("analytics", "https://stats/2"), ...qa("analytics", "https://stats/4"), ...qa("cars", "https://cars/1")])
  assert.equal(suggestMove(one, [most, one], vectorOf, cfg), null)
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
