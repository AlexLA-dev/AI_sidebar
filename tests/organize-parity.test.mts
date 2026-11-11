// The panel and the app organize chats the same way: the same cases through src/shared (JS) and through
// ContextFlow/Shared (App)/Organize.swift (built here with tests/organize-parity/main.swift) give the same
// results. Skipped where there's no Swift compiler.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { entryKey, entryTimes, withPageChanges, type Entry } from "../src/shared/conversation.ts"
import {
  embedText, hostOf, judgedTags, organizeScan, judgeText, looksMixed, missingVectors, movesAllowed, nameCheckKey, nameStateAfter, nameText, openMove, openName, openTags,
  organizeConfig, orgStateFor, packVector, refusedTags, scoredBlocks, suggestMove, tagCandidates, tagTargets, unpackVector, wantsNameCheck, type TagCandidate,
  type VectorOf
} from "../src/shared/organize.ts"
import { cleanOrgState, moveEntries, pageBlocks, sweepMoved, threadName, undoMove, type Thread, type Threads } from "../src/shared/threads.ts"

const root = new URL("..", import.meta.url).pathname
const swiftc = spawnSync("which", ["swiftc"]).status === 0
// The app runs on Apple's Foundation. Linux's (swift-corelibs) has no CoreFoundation functions in scope and reads
// some JSON numbers a bit off (a rounding tie lands on the other side), so there the test would compare the panel
// with a runtime the app never uses. It runs on a Mac (npm run check), not on the Linux CI runner.
const skip = process.platform !== "darwin" ? "the app's Foundation is Apple's: run on a Mac" : !swiftc && "no swiftc here"

type Case = Record<string, unknown> & { op: string }
type Verdict = { tag: string; fits: boolean; confidence: number }

/** A thread as both sides print it: its id, time and stored fields, or null when it's gone. */
function shown(t: Thread | undefined | null): unknown {
  if (!t || t.deleted) return null
  const { kind, deleted: _deleted, ...rest } = t
  return { ...rest, ...(kind ? { k: kind } : {}) }
}

/** The case's vectors by message key, as numbers or packed (base64): both sides use the same ones. */
const vectorsOf = (table: unknown): VectorOf => (e) => {
  const x = (table as Record<string, number[] | string>)[entryKey(e)]
  return x === undefined ? null : typeof x === "string" ? unpackVector(x) : Float32Array.from(x)
}
const numbers = (v: Float32Array | null) => (v ? Array.from(v) : null)

function js(c: Case): unknown {
  const cfg = organizeConfig(c.cfg)
  const chat = c.chat as Thread
  const chats = c.chats as Thread[]
  switch (c.op) {
    case "config":
      return organizeConfig(c.raw)
    case "embedText":
      return (c.m as Entry[]).map(embedText)
    case "nameText":
      return nameText(c.m as Entry[])
    case "wantsNameCheck":
      return wantsNameCheck(c.chat as Thread)
    case "org": {
      // As the panel reads a chat back (threadFromCloud cleans its "org").
      const org = cleanOrgState(chat.org)
      const t: Thread = { ...chat, org }
      return {
        clean: org ?? null,
        move: openMove(t, chats) ?? null,
        tags: openTags(t),
        name: openName(t) ?? null,
        after: nameStateAfter(org?.nm, c.key as string, c.answer as { fits: boolean; title: string }, c.current as string),
        state: orgStateFor(t, suggestMove(t, chats, vectorsOf(c.vectors), cfg), ((c.tg ?? []) as Array<[string, string]>).map(([key, tag]) => ({ key, tag })), org?.nm),
        key: nameCheckKey(t)
      }
    }
    case "hostOf":
      return (c.urls as Array<string | null>).map(hostOf)
    case "pack": {
      const packed = (c.vectors as number[][]).map((v) => packVector(v))
      return { packed, unpacked: packed.map((p) => numbers(unpackVector(p))) }
    }
    case "unpack":
      return (c.packed as string[]).map((p) => numbers(unpackVector(p)))
    case "scoredBlocks":
      return scoredBlocks(c.m as Entry[], vectorsOf(c.vectors)).map((b) => ({ ...b, v: numbers(b.v), a: numbers(b.a) }))
    case "movesAllowed":
      return movesAllowed(chat, chats, cfg)
    case "suggestMove":
      return suggestMove(chat, chats, vectorsOf(c.vectors), cfg)
    case "scan": {
      const vectorOf = vectorsOf(c.vectors)
      return organizeScan(chat, chats, vectorOf, cfg, suggestMove(chat, chats, vectorOf, cfg))
    }
    case "tags": {
      const vectorOf = vectorsOf(c.vectors)
      return tagTargets(chat, cfg, chats, vectorOf).map((i) => {
        const candidates = tagCandidates(chat, i, chats, vectorOf, cfg)
        return { i, judge: judgeText(chat.m, i), candidates, judged: judgedTags(candidates, (c.verdicts ?? []) as Verdict[], cfg) }
      })
    }
    case "tagCandidates":
      return tagCandidates(chat, c.index as number, chats, vectorsOf(c.vectors), cfg)
    case "refusedTags":
      return [...refusedTags(chats, cfg)].sort()
    case "judgedTags": {
      const candidates: TagCandidate[] = (c.candidates as string[]).map((tag) => ({ tag, pos: 0, neg: 0, coherence: 0, examples: [] }))
      return judgedTags(candidates, c.verdicts as Verdict[], cfg)
    }
    case "looksMixed":
      return looksMixed(chat, cfg)
    case "missingVectors": {
      const known = c.known as Record<string, string>
      return missingVectors(chats, (key, text) => known[key] === text, (c.max as number | undefined) ?? Infinity)
    }
    case "basics": {
      const m = c.m as Entry[]
      return { keys: m.map(entryKey), times: entryTimes(m), blocks: pageBlocks(m), pageChanges: withPageChanges(m).map((e) => e.pageChanged === true) }
    }
    case "move":
    case "undo": {
      const source = c.source as Thread
      const target = c.target as Thread | undefined
      const threads: Threads = { [source.id]: source, ...(target ? { [target.id]: target } : {}) }
      const moved = moveEntries(threads, {}, source.id, c.start as number, c.end as number, c.targetId as string, c.now as number)
      if (!moved) return null
      if (c.op === "move") return { source: shown(moved.threads[source.id]), target: shown(moved.threads[c.targetId as string]) }
      const current = { ...moved.threads }
      if ("changedSource" in c) current[source.id] = c.changedSource as Thread
      if ("changedTarget" in c) current[c.targetId as string] = c.changedTarget as Thread
      const back = undoMove(current, {}, moved.undo, c.later as number)
      if (back === current) return null
      return { source: shown(back[source.id]), target: shown(back[c.targetId as string]) }
    }
    case "sweep": {
      const list = c.threads as Thread[]
      const before = Object.fromEntries(list.map((t) => [t.id, t]))
      const swept = sweepMoved(before, {}, c.now as number).threads
      const changed = list.filter((t) => swept[t.id] && swept[t.id] !== t).map((t) => shown(swept[t.id]))
      return { changed, emptied: list.filter((t) => !swept[t.id]).map((t) => t.id).sort() }
    }
  }
  return null
}

// A run takes about half a second, the build under a minute. The binary reads its input to the end first: with
// execFileSync(bin, { input }) it was seen on this Mac waiting in read() for an end of input that never came (0 % CPU,
// for hours). So the input goes in through spawn and stdin.end(), and a run that doesn't answer fails the test after
// RUN_MS, killed, instead of holding the suite.
const BUILD_MS = 300_000
const RUN_MS = 60_000

