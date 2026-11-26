// The director's round on report-137: a sign-in or an account by a contact alone is the person's (a guard widened); a
// count that isn't the request's is refused; a time the person agreed to in an answer is the booking's time.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { classify } from "../src/shared/agent/classify.ts"
import { countKind, countRefusal, peopleSaid } from "../src/shared/agent/counts.ts"
import { answer, drive, newState, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, StepResult, ToolCall } from "../src/shared/agent/types.ts"
import { AGENT_RULES } from "../src/shared/usage.ts"

const page = (items: PageMap["items"], text = "", forms: PageMap["forms"] = [], url = "https://clinic.example/booking/step"): PageMap => ({ url, title: "Booking", lang: "es", forms, more: 0, part: 1, parts: 1, text, items }) as PageMap
const ctx = (map: PageMap) => ({ map, startHost: "clinic.example", request: "x", confirmedHere: true, policy: { amazon: true } })

test("an e-mail alone with «Continue» beside it is signing in or making an account: the person's", () => {
  // The shape of report-137's clinic page: social sign-in links, an e-mail field, terms links, «Continuar». No form.
  const items = [
    { id: "22", role: "link", label: "Continuar con Google", href: "/login-with/google" },
    { id: "24", role: "textbox", label: "Introduce tu dirección de email", type: "email", lock: "personal", state: ["filled"] },
    { id: "25", role: "link", label: "términos y condiciones", href: "/terminos" },
    { id: "27", role: "button", label: "Continuar" }
  ] as PageMap["items"]
  const text = "Continúa con tu correo electrónico. Si es tu primera reserva, te crearemos una cuenta gratuita."
  assert.deepEqual(classify({ tool: "click", id: "27" }, ctx(page(items, text))), { cls: "self", reason: "account" })
  // The page's words aren't needed: an e-mail alone with its press is enough.
  assert.deepEqual(classify({ tool: "click", id: "27" }, ctx(page(items.filter((i) => i.id !== "22")))), { cls: "self", reason: "account" })
  // «Continue with Google»: a sign-in with another account.
  assert.deepEqual(classify({ tool: "click", id: "22" }, ctx(page(items))), { cls: "self", reason: "auth" })
  // A phone alone with its country-code list and «Next», in a form; Japanese «次へ».
  const phone = page([
    { id: "1", role: "select", label: "Country code", options: ["+44", "+81"], form: 0 },
    { id: "2", role: "textbox", label: "電話番号", type: "tel", form: 0 },
    { id: "3", role: "button", label: "次へ", form: 0 }
  ] as PageMap["items"], "", [{ n: 0, fillable: true }] as PageMap["forms"])
  assert.deepEqual(classify({ tool: "click", id: "3" }, ctx(phone)), { cls: "self", reason: "account" })
})

test("still the agent's: a booking's details form, a booking's own commit word, «Back», a press after another button", () => {
  const form = [{ n: 0, fillable: true }] as PageMap["forms"]
  // Name, e-mail and phone together: the booking's details.
  const details = page([
    { id: "1", role: "textbox", label: "Nombre *", lock: "personal", form: 0 },
    { id: "2", role: "textbox", label: "Correo *", type: "email", lock: "personal", form: 0 },
    { id: "3", role: "textbox", label: "Teléfono", type: "tel", lock: "personal", form: 0 },
    { id: "4", role: "button", label: "Continuar", form: 0 }
  ] as PageMap["items"], "", form)
  assert.notEqual(classify({ tool: "click", id: "4" }, ctx(details)).reason, "account")
  // Japanese one-character name fields count as the name.
  const ja = page([
    { id: "1", role: "textbox", label: "氏", form: 0 }, { id: "2", role: "textbox", label: "名", form: 0 },
    { id: "3", role: "textbox", label: "Eメール必須", type: "email", form: 0 }, { id: "4", role: "button", label: "次へ", form: 0 }
  ] as PageMap["items"], "Googleでログイン", form)
  assert.notEqual(classify({ tool: "click", id: "4" }, ctx(ja)).reason, "account")
  // A phone alone with «Book»: the booking's own press, with its «Do it?».
  const book = page([{ id: "1", role: "textbox", label: "Phone", lock: "personal", form: 0 }, { id: "2", role: "button", label: "Book", type: "submit", form: 0 }] as PageMap["items"], "", form)
  assert.equal(classify({ tool: "click", id: "2" }, ctx(book)).cls, "confirm")
  // …unless the page says the e-mail or phone makes an account.
  assert.deepEqual(classify({ tool: "click", id: "2" }, ctx({ ...book, text: "We'll create an account for you." })), { cls: "self", reason: "account" })
  // «Back» beside the e-mail.
  const back = page([{ id: "1", role: "textbox", label: "E-mail", type: "email" }, { id: "2", role: "button", label: "Back" }] as PageMap["items"])
  assert.notEqual(classify({ tool: "click", id: "2" }, ctx(back)).reason, "account")
  // A shop page: an e-mail field, then «Buy now», then «Show more» — «Show more» isn't the e-mail's press.
  const shop = page([{ id: "3", role: "textbox", label: "E-mail", lock: "personal" }, { id: "4", role: "button", label: "Buy now" }, { id: "5", role: "button", label: "Show more" }] as PageMap["items"])
  assert.notEqual(classify({ tool: "click", id: "5" }, ctx(shop)).reason, "account")
})

