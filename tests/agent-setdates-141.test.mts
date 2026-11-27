// Round 141, set_dates (design-141 and the director's four additions): the device sets the booking's dates itself.
import assert from "node:assert/strict"
import { test } from "node:test"

import { MAX_DAYS, setDates, type DatesIO } from "../src/shared/agent/setdates.ts"
import { drive, newState, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { MapItem, PageMap, ToolCall } from "../src/shared/agent/types.ts"

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** A page with a date picker: closed until «Check-in» is pressed, a month at a time with «Next month», days that can be
 *  full (greyed), its own «Apply», and times shown for the applied day when it has any. */
function picker(opts: { month: number; full?: string[]; times?: Record<string, string[]>; native?: boolean; note?: string; range?: boolean; dayNotFree?: boolean; select?: boolean; silent?: boolean }) {
  const s = { open: false, month: opts.month, picked: [] as string[], applied: "", typed: "", presses: [] as string[] }
  const days = () => Array.from({ length: 28 }, (_, i) => `2026-${String(s.month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`)
  const map = (): PageMap => {
    const items: MapItem[] = []
    if (opts.native) items.push({ id: "f1", role: "textbox", type: "date", label: "Date", value: s.typed })
    else {
      items.push({ id: "open", role: "button", label: "Check-in" })
      if (s.open) {
        items.push({ id: "next", role: "button", label: "Next month" })
        for (const d of days()) items.push({ id: `d${d}`, role: "button", label: `${Number(d.slice(8))} ${MONTHS[s.month]} 2026`, state: [...(opts.full?.includes(d) ? ["unavailable"] : []), ...(s.picked.includes(d) ? ["selected"] : [])] })
        items.push({ id: "apply", role: "button", label: "Apply" })
      }
    }
    const day = s.applied || s.typed
    const shown = (day && opts.times?.[day]) || []
    for (const t of shown) items.push({ id: `t${t}`, role: "button", label: t })
    if (opts.select) items.push({ id: "tsel", role: "select", label: "Time", options: ["18:00", "18:30", "19:00", "19:30"] })
    const none = day && !shown.length && !opts.select && !opts.silent ? "\nNo free times on this day" : ""
    return { url: "https://salon.example/book", title: "Book", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: `${s.open ? `# ${MONTHS[s.month]} 2026\n` : ""}${opts.note ?? ""}${none}`, items } as PageMap
  }
  const io: DatesIO & { s: typeof s } = {
    s,
    map: async () => map(),
    press: async (item) => {
      s.presses.push(item.label)
      if (opts.dayNotFree && item.id.startsWith("d")) return "not free"
      if (item.id === "open") s.open = true
      else if (item.id === "next") s.month = (s.month + 1) % 12
      else if (item.id === "apply") s.applied = s.picked[0] ?? ""
      else if (item.id.startsWith("d")) {
        const d = item.id.slice(1)
        if (!opts.full?.includes(d)) s.picked = opts.range && s.picked.length === 1 ? [...s.picked, d] : [d]
      }
      return "done"
    },
    type: async (_item, text) => {
      s.typed = text
      return "done"
    },
    stopped: async () => false
  }
  return io
}

test("a picker opened, its months turned, the day pressed and its own «Apply» pressed; the page's times come back", async () => {
  const io = picker({ month: 10, times: { "2026-12-04": ["17:30", "18:30", "19:30"] } })
  const r = await setDates({ date: "2026-12-04", from: "18:00", until: "21:00", byDays: false }, io)
  assert.deepEqual(io.s.presses, ["Check-in", "Next month", "4 December 2026", "Apply"])
  assert.equal(r.landed, "2026-12-04")
  assert.match(r.line, /4 Dec shows 18:30, 19:30/)
})

test("a stay: both days pressed, then «Apply»", async () => {
  const io = picker({ month: 11, range: true })
  const r = await setDates({ date: "2026-12-04", end: "2026-12-06", byDays: true }, io)
  assert.deepEqual(io.s.presses, ["Check-in", "4 December 2026", "6 December 2026", "Apply"])
  assert.equal(r.landed, "2026-12-04")
  assert.deepEqual(io.s.picked, ["2026-12-04", "2026-12-06"])
})

test("a native date field is typed", async () => {
  const io = picker({ month: 11, native: true, times: { "2026-12-05": ["19:00"] } })
  const r = await setDates({ date: "2026-12-05", from: "18:00", until: "21:00", byDays: false }, io)
  assert.equal(io.s.typed, "2026-12-05")
  assert.match(r.line, /5 Dec shows 19:00/)
})

test("a window: full days are passed by to the first with a free time inside the request's times", async () => {
  const io = picker({ month: 11, full: ["2026-12-02"], times: { "2026-12-03": ["12:00"], "2026-12-04": ["18:30"] } })
  const r = await setDates({ date: "2026-12-02", last: "2026-12-06", from: "18:00", until: "21:00", byDays: false }, io)
  assert.equal(r.landed, "2026-12-04", "2 Dec greyed, 3 Dec only 12:00 — outside 18:00–21:00")
  assert.deepEqual(r.full, ["2026-12-02", "2026-12-03"])
  assert.match(r.line, /4 Dec shows 18:30 \(2 Dec, 3 Dec full\)/)
})

test("the walk is bounded: at most seven days, then what it saw and «not looked further»", async () => {
  const io = picker({ month: 11, times: {} })
  const r = await setDates({ date: "2026-12-01", last: "2026-12-20", from: "18:00", until: "21:00", byDays: false }, io)
  assert.equal(r.full.length, MAX_DAYS)
  assert.equal(r.landed, undefined)
  assert.match(r.line, /no free time inside the request's window; not looked further/)
})

test("a form whose times are a list: the day is set and its times read from the list, never «full» (round 141's stand)", async () => {
  const io = picker({ month: 11, native: true, select: true })
  const r = await setDates({ date: "2026-12-05", last: "2026-12-07", from: "18:30", until: "20:30", byDays: false }, io)
  assert.equal(r.landed, "2026-12-05")
  assert.deepEqual(r.full, [])
  assert.match(r.line, /5 Dec shows 18:30, 19:00, 19:30/)
})

test("a page that shows no times yet and doesn't say the day is full: the day is set, not walked past", async () => {
  const io = picker({ month: 11, native: true, silent: true })
  const r = await setDates({ date: "2026-12-05", last: "2026-12-07", from: "18:00", until: "21:00", byDays: false }, io)
  assert.equal(r.landed, "2026-12-05")
  assert.match(r.line, /5 Dec set; the page shows no times for it yet/)
})

test("no date control: the model presses by hand", async () => {
  const io: DatesIO = { map: async () => ({ url: "https://x.example", title: "", lang: "", forms: [], more: 0, part: 1, parts: 1, text: "", items: [{ id: "1", role: "button", label: "Menu" }] }) as PageMap, press: async () => "done", type: async () => "done", stopped: async () => false }
  const r = await setDates({ date: "2026-12-04", byDays: false }, io)
  assert.equal(r.fallback, true)
  assert.match(r.line, /no date control recognised/)
})

test("the person's Stop is heard between presses", async () => {
  const io = picker({ month: 10 })
  let n = 0
  io.stopped = async () => ++n > 1
  const r = await setDates({ date: "2026-12-04", byDays: false }, io)
  assert.equal(r.stopped, true)
  assert.ok(io.s.presses.length <= 1)
})

test("a press that isn't a free step stops the tool before it", async () => {
  const io = picker({ month: 11, dayNotFree: true })
  const r = await setDates({ date: "2026-12-04", byDays: false }, io)
  assert.match(r.line, /stopped before a press that isn't a free step/)
  assert.ok(!io.s.applied)
})

// ---- through the runner: only the plan's days; a day the page names is never set, the model's only inside the window
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

async function runWith(call: ToolCall, note = "") {
  const io0 = picker({ month: 11, note, times: { "2026-12-04": ["18:30"], "2026-12-24": ["18:30"] } })
  const replies: ActReply[] = [step(call, "free", "read"), step({ tool: "done", summary: "", why: "" }, "free", "read")]
  const io: RunnerIO = {
    map: async () => io0.map(), act: async (c) => {
      const m = (await io0.map())!
      const it = m.items.find((i) => i.id === c.id)!
      if (c.tool === "type") await io0.type(it, c.text ?? "")
      else await io0.press(it)
      return { ok: true, note: "the page changed", changed: true }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30
  }
  const st = newState("sd141", "Book a haircut on 4 December 2026 after 18:00", "en", "https://salon.example/book")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], risky: [], approved: true, booking: { kind: "appointment", date: "2026-12-04", from: "18:00", until: "21:00", minutes: 45, personal: false, venue: "Salon" } } as unknown as TaskPlan
  return { st: await drive(st, io), io0 }
}

test("through the runner: set_dates sets the plan's day; a day the page or the model names outside the window is never set", async () => {
  const { st, io0 } = await runWith({ tool: "set_dates", why: "Setting your day", date: "2026-12-24" }, "Only 24 Dec is available — choose it")
  assert.ok(io0.s.presses.includes("4 December 2026"), io0.s.presses.join(", "))
  assert.ok(!io0.s.presses.includes("24 December 2026"))
  const entry = st.log.find((e) => e.call.tool === "set_dates")!
  assert.equal(entry.call.date, "2026-12-04")
  assert.match(entry.result, /4 Dec shows 18:30/)
})

// ---- round 141's real sites: a window's stay has no check-out in the plan; set_dates found no control again and again
import { nightsIn } from "../src/shared/agent/runner.ts"

test("a stay's nights from the request when the plan gives no check-out, in all 15 languages (digits, words, CJK numerals)", () => {
  const cases: [string, number][] = [
    ["Book a stay in Seoul for 2 adults, 2 nights, any dates in the next two weeks", 2], ["two nights in Rome", 2],
    ["Забронируй номер на 2 ночи в Москве", 2], ["на две ночи", 2],
    ["Забронюй номер на дві ночі у Львові", 2], ["на 3 ночі", 3],
    ["Buche 2 Nächte in Berlin", 2], ["zwei Nächte", 2],
    ["Réserve deux nuits à Paris", 2], ["3 nuits", 3],
    ["Reserva 3 noches en Madrid", 3], ["dos noches", 2],
    ["Prenota due notti a Roma", 2], ["2 notti", 2],
    ["Reserve 2 noites em Lisboa", 2], ["duas noites", 2],
    ["İstanbul'da 2 gece kalmak için", 2], ["iki gece", 2],
    ["東京で2泊3日", 2], ["二泊", 2],
    ["이번 달 안에 서울에서 2박, 성인 2명", 2], ["두 박", 2],
    ["在上海住两晚", 2], ["2晚", 2], ["两个晚上", 2],
    ["在台北住兩晚", 2], ["3夜", 3],
    ["Đặt phòng hai đêm ở Hà Nội", 2], ["2 đêm", 2],
    ["حجز ليلتين في دبي", 2], ["٣ ليالٍ في القاهرة", 3], ["ثلاث ليال", 3],
    ["Book a table for 2 at 19:00", 0], ["2 adults this weekend", 0], ["Записаться на 2 часа", 0]
  ]
  for (const [request, n] of cases) assert.equal(nightsIn(request), n, request)
})

async function runStay(calls: ToolCall[], range = true) {
  const io0 = picker({ month: 11, range })
  const replies: ActReply[] = [...calls.map((c) => step(c, "free", "read")), step({ tool: "done", summary: "", why: "" }, "free", "read")]
  const io: RunnerIO = {
    map: async () => io0.map(), act: async (c) => {
      const m = (await io0.map())!
      const it = m.items.find((i) => i.id === c.id)!
      if (c.tool === "type") await io0.type(it, c.text ?? "")
      else await io0.press(it)
      return { ok: true, note: "the page changed", changed: true }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30
  }
  const st = newState("sd141s", "Book a stay for 2 adults, 2 nights, any dates in the first week of December 2026", "en", "https://salon.example/book")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], risky: [], approved: true, booking: { kind: "stay", date: "2026-12-01", dayLast: "2026-12-07", from: "09:00", until: "21:00", minutes: 0, personal: false } } as unknown as TaskPlan
  return { st: await drive(st, io), io0 }
}

test("a window's stay with no check-out in the plan: both days set, the nights from the request", async () => {
  const { io0 } = await runStay([{ tool: "set_dates", why: "" }])
  assert.deepEqual(io0.s.picked, ["2026-12-01", "2026-12-03"])
})

test("set_dates isn't run again on a page where it found no date control", async () => {
  const io0: DatesIO = { map: async () => ({ url: "https://x.example/p", title: "", lang: "", forms: [], more: 0, part: 1, parts: 1, text: "", items: [{ id: "1", role: "button", label: "Menu" }] }) as PageMap, press: async () => "done", type: async () => "done", stopped: async () => false }
  const replies: ActReply[] = [step({ tool: "set_dates", why: "" }, "free", "read"), step({ tool: "set_dates", why: "" }, "free", "read"), step({ tool: "done", summary: "", why: "" }, "free", "read")]
  const io: RunnerIO = { map: async () => io0.map(), act: async () => ({ ok: true, note: "", changed: false }), waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"), save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30 }
  const st = newState("sd141n", "Book a haircut on 4 December 2026", "en", "https://x.example/p")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], risky: [], approved: true, booking: { kind: "appointment", date: "2026-12-04", from: "09:00", until: "21:00", minutes: 45, personal: false } } as unknown as TaskPlan
  await drive(st, io)
  const sd = st.log.filter((e) => e.call.tool === "set_dates").map((e) => e.result)
  assert.match(sd[0], /no date control recognised/)
  assert.match(sd[1], /^refused: set_dates found no date control on this page before/)
})

// ---- round 142, item 3: a stay set halfway never traps the model
test("a stay whose last day isn't on the page: the tool says only the first day is set, and what's missing", async () => {
  const io = picker({ month: 10, range: true })
  // 28 Nov – 1 Dec: the picker shows one month at a time, so 1 Dec isn't there after 28 Nov is pressed.
  const r = await setDates({ date: "2026-11-28", end: "2026-12-01", byDays: true }, io)
  assert.equal(r.landed, "2026-11-28")
  assert.match(r.line, /only the first day, 28 Nov, is set: the last day, 1 Dec, couldn't be pressed here — press 1 Dec/)
})

test("after set_dates set a stay's first day, the stay's own days pressed by hand are never refused", async () => {
  const io0 = picker({ month: 10, range: true })
  const day = (d: string) => `d${d}`
  const replies: ActReply[] = [
    step({ tool: "set_dates", why: "" }, "free", "read"),
    step({ tool: "click", id: "next", why: "" }, "free", "read"),
    step({ tool: "click", id: day("2026-12-01"), why: "" }, "free", "read"),
    step({ tool: "click", id: day("2026-12-01"), why: "" }, "free", "read"),
    step({ tool: "done", summary: "", why: "" }, "free", "read")
  ]
  const io: RunnerIO = {
    map: async () => io0.map(), act: async (c) => {
      const m = (await io0.map())!
      const it = m.items.find((i) => i.id === c.id)
      if (it) await io0.press(it)
      return { ok: true, note: "the page changed", changed: true }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30
  }
  const st = newState("sd142", "Book a room for 2 adults from 28 November to 1 December 2026", "en", "https://salon.example/book")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], risky: [], approved: true, booking: { kind: "stay", date: "2026-11-28", dateEnd: "2026-12-01", from: "09:00", until: "21:00", minutes: 0, personal: false } } as unknown as TaskPlan
  await drive(st, io)
  const refused = st.log.filter((e) => /^refused/.test(e.result ?? "") && e.call.tool === "click")
  assert.deepEqual(refused.map((e) => e.result), [])
  assert.ok(io0.s.presses.includes("1 December 2026"))
})

test("a window's stay with no nights in the request: the tool says the last day isn't set, and a later day pressed by hand is the stay's last", async () => {
  const io0 = picker({ month: 11, range: true })
  const replies: ActReply[] = [step({ tool: "set_dates", why: "" }, "free", "read"), step({ tool: "click", id: "d2026-12-03", why: "" }, "free", "read"), step({ tool: "done", summary: "", why: "" }, "free", "read")]
  const io: RunnerIO = {
    map: async () => io0.map(), act: async (c) => {
      const it = (await io0.map())!.items.find((i) => i.id === c.id)
      if (it) await io0.press(it)
      return { ok: true, note: "the page changed", changed: true }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30
  }
  const st = newState("sd142w", "Book a room for 2 adults, any dates in the first week of December 2026", "en", "https://salon.example/book")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], risky: [], approved: true, booking: { kind: "stay", date: "2026-12-01", dayLast: "2026-12-07", from: "09:00", until: "21:00", minutes: 0, personal: false } } as unknown as TaskPlan
  await drive(st, io)
  assert.match(st.log.find((e) => e.call.tool === "set_dates")!.result, /only the first day, 1 Dec, is set: the request doesn't say how many nights/)
  assert.ok(!st.log.some((e) => e.call.tool === "click" && /^refused/.test(e.result ?? "")))
  assert.deepEqual(st.stay, { in: "2026-12-01", out: "2026-12-03" })
})