async function swift(cases: Case[]): Promise<unknown[]> {
  const dir = mkdtempSync(join(tmpdir(), "cf-organize-"))
  const bin = join(dir, "organize")
  execFileSync("swiftc", ["-O", join(root, "ContextFlow/Shared (App)/Organize.swift"), join(root, "tests/organize-parity/main.swift"), "-o", bin], { stdio: "pipe", timeout: BUILD_MS, killSignal: "SIGKILL" })
  const child = spawn(bin, { stdio: "pipe" })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on("data", (b: Buffer) => out.push(b))
  child.stderr.on("data", (b: Buffer) => err.push(b))
  child.stdin.on("error", () => undefined)
  child.stdin.end(JSON.stringify(cases))
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code))
  })
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), RUN_MS) })
  const code = await Promise.race([done, late]).finally(() => clearTimeout(timer))
  if (code === "late") {
    child.kill("SIGKILL")
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy()
    throw new Error(`the Swift side didn't answer in ${RUN_MS / 1000} s (pid ${child.pid}, killed): ${Buffer.concat(err).toString().slice(0, 500)}`)
  }
  if (code !== 0) throw new Error(`the Swift side exited with ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`)
  return JSON.parse(Buffer.concat(out).toString())
}

// ------------------------------------------------------------ cases

const page = (url: string, at?: number, extra: Record<string, unknown> = {}) => ({ url, title: url.split("/").pop() ?? url, hash: "h1", ...(at !== undefined ? { at } : {}), ...extra })
const q = (content: string, url: string, at?: number, extra: Partial<Entry> = {}): Entry => ({ role: "user", content, page: page(url, at), ...extra })
const a = (content: string, extra: Partial<Entry> = {}): Entry => ({ role: "assistant", content, ...extra })

const mixed: Entry[] = [
  q("Старый вопрос без времени", "https://a.example/1"), a("ответ"),
  q("Sofa sizes?", "https://ikea.example/sofa", 1_000, { page: page("https://ikea.example/sofa", 1_000, { text: "Sofa page text — 200 cm", hash: "s1" }) }), a("200 cm", { t: 1_010 }),
  { role: "user", content: "Заметка 메모", note: true, page: page("https://ikea.example/sofa", 1_020, { hash: "s1" }) },
  q("Flights to Tokyo?", "https://air.example/tokyo", 2_000, { id: "abc123def456", t: 2_000 }), a("From 600 €", { id: "zzz000yyy111", t: 2_100, tags: ["travel"] }),
  { role: "user", content: "loose note", note: true },
  { role: "user", content: "about the chat" }, a("app answer"),
  q("Sofa again", "https://ikea.example/sofa", 3_000, { page: page("https://ikea.example/sofa", 3_000, { hash: "s2" }), pageChanged: true }), a("grey"),
  q("😀 emoji question", "https://e.example/😀", 4_000), a("ok")
]

const target: Thread = { id: "t", u: 5, a: 2_500, title: "Japan", tags: ["travel"], m: [
  q("Kyoto temples?", "https://jg.example/kyoto", 1_500), a("Fushimi Inari", { t: 1_600 }),
  q("JR pass?", "https://jg.example/jr", 2_500), a("Not worth it")
] }
const source: Thread = { id: "s", u: 7, a: 4_000, pin: 2, m: mixed }

const cases: Case[] = [
  { op: "basics", m: mixed },
  { op: "basics", m: target.m },
  { op: "move", source, target, targetId: "t", start: 5, end: 6, now: 9_000 },
  { op: "move", source, target, targetId: "t", start: 10, end: 11, now: 9_000 },
  { op: "move", source, target, targetId: "t", start: 0, end: 1, now: 9_000 },
  { op: "move", source, targetId: "fresh", start: 12, end: 13, now: 9_000 },
  { op: "move", source: { id: "one", u: 1, m: [q("Only", "https://o.example/1", 10), a("x")] }, targetId: "t2", start: 0, end: 1, now: 9_000 },
  { op: "move", source: { id: "h", u: 1, k: "history", kind: "history", m: [{ role: "user", content: "what did I read?" }, a("x")] } as unknown as Thread, target, targetId: "t", start: 0, end: 1, now: 9_000 },
  { op: "undo", source, target, targetId: "t", start: 5, end: 6, now: 9_000, later: 9_500 },
  { op: "undo", source, target, targetId: "t", start: 5, end: 6, now: 9_000, later: 9_500,
    changedTarget: { ...target, u: 9_200, m: [...target.m, q("New", "https://jg.example/x", 9_100)] } },
  { op: "undo", source: { id: "one", u: 1, title: "Car", m: [q("Only", "https://o.example/1", 10), a("x")] }, targetId: "t2", start: 0, end: 1, now: 9_000, later: 9_500,
    changedSource: null, changedTarget: { id: "t2", u: 9_300, a: 10, m: [
      { ...q("Only", "https://o.example/1", 10), id: entryKey(q("Only", "https://o.example/1", 10)), from: { chat: "one", at: 9_000 } }, { ...a("x"), id: entryKey(a("x")), from: { chat: "one", at: 9_000 } }, q("More", "https://o.example/2", 9_200)
    ] } }
]

// Chat UX's fields (highlights, pins, reminders) ride along with a move, its undo and a new chat, the same in the app.
{
  const ux = { id: "ux", u: 3, a: 3_000, m: [
    q("Sofa?", "https://ikea.example/sofa", 1_000), a("Fits"),
    q("Range in winter?", "https://car.example/1", 2_000),
    a("About 380 km", { marks: [{ s: 6, e: 12, q: "380 km" }], remind: { at: 9_000_000, dev: "iphone-1" }, tags: ["Cars"] } as Partial<Entry>),
    { role: "user", content: "check the heat pump", note: true, id: "note00000001", t: 2_100, pinned: 5_000, page: page("https://car.example/1", 2_100) } as Entry
  ] } as Thread
  cases.push(
    { op: "move", source: ux, target, targetId: "t", start: 2, end: 4, now: 9_000 },
    { op: "move", source: ux, targetId: "fresh", start: 2, end: 4, now: 9_000 },
    { op: "undo", source: ux, target, targetId: "t", start: 2, end: 4, now: 9_000, later: 9_500,
      changedTarget: { ...target, u: 9_200, m: [...target.m, q("New", "https://jg.example/x", 9_100)] } }
  )
  const moved = moveEntries({ ux, t: target }, {}, "ux", 2, 4, "t", 9_000)!
  cases.push({ op: "sweep", now: 10_000, threads: [ux, moved.threads.t] })
}

// The sweep: a stale source brought a moved block back; two moves of one block; an unrelated twin stays.
{
  const moved = moveEntries({ s: source, t: target }, {}, "s", 5, 6, "t", 9_000)!
  const second = moveEntries({ s: source, t: target, u2: { id: "u2", u: 3, m: [q("Other", "https://x.example/1", 100), a("y")] } }, {}, "s", 5, 6, "u2", 9_100)!
  const twin: Thread = { id: "r", u: 2, m: [mixed[0], mixed[1]] }
  cases.push({ op: "sweep", now: 10_000, threads: [source, moved.threads.t, second.threads.u2, twin] })
  cases.push({ op: "sweep", now: 10_000, threads: [source, target] })
}

// ------------------------------------------------------------ suggestions

// Vectors by topic, as in tests/organize-engine.test.mts: a topic's direction, a little of the message's own
// and some noise, so messages on one topic are alike and on different ones aren't, and no sum comes out round.
const DIMS = 64
const axes = new Map<string, number>()
let seed = 42
const noise = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647 - 0.5
function vectorFor(topic: string): number[] {
  if (!axes.has(topic)) axes.set(topic, axes.size)
  const axis = axes.get(topic)!
  const v = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) v[i] = noise() * 0.12
  v[axis % DIMS] += 1
  v[(axis + 7 + (seed % 5)) % DIMS] += 0.45
  let n = 0
  for (const x of v) n += x * x
  return Array.from(v.map((x) => x / Math.sqrt(n)))
}

