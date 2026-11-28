// Round 142, the director's decision 15 (S2 proved H2): a phone beside a country or dial-code control takes the national
// part, with the control set to the number's calling code; a fixed code shown as the field's prefix likewise; a field that
// doesn't take the text gets the other forms; the no-value 13b question passes when the page refused that kind.
import assert from "node:assert/strict"
import { test } from "node:test"

import { codesIn, dialControl, fixedPrefix, nationalPart, pickDialOption } from "../src/shared/agent/phone.ts"
import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { drive, newState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap, ToolCall } from "../src/shared/agent/types.ts"

const COUNTRIES = ["Cyprus (+357)", "Canada (+1)", "Guernsey (+44)", "Isle of Man (+44)", "Jersey (+44)", "United Kingdom (+44)", "United States (+1)", "United Arab Emirates (+971)", "Japan (+81)", "Russia (+7)", "Kazakhstan (+7)", "Germany (+49)"]

test("the calling code and the national part (+44, +1, +7, +81, +971, +49)", () => {
  const cases: Array<[string, string, string]> = [
    ["+44 7700 900123", "United Kingdom (+44)", "7700 900123"],
    ["+1 202 555 0123", "United States (+1)", "202 555 0123"],
    ["+7 495 123-45-67", "Russia (+7)", "495 123-45-67"],
    ["+81 3-1234-5678", "Japan (+81)", "3-1234-5678"],
    ["+971 4 123 4567", "United Arab Emirates (+971)", "4 123 4567"],
    ["+49 30 123456", "Germany (+49)", "30 123456"]
  ]
  for (const [value, option, national] of cases) {
    const p = pickDialOption(COUNTRIES, value, { selected: "Cyprus (+357)", region: "", lang: "en" })
    assert.equal(p?.option, option, value)
    assert.equal(p?.national, national, value)
  }
  assert.equal(nationalPart("+44 (0) 7700 900123", "44"), "7700 900123")
  assert.deepEqual(codesIn("United Kingdom (+44)"), ["44"])
})

test("a shared code: the selected one, else the device's region, else the code's main territory", () => {
  assert.equal(pickDialOption(COUNTRIES, "+1 202 555 0123", { region: "CA" })?.option, "Canada (+1)", "a Canadian device")
  assert.equal(pickDialOption(COUNTRIES, "+1 202 555 0123", { region: "DE" })?.option, "United States (+1)", "the main territory")
  assert.equal(pickDialOption(COUNTRIES, "+1 202 555 0123", { selected: "Canada (+1)" })?.option, "Canada (+1)", "already selected")
  assert.deepEqual(pickDialOption(COUNTRIES, "+44 7700 900123", {})?.others, ["Guernsey (+44)", "Isle of Man (+44)", "Jersey (+44)"])
  // Options in the page's language: the region's name by Intl.DisplayNames.
  assert.equal(pickDialOption(["Канада (+1)", "Соединённые Штаты (+1)", "Россия (+7)", "Казахстан (+7)"], "+7 495 123-45-67", { region: "KZ", lang: "ru" })?.option, "Казахстан (+7)")
  assert.equal(pickDialOption(["カナダ (+1)", "アメリカ合衆国 (+1)"], "+1 202 555 0123", { lang: "ja" })?.option, "アメリカ合衆国 (+1)")
  assert.equal(pickDialOption(COUNTRIES, "07700 900123", {}), null, "no code: as before")
})

const page = (items: Partial<MapItem>[], over: Partial<PageMap> = {}): PageMap => ({ url: "https://tickets.example/checkout/details", title: "Details", lang: "en", more: 0, part: 1, parts: 1, forms: [{ n: 1, fillable: true }], text: "Your details",
  items: items.map((i, n) => ({ id: String(n + 1), role: "textbox", label: "", form: 1, ...i })) as MapItem[], ...over }) as PageMap

test("the field's control: a select beside it, in its form; not one far away or in another form", () => {
  const m = page([{ label: "First name" }, { role: "select", label: "Phone country code", options: COUNTRIES, value: "Cyprus (+357)" }, { label: "Telephone number", type: "tel" }])
  assert.equal(dialControl(m, m.items[2])?.id, "2")
  const other = page([{ role: "select", label: "Country", options: COUNTRIES, form: 2 }, { label: "Telephone number", type: "tel" }])
  assert.equal(dialControl(other, other.items[1]), null)
  assert.equal(fixedPrefix({ id: "x", role: "textbox", label: "휴대전화번호 +82" } as MapItem), "82")
})

