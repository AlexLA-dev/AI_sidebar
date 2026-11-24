// The agent's task runner (2.7.1): free steps done at once, «Сделать?» and the person's own steps waited for, a fill
// whose value never reaches the server, the device's own check over a milder server class, a blocked site.
import assert from "node:assert/strict"
import { test } from "node:test"

import type { FormEntry } from "../src/shared/agent/formdata.ts"
import { answer, drive, newState, stricter, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const MAP: PageMap = {
  url: "https://shop.example.com/p", title: "Shoes", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "",
  items: [
    { id: "1", role: "radio", label: "42" },
    { id: "2", role: "button", label: "Add to cart" },
    { id: "3", role: "textbox", label: "E-mail", lock: "personal", auto: "email" },
    { id: "4", role: "button", label: "Buy now" },
    { id: "5", role: "button", label: "Show more" }
  ]
}

function io(replies: ActReply[], entries: FormEntry[] = [], map: PageMap = MAP) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted } = {
    asked, acted,
    map: async () => map,
    act: async (c) => {
      acted.push(c)
      return { ok: true, note: "the page changed", changed: true }
    },
    waitPage: async () => {},
    ask: async (body) => {
      asked.push(JSON.parse(JSON.stringify(body)))
      return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }
    },
    save: async () => {},
    entries: async () => entries,
    policy: { amazon: true },
    maxSteps: 30
  }
  return r
}

const step = (call: ToolCall, cls: "free" | "confirm" | "self" | "blocked", reason = "x", extra: Partial<ActReply> = {}): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null, ...extra })

test("free steps run, «Сделать?» waits, Да does it, then done", async () => {
  const x = io([
    step({ tool: "click", id: "1", why: "size" }, "free", "toggle", { token: "tok", left: 4 }),
    step({ tool: "click", id: "2", why: "add" }, "confirm", "submit"),
    step({ tool: "done", summary: "In the cart" }, "free", "read")
  ])
  const s = await drive(newState("t1", "size 42 to cart", "en", MAP.url), x)
  assert.equal(s.status, "confirm")
  assert.deepEqual(x.acted.map((c) => c.id), ["1"])
  assert.equal(s.token, "tok")
  assert.equal(s.left, 4)
  const after = await answer(s, x, "yes")
  assert.equal(after.status, "done")
  assert.equal(after.summary, "In the cart")
  assert.deepEqual(x.acted.map((c) => c.id), ["1", "2"])
  assert.equal(x.asked[2].task.token, "tok")
  assert.equal(x.asked[2].task.confirmedHere, true)
})