// Every message's vector by its key: numbers, or packed as the device keeps them. Each case carries its own.
const table: Record<string, number[] | string> = {}
let clock = 1_000_000
let count = 0
function qa(topic: string, url: string, extra: { tags?: string[]; question?: string; packed?: boolean; vector?: number[] } = {}): Entry[] {
  count++
  clock += 1_000
  const question: Entry = { role: "user", content: extra.question ?? `${topic} question ${count} about something long enough`, page: { url, title: `${topic} page`, at: clock }, id: `q${count}`, t: clock }
  const answer: Entry = { role: "assistant", content: `${topic} answer ${count} with details`, id: `a${count}`, t: clock + 10, ...(extra.tags ? { tags: extra.tags } : {}) }
  for (const e of [question, answer]) {
    const v = extra.vector ?? vectorFor(topic)
    table[e.id!] = extra.packed ? packVector(v) : v
  }
  return [question, answer]
}
/** A question and its answer from before 2.5: no ids (keys from their text), a time from the page or none. */
function old(topic: string, url: string, at?: number): Entry[] {
  count++
  const list: Entry[] = [
    { role: "user", content: `${topic} old question ${count}, from before`, page: { url, title: `${topic} page`, ...(at !== undefined ? { at } : {}) } },
    { role: "assistant", content: `${topic} old answer ${count}` }
  ]
  for (const e of list) table[entryKey(e)] = vectorFor(topic)
  return list
}
const thread = (id: string, m: Entry[], extra: Partial<Thread> = {}): Thread => ({ id, u: 1, m, ...extra })
// "Ask your chats": `kind` in the panel, `k` as stored.
const history = (t: Thread) => ({ ...t, kind: "history", k: "history" }) as Thread
const no = (list: Entry[]) => list.map((e) => ({ ...e, dismissed: { move: true as const } }))
const movedIn = (list: Entry[], from: string, at: number) => list.map((e) => ({ ...e, from: { chat: from, at } }))
const react = () => [...qa("react", "https://react.example/1"), ...qa("react", "https://react.example/2"), ...qa("react", "https://react.example/3")]

/** The case with the vectors of its messages (unless it brings its own). */
function withVectors(c: Case): Case {
  if (c.vectors) return c
  const keys = new Set<string>()
  for (const t of [c.chat, ...((c.chats as Thread[] | undefined) ?? [])] as Array<Thread | undefined>) for (const e of t?.m ?? []) keys.add(entryKey(e))
  for (const e of (c.m as Entry[] | undefined) ?? []) keys.add(entryKey(e))
  return { ...c, vectors: Object.fromEntries([...keys].filter((k) => Object.hasOwn(table, k)).map((k) => [k, table[k]])) }
}

const japan = thread("japan", [...qa("japan", "https://jg.example/1"), ...qa("japan", "https://jg.example/2"), ...qa("japan", "https://jg.example/3")], { a: 5_000_000 })
const bread = thread("bread", [...qa("bread", "https://bread.example/1"), ...qa("bread", "https://bread.example/2")])
const suggestions: Case[] = []
const move = (chat: Thread, chats: Thread[], extra: Record<string, unknown> = {}) => suggestions.push({ op: "suggestMove", chat, chats, ...extra })

