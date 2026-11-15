// Calendar and Reminders in the panel (2.7): «Также в Напоминания» puts a message's reminder into Apple Reminders as well
// (moved with its time, taken back with it), and when only the app can ask for access, the link is followed in the
// tap itself (iPhone, iPad). The extension's native side is a stand-in here (`send`).
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let M: any
let sent: Array<Record<string, any>> = []
let replies: Record<string, unknown> = {}
let followed: string[] = []

const send = async (message: Record<string, any>) => {
  sent.push(message)
  return (replies[message.type] ?? null) as any
}

before(async () => {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>")
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  ;(globalThis as any).chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    runtime: { sendMessage: (m: Record<string, any>, cb?: (r: unknown) => void) => { void send(m).then((r) => cb?.(r)) }, lastError: undefined },
    storage: { local: { get: async () => ({}), set: async () => undefined } }
  }
  // followLink clicks a link: what it opens is noted.
  const click = window.HTMLElement.prototype.click
  window.HTMLElement.prototype.click = function (this: any) {
    if (this.tagName === "A") followed.push(this.getAttribute("href"))
    else click?.call(this)
  }
  const dir = mkdtempSync(join(tmpdir(), "cf-apple-"))
  const out = join(dir, "apple.mjs")
  await build({
    stdin: { contents: `export { scheduleReminder } from "./src/content/ux/useMessageUx"; export * from "./src/content/ux/apple"; export { AddCard } from "./src/content/ux/AddCard"; export { h, render } from "preact"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact",
    mainFields: ["module", "main"], loader: { ".tsx": "tsx" }, define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.7.0"', __TARGET__: '"safari"' }
  })
  M = await import(pathToFileURL(out).href)
})

beforeEach(() => {
  sent = []
  followed = []
  replies = { remind: { outcome: "scheduled" }, appleAdd: { outcome: "saved" } }
})

const AT = new Date(2026, 10, 20, 9, 0).getTime()
const answer = { role: "assistant", id: "msg1", t: 1, content: "Book the hotel in **Sochi** before the prices go up." }
const note = { role: "user", id: "note1", t: 2, note: true, content: "Check-in rules", page: { url: "https://hotel.example/rules", title: "Rules", at: 1 } }

test("«Также в Напоминания» on: the reminder goes into Apple Reminders too, under its key, at the same wall-clock time", async () => {
  assert.equal(await M.scheduleReminder(send, "chat1", answer, AT, "Trip", true), "scheduled")
  const add = sent.find((m) => m.type === "appleAdd")!
  assert.equal(add.key, "cf.remind.chat1.msg1")
  assert.deepEqual(add.item, { kind: "reminder", title: "Book the hotel in Sochi before the prices go up.", confidence: "sure", date: "2026-11-20", time: "09:00" })
  assert.equal(add.notes, "contextflow://chat?id=chat1&m=msg1")
  // A note on a page: its page in the notes, before the link back.
  await M.scheduleReminder(send, "chat1", note, AT, "", true)
  const second = sent.filter((m) => m.type === "appleAdd")[1]
  assert.equal(second.notes, "Rules\nhttps://hotel.example/rules\n\ncontextflow://chat?id=chat1&m=note1")
  assert.equal(second.url, "https://hotel.example/rules")
  assert.ok(sent.some((m) => m.type === "useEvent" && m.f === "apple" && m.a === "added" && m.via === "remind"))
})

test("off: nothing goes to Apple Reminders; notifications off but Reminders on still counts as set", async () => {
  await M.scheduleReminder(send, "chat1", answer, AT, "Trip", false)
  assert.ok(!sent.some((m) => m.type === "appleAdd" || m.type === "appleRemove"))
  replies.remind = { outcome: "denied" }
  assert.equal(await M.scheduleReminder(send, "chat1", answer, AT, "Trip", true), "scheduled")
  replies.appleAdd = { outcome: "denied" }
  assert.equal(await M.scheduleReminder(send, "chat1", answer, AT, "Trip", true), "denied")
})

test("a reminder that's in Apple Reminders: moved with its time, taken back with it, put back after an undo", async () => {
  const mirrored = { ...answer, remind: { at: AT, apple: true } }
  await M.scheduleReminder(send, "chat1", mirrored, null, "")
  assert.deepEqual(sent.filter((m) => m.type === "appleRemove").map((m) => m.key), ["cf.remind.chat1.msg1"])
  sent = []
  // Undo (no choice given): back where it was.
  await M.scheduleReminder(send, "chat1", mirrored, AT, "Trip")
  assert.equal(sent.filter((m) => m.type === "appleAdd").length, 1)
  sent = []
  // The window's box unticked while changing its time: out of Apple Reminders.
  await M.scheduleReminder(send, "chat1", mirrored, AT + 3_600_000, "Trip", false)
  assert.equal(sent.filter((m) => m.type === "appleRemove").length, 1)
  assert.equal(sent.filter((m) => m.type === "appleAdd").length, 0)
  sent = []
  // Never put there: cancelling touches nothing.
  await M.scheduleReminder(send, "chat1", answer, null, "")
  assert.ok(!sent.some((m) => m.type === "appleRemove"))
})

test("iPhone without access yet: the tap opens the app on a new id, and the reminder follows it there", async () => {
  replies.appleStatus = { available: true, platform: "ios", reminders: "none", events: "editor" }
  await M.loadApple(send)
  const id = M.handoffInTap("reminder")
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(followed, [`contextflow://add?id=${id}`])
  replies.appleAdd = { outcome: "app" }
  assert.equal(await M.scheduleReminder(send, "chat1", answer, AT, "Trip", true), "scheduled")
  assert.equal(sent.find((m) => m.type === "appleAdd")!.handoff, id)
  // Once: the next one isn't handed over by mistake.
  assert.equal(M.takeHandoff(), undefined)
  // With access, or on a Mac (the extension opens the app itself), nothing is followed in the tap.
  followed = []
  replies.appleStatus = { available: true, platform: "ios", reminders: "write", events: "editor" }
  await M.loadApple(send)
  assert.equal(M.handoffInTap("reminder"), undefined)
  assert.equal(M.addWay(M.appleNow(), "event"), "app", "events on iPhone: the system's editor in the app")
  replies.appleStatus = { available: true, platform: "macos", reminders: "none", events: "none" }
  await M.loadApple(send)
  assert.equal(M.handoffInTap("event"), undefined)
  assert.deepEqual(followed, [])
  replies.appleStatus = { available: true, platform: "macos", reminders: "denied", events: "write" }
  await M.loadApple(send)
  assert.equal(M.addWay(M.appleNow(), "reminder"), "denied")
  assert.equal(M.addWay(M.appleNow(), "event"), "write")
  // iOS 16, macOS 13, Chrome: nothing at all.
  replies.appleStatus = { available: false }
  await M.loadApple(send)
  assert.equal(M.addWay(M.appleNow(), "reminder"), null)
  replies.appleStatus = null
  assert.deepEqual(await M.loadApple(send), { available: false })
})

test("usage names: an Add's outcome as the registry has it", () => {
  assert.equal(M.appleAction("saved"), "added")
  assert.equal(M.appleAction("not-asked"), "not_asked")
  assert.equal(M.appleAction("app"), "app")
})

test("the card: what, when and where; a guess and a past time said; Add only when it can be added", () => {
  const box = (globalThis as any).document.createElement("div")
  const status = { available: true, platform: "ios", reminders: "write", events: "editor", lists: [{ id: "L1", title: "Home" }, { id: "L2", title: "Work" }], defaultList: "L2" }
  const items = [
    { kind: "reminder", title: "Book the hotel", date: "2099-11-20", confidence: "guess" },
    { kind: "event", title: "Flight SU 1234", date: "2099-03-14", time: "10:40", tz: "America/Los_Angeles", location: "SVO", confidence: "sure" },
    { kind: "event", title: "Old", date: "2020-01-01", time: "10:00", confidence: "sure" },
    { kind: "event", title: "No date yet", confidence: "sure" }
  ]
  M.render(M.h(M.AddCard, { card: { step: "ready", items }, status, onChange: () => {}, onAdd: () => {}, onRetry: () => {}, onClose: () => {} }), box)
  const rows = box.querySelectorAll(".cf-add-item")
  assert.equal(rows.length, 4)
  assert.equal(rows[0].querySelector(".cf-add-title").value, "Book the hotel")
  assert.equal(rows[0].querySelector('input[type="date"]').value, "2099-11-20")
  assert.ok(rows[0].querySelector(".cf-add-when").className.includes("guess"))
  assert.equal(rows[0].querySelector("option[selected]").getAttribute("value"), "L2", "the default list chosen")
  assert.equal(rows[1].querySelector(".cf-add-zone").textContent, "Los Angeles")
  assert.ok(rows[1].textContent.includes("SVO"))
  assert.ok(rows[2].querySelector(".cf-add-warn"), "a time already past is said")
  assert.equal(rows[0].querySelector(".cf-add-go").disabled, false)
  assert.equal(rows[3].querySelector(".cf-add-go").disabled, true, "an event needs a date")
  // No access to Reminders: said, and Add is off.
  M.render(M.h(M.AddCard, { card: { step: "ready", items: [items[0]] }, status: { ...status, reminders: "denied", lists: undefined }, onChange: () => {}, onAdd: () => {}, onRetry: () => {}, onClose: () => {} }), box)
  assert.equal(box.querySelector(".cf-add-go").disabled, true)
  assert.ok(box.querySelector(".cf-add-warn"))
  // Added: no button any more.
  M.render(M.h(M.AddCard, { card: { step: "ready", items: [{ ...items[0], state: "saved" }] }, status, onChange: () => {}, onAdd: () => {}, onRetry: () => {}, onClose: () => {} }), box)
  assert.equal(box.querySelector(".cf-add-go"), null)
  assert.ok(box.querySelector(".cf-add-ok"))
})