// Through the runner: a fill of the saved phone (the plan allows it), the acts the device does.
const run = async (map: PageMap, call: Record<string, unknown>, opts: { note?: (c: ToolCall) => string; after?: PageMap; request?: string } = {}) => {
  const acts: ToolCall[] = []
  let current = map
  const replies = [{ ok: true, call: { why: "", ...call } as unknown as ToolCall, verdict: { cls: "free", reason: "type" } }]
  const io = {
    map: async () => current,
    act: async (c: ToolCall) => { acts.push(c); if (opts.after && c.tool === "type") current = opts.after; return { ok: true, note: opts.note?.(c) ?? "typed" } },
    waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 4, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  const st = newState("ph", opts.request ?? "Book it. Phone +44 7700 900123.", "en", map.url)
  await drive(st, io)
  return acts
}

test("a «Country (+NN)» select with a strict national field: the code's country chosen, the national part typed (four scripts)", async () => {
  const labels: Array<[string, string, string, string[]]> = [
    ["en", "Phone country code", "Telephone number", COUNTRIES],
    ["ru", "Код страны", "Телефон", ["Кипр (+357)", "Великобритания (+44)", "Гернси (+44)"]],
    ["ja", "国番号", "電話番号", ["キプロス (+357)", "イギリス (+44)", "ガーンジー (+44)"]],
    ["ar", "رمز الدولة", "رقم الهاتف", ["قبرص (+357)", "المملكة المتحدة (+44)", "غيرنزي (+44)"]]
  ]
  for (const [lang, code, tel, options] of labels) {
    const m = page([{ role: "select", label: code, options, value: options[0] }, { label: tel, type: "tel" }], { lang })
    const acts = await run(m, { tool: "type", id: "2", text: "+44 7700 900123" })
    const sel = acts.find((a) => a.tool === "select")
    assert.ok(sel && /\+44/.test(sel.option ?? "") && !/Guernsey|Гернси|ガーンジー|غيرنزي/.test(sel.option ?? ""), `${lang}: ${sel?.option}`)
    assert.equal(acts.find((a) => a.tool === "type")?.text, "7700 900123", lang)
  }
})

test("still invalid with another option of the same code left: that one, once", async () => {
  const before = page([{ role: "select", label: "Code", options: ["Canada (+1)", "United States (+1)"], value: "Canada (+1)" }, { label: "Phone", type: "tel" }])
  const invalid = page([{ role: "select", label: "Code", options: ["Canada (+1)", "United States (+1)"], value: "Canada (+1)" }, { label: "Phone", type: "tel", state: ["invalid"] }])
  const acts = await run(before, { tool: "type", id: "2", text: "+1 202 555 0123" }, { request: "Book. Phone +1 202 555 0123.", after: invalid })
  // (Canada was already selected: no first select; the page marks the number invalid; United States, once, and the
  // national part again.)
  const sels = acts.filter((a) => a.tool === "select").map((a) => a.option)
  assert.deepEqual(sels, ["United States (+1)"])
  assert.deepEqual(acts.filter((a) => a.tool === "type").map((a) => a.text), ["202 555 0123", "202 555 0123"])
})

test("a flag button that opens a list: the option with the code pressed, the national part typed", async () => {
  const closed = page([{ role: "button", label: "🇨🇾 +357" }, { label: "Mobile", type: "tel" }])
  const open = page([{ role: "button", label: "🇨🇾 +357" }, { label: "Mobile", type: "tel" }, { role: "option", label: "Germany +49", form: 1 }, { role: "option", label: "United Kingdom +44", form: 1 }])
  let opened = false
  const acts: ToolCall[] = []
  const io = {
    map: async () => (opened ? open : closed),
    act: async (c: ToolCall) => { acts.push(c); if (c.tool === "click" && c.id === "1") opened = true; return { ok: true, note: "typed" } },
    waitPage: async () => {}, ask: async () => ({ ok: true, call: acts.length ? { tool: "done", summary: "x", why: "" } : { tool: "type", id: "2", text: "+44 7700 900123", why: "" }, verdict: { cls: "free", reason: "type" } }),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 3, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  await drive(newState("flag", "Book. Phone +44 7700 900123.", "en", closed.url), io)
  assert.ok(acts.some((a) => a.tool === "click" && a.id === "4"), JSON.stringify(acts.map((a) => `${a.tool}#${a.id}`)))
  assert.equal(acts.find((a) => a.tool === "type")?.text, "7700 900123")
})

test("a fixed prefix the field shows: the national part when it's the number's code; else as before; a plain field as before", async () => {
  const pref = page([{ label: "휴대전화번호 +82", type: "tel" }], { lang: "ko" })
  assert.equal((await run(pref, { tool: "type", id: "1", text: "+82 10-1234-5678" }, { request: "예약. 전화 +82 10-1234-5678." })).find((a) => a.tool === "type")?.text, "10-1234-5678")
  assert.equal((await run(pref, { tool: "type", id: "1", text: "+44 7700 900123" })).find((a) => a.tool === "type")?.text, "+44 7700 900123")
  const plain = page([{ label: "Phone", type: "tel" }])
  assert.deepEqual((await run(plain, { tool: "type", id: "1", text: "+44 7700 900123" })).map((a) => `${a.tool}:${a.text}`), ["type:+44 7700 900123"])
})

test("15d: a field that doesn't take the text: the number whole, its digits with «+», each only while the field stays empty", async () => {
  const plain = page([{ label: "Phone", type: "tel" }])
  let n = 0
  const acts = await run(plain, { tool: "type", id: "1", text: "+44 7700 900123" }, { note: () => (n++ < 2 ? "the field didn't take the text" : "typed") })
  assert.deepEqual(acts.filter((a) => a.tool === "type").map((a) => a.text), ["+44 7700 900123", "+44 7700 900123", "+447700900123"])
})

test("15e: the no-value question about a phone passes when the page marks the phone field invalid", async () => {
  const invalid = page([{ label: "Phone", type: "tel", state: ["invalid"] }])
  const acts: ToolCall[] = []
  const io = {
    map: async () => invalid, act: async (c: ToolCall) => { acts.push(c); return { ok: true } }, waitPage: async () => {},
    ask: async () => ({ ok: true, call: { tool: "ask_user", question: "The site says your phone number isn't valid. What phone number should I use?", why: "" }, verdict: { cls: "free", reason: "read" } }),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 3, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  const st = await drive(newState("e15", "Book. Phone +44 7700 900123.", "en", invalid.url), io)
  assert.equal(st.status, "asked")
  assert.equal(st.ruleCounts?.given_ask, undefined)
})

// Decision 15 amended (the director's answer to the phone-set blocker).
const US_CA = ["Canada (+1)", "United States (+1)"]
const drive15 = async (maps: { before: PageMap; afterType?: PageMap; afterPress?: PageMap }, calls: Array<Record<string, unknown>>, request: string, pressVerdict = { cls: "confirm", reason: "submit" }) => {
  const acts: ToolCall[] = []
  let current = maps.before
  const replies = calls.map((c) => ({ ok: true, call: { why: "", ...c } as unknown as ToolCall, verdict: c.tool === "click" ? pressVerdict : { cls: "free", reason: c.tool === "select" ? "select" : "type" } }))
  const io = {
    map: async () => current,
    act: async (c: ToolCall) => {
      acts.push(c)
      if (c.tool === "select") current = { ...current, items: current.items.map((i) => (i.id === c.id ? { ...i, value: c.option } : i)) }
      if (c.tool === "type" && maps.afterType) current = { ...maps.afterType, items: maps.afterType.items.map((i) => (i.role === "select" ? { ...i, value: current.items.find((x) => x.id === i.id)?.value } : i)) }
      if (c.tool === "click" && maps.afterPress) current = maps.afterPress
      return { ok: true, note: "typed" }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 8, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  const st = await drive(newState("p15", request, "en", maps.before.url), io)
  return { acts, st }
}
const form = (value: string, invalid = false) => page([{ role: "select", label: "Country code", options: US_CA, value }, { label: "Telephone number", type: "tel", ...(invalid ? { state: ["invalid"] } : {}) }, { role: "button", label: "Book" }])

test("15a2: the model's select on the dial-code control while the number is known gets the device's option (US for +1), and says why", async () => {
  const { acts, st } = await drive15({ before: form("Canada (+1)") }, [{ tool: "select", id: "1", option: "Canada (+1)" }, { tool: "type", id: "2", text: "+1 202 555 0123" }], "Book. Phone +1 202 555 0123.")
  const sels = acts.filter((a) => a.tool === "select").map((a) => a.option)
  assert.deepEqual(sels, ["United States (+1)"], "the model named Canada; the device chose the US (the code's main territory)")
  assert.match(st.log.find((l) => l.call.tool === "select")?.result ?? "", /the device chose «United States \(\+1\)»: the person's number has the code \+1/)
  assert.equal(acts.find((a) => a.tool === "type")?.text, "202 555 0123")
})

test("15a2: with no international number known, the model's select is as before", async () => {
  const { acts } = await drive15({ before: form("United States (+1)") }, [{ tool: "select", id: "1", option: "Canada (+1)" }], "Book a table for 2.")
  assert.deepEqual(acts.filter((a) => a.tool === "select").map((a) => a.option), ["Canada (+1)"])
})

test("15a: a selection this task made doesn't count as the page's — the device's rules decide", async () => {
  // (The task touched the control before — its own Canada is there now; the phone the request gives goes in.)
  const acts: ToolCall[] = []
  let current = form("Canada (+1)")
  const replies = [{ ok: true, call: { tool: "type", id: "2", text: "+1 202 555 0123", why: "" } as unknown as ToolCall, verdict: { cls: "free", reason: "type" } }]
  const io = {
    map: async () => current, act: async (c: ToolCall) => { acts.push(c); if (c.tool === "select") current = { ...current, items: current.items.map((i) => (i.id === c.id ? { ...i, value: c.option } : i)) }; return { ok: true, note: "typed" } },
    waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 4, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  const st = newState("p15a", "Book. Phone +1 202 555 0123.", "en", current.url)
  st.dialTouched = ["1"]
  await drive(st, io)
  assert.deepEqual(acts.filter((a) => a.tool === "select").map((a) => a.option), ["United States (+1)"], "the task's own Canada doesn't hold")
  // And the page's own Canada, untouched, does (then 15b's check decides).
  const untouched = await drive15({ before: form("Canada (+1)") }, [{ tool: "type", id: "2", text: "+1 202 555 0123" }], "Book. Phone +1 202 555 0123.")
  assert.deepEqual(untouched.acts.filter((a) => a.tool === "select").map((a) => a.option), [])
})

test("15b: the phone is typed with the field left; invalid then → the other option once, the national part again", async () => {
  const { acts } = await drive15({ before: form("Canada (+1)"), afterType: form("Canada (+1)", true) }, [{ tool: "type", id: "2", text: "+1 202 555 0123" }], "Book. Phone +1 202 555 0123.")
  const types = acts.filter((a) => a.tool === "type")
  assert.ok(types.every((t) => t.leave === true), "every phone typing leaves the field")
  // The page had Canada selected before the task: kept (15a), the page marks it invalid, the US once.
  assert.deepEqual(acts.filter((a) => a.tool === "select").map((a) => a.option), ["United States (+1)"])
})

test("15b: a page that checks only on the booking press — the other option once after the press, never twice", async () => {
  // (The press on «Book» is a «Do it?» card: answered yes, as the person would; then once more.)
  const { answer } = await import("../src/shared/agent/runner.ts")
  const acts: ToolCall[] = []
  let current = form("Canada (+1)")
  const replies = [{ tool: "type", id: "2", text: "+1 202 555 0123" }, { tool: "click", id: "3" }, { tool: "click", id: "3" }].map((c) => ({ ok: true, call: { why: "", ...c } as unknown as ToolCall, verdict: c.tool === "click" ? { cls: "confirm", reason: "submit" } : { cls: "free", reason: "type" } }))
  const io = {
    map: async () => current,
    act: async (c: ToolCall) => { acts.push(c); if (c.tool === "select") current = { ...current, items: current.items.map((i) => (i.id === c.id ? { ...i, value: c.option } : i)) }; if (c.tool === "click") current = form(current.items[0].value ?? "", true); return { ok: true, note: "typed" } },
    waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 8, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  let st = await drive(newState("p15b", "Book. Phone +1 202 555 0123.", "en", current.url), io)
  for (let k = 0; k < 2 && st.status === "confirm"; k++) st = await answer(st, io, "yes")
  assert.deepEqual(acts.filter((a) => a.tool === "select").map((a) => a.option), ["United States (+1)"], "once a task")
  assert.equal(st.phoneExtra, true)
})

test("15c: a question quoting the phone while the page marks the phone field invalid reaches the person", async () => {
  const { st } = await drive15({ before: form("United States (+1)", true) }, [{ tool: "ask_user", question: "The page says +1 202 555 0123 isn't valid. Which number should I use?" }], "Book. Phone +1 202 555 0123.")
  assert.equal(st.status, "asked")
  assert.equal(st.ruleCounts?.given_ask, undefined)
})