// Another chat's topic; a coherent chat gets nothing; stricter thresholds; a smaller window; deleted chats.
const pile = thread("pile", [...react(), ...qa("japan", "https://travel-blog.example/9")])
move(pile, [pile, japan, bread])
move(japan, [pile, japan, bread])
move(pile, [pile, japan, bread], { cfg: { moveT: 0.95, moveT1: 0.99 } })
move(pile, [pile, japan, bread], { cfg: { moveD: 0.95 } })
move(pile, [pile, japan, bread], { cfg: { window: 1, moveT: 0.5 } })
move({ ...pile, deleted: true }, [pile, japan, bread])
move(pile, [pile, { ...japan, deleted: true }, bread])
move(history(pile), [japan, bread])
// The same page in another chat, without vectors: of two such chats the one written in last, of equals the first.
const pages = thread("pages", [...qa("sofa", "https://ikea.example/sofa"), ...qa("misc", "https://x.example/1"), ...qa("japan", "https://jg.example/2", { question: "Different words entirely, same page" })])
const laterJapan = thread("later", qa("japan", "https://jg.example/2"), { a: 9_000_000 })
move(pages, [pages, japan], { vectors: {} })
move(pages, [pages, japan, laterJapan], { vectors: {} })
move(pages, [pages, laterJapan, { ...japan, a: 9_000_000 }], { vectors: {} })
move(thread("twice", [...qa("japan", "https://jg.example/2"), ...qa("misc", "https://x.example/2"), ...qa("japan", "https://jg.example/2")]), [japan])
// Blocks in a row to one chat are one suggestion; other windows; two blocks to two chats (same sites, then topics): the bigger margin.
const two = thread("two", [...react(), ...qa("japan", "https://jg.example/7"), ...qa("japan", "https://jg.example/8")])
move(two, [two, japan, bread])
move(two, [two, japan, bread], { cfg: { window: 1 } })
move(two, [two, japan, bread], { cfg: { window: 5 } })
const split = thread("split", [...react(), ...qa("bread", "https://bread.example/9"), ...qa("japan", "https://jg.example/9")])
move(split, [split, japan, bread])
const split2 = thread("split2", [...react(), ...qa("bread", "https://bread-blog.example/9"), ...qa("japan", "https://travel.example/9")])
move(split2, [split2, japan, bread])
// A new chat: alike blocks in a row together, others apart; only when something stays.
const cars = thread("cars", [...react(), ...qa("cars", "https://car.example/1")])
move(cars, [cars, japan, bread])
move(cars, [cars, japan, bread], { cfg: { splitMin: 4 } })
move(thread("cars2", [...react(), ...qa("cars", "https://car.example/1"), ...qa("cars", "https://car.example/2")]), [japan, bread])
move(thread("mixed2", [...react(), ...qa("cars", "https://car.example/3"), ...qa("garden", "https://garden.example/1")]), [japan, bread])
move(thread("small", [...qa("react", "https://react.example/1"), ...qa("cars", "https://car.example/4")]), [japan])
// The same site: one other chat is about it ("www." aside); two such chats: the topic decides.
const ikea = thread("ikea", [...qa("sofa", "https://ikea.example/a"), ...qa("sofa", "https://ikea.example/b"), ...qa("lamp", "https://lamps.example/1")])
const ikea2 = thread("ikea2", [...qa("sofa", "https://ikea.example/c"), ...qa("sofa", "https://ikea.example/d")])
const site = thread("site", [...react(), ...qa("sofa", "https://www.ikea.example/new-sofa")])
move(site, [site, ikea, japan])
move(site, [site, ikea, ikea2, japan])
move(site, [site, ikea, japan], { cfg: { siteT: 0.99 } })
// 2.6: a note-only chat on a page joins the chat with questions about it (a short note by the page alone, a longer
// one by its topic), never the other way; off-topic blocks leave a mix for the one-topic chat, which never goes into
// the mix; of two one-block chats only the smaller joins.
function noteOn(topic: string, url: string, text: string): Entry {
  count++
  clock += 1_000
  const e: Entry = { role: "user", content: text, note: true, page: { url, title: `${topic} page`, at: clock }, id: `n${count}`, t: clock }
  table[e.id!] = vectorFor(topic)
  return e
}
const service = thread("service", [...qa("cf", "https://context-flow.example/"), ...qa("cf", "https://context-flow.example/")])
const memo = thread("memo", [noteOn("cf", "https://context-flow.example/", "FAQ for pricing")])
const memo2 = thread("memo2", [noteOn("cf", "https://context-flow.example/blog", "Write the post about sorting chats by topic, before and after")])
move(memo, [service, memo])
move(memo, [service, memo], { vectors: {} })
move(service, [service, memo])
move(memo2, [service, memo2])
move(memo2, [service, memo2], { cfg: { topicT: 0.99 } })
const mix = thread("mix", [...qa("cars", "https://cars.example/1"), ...qa("cars", "https://cars.example/2"), ...qa("analytics", "https://stats.example/1"), ...qa("analytics", "https://stats.example/2")])
const lone = thread("lone", qa("analytics", "https://stats.example/3"))
const most = thread("most", [...qa("cars", "https://cars.example/1"), ...qa("analytics", "https://stats.example/1"), ...qa("analytics", "https://stats.example/2"), ...qa("analytics", "https://stats.example/4")])
move(mix, [mix, lone])
move(lone, [mix, lone])
move(lone, [most, lone])
move(most, [most, lone])
move(lone, [mix, lone], { cfg: { topicT: 0.01 } })
const twin = thread("twin", qa("bread", "https://bread.example/8"))
const twin2 = thread("twin2", [...qa("bread", "https://bread.example/9"), ...qa("bread", "https://bread.example/9")])
move(twin, [twin, twin2])
move(twin2, [twin, twin2])
move(twin, [twin, { ...twin2, m: twin2.m.slice(0, 2), a: 99_000_000 }])
// 2.6: what the AI reads to name a chat (pages, questions, notes, answers' starts; a long chat's first and latest
// pages), and when a name is checked by itself (never the user's).
const longChat = thread("long", Array.from({ length: 30 }, (_, i) => qa(`t${i % 4}`, `https://long.example/${i}`, { question: `Question ${i} ${"детали ".repeat(60)}` })).flat())
suggestions.push(
  { op: "nameText", m: [...service.m, ...memo.m, { role: "assistant", content: "**" }, { role: "user", content: "", label: "Summarize", page: { url: "https://s.example/", title: "" } }] },
  { op: "nameText", m: longChat.m },
  { op: "nameText", m: [] },
  { op: "wantsNameCheck", chat: service },
  { op: "wantsNameCheck", chat: memo },
  { op: "wantsNameCheck", chat: { ...service, title: "Mine", aiTitle: "Theirs", ait: "Theirs" } },
  { op: "wantsNameCheck", chat: { ...service, title: "Theirs", aiTitle: "Theirs", ait: "Theirs" } },
  { op: "wantsNameCheck", chat: history(service) }
)
// 2.6 (91): a one-block chat on a site joins the chat with the most of that site (a short note by its site alone);
// not a chat about something else on one video site; of two site chats, the one with more of it.
const cfSite = thread("cfsite", [...qa("cf", "https://context-flow.example/"), ...qa("cf", "https://context-flow.example/pricing"), ...qa("cf", "https://context-flow.example/support")])
const cfSmall = thread("cfsmall", [...qa("cf", "https://context-flow.example/blog"), ...qa("cf", "https://context-flow.example/faq")])
const changelog = thread("changelog", [noteOn("cf", "https://context-flow.example/changelog", "Release notes")])
move(changelog, [cfSite, cfSmall, changelog])
move(changelog, [cfSmall, changelog])
move(changelog, [cfSite, changelog], { vectors: {} })
move(cfSite, [cfSite, changelog])
const videoCars = thread("videocars", [...qa("cars", "https://video.example/1"), ...qa("cars", "https://video.example/2")])
const borsch = thread("borsch", [noteOn("borsch", "https://video.example/3", "Try this borsch recipe with smoked pears on Sunday, for the guests")])
move(borsch, [videoCars, borsch])
// 2.6 (93): the questions about a site all on one page (one block) take a lone note on another page of it; two lone
// notes don't join; one video's question doesn't take a note on another topic.
const cfHome = thread("cfhome", [...qa("cf", "https://context-flow.example/"), ...qa("cf", "https://context-flow.example/"), ...qa("cf", "https://context-flow.example/")])
const blogNote = thread("blognote", [noteOn("cf", "https://context-flow.example/blog", "Post about sorting")])
move(changelog, [cfHome, changelog])
move(cfHome, [cfHome, changelog])
move(blogNote, [blogNote, changelog])
move(borsch, [thread("videoone", qa("cars", "https://video.example/7")), borsch])
// 2.6 (93): the match shown with moves by topic and site, and the minimum; a page needs none.
move(pile, [pile, japan, bread], { cfg: { minMatch: 99.5 } })
move(pile, [pile, japan, bread], { cfg: { matchLo: 0.5, matchHi: 0.9 } })
move(site, [site, ikea, japan], { cfg: { minMatch: 10, siteT: 0.01 } })
// 2.6 (94): an answer off the chat's topic asked on the same page (one block): to the chat about it, from minMatch,
// else a new chat; one a mix fits gets nothing; two off-topic answers alike go together; something has to stay; asked
// in the app (no page) as well; turned down, never again.
{
  const page = "https://react.example/1"
  const offTail = thread("offtail", [...qa("react", page), ...qa("react", page), ...qa("react", page), ...qa("japan", page)])
  move(offTail, [offTail, japan, bread])
  move(offTail, [offTail, bread])
  move(offTail, [offTail, pile, bread])
  move(offTail, [offTail, japan, bread], { cfg: { minMatch: 100.5 } })
  move(thread("offtwo", [...qa("react", page), ...qa("react", page), ...qa("japan", page), ...qa("japan", page)]), [bread])
  move(thread("offmixed", [...qa("react", page), ...qa("react", page), ...qa("japan", page), ...qa("bread", page)]), [bread])
  move(thread("offshort", [...qa("react", page), ...qa("japan", page)]), [bread])
  move(thread("offtwoblocks", [...qa("react", "https://react.example/2"), ...qa("react", page), ...qa("japan", page)]), [bread])
  const appQ = qa("japan", page).map((e) => (e.role === "user" ? { ...e, page: undefined } : e))
  move(thread("offapp", [...qa("react", page), ...qa("react", "https://react.example/2"), ...appQ]), [bread])
  move(thread("offno", [...qa("react", page), ...qa("react", page), ...no(qa("japan", page))]), [bread])
  move(thread("offwindow", [...qa("react", page), ...qa("react", page), ...qa("japan", page), ...qa("react", "https://react.example/5"), ...qa("react", "https://react.example/6"), ...qa("react", "https://react.example/7")]), [bread])
}
// 2.6 (94): a chat on the topic and pages of a newer one joins it whole; not into a chat of one block, not when turned
// down, not into an older one, not on other pages or another topic.
{
  const fresh = thread("freshjapan", [...qa("japan", "https://jg.example/1"), ...qa("japan", "https://jg.example/2"), ...qa("japan", "https://jg.example/4")])
  move(japan, [japan, fresh, bread])
  move(fresh, [japan, fresh, bread])
  move({ ...japan, org: { n: japan.m.length, k: entryKey(japan.m[japan.m.length - 1]), mx: ["freshjapan"] } }, [japan, fresh])
  move(japan, [japan, thread("onejapan", qa("japan", "https://jg.example/1"))])
  move(japan, [japan, thread("elsewhere", [...qa("japan", "https://other.example/1"), ...qa("japan", "https://other.example/2")])])
  move(japan, [japan, thread("breadjg", [...qa("bread", "https://jg.example/1"), ...qa("bread", "https://jg.example/2"), ...qa("bread", "https://jg.example/3")])])
  move(japan, [japan, fresh], { cfg: { minMatch: 100.5 } })
  move(thread("lonejapan", qa("japan", "https://jg.example/2")), [japan, fresh])
  move(thread("oldlone", [noteOn("japan", "https://jg.example/1", "A note about the rail pass for the trip")]), [fresh])
  move(no(japan.m).length ? { ...japan, m: [...japan.m.slice(0, 2), ...no(japan.m.slice(2, 4)), ...japan.m.slice(4)] } : japan, [japan, fresh])
}
// 2.6 (95): the newer chat shows the merge too (an older chat joins it); one shared page is enough and the newer chat
// may be one block; the answers decide (questions on a shared page are mostly its title); a chat of two pages on two
// topics: the newer page goes; an end of a block whose answer fits another chat far better; a site's chat takes a
// question chat on its topic only.
{
  const qa2 = (qTopic: string, aTopic: string, url: string): Entry[] => {
    const [q, a] = qa(qTopic, url)
    table[a.id!] = vectorFor(aTopic)
    return [q, a]
  }
  const fresh = thread("freshjapan2", [...qa("japan", "https://jg.example/1"), ...qa("japan", "https://jg.example/2"), ...qa("japan", "https://jg.example/4")])
  move(fresh, [japan, fresh, bread])
  move(fresh, [{ ...japan, org: { n: japan.m.length, k: entryKey(japan.m[japan.m.length - 1]), mx: ["freshjapan2"] } }, fresh])
  move(japan, [japan, thread("onejapan2", [...qa("japan", "https://jg.example/2"), ...qa("japan", "https://jg.example/2")])])
  move(japan, [japan, thread("titleonly", [...qa2("japan", "bread", "https://jg.example/1"), ...qa2("japan", "bread", "https://jg.example/5")])])
  move(japan, [japan, fresh], { cfg: { mergeA: 0.99 } })
  // Answers partly on the topic, questions on another: the answers fit, the match shown (by both) is below minMatch.
  const halfOn = (url: string): Entry[] => {
    const [q, a] = qa("bread", url)
    const j = vectorFor("japan"), b = vectorFor("bread")
    const v = j.map((x, i) => x * 0.6 + b[i] * 0.8)
    const n = Math.sqrt(v.reduce((t, x) => t + x * x, 0))
    table[a.id!] = v.map((x) => x / n)
    return [q, a]
  }
  const halfJapan = thread("halfjapan", [...halfOn("https://jg.example/1"), ...halfOn("https://jg.example/5")])
  move(japan, [japan, halfJapan])
  move(halfJapan, [japan, halfJapan])
  move(japan, [japan, halfJapan], { cfg: { minMatch: 0 } })
  // 2.6 (96): the block's last answer against the person's usual fit (on by default, tailRelCap 0.35; off with 0); a new
  // chat only; three other chats at least.
  const kombuchaChat = thread("kombuchachat", [...qa("kombucha", "https://k.example/1"), ...qa("kombucha", "https://k.example/2")])
  const tentsChat = thread("tentschat", [...qa("tents", "https://tents.example/1"), ...qa("tents", "https://tents.example/2")])
  const usualHost = thread("usualhost", [...qa("react", "https://react.example/9"), ...qa("react", "https://react.example/9"), ...qa("react", "https://react.example/9"), ...qa2("react", "japan", "https://react.example/9")])
  move(usualHost, [usualHost, bread, kombuchaChat, tentsChat])
  move(usualHost, [usualHost, bread, kombuchaChat, tentsChat], { cfg: { tailRelCap: 0 } })
  move(usualHost, [usualHost, bread, kombuchaChat, tentsChat], { cfg: { tailRelCap: 0.35, tailRelD: 0.05 } })
  move(usualHost, [usualHost, bread, kombuchaChat, tentsChat], { cfg: { tailRelCap: 0.35, tailRelD: 0 } })
  move(usualHost, [usualHost, bread, kombuchaChat], { cfg: { tailRelCap: 0.35, tailRelD: 0.05 } })
  move(usualHost, [usualHost, bread, kombuchaChat, tentsChat, japan], { cfg: { tailRelCap: 0.35, tailRelD: 0.05 } })
  move(usualHost, [usualHost, bread, kombuchaChat, tentsChat], { cfg: { tailRelCap: 0.01, tailRelD: 0.05 } })
  const tents = thread("tents", [...qa("tents", "https://outdoor.example/tents"), ...qa("tents", "https://campshop.example/2p")])
  const camera = thread("cameramix", [...qa("camera", "https://shop.example/camera-x"), ...qa("camera", "https://shop.example/camera-x"), ...qa("tents", "https://other.example/tent-y")])
  move(camera, [camera, tents, bread])
  move(camera, [camera, bread])
  move(camera, [camera, bread], { cfg: { splitMin: 3 } })
  move(thread("backagain", [...qa("camera", "https://shop.example/camera-x"), ...qa("kombucha", "https://kitchn.example/k"), ...qa2("camera", "kombucha", "https://shop.example/camera-x")]), [bread])
  const monitors = thread("monitors", [...qa("monitor", "https://rtings.example/dell"), ...qa("monitor", "https://lg.example/27")])
  const vpage = "https://roborock.example/s8"
  const vacuum = thread("vacuum", [...qa("vacuum", vpage), ...qa("vacuum", vpage), ...qa("vacuum", vpage), ...qa2("vacuum", "monitor", vpage)])
  move(vacuum, [vacuum, monitors, bread])
  move(vacuum, [vacuum, bread])
  move(vacuum, [vacuum, monitors, bread], { cfg: { moveD: 0.9 } })
  const oneQ = thread("oneq", [...qa("monitor", "https://rtings.example/dell"), ...qa("monitor", "https://rtings.example/dell")])
  move(vacuum, [vacuum, oneQ, bread])
  // A page with one question on the chat's topic and then one on another: only the latter goes.
  move(thread("narrow", [...qa("react", "https://react.example/1"), ...qa("react", "https://react.example/2"), ...qa("react", "https://react.example/9"), ...qa("kombucha", "https://react.example/9")]), [bread])
  move(thread("narrow2", [...qa("react", "https://react.example/1"), ...qa("react", "https://react.example/2"), ...qa("react", "https://react.example/9"), ...qa("japan", "https://react.example/9")]), [japan, bread])
  const headphones = thread("headphones", [...qa("headphones", "https://rtings.example/xm5"), ...qa("headphones", "https://rtings.example/airpods"), ...qa("headphones", "https://apple.example/airpods")])
  move(thread("monitorq", [...qa("monitor", "https://rtings.example/dell"), ...qa("monitor", "https://rtings.example/dell")]), [headphones])
  move(thread("monitorq2", [...qa("headphones", "https://rtings.example/dell"), ...qa("headphones", "https://rtings.example/dell")]), [headphones])
}
// 2.6 (93): organizing's state kept with the chat, as another device reads it back: the move while the chat is as it
// was, the tags still open, the name unless turned down or typed by the user; junk dropped part by part.
{
  const kept = (chat: Thread, org: unknown, extra: Record<string, unknown> = {}) =>
    suggestions.push({ op: "org", chat: { ...chat, org } as Thread, chats: [chat, japan, bread], name: threadName({ ...chat, org: undefined }), key: "k2", answer: { fits: false, title: "Japan, by rail" }, current: threadName(chat), tg: [], ...extra })
  const last = (t: Thread) => entryKey(t.m[t.m.length - 1])
  const n = pile.m.length
  const mv = { s: 6, e: 7, to: "japan", why: "topic", mt: 91 }
  kept(pile, { n, k: last(pile), mv, tg: [[entryKey(pile.m[1]), "React"], [entryKey(pile.m[7]), "Travel"]], nm: { k: "k1", t: "React and a trip" } }, { tg: [[entryKey(pile.m[1]), "React"]] })
  kept(pile, { n: n - 1, k: last(pile), mv }) // a message since: not that move any more
  kept(pile, { n, k: "other", mv: { ...mv, to: null, why: "apart" } })
  kept(pile, { n, k: last(pile), mv: { ...mv, to: "gone" } })
  kept(pile, { n, k: last(pile), mv: { ...mv, s: 7, e: 6 } })
  // 2.6 (95): a merge into this chat (fr) while the older chat is there and didn't turn it down; a name hidden while a
  // move is open; an older-chat merge turned down here (mx) isn't open.
  kept(japan, { n: japan.m.length, k: last(japan), mv: { s: 5, e: 5, to: "japan", why: "merge", mt: 88, fr: "bread" }, nm: { k: "k1", t: "Japan, by rail" } })
  kept(japan, { n: japan.m.length, k: last(japan), mv: { s: 5, e: 5, to: "japan", why: "merge", mt: 88, fr: "gone" } })
  kept(japan, { n: japan.m.length, k: last(japan), mv: { s: 5, e: 5, to: "japan", why: "merge", fr: "" } })
  kept(pile, { n, k: last(pile), mv: { s: 0, e: 7, to: "japan", why: "merge", mt: 80 }, mx: ["japan"], nm: { k: "k1", t: "React and a trip" } })
  // 2.6 (98): a name turned down stays turned down when it comes back reworded, in any script; another name comes.
  const named = (t: string, no: string[], title = "Japan, by rail") => kept(pile, { n, k: last(pile), nm: { k: "k1", t, no } }, { answer: { fits: false, title } })
  named("A trip to Japan and React", ["React and a trip to Japan"])
  named("Kyoto ryokans", ["Japan by rail"], "Japan, by rail: passes and seats")
  named("Kyoto ryokans", ["Japan by rail"], "Ryokans and onsen in Kyoto")
  named("Поездка в Японию на поезде", ["Поездка в Японию по железной дороге"], "Поездка в Японию: поезда")
  named("京都の紅葉と旅館", ["京都の紅葉旅行"], "京都の紅葉と旅館のプラン")
  named("교토 단풍 여행", ["교토 단풍 여행 계획"], "부산 맛집")
  named("رحلة إلى اليابان", ["رحلة إلى اليابان بالقطار"], "رحلة إلى اليابان بالقطار والفنادق")
  kept({ ...pile, m: pile.m.map((e, i) => (i === 7 ? { ...e, dismissed: { move: true as const, tags: ["travel"] } } : i === 1 ? { ...e, tags: ["react"] } : e)) },
    { n, k: last(pile), mv, tg: [[entryKey(pile.m[1]), "React"], [entryKey(pile.m[7]), "TRAVEL"], ["nope", "X"]] })
  kept(pile, { n, k: last(pile), nm: { k: "k1", t: "React and a trip", no: ["react AND a trip"] } }, { answer: { fits: false, title: "REACT and a trip" } })
  kept({ ...pile, title: "Mine", aiTitle: "Mine", ait: "Mine" } as Thread, { n, k: last(pile), nm: { k: "k1", t: "Mine" } }, { answer: { fits: true, title: "Whatever" } })
  kept({ ...pile, title: "Japan trip", aiTitle: "Japan trip", ait: "Japan trip" } as Thread, { n, k: last(pile) }, { answer: { fits: false, title: "JAPAN Trip" }, current: "Japan trip" })
  kept({ ...pile, title: "Typed", aiTitle: "AI's", ait: "AI's" } as Thread, { n, k: last(pile), nm: { k: "k1", t: "React and a trip" } }, { current: "Typed" })
  for (const junk of [null, 5, "x", [], { n: "2", k: "" }, { n: true, k: "" }, { n: 1 }, { n: 1, k: "", mv: { s: 0, e: 0, to: 3, why: "topic" }, tg: [["a", 1], ["b", "B", "extra"], "c", ["d"]], nm: { k: "z", t: "", no: [1, "N"] } },
    { n: 1, k: "", mx: ["a", 5, "", "b"], mv: { s: 0, e: 3, to: "x", why: "merge", mt: 80 } }, { n: 1, k: "", mx: "a" },
    { n: 1, k: "", mv: { s: 0, e: 0, why: "topic" } }, { n: 1, k: "", mv: { s: 0, e: 0, to: null, why: "elsewhere" } }, { n: 1, k: "", mv: { s: 0, e: 1, to: null, why: "apart", mt: "84" } }, { n: 1, k: "", mv: { s: 0, e: 1, to: "x", why: "site", mt: 57.5 }, nm: { t: "no key" } }])
    kept(bread, junk)
}
// Short questions, moved-in and turned-down blocks get nothing.
const thanks: Entry[] = [{ role: "user", content: "ok thanks", id: "ok", t: 1_999_999 }, { role: "assistant", content: "You're welcome", id: "ok2", t: 1_999_999 }]
table.ok = vectorFor("japan")
table.ok2 = vectorFor("japan")
move(thread("thanks", [...qa("react", "https://react.example/1"), ...qa("react", "https://react.example/2"), ...thanks]), [japan])
move(thread("moved", [...qa("react", "https://react.example/1"), ...qa("react", "https://react.example/2"), ...movedIn(qa("japan", "https://jg.example/5"), "x", 1)]), [japan])
move(thread("refused", [...qa("react", "https://react.example/1"), ...qa("react", "https://react.example/2"), ...no(qa("japan", "https://jg.example/6"))]), [japan])
// Three refused, none taken: moves are off in this chat; one taken after them puts them back on.
const tired = thread("tired", [...qa("react", "https://react.example/1"), ...no(qa("a", "https://a.example/1")), ...no(qa("b", "https://b.example/1")), ...no(qa("c", "https://c.example/1")), ...qa("japan", "https://jg.example/10")])
const taken = thread("taken", movedIn(qa("d", "https://d.example/1"), "tired", 10_000_000))
move(tired, [tired, japan])
move(tired, [tired, japan, taken])
suggestions.push(
  { op: "movesAllowed", chat: tired, chats: [tired] },
  { op: "movesAllowed", chat: tired, chats: [tired, taken] },
  { op: "movesAllowed", chat: tired, chats: [tired], cfg: { rollback: 4 } }
)
// Notes: a short one says too little, a long one enough; a note without a page is a block of its own.
const notes = thread("notes", [
  ...react(),
  { role: "user", content: "Kyoto: book the ryokan early, two nights, ask about the onsen", note: true, page: { url: "https://jg-notes.example/k", title: "Ryokan" }, id: "n1", t: 2_000_000 },
  { role: "user", content: "short note", note: true, page: { url: "https://jg-notes.example/k2", title: "x" }, id: "n2", t: 2_000_100 },
  { role: "user", content: "a loose note about japan rail passes and their prices", note: true, id: "n3", t: 2_000_200 }
])
for (const id of ["n1", "n2", "n3"]) table[id] = vectorFor("japan")
move(notes, [notes, japan])
// From before 2.5 (keys from the text, times from the page or none); packed vectors, as the device keeps them.
const olden = thread("olden", [...old("react", "https://react.example/1", 500), ...old("react", "https://react.example/2"), ...old("react", "https://react.example/3", 700), ...old("japan", "https://travel-blog.example/1")])
move(olden, [olden, japan])
const packedJapan = thread("pj", [...qa("japan", "https://pj.example/1", { packed: true }), ...qa("japan", "https://pj.example/2", { packed: true })])
const packedPile = thread("pp", [...react(), ...qa("japan", "https://pp.example/9", { packed: true })])
move(packedPile, [packedPile, packedJapan])
suggestions.push({ op: "scoredBlocks", m: [...notes.m, ...thanks, ...movedIn(qa("x", "https://x.example/9"), "y", 5), ...no(qa("x", "https://x.example/9")), ...olden.m] }, { op: "scoredBlocks", m: mixed })
// Dense scripts count three times a character: short Chinese, Japanese and Korean questions and notes in the app say
// enough; as short a question in English, or a Chinese one shorter still, doesn't. A Han character outside the BMP.
{
  const asked = (content: string, i: number): Entry[] => [
    { role: "user", content, id: `cjk${i}q`, t: 3_000_000 + i * 100 },
    { role: "assistant", content: `answer ${i}`, id: `cjk${i}a`, t: 3_000_000 + i * 100 + 10 }
  ]
  const noted = (content: string, i: number): Entry => ({ role: "user", content, note: true, id: `cjk${i}n`, t: 3_000_000 + i * 100 })
  const cjk = [
    ...asked("京都哪里好玩？", 1), ...asked("京都のおすすめは？", 2), ...asked("교토 어디가 좋아요?", 3), ...asked("Kyoto tips?", 4),
    ...asked("多少钱？", 5), ...asked("𠮷野家の牛丼、いくら？", 6), noted("京都的红叶季节要提前订酒店。", 7), noted("Book the hotel early.", 8)
  ]
  for (const e of cjk) table[e.id!] = vectorFor("japan")
  suggestions.push({ op: "scoredBlocks", m: cjk })
}

