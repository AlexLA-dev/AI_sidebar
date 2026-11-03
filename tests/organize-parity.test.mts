// The panel and the app organize chats the same way: the same cases through src/shared (JS) and through
// ContextFlow/Shared (App)/Organize.swift (built here with tests/organize-parity/main.swift) give the same
// results. Skipped where there's no Swift compiler.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { entryKey, entryTimes, withPageChanges, type Entry } from "../src/shared/conversation.ts"
import { moveEntries, pageBlocks, sweepMoved, undoMove, type Thread, type Threads } from "../src/shared/threads.ts"

const root = new URL("..", import.meta.url).pathname
const swiftc = spawnSync("which", ["swiftc"]).status === 0

type Case = Record<string, unknown> & { op: string }

/** A thread as both sides print it: its id, time and stored fields, or null when it's gone. */
function shown(t: Thread | undefined | null): unknown {
  if (!t || t.deleted) return null
  const { kind, deleted: _deleted, ...rest } = t
  return { ...rest, ...(kind ? { k: kind } : {}) }
}

function js(c: Case): unknown {
  switch (c.op) {
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

function swift(cases: Case[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "cf-organize-"))
  const bin = join(dir, "organize")
  execFileSync("swiftc", ["-O", join(root, "ContextFlow/Shared (App)/Organize.swift"), join(root, "tests/organize-parity/main.swift"), "-o", bin], { stdio: "pipe" })
  return JSON.parse(execFileSync(bin, { input: JSON.stringify(cases) }).toString())
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

// The sweep: a stale source brought a moved block back; two moves of one block; an unrelated twin stays.
{
  const moved = moveEntries({ s: source, t: target }, {}, "s", 5, 6, "t", 9_000)!
  const second = moveEntries({ s: source, t: target, u2: { id: "u2", u: 3, m: [q("Other", "https://x.example/1", 100), a("y")] } }, {}, "s", 5, 6, "u2", 9_100)!
  const twin: Thread = { id: "r", u: 2, m: [mixed[0], mixed[1]] }
  cases.push({ op: "sweep", now: 10_000, threads: [source, moved.threads.t, second.threads.u2, twin] })
  cases.push({ op: "sweep", now: 10_000, threads: [source, target] })
}

test("organizing gives the same results in the panel and in the app", { skip: !swiftc && "no swiftc here" }, () => {
  const fromSwift = swift(cases)
  cases.forEach((c, i) => {
    // Through JSON, as the app reads and writes it.
    const fromJs = JSON.parse(JSON.stringify(js(c)))
    assert.deepEqual(fromSwift[i], fromJs, `case ${i} (${c.op})`)
  })
})