test("the people the person said: the request, then their answers (the last said)", () => {
  assert.equal(peopleSaid("Book a table for 2 tomorrow at 19:00"), 2)
  assert.equal(peopleSaid("Get me 1 free ticket for the first event"), 1)
  assert.equal(peopleSaid("明日の12:00に2名で予約して"), 2)
  assert.equal(peopleSaid("Réserve une table pour 2 demain à 20h00"), 2)
  assert.equal(peopleSaid("на 3 персоны"), 3)
  assert.equal(peopleSaid("Book for 2 nights"), null, "nights aren't people")
  assert.equal(peopleSaid("at 7 pm"), null)
  assert.equal(peopleSaid("for 2 people\nmake it 4 people"), 4)
  assert.equal(countKind({ label: "", role: "select", options: ["1名", "2名", "3名"] }), "people")
  assert.equal(countKind({ label: "名", role: "textbox" }), null, "a name's field isn't a count")
})

test("a count that isn't the request's is refused, by the kind of control; the request's is not", () => {
  const big = { id: "f2:292", role: "select", label: "Party size selector", options: ["9 people", "10 people", "11 people", "12 people"] } as PageMap["items"][number]
  const map = page([big])
  const why = countRefusal({ tool: "select", id: big.id, option: "12 people" } as ToolCall, big, map, "Book a table for 2 tomorrow at 19:00", 2)
  assert.match(why ?? "", /isn't the 2 people .* doesn't offer 2 .* ask_user/)
  const small = { ...big, options: ["1 person", "2 people", "3 people"] }
  assert.equal(countRefusal({ tool: "select", id: big.id, option: "2 people" } as ToolCall, small, map, "Book a table for 2", 2), null)
  // No number in the request: the person's rule decides.
  assert.match(countRefusal({ tool: "select", id: big.id, option: "2 people" } as ToolCall, small, map, "Book a table tomorrow", 3) ?? "", /isn't the 3 people/)
  // Rooms: one unless the request says.
  const rooms = { id: "r", role: "select", label: "Rooms", options: ["1", "2", "3"] } as PageMap["items"][number]
  assert.match(countRefusal({ tool: "select", id: "r", option: "2" } as ToolCall, rooms, map, "a stay for 2 adults", 2) ?? "", /isn't the 1 room/)
  assert.equal(countRefusal({ tool: "select", id: "r", option: "2" } as ToolCall, rooms, map, "2 rooms for 4 adults", 2), null)
  // A counter: «Increase» beside a quantity that already shows the request's number.
  const counter = page([
    { id: "a", role: "button", label: "Decrease" }, { id: "b", role: "textbox", label: "Tickets", type: "number", value: "1" }, { id: "c", role: "button", label: "Increase" }
  ] as PageMap["items"])
  assert.match(countRefusal({ tool: "click", id: "c" } as ToolCall, counter.items[2], counter, "Get me 1 free ticket", 2) ?? "", /already show 1/)
  assert.equal(countRefusal({ tool: "click", id: "c" } as ToolCall, counter.items[2], counter, "Get 2 adult tickets", 2), null)
  // A select that counts nothing (a time list) isn't touched.
  const times = { id: "t", role: "select", label: "Time", options: ["12:00", "12:30"] } as PageMap["items"][number]
  assert.equal(countRefusal({ tool: "select", id: "t", option: "12:30" } as ToolCall, times, map, "for 2", 2), null)
  assert.ok((AGENT_RULES as readonly string[]).includes("count_other"))
})

const step = (call: ToolCall, cls: "free" | "confirm", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
function io(maps: PageMap[], replies: ActReply[], acts: StepResult[] = []): RunnerIO {
  let last = maps[maps.length - 1]
  return {
    map: async () => (maps.length ? (last = maps.shift()!) : last),
    act: async () => acts.shift() ?? { ok: true, note: "the page changed" },
    waitPage: async () => {},
    ask: async () => replies.shift() ?? step({ tool: "done", summary: "x" }, "free", "read"),
    save: async () => {},
    entries: async () => [],
    policy: { amazon: true },
    maxSteps: 30
  }
}
const running = (request: string, booking: Record<string, unknown>): AgentState => {
  const s = newState("r138", request, "en", "https://venue.example/reserve")
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking } as unknown as TaskPlan
  s.ruleParty = 2
  return s
}

test("through a run: «12 people» for a table for 2 is refused and counted; the person's answer with a time makes it the booking's time", async () => {
  const big = { id: "5", role: "select", label: "Party size selector", options: ["9 people", "10 people", "11 people", "12 people"] } as PageMap["items"][number]
  const map = page([big], "", [], "https://venue.example/reserve")
  const s = await drive(running("Book a table for 2 tomorrow at 19:00", { kind: "table", date: "2026-11-27", from: "18:00", until: "20:00", minutes: 90 }), io([map], [step({ tool: "select", id: "5", option: "12 people" } as ToolCall, "free", "select")]))
  assert.ok(s.log.some((e) => /refused: «12 people» isn't the 2 people/.test(e.result)), s.log.map((e) => e.result).join(" / "))
  assert.equal(s.ruleCounts?.count_other, 1)
  // The window was 11:00–14:00; the person agreed to 10:30 on 1 December.
  const slots = page([{ id: "1", role: "button", label: "10:30" }, { id: "2", role: "button", label: "10:00" }], "Tuesday 1 December", [], "https://venue.example/reserve")
  const t = running("Buche mir einen Herrenhaarschnitt am Dienstag ab 11:00", { kind: "appointment", date: "2026-12-01", from: "11:00", until: "14:00", minutes: 30 })
  t.status = "asked"
  t.summary = "Only 09:00–10:30 are free. Which one?"
  const u = await answer(t, io([slots], [step({ tool: "click", id: "1", date: "2026-12-01", time: "10:30" } as ToolCall, "free", "click")]), "reply", ["Am 2026-12-01 um 10:30 buchen"])
  assert.equal(u.plan!.booking!.from, "10:30")
  assert.equal(u.plan!.booking!.until, "10:30")
  assert.ok(!u.log.some((e) => /is outside the time/.test(e.result)), u.log.map((e) => e.result).join(" / "))
  // A time the person didn't agree to is still outside it.
  const w = running("Buche mir einen Herrenhaarschnitt am Dienstag ab 11:00", { ...u.plan!.booking! })
  const v = await drive(w, io([slots], [step({ tool: "click", id: "2", date: "2026-12-01", time: "10:00" } as ToolCall, "free", "click")]))
  assert.ok(v.log.some((e) => /10:00 is outside the time/.test(e.result)))
})

test("B1: a press that belongs to another place than the chosen one is refused, with the chosen place's own link", async () => {
  const { otherPlace } = await import("../src/shared/agent/runner.ts")
  const list = page([
    { id: "10", role: "link", label: "Four Seasons Hotel 9.1 Superb 1,204 reviews", href: "/hotel/cy/four-seasons.html" },
    { id: "11", role: "button", label: "See availability" },
    { id: "20", role: "link", label: "Harmony Bay Hotel 8.6 Excellent 851 reviews", href: "/hotel/cy/harmony-bay.html" },
    { id: "21", role: "button", label: "See availability" },
    { id: "30", role: "link", label: "The Grand Resort 8.9 Fabulous 2,310 reviews", href: "/hotel/cy/grand-resort.html" }
  ] as PageMap["items"], "", [], "https://stays.example/searchresults")
  const st = { plan: { booking: { venue: "Harmony Bay Hotel" } } } as never
  // Another hotel's link, and the «See availability» in its card: refused, naming Harmony Bay's own link.
  assert.match(otherPlace(st, list, list.items[0]) ?? "", /belongs to «Four Seasons Hotel», not «Harmony Bay Hotel».*id 20/)
  assert.match(otherPlace(st, list, list.items[1]) ?? "", /belongs to «Four Seasons Hotel»/)
  // The chosen hotel's link and its card's button: pressed.
  assert.equal(otherPlace(st, list, list.items[2]), null)
  assert.equal(otherPlace(st, list, list.items[3]), null)
  // No place chosen, or the chosen place not on this list, or on its own page: nothing refused.
  assert.equal(otherPlace({ plan: { booking: {} } } as never, list, list.items[0]), null)
  assert.equal(otherPlace({ plan: { booking: { venue: "Olive Grove" } } } as never, list, list.items[0]), null)
  const own = { ...list, url: "https://stays.example/hotel/cy/harmony-bay.html" }
  assert.equal(otherPlace(st, own, own.items[1]), null)
  assert.ok((AGENT_RULES as readonly string[]).includes("place_other"))
})

test("B3: the task that just ended shows its end card open; earlier tasks stay folded; an answer-only task shows its answer", () => {
  const panel = readFileSync("src/content/agent/AgentPanel.tsx", "utf8")
  assert.match(panel, /const \[open, setOpen\] = useState\(\(\) => endsOpen\(state\)\)/)
  assert.match(panel, /const endsOpen = \(s: PanelAgent\) => !past && /)
  assert.match(panel, /if \(endsOpen\(state\)\) setOpen\(true\)/)
})