// Tags: the user's tags with two examples or more that are alike; not on messages (or chats) that have them.
const work = thread("work", [...qa("work", "https://w.example/1", { tags: ["work"] }), ...qa("work", "https://w.example/2", { tags: ["Work"] }), ...qa("work", "https://w.example/3")])
const misc = thread("misc", [...qa("bread", "https://b.example/1", { tags: ["later"] }), ...qa("japan", "https://j.example/1", { tags: ["later"] }), ...qa("cars", "https://c.example/1", { tags: ["later"] })])
const once = thread("once", [...qa("garden", "https://g.example/1", { tags: ["garden"] }), ...qa("garden", "https://g.example/2")])
const all = [work, misc, once, japan, bread]
const yesWork = [{ tag: "#work", fits: true, confidence: 0.9 }]
for (const t of [work, misc, once]) suggestions.push({ op: "tags", chat: t, chats: all, verdicts: yesWork })
// Several tags on the same messages: equal margins go by name, three at most; the judge leaves one (or two).
const office = thread("office", [...qa("work", "https://o.example/1", { tags: ["Work", "office", "dev", "job"] }), ...qa("work", "https://o.example/2", { tags: ["work", "office", "dev", "job"] }), ...qa("work", "https://o.example/3")])
const verdicts = [{ tag: "#office", fits: true, confidence: 0.9 }, { tag: "dev", fits: false, confidence: 0.99 }, { tag: "JOB", fits: true, confidence: 0.69 }]
suggestions.push({ op: "tags", chat: office, chats: [office, japan, bread], verdicts }, { op: "tags", chat: office, chats: [office, japan, bread], verdicts, cfg: { maxTags: 2, judge: 0.6 } })
// A chat's tags: its blocks are examples (a little less); close messages without it outweigh them; its own chat gets none.
const trip = thread("trip", [...qa("japan", "https://trip.example/1"), ...qa("japan", "https://trip.example/2")], { tags: ["Japan trip"] })
const plan = thread("plan", [...qa("bread", "https://bread.example/7"), ...qa("japan", "https://plan.example/1")])
suggestions.push(
  { op: "tags", chat: plan, chats: [plan, trip, bread], verdicts: [{ tag: "japan trip", fits: true, confidence: 0.8 }] },
  { op: "tags", chat: plan, chats: [plan, trip, japan, bread] },
  { op: "tags", chat: { ...plan, tags: ["japan TRIP"] }, chats: [plan, trip, bread] }
)
// 2.6 (98): a tag on one message (just made): offered on the messages like it, on its page too and earlier in a long
// chat (twice the window); not on other topics; an established tag (three examples) keeps its margin.
{
  const fresh = thread("freshtag", [...qa("garden", "https://g2.example/1", { tags: ["garden"] }), ...qa("garden", "https://g2.example/1"), ...Array.from({ length: 6 }, (_, i) => qa(i % 2 ? "garden" : "bread", `https://g2.example/${i + 2}`)).flat()])
  suggestions.push({ op: "tags", chat: fresh, chats: [fresh, japan, bread], verdicts: [{ tag: "garden", fits: true, confidence: 0.9 }] })
  suggestions.push({ op: "tags", chat: fresh, chats: [fresh, japan, bread], cfg: { tagT1: 0.99 } })
  const three = thread("threetags", [...qa("garden", "https://g3.example/1", { tags: ["garden"] }), ...qa("garden", "https://g3.example/1", { tags: ["garden"] }), ...qa("garden", "https://g3.example/2", { tags: ["garden"] }), ...qa("garden", "https://g3.example/1")])
  suggestions.push({ op: "tags", chat: three, chats: [three, japan, bread] })
}
// 2.6 (98, «Не предлагает такую метку в других чатах, а надо»): a tag put on in one chat is offered on the messages
// like it in another, older ones too (beyond its window), the closest first, at most the window more; not on a message
// that turned it down, nor in a chat that has it; a tag on a message elsewhere (one example, then two).
{
  const tagged = thread("gtag", [...qa("garden", "https://gt.example/1", { tags: ["Garden"] }), ...qa("bread", "https://gt.example/2")])
  const elsewhere = thread("gelse", [
    ...Array.from({ length: 4 }, (_, i) => qa("garden", `https://ge.example/${i}`)).flat(),
    ...qa("garden", "https://ge.example/near", { vector: vectorFor("garden").map((x, i) => (i % 9 ? x : x + 0.3)) }),
    ...Array.from({ length: 6 }, (_, i) => qa(i % 2 ? "bread" : "japan", `https://ge.example/x${i}`)).flat()
  ])
  const chats = [elsewhere, tagged, japan, bread]
  suggestions.push({ op: "tags", chat: elsewhere, chats, verdicts: [{ tag: "garden", fits: true, confidence: 0.9 }] })
  const turned = thread("gelse", elsewhere.m.map((e, i) => (i === 3 ? { ...e, dismissed: { tags: ["garden"] } } : e)))
  suggestions.push({ op: "tags", chat: turned, chats: [turned, tagged, japan, bread] })
  suggestions.push({ op: "tags", chat: { ...elsewhere, tags: ["GARDEN"] }, chats })
  suggestions.push({ op: "tags", chat: elsewhere, chats, cfg: { tagWindow: 2 } }, { op: "tags", chat: elsewhere, chats, cfg: { tagT1: 0.99 } })
  const twice = thread("gtag2", [...qa("garden", "https://gt2.example/1", { tags: ["garden"] })])
  suggestions.push({ op: "tags", chat: elsewhere, chats: [...chats, twice] })
}
// Refused: on three messages without one taken; one taken after them; on the message itself.
const refuse = (tag: string) => (e: Entry) => (e.role === "assistant" ? { ...e, dismissed: { tags: [tag] } } : e)
const tiredTags = thread("tt", [...qa("x", "https://x.example/1").map(refuse("work")), ...qa("x", "https://x.example/2").map(refuse("work")), ...qa("x", "https://x.example/3").map(refuse("Work"))])
const tookWork = thread("yes", qa("x", "https://x.example/4").map((e) => (e.role === "assistant" ? { ...e, t: 99_999_999, accepted: { tags: ["work"] } } : e)))
suggestions.push(
  { op: "refusedTags", chats: [tiredTags] },
  { op: "refusedTags", chats: [tiredTags, tookWork] },
  { op: "refusedTags", chats: [tiredTags], cfg: { rollback: 4 } },
  { op: "tags", chat: work, chats: [...all, tiredTags], verdicts: yesWork },
  { op: "tags", chat: work, chats: [...all, tiredTags, tookWork], verdicts: yesWork }
)
const refusedHere = thread("work", work.m.map((e, i) => (i === 5 ? { ...e, dismissed: { tags: ["WORK"] } } : e)))
suggestions.push({ op: "tags", chat: refusedHere, chats: [refusedHere, misc, once, japan, bread] })
// Examples alike to the message by the same amount keep their order; notes get tags too.
const same = vectorFor("tea")
const tea = thread("tea", [
  ...[1, 2, 3, 4, 5].flatMap((i) => qa("tea", `https://tea.example/${i}`, { tags: ["tea"], vector: same })),
  { role: "user", content: "Sencha vs gyokuro: steep gyokuro cooler, around 60 degrees, and longer", note: true, page: { url: "https://tea.example/6", title: "Tea notes" }, id: "tn", t: 3_000_000 }
])
table.tn = vectorFor("tea")
suggestions.push({ op: "tags", chat: tea, chats: [tea, japan, bread] })
// No tags for a question, a message past the end, or in "Ask your chats"; deleted chats' and "Ask your chats"' tags don't count.
const gone = thread("gone", [...qa("work", "https://gone.example/1", { tags: ["gone"] }), ...qa("work", "https://gone.example/2", { tags: ["gone"] })], { deleted: true })
const asked = history(thread("asked", [...qa("work", "https://asked.example/1", { tags: ["asked"] }), ...qa("work", "https://asked.example/2", { tags: ["asked"] })]))
suggestions.push(
  { op: "tagCandidates", chat: work, index: 4, chats: all },
  { op: "tagCandidates", chat: work, index: 99, chats: all },
  { op: "tagCandidates", chat: history(work), index: 5, chats: all },
  { op: "tagCandidates", chat: work, index: 5, chats: [...all, gone, asked] },
  { op: "tagCandidates", chat: work, index: 5, chats: [...all, { ...gone, deleted: false }] }
)
suggestions.push(
  { op: "judgedTags", candidates: ["Work", "dev", "Дом"], verdicts: [{ tag: "##work", fits: true, confidence: 0.7 }, { tag: "дом", fits: true, confidence: 0.95 }, { tag: "dev", fits: true, confidence: 0.2 }], cfg: { maxTags: 3 } },
  { op: "judgedTags", candidates: ["Work", "dev"], verdicts: [{ tag: "work", fits: true, confidence: 0.99 }, { tag: "dev", fits: true, confidence: 0.99 }] },
  { op: "judgedTags", candidates: ["Work", "dev", "x"], verdicts: [{ tag: "x", fits: true, confidence: 1 }, { tag: "dev", fits: true, confidence: 0.99 }, { tag: "WORK", fits: true, confidence: 0.99 }], cfg: { maxTags: 2.5 } }
)

