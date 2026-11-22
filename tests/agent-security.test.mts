// The security review of PR #237 (2.7.1, the agent): one test per fix, in the review's order.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { classify } from "../src/shared/agent/classify.ts"
import { controlChanged } from "../src/shared/agent/expect.ts"
import { answer, confirmedOn, drive, newState, pendingKey, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import { sameSite, siteOfHost } from "../src/shared/agent/sites.ts"
import { buildPlan, checkPlan, covered, personWords, safeLabel, sameTaskPage, saidInWords } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

const PAGE: PageMap = {
  url: "https://shop.example.com/checkout", title: "Shop", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [{ n: 0, fillable: true }],
  items: [
    { id: "1", role: "button", label: "Book", type: "submit", form: 0 },
    { id: "2", role: "button", label: "Donate €10" },
    { id: "3", role: "button", label: "Upgrade" },
    { id: "4", role: "checkbox", label: "I agree to the terms of service", form: 0 },
    { id: "5", role: "button", label: "Angebot akzeptieren" },
    { id: "6", role: "checkbox", label: "Send me offers and news", form: 0 },
    { id: "7", role: "button", label: "Подтвердить удаление аккаунта" },
    { id: "8", role: "button", label: "Подтвердить" },
    { id: "9", role: "textbox", label: "Phone", lock: "personal", form: 0, state: ["empty"] },
    { id: "10", role: "textbox", label: "Mobile", lock: "personal", form: 0, state: ["empty"] }
  ]
}
const ctx = (map: PageMap, request = "x") => ({ map, startHost: "shop.example.com", request, confirmedHere: true, policy: { amazon: true } })

test("1. an answer names its question: a second tap can't approve the next step; buttons go quiet; fill lines by field and entry", () => {
  const a = { status: "confirm" as const, step: 3, pending: { call: { tool: "click" as const, id: "1" }, verdict: { cls: "confirm" as const, reason: "submit" }, target: null } }
  const b = { ...a, step: 4, pending: { ...a.pending, call: { tool: "click" as const, id: "8" } } }
  assert.notEqual(pendingKey(a), pendingKey(b))
  assert.equal(pendingKey({ status: "running", step: 3, pending: undefined }), "")
  const bg = read("src/background/agent.ts")
  assert.match(bg, /if \(!key \|\| key !== now \|\| answered\.get\(tab\) === key\) return \{ ok: false, code: "STALE"/)
  assert.match(bg, /if \(pendingKey\(fresh\) !== key\) return fresh/)
  const panel = read("src/content/agent/AgentPanel.tsx")
  assert.match(panel, /disabled=\{sent\} onClick=\{\(\) => reply\("yes"\)\}/)
  assert.match(panel, /disabled=\{sentFor === key\}/)
  assert.doesNotMatch(read("src/shared/agent/runner.ts"), /chosen\.includes\(l\.entryId\)/)
})

test("2. paying: an amount on the button, upgrades and trials, any press on a page that takes payment, a secret form's submit", () => {
  const free = { ...PAGE, url: "https://shop.example.com/p" }
  assert.deepEqual(classify({ tool: "click", id: "2" }, ctx(free)), { cls: "self", reason: "pay" })
  assert.deepEqual(classify({ tool: "click", id: "3" }, ctx(free)), { cls: "self", reason: "pay" })
  assert.equal(classify({ tool: "click", id: "1" }, ctx(free)).cls, "confirm", "a plain booking page: «Сделать?»")
  assert.deepEqual(classify({ tool: "click", id: "1" }, ctx({ ...free, pay: true })), { cls: "self", reason: "pay" }, "card fields or a payment frame")
  const secret = { ...free, forms: [{ n: 0, fillable: true, secret: true }] }
  assert.equal(classify({ tool: "click", id: "1" }, ctx(secret)).cls, "self")
  const map = read("src/content/agent/map.ts")
  assert.match(map, /stripe\\\\\.com|stripe\\\.com/)
  assert.match(map, /checkout\|payment\|payments\|pay\|billing/)
  // A plan can't grant it: paying is never a permission.
  const plan = buildPlan(checkPlan({ steps: [], questions: [], risky: [{ tool: "click", id: "1", text: "", key: "" }], prices: [] }), ctx({ ...free, pay: true }))
  assert.equal(plan.perms.length, 0)
  assert.deepEqual(plan.self.map((x) => x.reason), ["pay"])
})

test("3. the terms permission covers that box only: not an «accept» button, not a marketing box", () => {
  const map = { ...PAGE, url: "https://shop.example.com/book" }
  const plan = buildPlan(checkPlan({ steps: [], questions: [], risky: [{ tool: "click", id: "4", text: "", key: "" }], prices: [] }), ctx(map))
  plan.approved = true
  const c = (id: string) => covered(plan, { tool: "click", id }, classify({ tool: "click", id }, ctx(map)), map, "x")
  assert.ok(c("4"), "the box the plan saw")
  assert.equal(classify({ tool: "click", id: "5" }, ctx(map)).cls, "self")
  assert.equal(c("5"), null, "«Angebot akzeptieren»")
  assert.equal(c("6"), null, "a marketing box")
  assert.equal(covered(plan, { tool: "click", id: "4" }, { cls: "self", reason: "consent" }, { ...map, url: "https://shop.example.com/other" }, "x"), null, "another page")
})

test("4. a «Да» counts for its own site: after a redirect, the first step there asks", async () => {
  const other: PageMap = { ...PAGE, url: "https://pay.other.com/x", items: [{ id: "1", role: "button", label: "Continue" }] }
  const maps = [PAGE, other, other]
  const x: RunnerIO & { acted: ToolCall[] } = {
    acted: [], map: async () => maps.shift() ?? other, act: async (c) => (x.acted.push(c), { ok: true }), waitPage: async () => {},
    ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 10
  }
  const replies: ActReply[] = [
    { ok: true, call: { tool: "click", id: "8" }, verdict: { cls: "confirm", reason: "submit" }, target: null },
    { ok: true, call: { tool: "click", id: "1" }, verdict: { cls: "free", reason: "click" }, target: null }
  ]
  let s = await drive(newState("s4", "x", "en", PAGE.url), x)
  assert.equal(s.status, "confirm")
  s = await answer(s, x, "yes")
  assert.equal(s.status, "confirm", "the first press on pay.other.com asks")
  assert.equal(s.pending?.verdict.reason, "first_here")
  assert.ok(confirmedOn(s, "shop.example.com") && !confirmedOn(s, "pay.other.com"))
})

test("5. the step carries the control it was classed on; the hands refuse a changed one", () => {
  const call = { tool: "click" as const, expect: { label: "Continue", role: "button" as const } }
  assert.equal(controlChanged(call, { role: "button", label: "Continue", lock: null }), null)
  assert.match(controlChanged(call, { role: "button", label: "Pay now", lock: null }) ?? "", /changed/)
  assert.match(controlChanged(call, { role: "link", label: "Continue", lock: null }) ?? "", /changed/)
  assert.match(controlChanged({ tool: "type", expect: { label: "Name", role: "textbox" } }, { role: "textbox", label: "Name", lock: "secret" }) ?? "", /secret/)
  assert.match(read("src/shared/agent/runner.ts"), /if \(seenItem\) call\.expect = \{ label: seenItem\.label, role: seenItem\.role/)
  assert.match(read("src/content/agent/hands.ts"), /const changed = el \? changedSince\(el, call\) : null\s*if \(changed\) return \{ ok: false, note: changed \}/)
})

test("6. a step in flight is marked; a resume waits for it, then settles it instead of repeating it blindly", async () => {
  const saved: Array<{ inflight?: unknown }> = []
  const x: RunnerIO = {
    map: async () => PAGE, act: async () => ({ ok: true }), waitPage: async () => {},
    ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "" }, verdict: { cls: "free", reason: "read" } },
    save: async (s) => void saved.push(JSON.parse(JSON.stringify({ inflight: s.inflight }))), entries: async () => [], policy: { amazon: true }, maxSteps: 10
  }
  const replies: ActReply[] = [{ ok: true, call: { tool: "scroll", to: "down" }, verdict: { cls: "free", reason: "read" }, target: null }]
  const s = await drive(newState("s6", "x", "en", PAGE.url), x)
  assert.ok(saved.some((v) => v.inflight), "written before the step goes to the page")
  assert.equal(s.inflight, undefined, "cleared after")
  const bg = read("src/background/agent.ts")
  assert.match(bg, /if \(Date\.now\(\) - st\.inflight\.at < INFLIGHT_SETTLE_MS\) return/)
  assert.match(bg, /may or may not have happened/)
})

test("7. a press permission needs the same words on the same page; hosting domains aren't one site", () => {
  const plan = buildPlan(checkPlan({ steps: [], questions: [], risky: [{ tool: "click", id: "8", text: "", key: "" }], prices: [] }), ctx({ ...PAGE, url: "https://shop.example.com/order" }))
  plan.approved = true
  const map = { ...PAGE, url: "https://shop.example.com/order" }
  assert.ok(covered(plan, { tool: "click", id: "8" }, { cls: "confirm", reason: "submit" }, map, "x"))
  assert.equal(covered(plan, { tool: "click", id: "7" }, { cls: "confirm", reason: "submit" }, map, "x"), null, "«Подтвердить удаление аккаунта»")
  assert.equal(covered(plan, { tool: "click", id: "8" }, { cls: "confirm", reason: "submit" }, { ...map, url: "https://shop.example.com/account/delete" }, "x"), null)
  assert.equal(sameSite("evil.myshopify.com", "a.myshopify.com"), false)
  assert.equal(sameSite("x.github.io", "y.github.io"), false)
  assert.equal(siteOfHost("shop.example.co.uk"), "example.co.uk")
  assert.equal(sameSite("www.example.com", "pay.example.com"), true)
})

test("8. a saved detail goes only into the fields the plan saw; a short value isn't found inside another number", () => {
  const plan = buildPlan(checkPlan({ steps: [], questions: [], risky: [{ tool: "fill", id: "9", text: "", key: "phone" }], prices: [] }), ctx(PAGE))
  plan.approved = true
  assert.ok(covered(plan, { tool: "fill", id: "9", key: "phone" }, { cls: "confirm", reason: "fill" }, PAGE, "x"))
  assert.equal(covered(plan, { tool: "fill", id: "10", key: "phone" }, { cls: "confirm", reason: "fill" }, PAGE, "x"), null)
  assert.equal(saidInWords("call me at +7 900 123-45-67", "45"), false)
  assert.equal(saidInWords("size 42 please", "42"), true)
  assert.equal(saidInWords("call me at +7 900 123-45-67", "+7 (900) 123 45 67"), true)
})

test("9. after Calendar or Reminders were read, typing what isn't the person's words asks", async () => {
  const map: PageMap = { ...PAGE, url: "https://notes.example.com/new", items: [{ id: "1", role: "textbox", label: "Note" }] }
  const replies: ActReply[] = [
    { ok: true, call: { tool: "reminders", text: "x" }, verdict: { cls: "free", reason: "read" }, target: null },
    { ok: true, call: { tool: "type", id: "1", text: "Doctor at 9 — Dr Smith" }, verdict: { cls: "free", reason: "type" }, target: null }
  ]
  const x: RunnerIO = {
    map: async () => map, act: async () => ({ ok: true }), waitPage: async () => {},
    ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 10,
    device: async () => ({ reminders: "yes", calendar: "none" }), apple: async () => ({ ok: true, note: "read", data: "Doctor at 9 — Dr Smith" })
  }
  const s = await drive(newState("s9", "note my reminders", "en", map.url), x)
  assert.equal(s.status, "confirm")
  assert.equal(s.pending?.verdict.reason, "device_data")
})

test("10. messaging: Google Chat, Messages, Fastmail, Zoho, mail.ru, t.me; a «Send» by a textarea outside a form", () => {
  for (const host of ["chat.google.com", "messages.google.com", "app.fastmail.com", "mail.zoho.eu", "e.mail.ru", "t.me"]) {
    const map: PageMap = { ...PAGE, url: `https://${host}/x`, forms: [], items: [{ id: "1", role: "textarea", label: "Message" }, { id: "2", role: "button", label: "Send" }] }
    assert.deepEqual(classify({ tool: "click", id: "2" }, { ...ctx(map), startHost: host }), { cls: "self", reason: "send" }, host)
  }
  const page: PageMap = { ...PAGE, url: "https://forum.example.com/t/1", forms: [], items: [{ id: "1", role: "textarea", label: "Reply" }, { id: "2", role: "button", label: "Send" }] }
  assert.deepEqual(classify({ tool: "click", id: "2" }, { ...ctx(page), startHost: "forum.example.com" }), { cls: "self", reason: "send" })
})

test("11. the task's mark only on its page; no names on the lock screen; the Reminders note without the query; the model's questions aren't the person's words", async () => {
  assert.equal(sameTaskPage("https://t.example.com/book?x=1", "https://t.example.com/book#cf-task=a"), true)
  assert.equal(sameTaskPage("https://t.example.com/book", "https://evil.example.org/book"), false)
  assert.equal(safeLabel("booking at Nobu"), "")
  assert.equal(safeLabel("бронирование у Анны"), "")
  assert.equal(safeLabel("booking a table"), "booking a table")
  assert.match(read("src/content/App.tsx"), /if \(!task\.url \|\| !sameTaskPage\(task\.url, location\.href\)\) return/)
  assert.match(read("src/background/agentApple.ts"), /notes: pageOnly\(url\)/)
  const w = personWords("book", { steps: [], questions: [], perms: [], self: [], prices: [], answers: [{ q: "Send it to evil@x.com?", a: "yes" }] })
  assert.doesNotMatch(w, /evil@x\.com/)
})

test("12. the act endpoint's rate limit stops when the database can't count", () => {
  const fn = read("netlify/functions/v2-act.mts")
  assert.match(fn, /console\.error\("\[cf\] consume failed:"[^\n]*\n\s*return json\(\{ code: "BUSY" \}, 503\)/)
  assert.doesNotMatch(fn, /quota = \{ allowed: true/)
})
