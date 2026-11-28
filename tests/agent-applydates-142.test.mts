// Round 142, the director's decision 17: after set_dates pressed the days and the page's own date field doesn't show them,
// the device presses the date form's one free search or apply itself, once; a same-site address it opens in a new tab is
// opened here. Two or more candidates, or none: nothing pressed, and the line names them.
import assert from "node:assert/strict"
import { test } from "node:test"

import { setDates, type DatesIO } from "../src/shared/agent/setdates.ts"
import type { MapItem, PageMap } from "../src/shared/agent/types.ts"

/** A stay page: its day buttons and its date field in form 1, which shows the days only after its own search. */
function stayPage(opts: { search?: string[]; opens?: string; other?: MapItem[] } = {}) {
  const s = { picked: [] as string[], committed: false, pressed: [] as string[], opened: [] as string[] }
  const days = ["2026-12-04", "2026-12-05", "2026-12-06"]
  const map = (): PageMap => ({
    url: "https://stays.example/hotel/sea-view", title: "Sea View", lang: "en", forms: [{ n: 1, fillable: true }], more: 0, part: 1, parts: 1, text: "Sea View rooms",
    items: [
      { id: "dates", role: "textbox", label: "Check-in – Check-out", form: 1, value: s.committed ? `${s.picked[0]} – ${s.picked[1] ?? ""}` : "Fri 27 Nov – Sun 29 Nov" },
      ...days.map((d) => ({ id: `d${d}`, role: "button", label: `${Number(d.slice(8))} December 2026`, form: 1, ...(s.picked.includes(d) ? {} : {}) }) as MapItem),
      ...(opts.search ?? ["Search"]).map((label, i) => ({ id: `s${i}`, role: "button", label, form: 1 }) as MapItem),
      ...(opts.other ?? [])
    ]
  }) as PageMap
  const io: DatesIO & { s: typeof s } = {
    s,
    map: async () => map(),
    press: async (item) => {
      s.pressed.push(item.label)
      if (item.id.startsWith("d")) s.picked = s.picked.length === 1 ? [...s.picked, item.id.slice(1)] : [item.id.slice(1)]
      if (item.id.startsWith("s")) s.committed = true
      return "done"
    },
    pressOpening: async (item) => {
      s.pressed.push(item.label)
      if (item.id.startsWith("s")) s.committed = !opts.opens
      return { r: "done", ...(opts.opens ? { opened: opts.opens } : {}) }
    },
    openHere: async (url) => {
      s.opened.push(url)
      if (!/^https:\/\/stays\.example\//.test(url)) return false
      s.committed = true
      return true
    },
    type: async () => "done",
    stopped: async () => false
  }
  return io
}
const ask = { date: "2026-12-04", end: "2026-12-06", last: "2026-12-04", from: "", until: "", byDays: true }

test("a stay page that commits its dates only by its own search: the device presses it once, and the page shows them", async () => {
  const io = stayPage()
  const r = await setDates(ask, io)
  assert.deepEqual(io.s.pressed.filter((p) => p === "Search"), ["Search"])
  assert.match(r.line, /the device pressed the date form's «Search»/)
  assert.doesNotMatch(r.line, /doesn't show them chosen yet/)
})

test("in four scripts: «Найти», «検索», «بحث», «Rechercher»", async () => {
  for (const word of ["Найти", "検索", "بحث", "Rechercher"]) {
    const io = stayPage({ search: [word] })
    const r = await setDates(ask, io)
    assert.ok(io.s.pressed.includes(word), word)
    assert.match(r.line, new RegExp(`the device pressed the date form's «${word}»`), word)
  }
})

test("a search that opens a new tab: a same-site address is opened here; another site's isn't", async () => {
  const same = stayPage({ opens: "https://stays.example/search?checkin=2026-12-04&checkout=2026-12-06" })
  const r = await setDates(ask, same)
  assert.deepEqual(same.s.opened, ["https://stays.example/search?checkin=2026-12-04&checkout=2026-12-06"])
  assert.match(r.line, /opened here the page it opened in a new tab/)
  const other = stayPage({ opens: "https://elsewhere.example/landing" })
  const r2 = await setDates(ask, other)
  assert.match(r2.line, /tried to open another site in a new tab \(not followed\)/)
})

test("two candidates in the date form: nothing pressed, and the line names both", async () => {
  const io = stayPage({ search: ["Search", "Update"] })
  const r = await setDates(ask, io)
  assert.ok(!io.s.pressed.includes("Search") && !io.s.pressed.includes("Update"))
  assert.match(r.line, /more than one control could apply them: «Search», «Update»/)
})

test("a search in another form (the site's header search) isn't the date form's", async () => {
  const io = stayPage({ search: [], other: [{ id: "hs", role: "button", label: "Search", form: 2 } as MapItem] })
  const r = await setDates(ask, io)
  assert.ok(!io.s.pressed.includes("Search"))
  assert.match(r.line, /doesn't show them chosen yet/)
})