// "Everything in one chat?": many sites lately, or many blocks.
const sites = thread("s", [...qa("a", "https://a.com/1"), ...qa("b", "https://www.b.com/1"), ...qa("c", "https://c.com/1")])
const many = thread("many", [1, 2, 3, 4, 5, 6].flatMap((i) => qa("a", `https://same.example/${i}`)))
suggestions.push(
  { op: "looksMixed", chat: sites },
  { op: "looksMixed", chat: sites, cfg: { messSites: 4 } },
  { op: "looksMixed", chat: japan },
  { op: "looksMixed", chat: history(sites) },
  { op: "looksMixed", chat: many },
  { op: "looksMixed", chat: many, cfg: { messBlocks: 7 } },
  { op: "looksMixed", chat: thread("w", [...qa("a", "https://www.a.com/1"), ...qa("a", "https://a.com/2"), ...qa("b", "https://b.com/1"), { role: "user", content: "loose", note: true }, ...qa("c", "about:blank")]) }
)

// The messages to embed: the newest chats first (of equals, the first), each key once, none it has.
const m1 = thread("m1", [...qa("a", "https://m.example/1"), { role: "assistant", content: "" }, ...old("a", "https://m.example/2", 10)], { a: 100 })
const m2 = thread("m2", [...qa("b", "https://m.example/3"), m1.m[0]], { a: 200 })
const m3 = thread("m3", qa("c", "https://m.example/4"), { a: 200 })
const known = { [entryKey(m1.m[1])]: embedText(m1.m[1]), [entryKey(m2.m[0])]: "an older text" }
suggestions.push(
  { op: "missingVectors", chats: [m1, m2, m3, gone, asked], known },
  { op: "missingVectors", chats: [m1, m2, m3], known: {}, max: 3 }
)

