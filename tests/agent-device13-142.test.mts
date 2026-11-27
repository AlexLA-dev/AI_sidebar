// Round 142, the director's decision 13: three device rules, no guard narrowed.
// 13a: a cookie layer the product's closer left is refused by the device by its own «reject» control (never an accept).
// 13b: a question asking leave to use a contact the person gave is sent back once a task.
// 13c: the press that sends a booking while a contact the person gave is still empty is sent back once per field.
import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { asciiDigits, contactGiven, contactsQuoted, drive, emptyGivenField, newState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { AGENT_RULES } from "../src/shared/usage.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const run = async (maps: PageMap[], calls: Array<Record<string, unknown>>, request: string, verdict = { cls: "free", reason: "click" }) => {
  const acted: ToolCall[] = []
  const replies = calls.map((call) => ({ ok: true, call: { why: "", ...call } as unknown as ToolCall, verdict }))
  let n = 0
  const io: RunnerIO = {
    map: async () => maps[Math.min(n, maps.length - 1)],
    act: async (c: ToolCall) => { acted.push(c); n++; return { ok: true } },
    waitPage: async () => {},
    ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 12, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  const st = newState("t13", request, "en", maps[0].url)
  return { st: await drive(st, io), acted }
}
const page = (items: PageMap["items"], over: Partial<PageMap> = {}): PageMap => ({ url: "https://tables.example/book", title: "Book", lang: "en", more: 0, part: 1, parts: 1, forms: [], text: "Book a table", items, ...over }) as PageMap

test("the new rule codes are in the end event's list", () => {
  for (const code of ["cookie_device", "given_ask", "contact_empty"]) assert.ok((AGENT_RULES as readonly string[]).includes(code), code)
})

// 13a
const BANNER = (labels: string[]) => page([...labels.map((label, i) => ({ id: `c${i}`, role: "button", label, where: "dialog" })), { id: "9", role: "button", label: "Book" }] as PageMap["items"], { consent: true, text: "We use cookies to improve your experience. Book a table" })
const CLEAN = page([{ id: "9", role: "button", label: "Book" }] as PageMap["items"])

test("13a: the device presses the layer's «reject» itself, logs it and reads the page again", async () => {
  const { st, acted } = await run([BANNER(["Accept all", "Reject all"]), CLEAN], [], "Book a table for 2")
  assert.equal(acted[0]?.id, "c1", "«Reject all» pressed first, by the device")
  assert.match(st.log[0].result ?? "", /the device refused optional cookies itself: «Reject all»/)
  assert.equal(st.ruleCounts?.cookie_device, 1)
})

test("13a: in other languages too («Только необходимые», «すべて拒否», «رفض الكل»)", async () => {
  for (const reject of ["Только необходимые", "Alle ablehnen", "すべて拒否", "رفض الكل"]) {
    const { acted } = await run([BANNER(["Accept", reject]), CLEAN], [], "Book a table for 2")
    assert.equal(acted[0]?.id, "c1", reject)
  }
})

test("13a: an accept-only banner is never pressed by the device; nor a reject outside a consent layer", async () => {
  const { st, acted } = await run([BANNER(["Accept all", "Got it"])], [], "Book a table for 2")
  assert.ok(!acted.some((c) => c.id === "c0" || c.id === "c1"), "nothing pressed")
  assert.equal(st.ruleCounts?.cookie_device, undefined)
  const plain = page([{ id: "c1", role: "button", label: "Reject all", where: "dialog" }, { id: "9", role: "button", label: "Book" }] as PageMap["items"], { text: "Choose a time" })
  assert.equal((await run([plain], [], "Book a table for 2")).acted.length, 0)
})

test("13a: once per page address — a banner the press didn't close is left to the model", async () => {
  const { st, acted } = await run([BANNER(["Accept all", "Reject all"])], [], "Book a table for 2")
  assert.equal(acted.filter((c) => c.id === "c1").length, 1)
  assert.equal(st.ruleCounts?.cookie_device, 1)
})

test("13a: at most three a task", async () => {
  const many = [0, 1, 2, 3, 4].map((i) => ({ ...BANNER(["Reject all"]), url: `https://tables.example/p${i}` }))
  const { st } = await run(many, [], "Book a table for 2")
  assert.equal(st.ruleCounts?.cookie_device, 3)
})

// 13b
test("13b: contacts quoted by pattern — e-mails, 7+ digits in any script, never dates or short numbers", () => {
  assert.deepEqual(contactsQuoted("Please confirm +44 20 7946 0000 so I can type it."), [{ kind: "phone", value: "+44 20 7946 0000" }])
  assert.deepEqual(contactsQuoted("Use anna@example.com?"), [{ kind: "email", value: "anna@example.com" }])
  assert.deepEqual(contactsQuoted("电话号码 +81 3-1234-5678 を入力してよろしいですか？").map((c) => c.kind), ["phone"])
  assert.deepEqual(contactsQuoted("هل أستخدم الرقم +٩٧١ ٤ ١٢٣ ٤٥٦٧؟").map((c) => c.kind), ["phone"])
  assert.deepEqual(contactsQuoted("On 2026-12-05 at 19:30 for 4 people, or 05.12.2026?"), [])
  assert.equal(asciiDigits("+٩٧١ ٤ ١٢٣"), "+971 4 123")
})

test("13b: given means the person's words (any digits' script) or a live saved entry", () => {
  const ph = (value: string) => ({ kind: "phone" as const, value })
  assert.ok(contactGiven(ph("+44 20 7946 0000"), "Book for Anna Petrova, phone +44 20 7946 0000.", []))
  assert.ok(contactGiven(ph("+7 495 123-45-67"), "Забронируй, телефон +7 495 123-45-67", []))
  assert.ok(contactGiven(ph("+81 3-1234-5678"), "名前はアンナ・ペトロワ、電話 +81 3-1234-5678。", []))
  assert.ok(contactGiven(ph("+971 4 123 4567"), "الهاتف +٩٧١ ٤ ١٢٣ ٤٥٦٧", []), "Arabic-Indic digits in the request")
  assert.ok(contactGiven(ph("+971 4 123 4567"), "احجز", [{ key: "tel", label: "Phone", value: "+971 4 123 4567" } as never]), "a saved entry")
  assert.ok(contactGiven({ kind: "email", value: "anna@example.com" }, "почта anna@example.com", []))
  assert.ok(!contactGiven(ph("+44 20 7946 1111"), "phone +44 20 7946 0000", []), "another number")
})

const FORM = page([{ id: "1", role: "textbox", label: "Name", value: "Anna Petrova" }, { id: "2", role: "textbox", label: "Phone", type: "tel", lock: "personal", state: ["empty"] }, { id: "3", role: "button", label: "Book" }] as PageMap["items"])

test("13b: «please confirm the phone you gave» is sent back once; a second such question goes to the person", async () => {
  const ask = { tool: "ask_user", question: "Phone number for the booking: please confirm +44 20 7946 0000 so I can type it into the Phone field." }
  const { st } = await run([FORM], [ask, ask], "Book a table for 2 on 4 December at 18:30. Name Anna Petrova, phone +44 20 7946 0000.")
  assert.match(st.log.find((l) => /^refused: the person gave/.test(l.result ?? ""))?.result ?? "", /«\+44 20 7946 0000» themselves: type it as written/)
  assert.equal(st.ruleCounts?.given_ask, 1)
  assert.equal(st.status, "asked", "the second one reached the person")
})

test("13b: in Japanese, Russian and Arabic requests", async () => {
  for (const [request, question] of [
    ["2026年12月4日18:30に予約して。名前はアンナ・ペトロワ、電話 +81 3-1234-5678。", "電話番号が保存されていないため、+81 3-1234-5678 を入力してよろしいですか？"],
    ["Забронируй на 4 декабря в 18:30. Имя Анна Петрова, телефон +7 495 123-45-67.", "Подтвердите, пожалуйста, телефон +7 495 123-45-67?"],
    ["احجز يوم 4 ديسمبر الساعة 18:30. الاسم آنا بيتروفا، الهاتف +٩٧١ ٤ ١٢٣ ٤٥٦٧.", "هل أكتب رقم الهاتف +971 4 123 4567؟"]
  ]) {
    const { st } = await run([FORM], [{ tool: "ask_user", question }], request)
    assert.equal(st.ruleCounts?.given_ask, 1, `${request} ${JSON.stringify(st.log.map((l) => l.result))} ${st.status} ${st.summary}`)
  }
})

test("13b: detail-missing still ends in the question; a question with no contact passes", async () => {
  const { st } = await run([FORM], [{ tool: "ask_user", question: "What phone number should I use for the booking?" }], "Book a table for 2 on 4 December at 18:30. Name Anna Petrova.")
  assert.equal(st.status, "asked")
  assert.equal(st.ruleCounts?.given_ask, undefined)
  const other = await run([FORM], [{ tool: "ask_user", question: "Should I use +44 20 7946 9999 instead?" }], "Book a table, phone +44 20 7946 0000.")
  assert.equal(other.st.status, "asked", "a number the person didn't give is a real question")
})

// 13c
const given = (kinds: string[]) => new Set(kinds)
test("13c: the first empty contact field of a kind the person gave (locked fields by their state)", () => {
  assert.equal(emptyGivenField(FORM, given(["phone"]), [])?.item.id, "2")
  assert.equal(emptyGivenField(FORM, given(["email"]), []), null, "no e-mail field here")
  assert.equal(emptyGivenField(FORM, given(["phone"]), ["2"]), null, "once per field")
  const filled = page([{ id: "2", role: "textbox", label: "Phone", type: "tel", lock: "personal", state: ["filled"] }] as PageMap["items"])
  assert.equal(emptyGivenField(filled, given(["phone"]), []), null)
  const nameEmpty = page([{ id: "1", role: "textbox", label: "Name", value: "" }] as PageMap["items"])
  assert.equal(emptyGivenField(nameEmpty, given(["phone", "email"]), []), null, "a name only when the plan lists a typed name")
  assert.equal(emptyGivenField(nameEmpty, given(["name"]), [])?.kind, "name")
})

const RU_FORM = page([
  { id: "1", role: "textbox", label: "Имя", value: "Анна Петрова" }, { id: "2", role: "textbox", label: "Телефон", type: "tel", lock: "personal", state: ["filled"] },
  { id: "3", role: "textbox", label: "Электронная почта", type: "email", lock: "personal", state: ["empty"] }, { id: "4", role: "button", label: "Забронировать" }
] as PageMap["items"], { lang: "ru", forms: [{ n: 1, fillable: true }] as PageMap["forms"] })

test("13c: «Забронировать» with the e-mail the request gave still empty is sent back once; the second press goes on", async () => {
  const press = { tool: "click", id: "4" }
  const { st } = await run([RU_FORM], [press, press], "Забронируй столик на 4 на 5 декабря 19:30. Имя Анна Петрова, телефон +7 495 123-45-67, почта anna@example.com.", { cls: "confirm", reason: "submit" })
  const refused = st.log.filter((l) => /^refused: «Электронная почта» is still empty and the person gave their email/.test(l.result ?? ""))
  assert.equal(refused.length, 1)
  assert.equal(st.ruleCounts?.contact_empty, 1)
  assert.ok(st.pending || st.status === "confirm" || st.log.length > 1, "the second press went on to its own class (a card)")
})

test("13c: saved details alone, or a contact the person didn't give, never trigger it", async () => {
  const press = { tool: "click", id: "4" }
  const { st } = await run([RU_FORM], [press], "Забронируй столик на 4 на 5 декабря 19:30. Имя Анна Петрова, телефон +7 495 123-45-67.", { cls: "confirm", reason: "submit" })
  assert.equal(st.ruleCounts?.contact_empty, undefined)
  // Arabic-Indic digits for the phone, the phone field empty: it counts as given.
  const ar = page([{ id: "2", role: "textbox", label: "الهاتف", type: "tel", lock: "personal", state: ["empty"] }, { id: "4", role: "button", label: "احجز" }] as PageMap["items"], { lang: "ar" })
  const r = await run([ar], [press], "احجز طاولة. الهاتف +٩٧١ ٤ ١٢٣ ٤٥٦٧.", { cls: "confirm", reason: "submit" })
  assert.equal(r.st.ruleCounts?.contact_empty, 1)
})
