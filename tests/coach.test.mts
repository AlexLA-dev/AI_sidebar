// 2.8, В3.1 / В3.3 / Г4: the hint coordinator (src/content/coach). One hint at a time, one new thing a session, each
// hint at most twice, gone after two ✕ and once taken, the first day only what leads to the next rung, one capability a
// day; the rungs from what the panel saw; what 2.7 kept is read once so nobody is asked again. And a scripted week of
// use (many sessions, pages and wants at random) in which no session ever shows two hints.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-coach-"))
  const src = new URL("../src/content/coach/", import.meta.url).pathname
  const usage = new URL("../src/shared/usage.ts", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${src}rules.ts"\nexport { seedCoach } from "${src}seed.ts"\nexport { changeStored } from "${src}state.ts"\nexport { FEATURES, COACH_HINTS, useFields } from "${usage}"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const H = 3_600_000
// Noon on a day, so a few hours either way stay on that day in any test machine's zone.
const DAY1 = new Date(2026, 10, 24, 12).getTime()
const at = (day: number, hours = 0) => DAY1 + (day - 1) * 24 * H + hours * H
const moment = (now: number, rung = 11, extra: Record<string, unknown> = {}) => ({ now, rung, flow: false, current: null, here: new Set(), ...extra })
const fresh = () => lib.freshCoach(DAY1)

test("days are the person's calendar days from the first run; rungs from what the panel saw", () => {
  assert.equal(lib.dayNumber(DAY1, DAY1), 1)
  assert.equal(lib.dayNumber(DAY1, at(1, 11)), 1)
  assert.equal(lib.dayNumber(DAY1, at(2, -11)), 2, "past midnight is the next day")
  assert.equal(lib.dayNumber(DAY1, at(8)), 8)
  const s = fresh()
  assert.equal(lib.rungOf(s, false, false), 7)
  assert.equal(lib.rungOf(lib.afterPanelOpen(s, DAY1), false, false), 8)
  assert.equal(lib.rungOf(lib.afterPanelOpen(s, DAY1), true, false), 10)
  const answered = lib.afterAnswer(s, DAY1, false)
  assert.equal(lib.rungOf(answered, true, false), 11)
  assert.equal(lib.rungOf(lib.afterAnswer(answered, at(2), true), true, false), 12, "asked again on another day")
  assert.equal(lib.rungOf(lib.afterLimit(answered, DAY1), true, false), 13)
  assert.equal(lib.rungOf(s, false, true), 13, "a paid plan is past the limit's rung")
})

test("day 1 is quiet: only what leads to the next rung", () => {
  const s = fresh()
  const all = lib.HINT_IDS
  const shown = all.filter((id: string) => lib.allowed(s, id, moment(at(1, 2), 11)))
  // (The return discount is the limit's own offer: on return the same day too, the owner's rule.)
  // (The agent's chip and the return discount aren't hints: outside the coordinator since 2.8.1.)
  assert.deepEqual(shown.sort(), ["cookie_line", "fab_pulse", "sel_ask"].sort())
  for (const id of ["organize_mess", "organize_tags", "organize_consent", "invite", "whatsnew", "translate_pill", "page_similar"]) {
    assert.equal(lib.allowed(s, id, moment(at(1, 2), 13)), false, `${id} waits for day 2`)
    assert.equal(lib.allowed(s, id, moment(at(2), 11)), true, `${id} on day 2`)
  }
  // Before the first answer, nothing but the pulse and an answer's own offer.
  assert.deepEqual(all.filter((id: string) => lib.allowed(s, id, moment(at(3), 8))).sort(), ["cookie_line", "fab_pulse"])
})

test("one at a time, the one up stays, an answer's offer comes first, the flow holds everything", () => {
  const s = fresh()
  const m = moment(at(2))
  assert.equal(lib.choose(s, ["invite", "organize_mess", "whatsnew"], m), "organize_mess", "highest priority")
  assert.equal(lib.choose(s, ["invite", "organize_mess"], { ...m, current: "invite" }), "invite", "no flipping to another")
  // A notice of what was just done on the page takes its few seconds ahead of a hint up (the cookie line, the pulse).
  assert.equal(lib.choose(s, ["invite", "cookie_line"], { ...m, current: "invite" }), "cookie_line")
  assert.equal(lib.choose(s, ["fab_pulse", "cookie_line"], { ...moment(at(1), 7), current: "fab_pulse" }), "cookie_line")
  assert.equal(lib.choose(s, ["invite", "cookie_line", "fab_pulse"], { ...m, flow: true }), null)
  assert.equal(lib.choose(s, [], m), null)
})

test("each hint at most twice, gone after two ✕, never again once taken", () => {
  let s = fresh()
  const m = (day: number) => moment(at(day))
  s = lib.afterShown(s, "invite", at(2))
  s = lib.afterShown(s, "invite", at(3))
  assert.equal(lib.allowed(s, "invite", m(4)), false, "two shows")
  assert.equal(lib.allowed(s, "invite", { ...m(3), here: new Set(["invite"]) }), true, "still up on the page it showed on")
  s = fresh()
  s = lib.afterDismissed(s, "whatsnew", at(2))
  s = lib.afterDismissed(s, "whatsnew", at(3))
  assert.equal(lib.retired(s, "whatsnew"), true)
  s = lib.afterDone(fresh(), "side", at(2))
  assert.equal(lib.allowed(s, "side", m(5)), false)
  // An answer's offer stays the way to the agent each time a question asks for it.
  // The pulse shows until the panel opens, whatever the count.
  s = fresh()
  for (let i = 0; i < 5; i++) s = lib.afterShown(s, "fab_pulse", at(1, i * 0.1))
  assert.equal(s.hints.fab_pulse.day, lib.dayKey(at(1)), "its shown is reported once a device day")
  assert.equal(lib.allowed(s, "fab_pulse", moment(at(1, 1), 7)), true)
  assert.equal(lib.allowed(lib.afterDone(s, "fab_pulse", at(1, 1)), "fab_pulse", moment(at(1, 1), 7)), false)
})

test("one new thing a session; a new session after 30 minutes; one capability a day", () => {
  let s = lib.touch(fresh(), at(2))
  s = lib.afterShown(s, "invite", at(2))
  assert.equal(lib.allowed(s, "organize_mess", moment(at(2, 0.1))), false, "another hint waits")
  assert.equal(lib.allowed(s, "invite", moment(at(2, 0.1))), true, "the same one may come back on the next page")
  s = lib.afterDismissed(s, "invite", at(2, 0.2))
  assert.equal(lib.allowed(s, "invite", moment(at(2, 0.3))), false, "closed: not again this session")
  assert.equal(lib.allowed(s, "organize_mess", moment(at(2, 0.3))), false, "the session had its one thing")
  assert.equal(lib.allowed(s, "organize_mess", moment(at(2, 1))), true, "a new session after a gap")
  // Capabilities: one a day.
  s = lib.afterShown(lib.touch(fresh(), at(2)), "page_similar", at(2))
  assert.equal(lib.allowed(s, "page_listen", moment(at(2, 3))), false)
  assert.equal(lib.allowed(s, "page_listen", moment(at(3))), true)
})

test("what 2.7 kept is read once: closed, used and seen hints aren't asked again; an old user isn't on day 1", () => {
  const stored = {
    "cf:pageHints": { off: false, used: ["similar"], shownIds: { watch: 2 } },
    "cf:selHint": -1,
    "cf:noteHint": 3,
    "cf:offerCard": 1,
    "cf:hintsSeen": ["new27", "side", "chats"],
    "cf:orgCards": { mess: { chats: [], at: 0, closed: true } },
    "cf:tourSeen": true,
    "cf:threads": { a: { id: "a", u: at(1), a: at(1), m: [{ role: "user", content: "q", t: at(-9) }, { role: "assistant", content: "a", t: at(-9) }, { role: "assistant", content: "b", t: at(-8) }] } }
  }
  const s = lib.seedCoach(fresh(), stored, at(1))
  assert.equal(s.seeded, true)
  assert.equal(lib.dayNumber(s.first, at(1)), 11, "the first answer ten days ago")
  assert.equal(s.answers, 2)
  assert.equal(lib.rungOf(s, true, false), 12)
  for (const id of ["page_similar", "page_watch", "sel_ask", "note_tip", "whatsnew", "side", "chats_tip", "organize_mess", "fab_pulse"]) {
    assert.equal(lib.allowed(s, id, moment(at(1))), false, id)
  }
  for (const id of ["invite", "page_listen"]) assert.equal(lib.allowed(s, id, moment(at(1))), true, id)
  // Turned off with two ✕ in 2.7: every page line stays off.
  const off = lib.seedCoach(fresh(), { "cf:pageHints": { off: true } }, at(1))
  assert.equal(lib.retired(off, "page_listen"), true)
  // A new install: nothing to read, day 1.
  const blank = lib.seedCoach(fresh(), {}, DAY1)
  assert.equal(lib.dayNumber(blank.first, DAY1), 1)
  assert.equal(lib.rungOf(blank, false, false), 7)
  // Only a new install is in the first-open test; one that used ContextFlow before isn't.
  assert.equal(blank.armed, true)
  assert.equal(s.armed, false)
  assert.equal(lib.seedCoach(fresh(), { "cf:tourSeen": true }, DAY1).armed, false)
  // R5: from 2.7 with no chat kept (only the consent given, a closed line): no arm, and not on «day 1».
  const old27 = lib.seedCoach(fresh(), { "cf:consent": 3 }, at(1))
  assert.equal(old27.armed, false)
  assert.ok(lib.dayNumber(old27.first, at(1)) >= 2)
  assert.equal(lib.seedCoach(fresh(), { "cf:pageHints": { closes: 1 } }, at(1)).armed, false)
  assert.equal(lib.seedCoach(s, { "cf:selHint": 0 }, at(1)), s, "once")
})

test("every coordinator hint can be reported (hint.* what), with its rung and day", () => {
  const listed = new Set(lib.FEATURES.hint.fields.what)
  for (const id of lib.HINT_IDS) assert.ok(listed.has(id), id)
  const kept = lib.useFields({ f: "hint", a: "dismiss", what: "organize_mess", rung: 11, day: 2 })
  assert.deepEqual(kept, { f: "hint", a: "dismiss", what: "organize_mess", rung: 11, day: 2 })
  assert.deepEqual(lib.useFields({ f: "panel", a: "close", open_s: 14, did: "none" }), { f: "panel", a: "close", open_s: 14, did: "none" })
  assert.deepEqual(lib.useFields({ f: "fab", a: "shown", page: "product", first: 1 }), { f: "fab", a: "shown", page: "product", first: 1 })
  assert.deepEqual(lib.useFields({ f: "consent", a: "shown", via: "write" }), { f: "consent", a: "shown", via: "write" })
})

// Г4: a scripted first week. Each step is a page in a session: some prompts fit (at random), the coordinator picks one,
// it shows (and stays while it fits), the person sometimes closes or takes it. Checked: never two hints at once (one
// slot), never two different hints in a session, day 1 only the rung's hints, the budgets, one capability a day.
test("a scripted first week: no session ever shows two hints, the first day stays quiet", () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const ids: string[] = lib.HINT_IDS
  for (let run = 0; run < 40; run++) {
    let s = fresh()
    let consent = false
    let paid = false
    const shownLog: Array<{ id: string; day: number; session: number }> = []
    const capDays = new Map<number, Set<string>>()
    let sessionNo = 0
    let lastStep = DAY1
    for (let day = 1; day <= 7; day++) {
      const sessions = 1 + Math.floor(rnd() * 3)
      for (let k = 0; k < sessions; k++) {
        let now = at(day, k * 3 + rnd())
        if (now - lastStep > lib.SESSION_GAP_MS) sessionNo++
        s = lib.touch(s, now)
        const pages = 1 + Math.floor(rnd() * 6)
        for (let p = 0; p < pages; p++) {
          now += 60_000 + rnd() * 300_000
          lastStep = now
          s = lib.touch(s, now)
          const here = new Set<string>()
          let current: string | null = null
          // The panel opens on most pages; answers come; once in a while the limit.
          if (rnd() < 0.7) {
            s = lib.afterPanelOpen(s, now)
            if (s.panelOpens === 1) s = lib.afterDone(s, "fab_pulse", now)
            if (rnd() < 0.5) consent = true
            if (consent && rnd() < 0.8) s = lib.afterAnswer(s, now, rnd() < 0.6)
            if (consent && rnd() < 0.03) s = lib.afterLimit(s, now)
          }
          if (rnd() < 0.02) paid = true
          const rung = lib.rungOf(s, consent, paid)
          // A few rounds on the page: wants change, the slot follows.
          for (let r = 0; r < 4; r++) {
            const wanting = ids.filter(() => rnd() < 0.25)
            const pick: string | null = lib.choose(s, wanting, { now, rung, flow: rnd() < 0.1, current, here })
            if (pick === null) {
              current = null
              continue
            }
            const spec = lib.HINTS[pick]
            assert.ok(lib.dayNumber(s.first, now) >= spec.day, `${pick} before its day`)
            assert.ok(rung >= spec.rung, `${pick} before its rung`)
            if (!here.has(pick)) {
              here.add(pick)
              if (spec.kind === "hint") {
                const before = s.hints[pick]
                assert.ok(!before?.done && (before?.dismissed ?? 0) < 2, `${pick} retired but shown`)
                if (!spec.untilDone) assert.ok((before?.shown ?? 0) < 2, `${pick} shown a third time`)
                shownLog.push({ id: pick, day, session: sessionNo })
                if (spec.cap) {
                  const set = capDays.get(day) ?? new Set()
                  set.add(pick)
                  capDays.set(day, set)
                }
              }
              s = lib.afterShown(s, pick, now)
            }
            current = pick
            const act = rnd()
            if (act < 0.25) {
              s = lib.afterDismissed(s, pick, now)
              current = null
            } else if (act < 0.35) {
              s = lib.afterDone(s, pick, now)
              current = null
            }
          }
        }
      }
    }
    // One new thing a session (the pulse aside: it shows until the first open, and that is the rung itself).
    const bySession = new Map<number, Set<string>>()
    for (const e of shownLog) {
      if (lib.HINTS[e.id].untilDone) continue
      const set = bySession.get(e.session) ?? new Set()
      set.add(e.id)
      bySession.set(e.session, set)
    }
    for (const [session, set] of bySession) assert.ok(set.size <= 1, `run ${run}, session ${session}: ${[...set].join(", ")}`)
    for (const [day, set] of capDays) assert.ok(set.size <= 1, `run ${run}, day ${day}: capabilities ${[...set].join(", ")}`)
    for (const e of shownLog) if (e.day === 1) assert.ok(["fab_pulse", "sel_ask"].includes(e.id), `day 1: ${e.id}`)
  }
})