// Texts, sites, packed vectors and thresholds.
const long = (n: number, s: string) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const tie = (n: number) => (2 * n + 1) / 254
suggestions.push(
  { op: "embedText", m: [
    { role: "user", content: "Summarize this page in five points, plain words…", label: "Summarize", page: { url: "u", title: "Kyoto temples" } },
    { role: "assistant", content: "**Bold** [1](https://a.b/c) text" },
    { role: "assistant", content: "Ответ [12](https://ru.example/x) и   [123](https://x.example/y) — `код` > цитата | таблица\t\tконец" },
    { role: "user", content: "그 페이지에서 가장 중요한 점은? 　 다음 줄﻿끝\v", page: { url: "https://ko.example/1", title: "  **한국어** 제목 # " } },
    { role: "user", content: `😀 emoji first, then ${long(700, "текст 한글 words ")}`, page: { url: "https://e.example/1", title: "" } },
    { role: "user", content: "", label: "", page: { url: "https://e.example/2", title: "Only the title" } },
    { role: "user", content: `Заметка ${long(1_100, "длинная заметка ")}`, note: true, page: { url: "https://n.example/1", title: long(300, "Заголовок ") } },
    { role: "assistant", content: long(900, "Long answer with [3](http://cite.example/a) a citation. ") },
    { role: "user", content: "[1](https://no-close.example/a b) [1]( https://space.example) \t [7](https://ok.example/a)tail" },
    { role: "user", content: "   ", note: true },
    { role: "assistant", content: "_*_ ### >>> |||" },
    // 2.6 (95): Find similar, by what it's about.
    { role: "user", content: "Cheaper", label: "Cheaper", similarAsk: "", page: { url: "https://shop.example/r", title: "Earbuds **X** - Example Shop" } },
    { role: "user", content: "Дешевле", label: "Дешевле", similarAsk: "в наличии", similarSel: "  палатка  на двоих ", page: { url: "https://x.example/1", title: "Палатка" } },
    { role: "user", content: "Cheaper", label: "Cheaper", similarAsk: "", page: { url: "https://x.example/2", title: "" } },
    { role: "user", content: "Cheaper", similarAsk: "" },
    { role: "assistant", content: "Wireless earbuds like the Earbuds X, some with noise cancelling.\n\n1. **[Buds One, Black](https://a.example/1)** (a.example) — ANC. The page states no price. _(Not confirmed)_\n2. **[Sound [2-in-1] Pod](https://a.example/2)** (b.example) — Case. _(59.00 USD · Not confirmed)_\n 3. **[Третий](https://a.example/3)** (x.ru) — y\n\nCheck the delivery before buying." },
    { role: "assistant", content: "1. **[Only list](https://a.example/1)** (a) — x\n2. **[Second](https://a.example/2)** (b) — y" },
    { role: "assistant", content: "1. **[One item](https://a.example/1)** (a) — x\nnot a list" }
  ] },
  { op: "hostOf", urls: ["https://jg/1", "https://www.Example.COM:8080/a?b#c", "https://user:pw@www.host.com/", "http://192.168.0.1/x", "https://sub.www.example.com/", "u", "", null, "about:blank", "mailto:a@b.com", "file:///Users/x", "https://e.example/😀"] },
  { op: "pack", vectors: [vectorFor("pack"), [1, tie(5), -tie(5), tie(60), -tie(60), 0, -0.0001, 0.25, -1], [0, 0, 0], [0.5, -0.25, 2, -3e-8, 1e-300], Array.from({ length: 256 }, (_, i) => Math.sin(i))] },
  { op: "unpack", packed: ["%%%", "", "AAAA", "AQID", " AQ ID\n", "AQI", "AQ", "A", "AQ==", "AQ=", "AQ===", "AR==", "/+8=", "gIGC", packVector(vectorFor("pack"))] },
  ...[{ moveT: 0.6, window: "5", nope: 1 }, { moveT: true, judge: false }, { moveT: -1, moveD: 1_001, moveT1: 1_000, siteT: 0 }, { splitMin: 2.5, maxTags: 0 }, null, [], "x", 5].map((raw) => ({ op: "config", raw }))
)
// 2.6 (98): each move case's scan too (what it compared, why nothing fired), as both engines report it.
suggestions.push(...suggestions.filter((c) => c.op === "suggestMove").map((c) => ({ ...c, op: "scan" })))
cases.push(...suggestions.map(withVectors))