test("Нет is told to the model; the person's own step waits for Готово and goes on", async () => {
  const x = io([
    step({ tool: "click", id: "2" }, "confirm", "submit"),
    step({ tool: "click", id: "4" }, "self", "pay"),
    step({ tool: "done", summary: "left the payment to you" }, "free", "read")
  ])
  let s = await drive(newState("t2", "buy", "en", MAP.url), x)
  s = await answer(s, x, "no")
  assert.equal(s.status, "self")
  assert.match(x.asked[1].log.at(-1).result, /said no/)
  s = await answer(s, x, "notnow")
  assert.equal(s.status, "done")
  assert.match(x.asked[2].log.at(-1).result, /didn't do this step now/)
  assert.deepEqual(x.acted, [], "the person's own step is never done by the hands")
})

test("a server that calls «Buy now» free is overruled by the device's own check", async () => {
  const x = io([step({ tool: "click", id: "4" }, "free", "click")])
  const s = await drive(newState("t3", "buy", "en", MAP.url), x)
  assert.equal(s.status, "self")
  assert.equal(x.acted.length, 0)
  assert.equal(stricter({ cls: "free", reason: "a" }, { cls: "confirm", reason: "b" }).cls, "confirm")
})

test("fill: the card shows the value, the server only ever gets the key", async () => {
  const entries: FormEntry[] = [{ id: "e1", key: "email", label: "", value: "anna@example.com", updatedAt: 1 }]
  const x = io([step({ tool: "fill", id: "3", key: "email" }, "confirm", "fill")], entries)
  let s = await drive(newState("t4", "subscribe me", "en", MAP.url), x)
  assert.equal(s.status, "fill")
  assert.deepEqual(s.pending?.fill, [{ entryId: "e1", label: "E-mail", value: "anna@example.com", id: "3", key: "email" }])
  assert.deepEqual(x.asked[0].keys, ["email"])
  // An entry id alone ticks nothing (the review: it could have ticked the line for another field).
  const only = await answer(JSON.parse(JSON.stringify(s)), io([], entries), "yes", ["e1"])
  assert.match(only.log.map((e) => e.result).join(" "), /chose not to fill/)
  s = await answer(s, x, "yes", ["3:e1"])
  assert.equal(x.acted[0].text, "anna@example.com")
  assert.ok(!JSON.stringify(x.asked).includes("anna@example.com"), "no value in any request")
  assert.equal(s.status, "done")
})

test("a blocked site ends the task with its own reason; a blocked step is told back", async () => {
  const x = io([step({ tool: "click", id: "2" }, "blocked", "site_amazon")], [], { ...MAP, url: "https://www.amazon.de/dp/1" })
  const s = await drive(newState("t5", "add", "en", "https://www.amazon.de/dp/1"), x)
  assert.equal(s.status, "blocked")
  assert.equal(s.error, "site_amazon")
  const y = io([step({ tool: "type", id: "3", text: "4111 1111 1111 1111" }, "blocked", "secret_text")])
  const t = await drive(newState("t6", "x", "en", MAP.url), y)
  assert.equal(t.status, "done")
  assert.match(y.asked[1].refused, /secret_text/)
})

test("an error from the server stops it with the code; the step limit ends it", async () => {
  const x = io([{ ok: false, code: "AGENT_LIMIT" }])
  const s = await drive(newState("t7", "x", "en", MAP.url), x)
  assert.equal(s.status, "error")
  assert.equal(s.error, "AGENT_LIMIT")
  const many = Array.from({ length: 40 }, () => step({ tool: "click", id: "5" }, "free", "nav"))
  const y = io(many)
  const t = await drive(newState("t8", "x", "en", MAP.url), { ...y, maxSteps: 5 })
  assert.equal(t.step, 5)
  assert.equal(t.error, "steps")
})

test("fill: the form's other empty fields with a saved detail by autocomplete come on the same card", async () => {
  const map: PageMap = {
    ...MAP, forms: [{ n: 0, fillable: true }],
    items: [
      { id: "1", role: "textbox", label: "Имя", lock: "personal", auto: "name", state: ["empty"], form: 0 },
      { id: "2", role: "textbox", label: "Телефон", lock: "personal", auto: "tel", state: ["empty"], form: 0 },
      { id: "3", role: "textbox", label: "Почта", lock: "personal", auto: "email", state: ["filled"], form: 0 },
      { id: "4", role: "textbox", label: "Комментарий", state: ["empty"], form: 0 }
    ]
  }
  const entries: FormEntry[] = [
    { id: "a", key: "name.full", label: "", value: "Анна Петрова", updatedAt: 1 },
    { id: "b", key: "phone", label: "", value: "+7 900 123-45-67", updatedAt: 1 },
    { id: "c", key: "email", label: "", value: "anna@example.com", updatedAt: 1 }
  ]
  const x = io([step({ tool: "fill", id: "1", key: "name.full" }, "confirm", "fill")], entries, map)
  let s = await drive(newState("t9", "book", "ru", MAP.url), x)
  assert.deepEqual(s.pending?.fill?.map((l) => l.id), ["1", "2"], "the filled e-mail and the comment aren't offered")
  s = await answer(s, x, "yes", ["1:a", "2:b"])
  assert.deepEqual(x.acted.map((c) => [c.id, c.text]), [["1", "Анна Петрова"], ["2", "+7 900 123-45-67"]])
  assert.ok(!JSON.stringify(x.asked).includes("Анна Петрова"))
})

test("after a form is sent, «Отменить» has nothing to offer", async () => {
  const x = io([step({ tool: "click", id: "1" }, "free", "toggle"), step({ tool: "click", id: "2" }, "confirm", "submit"), step({ tool: "done", summary: "ok" }, "free", "read")])
  x.act = async (c) => {
    x.acted.push(c)
    return { ok: true, note: "typed", undo: { id: c.id ?? "", kind: "value", before: "" } }
  }
  let s = await drive(newState("t10", "x", "en", MAP.url), x)
  assert.equal(s.undo.length, 1)
  s = await answer(s, x, "yes")
  assert.equal(s.undo.length, 0)
})

test("an answer the code refused twice ends the task with an error, not an empty question", async () => {
  const x = io([{ ok: true, call: { tool: "ask_user", question: "", why: "no saved detail" }, verdict: { cls: "blocked", reason: "bad_call" }, target: null }])
  const s = await drive(newState("t11", "x", "en", MAP.url), x)
  assert.equal(s.status, "error")
  assert.equal(s.error, "bad_call")
})

test("a menu the last press opened isn't pressed again (it would close): the model hears to choose from its list", async () => {
  const open: PageMap = { ...MAP, items: [{ id: "6", role: "button", label: "Colour Black", state: ["expanded"] }, { id: "7", role: "option", label: "Red" }] }
  const x = io([
    step({ tool: "click", id: "6", why: "open the colours" }, "free", "click"),
    step({ tool: "click", id: "6", why: "open the colours" }, "free", "click"),
    step({ tool: "click", id: "7", why: "red" }, "free", "click"),
    step({ tool: "done", summary: "ok" }, "free", "read")
  ], [], open)
  const s = await drive(newState("t1", "red colour", "en", MAP.url), x)
  assert.equal(s.status, "done")
  assert.deepEqual(x.acted.map((c) => c.id), ["6", "7"])
  assert.match(s.log.find((l) => l.result.startsWith("refused"))?.result ?? "", /is open now/)
})

test("a control the page shows disabled (the model's call refused on it) waits and reads again, twice, before the task ends", async () => {
  const bad = (): ActReply => ({ ok: true, call: { tool: "ask_user", question: "", why: "element 2 is disabled" }, verdict: { cls: "blocked", reason: "bad_call" }, target: null })
  const x = io([bad(), step({ tool: "click", id: "5", why: "more" }, "free", "click"), step({ tool: "done", summary: "ok" }, "free", "read")])
  const s = await drive(newState("t1", "add", "en", MAP.url), x)
  assert.equal(s.status, "done")
  const y = io([bad(), bad(), bad()])
  const t = await drive(newState("t2", "add", "en", MAP.url), y)
  assert.equal(t.status, "error")
  assert.equal(t.error, "bad_call")
})