test("F6 (2.8.1): another tab's write between this tab's read and write isn't lost — the change is made again on it", async () => {
  // One stored copy; tab A reads it, tab B writes (a hint shown), then A writes (the panel opened).
  let stored: any = { ...fresh(), seeded: true }
  const clone = (v: unknown) => JSON.parse(JSON.stringify(v))
  const load = async () => ({ ...lib.freshCoach(DAY1), ...clone(stored) })
  const save = async (s: unknown) => {
    stored = clone(s)
  }
  let peeks = 0
  const peek = async () => {
    // B's write lands right after A's first read.
    if (peeks++ === 0) stored = { ...stored, session: { ...stored.session, shown: "page_summary", settled: false }, hints: { page_summary: { shown: 1, dismissed: 0, done: false } } }
    return clone(stored)
  }
  const after = await lib.changeStored((s: any) => lib.afterPanelOpen(s, DAY1 + 1000), DAY1 + 1000, load, peek, save)
  assert.equal(after.panelOpens, 1)
  assert.equal(after.session.shown, "page_summary", "B's hint is still the session's one")
  assert.equal(after.hints.page_summary.shown, 1)
  assert.deepEqual(stored, clone(after))
  // Nobody wrote meanwhile: one read again, written as changed.
  peeks = 1
  const again = await lib.changeStored((s: any) => lib.afterPanelOpen(s, DAY1 + 2000), DAY1 + 2000, load, async () => clone(stored), save)
  assert.equal(again.panelOpens, 2)
})
