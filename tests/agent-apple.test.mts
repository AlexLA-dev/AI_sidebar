// The agent's Calendar and Reminders (2.7.1, the owner: «Календарь и напоминания для агента делаем в 2.7.1»): the
// calls are checked, reading is free and writing always asks, nothing touches the page, access not given yet is the
// person's own step, and what the device read goes to the next step only.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { checkCall } from "../src/shared/agent/call.ts"
import { classify } from "../src/shared/agent/classify.ts"
import { answer, appleKind, drive, newState, nowLine, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { PageMap, StepResult, ToolCall } from "../src/shared/agent/types.ts"

const MAP: PageMap = { url: "https://shop.example.com/p", title: "Shop", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "", items: [{ id: "1", role: "button", label: "Add to cart" }] }
const ctx = { map: MAP, startHost: "shop.example.com", request: "x", confirmedHere: false, policy: { amazon: true } }

test("the calls are checked: dates and times, lengths, what each needs", () => {
  const ok = (raw: Record<string, unknown>) => checkCall(raw, MAP)
  assert.equal(ok({ tool: "reminders", text: "батарейки" }).ok, true)
  const add = ok({ tool: "reminder_add", text: "Купить батарейки", list: "Покупки", date: "2026-11-28", time: "10:00" })
  assert.ok(add.ok && add.call.list === "Покупки" && add.call.time === "10:00")
  assert.equal(ok({ tool: "reminder_add", text: "" }).ok, false)
  assert.equal(ok({ tool: "reminder_add", text: "x", date: "28.11.2026" }).ok, false)
  assert.equal(ok({ tool: "reminder_add", text: "x", time: "10:00" }).ok, false, "a time needs a day")
  assert.equal(ok({ tool: "reminder_done" }).ok, false)
  const cal = ok({ tool: "calendar", date: "2026-11-28", time: "18:00", minutes: 5000, days: 40 })
  assert.ok(cal.ok && cal.call.minutes === 720 && cal.call.days === 14)
  assert.equal(ok({ tool: "calendar", time: "18:00" }).ok, false)
  assert.equal(ok({ tool: "event_add", text: "Ужин", date: "2026-12-05" }).ok, false, "an event needs a time")
  const ev = ok({ tool: "event_add", text: "Ужин", date: "2026-12-05", time: "19:30", place: "Ресторан" })
  assert.ok(ev.ok && ev.call.minutes === 60 && ev.call.place === "Ресторан")
})

test("reading is free, writing always asks first, on any site", () => {
  assert.equal(classify({ tool: "reminders" }, ctx).cls, "free")
  assert.equal(classify({ tool: "calendar", date: "2026-11-28" }, ctx).cls, "free")
  for (const tool of ["reminder_add", "reminder_done", "event_add"] as const) {
    const v = classify({ tool, text: "x" }, ctx)
    assert.equal(v.cls, "confirm")
    assert.equal(v.reason, tool)
  }
  assert.equal(appleKind("event_add"), "calendar")
  assert.equal(appleKind("reminder_done"), "reminders")
})

function io(replies: ActReply[], device: { reminders: string; calendar: string }, results: StepResult[] = []) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const apple: ToolCall[] = []
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted; appleCalls: typeof apple } = {
    asked, acted, appleCalls: apple,
    map: async () => MAP,
    act: async (c) => {
      acted.push(c)
      return { ok: true }
    },
    waitPage: async () => {},
    ask: async (body) => {
      asked.push(JSON.parse(JSON.stringify(body)))
      return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }
    },
    save: async () => {},
    entries: async () => [],
    policy: { amazon: true },
    maxSteps: 30,
    device: async () => device,
    apple: async (c) => {
      apple.push(c)
      return results.shift() ?? { ok: true, note: "done" }
    }
  }
  return r
}

const step = (call: ToolCall, cls: "free" | "confirm", reason = "x"): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

