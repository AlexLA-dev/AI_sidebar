// F2/F3 (2.8.1, the director): one opening, one close, and only the time the panel was seen (src/content/openings.ts).
// Two tabs are two copies of the module (each its own turn of writes) over one shared store.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const url = new URL("../src/content/openings.ts", import.meta.url).href
type Mod = typeof import("../src/content/openings.ts")
const tab = async (name: string): Promise<Mod> => import(`${url}?${name}`)

function store(): Mod["chromeOpenings"] & { items: Record<string, unknown> } {
  const items: Record<string, unknown> = {}
  const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  // Every call yields first, as chrome.storage does: other tabs' calls can come in between.
  const tick = () => new Promise((done) => setTimeout(done, 1))
  return {
    items,
    get: async (keys) => {
      await tick()
      return Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, clone(items[k])]))
    },
    set: async (more) => {
      await tick()
      for (const [k, v] of Object.entries(more)) items[k] = clone(v)
    },
    remove: async (keys) => {
      await tick()
      for (const k of keys) delete items[k]
    }
  }
}

const MIN = 60_000
let clock = 1_800_000_000_000
const now = () => clock
const noWait = async () => {
  await new Promise((done) => setTimeout(done, 5))
}
const rec = (at: number, last: number, seen: number, extra: Record<string, unknown> = {}) => ({ at, last, seen, did: "chip" as const, ...extra })

test("an opening closed by its own page: one close; a second close or a later write says nothing", async () => {
  const s = store()
  const a = await tab("own")
  const t0 = clock
  assert.deepEqual(await a.keepOpening("o1", rec(t0, t0, 0), "A", s, now, noWait), { state: "kept" })
  assert.equal(typeof (s.items[a.INDEX_KEY] as Record<string, number>).o1, "number")
  clock += 42_000
  assert.equal(await a.endOpening("o1", rec(t0, clock, 42_000), "A", s, now), true)
  assert.equal(await a.endOpening("o1", rec(t0, clock, 42_000), "A", s, now), false)
  // The tombstone isn't turned back into an opening (a write that was on its way).
  assert.deepEqual(await a.keepOpening("o1", rec(t0, clock + 5, 42_005), "A", s, now, noWait), { state: "closed" })
  assert.equal(a.openSeconds(rec(t0, clock, 42_000)), 42)
})

test("a page gone for good: the next page closes it once; two pages flushing it at the same time send one close", async () => {
  const s = store()
  const owner = await tab("gone-owner")
  const t0 = clock
  await owner.keepOpening("o2", rec(t0, t0 + 20_000, 20_000, { gone: 1 }), "OWN", s, now, noWait)
  const b = await tab("gone-b")
  const c = await tab("gone-c")
  const [fromB, fromC] = await Promise.all([b.flushOpenings(null, "B", s, now, noWait), c.flushOpenings(null, "C", s, now, noWait)])
  assert.equal(fromB.length + fromC.length, 1, "one close")
  assert.equal(owner.openSeconds([...fromB, ...fromC][0]), 20)
  // Later pages find nothing; the restored owner (it wasn't gone after all) says nothing more.
  assert.deepEqual(await b.flushOpenings(null, "B2", s, now, noWait), [])
  assert.deepEqual(await owner.keepOpening("o2", rec(t0, clock, 21_000), "OWN", s, now, noWait), { state: "closed" })
  assert.equal(await owner.endOpening("o2", rec(t0, clock, 21_000), "OWN", s, now), false)
})

test("tab A open in the background, tab B opens a minute later: B doesn't close A's opening; A closes it once", async () => {
  const s = store()
  const a = await tab("bg-a")
  const b = await tab("bg-b")
  const t0 = clock
  await a.keepOpening("o3", rec(t0, t0 + 30_000, 30_000), "A", s, now, noWait)
  clock += 2 * MIN
  assert.deepEqual(await b.flushOpenings("own-b", "B", s, now, noWait), [])
  clock += 5 * MIN
  // A back on screen within half an hour: the same opening, its away time not counted.
  assert.deepEqual(await a.keepOpening("o3", rec(t0, clock, 31_000), "A", s, now, noWait), { state: "kept" })
  assert.equal(await a.endOpening("o3", rec(t0, clock, 35_000), "A", s, now), true)
  assert.deepEqual(await b.flushOpenings("own-b", "B", s, now, noWait), [])
})

test("F3: a tab put away with the panel open and woken days later ends the opening at its last sight, once", async () => {
  const s = store()
  const a = await tab("sleep-a")
  const t0 = clock
  await a.keepOpening("o4", rec(t0, t0 + 50_000, 50_000), "A", s, now, noWait)
  clock += 3 * 24 * 60 * MIN
  const woke = await a.keepOpening("o4", rec(t0, clock, 51_000), "A", s, now, noWait)
  assert.equal(woke.state, "ended")
  assert.equal(woke.state === "ended" && a.openSeconds(woke.record), 50, "the days away aren't counted")
  // Nothing more for it: not from A's close, not from another page.
  assert.equal(await a.endOpening("o4", rec(t0, clock, 52_000), "A", s, now), false)
  const b = await tab("sleep-b")
  assert.deepEqual(await b.flushOpenings(null, "B", s, now, noWait), [])
})

test("F3: a tab asleep and another page flushing it while it wakes: one close", async () => {
  const s = store()
  const a = await tab("race-a")
  const b = await tab("race-b")
  const t0 = clock
  await a.keepOpening("o5", rec(t0, t0 + 10_000, 10_000), "A", s, now, noWait)
  clock += 2 * 60 * MIN
  const [woke, flushed] = await Promise.all([a.keepOpening("o5", rec(t0, clock, 11_000), "A", s, now, noWait), b.flushOpenings(null, "B", s, now, noWait)])
  const closes = (woke.state === "ended" ? 1 : 0) + flushed.length
  assert.equal(closes, 1)
  assert.notEqual(woke.state, "kept")
})