test("organizing gives the same results in the panel and in the app", { skip }, async () => {
  // The cases reach every kind of move suggestion, and tags the judge confirms, or the parity would say little.
  const whys = new Set(cases.filter((c) => c.op === "suggestMove").map((c) => (js(c) as { why: string } | null)?.why ?? "none"))
  assert.deepEqual([...whys].sort(), ["apart", "merge", "none", "page", "site", "topic"])
  // 2.6 (95): a merge into the chat shown, and one kept in a chat's record.
  assert.ok(cases.some((c) => c.op === "suggestMove" && (js(c) as { from?: string } | null)?.from))
  assert.ok(cases.some((c) => c.op === "org" && (js(c) as { move: { fr?: string } | null }).move?.fr))
  assert.ok(cases.some((c) => c.op === "tags" && (js(c) as Array<{ candidates: unknown[]; judged: string[] }>).some((t) => t.candidates.length === 3 && t.judged.length > 0)))
  // And the kept state: a move, tags and a name still open in some, and junk in others.
  const kept = cases.filter((c) => c.op === "org").map((c) => js(c) as { clean: unknown; move: unknown; tags: unknown[]; name: unknown })
  assert.ok(kept.some((k) => k.move) && kept.some((k) => k.tags.length) && kept.some((k) => k.name) && kept.some((k) => !k.clean))
  const fromSwift = await swift(cases)
  cases.forEach((c, i) => {
    // Through JSON, as the app reads and writes it.
    const fromJs = JSON.parse(JSON.stringify(js(c)))
    assert.deepEqual(fromSwift[i], fromJs, `case ${i} (${c.op})`)
  })
})