test("a read goes to the device, never the page, and its data to the next step only; the date and the device are said", async () => {
  const x = io([
    step({ tool: "reminders", text: "батарейки" }, "free", "read"),
    step({ tool: "reminder_add", text: "Купить батарейки", list: "Покупки", date: "2026-11-28" }, "confirm", "reminder_add"),
    step({ tool: "done", summary: "ok" }, "free", "read")
  ], { reminders: "yes", calendar: "none" }, [{ ok: true, note: "read", data: "From the person's Reminders: «Покупки» (3 open)" }, { ok: true, note: "added to «Покупки»" }])
  let s = await drive(newState("a1", "напомни купить батарейки в субботу", "ru", MAP.url), x)
  assert.equal(s.status, "confirm", "adding a reminder waits for «Да»")
  assert.equal(x.appleCalls.length, 1)
  assert.deepEqual(x.acted, [], "the page isn't touched")
  assert.match(x.asked[1].data, /Покупки/)
  assert.match(x.asked[0].task.now, /^\d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}/)
  assert.deepEqual(x.asked[0].task.device, { reminders: "yes", calendar: "none" })
  s = await answer(s, x, "yes")
  assert.equal(s.status, "done")
  assert.equal(x.appleCalls[1].tool, "reminder_add")
  assert.equal(x.asked[2].data, undefined, "the read's data went once")
  assert.match(x.asked[2].log.at(-1).result, /added/)
})

test("not allowed yet: the person's own step (open the app), then the tool again; turned off: the model is told", async () => {
  const x = io([
    step({ tool: "calendar", date: "2026-11-28", time: "18:00", minutes: 60 }, "free", "read"),
    step({ tool: "calendar", date: "2026-11-28", time: "18:00", minutes: 60 }, "free", "read"),
    step({ tool: "done", summary: "ok" }, "free", "read")
  ], { reminders: "yes", calendar: "none" })
  let s = await drive(newState("a2", "первое свободное после 18:00", "ru", MAP.url), x)
  assert.equal(s.status, "self")
  assert.equal(s.pending?.verdict.reason, "access_calendar")
  assert.equal(x.appleCalls.length, 0)
  s = await answer(s, x, "did")
  assert.match(x.asked[1].log.at(-1).result, /call the tool again/)

  const off = io([step({ tool: "reminders", text: "x" }, "free", "read"), step({ tool: "done", summary: "ok" }, "free", "read")], { reminders: "denied", calendar: "denied" })
  const s2 = await drive(newState("a3", "x", "en", MAP.url), off)
  assert.equal(s2.status, "done")
  assert.match(off.asked[1].log.at(-1).result, /turned off in Settings/)
  assert.equal(off.appleCalls.length, 0)
})

test("the date line the model gets", () => {
  assert.match(nowLine(new Date(2026, 10, 21, 19, 5)), /^2026-11-21 Sat 19:05/)
})

test("the request's own language, over the panel's (the step lines follow it)", async () => {
  const { requestLanguage } = await import("../src/shared/agent/lang.ts")
  const cases: Array<[string, string, string]> = [
    ["Забронируй столик на 5 декабря в 19:30 на 4 человек", "en", "ru"],
    ["Забронюй столик на п'ятницю, будь ласка, і додай нагадування", "en", "uk"],
    ["「もっと見る」を2回押して、最新の記事タイトルを10件教えて", "en", "ja"],
    ["Zeig mir nur E-Gitarren von Fender unter 500 Euro", "en", "de"],
    ["Order a medium pizza with bacon", "ru", "en"],
    ["Réserve une table pour 4 personnes", "en", "fr"],
    ["Añade dos pares a la cesta", "en", "es"],
    ["Đặt bàn cho 4 người", "en", "vi"],
    ["42", "ru", "ru"],
    ["https://example.com", "de", "de"]
  ]
  for (const [text, panel, want] of cases) assert.equal(requestLanguage(text, panel), want, text)
})