test("a page kept for Back/Forward isn't gone: it comes back to the same opening, one close", async () => {
  const s = store()
  const a = await tab("bf-a")
  const t0 = clock
  // pagehide, persisted: kept without `gone`.
  await a.keepOpening("o6", rec(t0, t0 + 8_000, 8_000), "A", s, now, noWait)
  clock += 3 * MIN
  const b = await tab("bf-b")
  assert.deepEqual(await b.flushOpenings(null, "B", s, now, noWait), [])
  // Back: restored, then closed.
  assert.deepEqual(await a.keepOpening("o6", rec(t0, clock, 8_000), "A", s, now, noWait), { state: "kept" })
  assert.equal(await a.endOpening("o6", rec(t0, clock + 4_000, 12_000), "A", s, now), true)
})

test("a claim left by a page that went away mid-claim is taken again later; the index forgets old tombstones and old records", async () => {
  const s = store()
  const a = await tab("claim-a")
  const t0 = clock
  s.items["cf:opening:o7"] = rec(t0, t0 + 1_000, 1_000, { gone: 1, claim: "LOST", claimAt: t0 + 2_000 })
  s.items["cf:opening:o8"] = { ...rec(t0, t0, 0), closed: t0 }
  // A 2.8.1 build before F2 kept whole records in the index.
  s.items[a.INDEX_KEY] = { o7: t0, o8: t0, legacy: { at: t0, last: t0, did: "none" } }
  clock = t0 + 5_000
  assert.deepEqual(await a.flushOpenings(null, "A", s, now, noWait), [], "a fresh claim is someone else's")
  clock = t0 + 30_000
  const closed = await a.flushOpenings(null, "A", s, now, noWait)
  assert.equal(closed.length, 1)
  assert.equal("legacy" in (s.items[a.INDEX_KEY] as Record<string, unknown>), false)
  clock = t0 + 2 * 24 * 60 * MIN
  await a.flushOpenings(null, "A", s, now, noWait)
  assert.deepEqual(s.items[a.INDEX_KEY], {})
  assert.equal("cf:opening:o8" in s.items, false)
})

test("the panel: closes go only through the openings (once), with the time on screen; Back/Forward isn't gone", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  assert.doesNotMatch(app, /OPENINGS_KEY|Date\.now\(\) - opening\.at/)
  assert.match(app, /void endOpening\(opening\.id, rec, PAGE_TOKEN\)\.then\(\(mine\) => \{\s*if \(mine\) void sendBackground\(\{ type: "useEvent", f: "panel", a: "close", open_s: openSeconds\(rec\), did: rec\.did \}\)/)
  assert.match(app, /keepRef\.current\(!e\.persisted\)/)
  assert.match(app, /for \(const rec of closed\) void sendBackground\(\{ type: "useEvent", f: "panel", a: "close", open_s: openSeconds\(rec\), did: rec\.did, cut: 1 \}\)/)
  // The time on screen stops while the page is out of view.
  assert.match(app, /o\.seen \+= now - o\.since\s*o\.since = null/)
})

test("the director's review of #268: two tabs adding openings at once, and a cleanup against an add, lose no id", async () => {
  const s = store()
  const a = await tab("idx-a")
  const b = await tab("idx-b")
  const t0 = clock
  // A day-old tombstone, so the cleanup rewrites the index while the two tabs add theirs.
  s.items["cf:opening:old"] = { ...rec(t0 - 2 * 24 * 60 * MIN, t0 - 2 * 24 * 60 * MIN, 0), closed: t0 - 2 * 24 * 60 * MIN }
  s.items[a.INDEX_KEY] = { old: t0 - 2 * 24 * 60 * MIN }
  const c = await tab("idx-c")
  await Promise.all([a.keepOpening("oa", rec(t0, t0, 0), "A", s, now, noWait), b.keepOpening("ob", rec(t0, t0, 0), "B", s, now, noWait), c.flushOpenings(null, "C", s, now, noWait)])
  // Whatever the interleaving, each tab's next keep (15 s on) puts its id back if it was taken out.
  clock += 15_000
  await Promise.all([a.keepOpening("oa", rec(t0, clock, 15_000), "A", s, now, noWait), b.keepOpening("ob", rec(t0, clock, 15_000), "B", s, now, noWait)])
  const ids = s.items[a.INDEX_KEY] as Record<string, number>
  assert.equal(typeof ids.oa, "number")
  assert.equal(typeof ids.ob, "number")
  // Both tabs go away for good: a later page closes both, once each.
  await a.keepOpening("oa", rec(t0, clock, 15_000, { gone: 1 }), "A", s, now, noWait)
  await b.keepOpening("ob", rec(t0, clock, 15_000, { gone: 1 }), "B", s, now, noWait)
  const d = await tab("idx-d")
  assert.equal((await d.flushOpenings(null, "D", s, now, noWait)).length, 2)
  // An old id a tab wrote back with its own (its record already forgotten) is forgotten by the next cleanup.
  assert.equal("old" in (s.items[a.INDEX_KEY] as Record<string, number>), false)
  assert.equal("cf:opening:old" in s.items, false)
})

test("the director's review of #268: a panel left open on a page put away for over half an hour starts a new opening when seen again", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  assert.match(app, /if \(openingRef\.current === o && document\.visibilityState === "visible" && !gone\) startOpeningRef\.current\("back", false\)/)
  assert.match(app, /if \(o\.closed\) return again\(\)/)
  assert.match(app, /if \(kept\.state === "ended"\) void sendBackground\([^\n]+\)\n\s+again\(\)/)
})
