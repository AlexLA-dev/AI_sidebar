// Build 94, the owner's notes on TestFlight 93: a chat's row shows the eye with how many of its pages are watched, the
// bell while a reminder in it is still to ring, and a spinner while its last question is being answered; and the chats
// an "Ask your chats" answer names are links that open them. The app has the same rules (RowMarks in Later.swift), checked
// against these at the end.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { linkChats, remindsAhead, watchesOn } from "../src/shared/chatMarks.ts"
import { stripCitations, type Entry } from "../src/shared/conversation.ts"
import { historyPrompt } from "../src/shared/history.ts"
import { ORPHAN_MS, pendingQuestion } from "../src/shared/jobs.ts"
import { toPlainText } from "../src/shared/share.ts"

const NOW = 1_800_000_000_000
const page = (url: string, at = NOW - 3_600_000) => ({ url, title: "A page", at })
const q = (content: string, extra: Partial<Entry> = {}): Entry => ({ role: "user", content, page: page("https://shop.example/item?utm_source=x#top"), ...extra })
const a = (content: string, extra: Partial<Entry> = {}): Entry => ({ role: "assistant", content, ...extra })

test("the bell: a reminder still to ring, not one that rang", () => {
  assert.equal(remindsAhead([q("Price?"), a("42 €", { remind: { at: NOW + 60_000 } })], NOW), true)
  assert.equal(remindsAhead([q("Price?"), a("42 €", { remind: { at: NOW - 60_000 } })], NOW), false)
  assert.equal(remindsAhead([q("Price?"), a("42 €")], NOW), false)
  // A note's reminder counts too.
  assert.equal(remindsAhead([{ role: "user", content: "Call them", note: true, remind: { at: NOW + 1, page: true } }], NOW), true)
})

test("the eye: watched pages of the chat, by the page's address without its hash or tracking", () => {
  const m = [q("Price?"), a("42 €"), q("Stock?", { page: page("https://shop.example/other") })]
  assert.equal(watchesOn(m, ["https://shop.example/item", "https://shop.example/other#reviews", "https://elsewhere.example/"]), 2)
  assert.equal(watchesOn(m, []), 0)
  assert.equal(watchesOn([a("Hi")], ["https://shop.example/item"]), 0)
})

test("the spinner off the device answering: a question without an answer, asked under ORPHAN_MS ago", () => {
  assert.equal(pendingQuestion([q("Similar?", { t: NOW - 5_000, similarAsk: "" })], NOW), true)
  assert.equal(pendingQuestion([q("Similar?", { t: NOW - ORPHAN_MS - 1 })], NOW), false)
  assert.equal(pendingQuestion([q("Similar?", { t: NOW - 5_000 }), a("Here")], NOW), false)
  assert.equal(pendingQuestion([{ role: "user", content: "A note", note: true, t: NOW - 5_000 }], NOW), false)
  // Without its own time, the page's (older questions).
  assert.equal(pendingQuestion([q("Why?", { page: page("https://a.example/", NOW - 10_000) })], NOW), true)
  assert.equal(pendingQuestion([], NOW), false)
})

const chats = [
  { id: "5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b", name: "Trip to Rome" },
  { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Rome" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Как выбрать ноутбук" },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", name: "Notes" }
]

test("links: the model's links to known chats stay, any other keeps just its name", () => {
  const text = "See [Trip to Rome](chat:5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b) and [Lost one](chat:ffffffff-0000-4000-8000-000000000009)."
  assert.equal(linkChats(text, chats), "See [Trip to Rome](chat:5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b) and Lost one.")
})

test("links: a chat's name written out becomes a link once, the longest names first", () => {
  const text = "In **«Trip to Rome»** (May 3) you read about the Colosseum; trip to rome again later."
  assert.equal(linkChats(text, chats), "In **«[Trip to Rome](chat:5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b)»** (May 3) you read about the Colosseum; trip to rome again later.")
  // Any case, Cyrillic, whole words only.
  assert.equal(linkChats("Чат «как выбрать ноутбук» от 2 мая.", chats), "Чат «[как выбрать ноутбук](chat:aaaaaaaa-0000-4000-8000-000000000002)» от 2 мая.")
  assert.equal(linkChats("Как выбрать ноутбуки — не тот чат.", chats), "Как выбрать ноутбуки — не тот чат.")
})

test("links: not in code, not inside a link, not for short names", () => {
  assert.equal(linkChats("`Trip to Rome` and [Trip to Rome](https://rome.example/)", chats), "`Trip to Rome` and [Trip to Rome](https://rome.example/)")
  assert.equal(linkChats("Your Notes and Rome.", chats), "Your Notes and Rome.")
  // A chat the model already linked isn't linked again by name.
  const linked = "[Trip to Rome](chat:5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b): Trip to Rome."
  assert.equal(linkChats(linked, chats), linked)
})

test("copies, shares and snippets keep a linked chat's name, not its id", () => {
  const text = "Read [Trip to Rome](chat:5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b) [1](https://rome.example/)."
  assert.equal(stripCitations(text), "Read Trip to Rome.")
  assert.equal(toPlainText(text), "Read Trip to Rome.")
})

test("the server asks for links only from clients that open them", () => {
  const digest = [{ id: "5b1e0c2a-7d4f-4c3a-9e2b-1f6a8d0c4e7b", title: "Trip to Rome", date: "2026-05-03", text: "Q: …" }]
  assert.match(historyPrompt(digest, "", "en", true), /\[Title\]\(chat:<id>\)/)
  assert.doesNotMatch(historyPrompt(digest, "", "en"), /chat:/)
})

test("the app has the same rules (RowMarks in Later.swift)", () => {
  const swift = readFileSync(new URL("../ContextFlow/Shared (App)/Later.swift", import.meta.url), "utf8")
  // The same orphan time, shortest name and link pattern.
  assert.match(swift, new RegExp(`orphan: TimeInterval = ${ORPHAN_MS / 1000}\\b`))
  assert.match(swift, /minName = 6\b/)
  assert.match(swift, /chat:\(\[A-Za-z0-9_-\]\{1,64\}\)/)
})