test("«Сделать на этой странице?» under a question that asks for an action, not under ordinary questions", async () => {
  const { asksForAction } = await import("../src/shared/agent/hint.ts")
  for (const yes of ["добавь в корзину 2 пары", "Пожалуйста, выбери размер 42", "Забронируй столик на пятницу", "Додай у кошик", "Add size 42 to the cart",
    "please book a table for 4", "Füge zwei Paare in den Warenkorb", "Ajoute-le au panier", "Añade dos al carrito", "Aggiungi al carrello",
    "Adicione ao carrinho", "Sepete ekle", "Thêm vào giỏ hàng", "サイズ42を選んで", "장바구니에 담아 줘", "加入购物车", "أضف إلى السلة", "Can you add it to the cart?"]) {
    assert.equal(asksForAction(yes), true, yes)
  }
  for (const no of ["Что это за страница?", "сколько стоит доставка", "Summarize", "What is the price?", "Wie teuer ist das?", "basically, what's the point",
    "Premium plan worth it", "Это хорошая цена?", "このページは何ですか", "set of rules explained?"]) {
    assert.equal(asksForAction(no), false, no)
  }
})

test("«Готово» without allowing: the model hears it, not a second access step", async () => {
  const x = io([
    step({ tool: "reminders", text: "хлеб" }, "free", "read"),
    step({ tool: "reminders", text: "хлеб" }, "free", "read"),
    step({ tool: "done", summary: "ok" }, "free", "read")
  ], { reminders: "none", calendar: "none" })
  let s = await drive(newState("a4", "напомни купить хлеб", "ru", MAP.url), x)
  assert.equal(s.status, "self")
  s = await answer(s, x, "did")
  assert.equal(s.status, "done")
  assert.match(x.asked[2].log.at(-1).result, /still isn't given/)
  assert.equal(x.appleCalls.length, 0)
})

test("121: «Забукай меня на стрижку…» and other ways to ask are action requests; questions about booking aren't", async () => {
  const { asksForAction } = await import("../src/shared/agent/hint.ts")
  for (const yes of ["Забукай меня на стрижку через месяц в субботу", "закажи две пиццы", "Найди барбера и забронируй на субботу", "можешь забронировать столик на 20:00?",
    "Order the blue one", "I want you to book a haircut on Saturday", "Bestelle das in Größe M", "Buche mir einen Termin am Samstag", "купи это в размере 42", "оформи заказ"]) {
    assert.equal(asksForAction(yes), true, yes)
  }
  for (const no of ["what's the booking policy", "Как здесь работает бронирование?", "Is ordering online cheaper?", "Bestellung status?", "где кнопка заказа"]) {
    assert.equal(asksForAction(no), false, no)
  }
})

test("121: the chat's answer names the agent's button only when the panel shows it (the flag follows the chip)", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  assert.match(app, /asksForAction\(content\) && !agentBusyRef\.current \? \{ agent: true as const, agentLabel: t\("agentHint"\) \}/)
  assert.match(app, /const offerFor = lastUserIndex >= 0 && !historyMode && !agentBusy && [^\n]*asksForAction\(messages\[lastUserIndex\]\.content\)/)
  assert.ok(!/offerFor[^\n]*agentPast/.test(app), "a past task in the chat doesn't hide it")
  assert.match(readFileSync("src/shared/prompt.ts", "utf8"), /under your answer ContextFlow shows a button/)
})

test("123: the answer names the agent's button with the chip's own words, never a translation of them", async () => {
  const { withAgentRule } = await import("../src/shared/prompt.ts")
  const [rules] = withAgentRule(["Rules:\n- a\n\nrest", "x"], true, "Do it on this page?")
  assert.match(rules, /«Do it on this page\?» \(exactly these words\)/)
  const [plain] = withAgentRule(["Rules:\n- a\n\nrest", "x"], true)
  assert.match(plain, /«Do it on this page\?» \(in their language\)/)
  assert.match(readFileSync("src/content/App.tsx", "utf8"), /agent: true as const, agentLabel: t\("agentHint"\)/)
})
