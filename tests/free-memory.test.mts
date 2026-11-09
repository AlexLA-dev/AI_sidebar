// Build 92, the owner: «на бесплатном плане до 5 сообщений из чата (без учета наших вопросов, но с учетом наших
// заметок)». A free answer remembers the last 5 answers and notes; the questions come with their answers, and the one
// asked now always goes. The same on the server, whatever an older panel sends.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

const { FREE_MEMORY, historyForModel, lastCounted } = await import("../src/shared/conversation.ts")
const { freeMemory } = await import("../netlify/shared/llm.mts")
type Entry = import("../src/shared/conversation.ts").Entry

const q = (n: number): Entry => ({ role: "user", content: `Q${n}` })
const a = (n: number): Entry => ({ role: "assistant", content: `A${n}` })
const note = (n: number): Entry => ({ role: "user", content: `N${n}`, note: true })

test("five answers and notes, with their questions and the question asked now", () => {
  assert.equal(FREE_MEMORY, 5)
  const chat = [q(1), a(1), note(1), q(2), a(2), q(3), a(3), q(4), a(4), q(5), a(5), q(6), a(6), q(7)]
  const counts = (e: Entry) => e.role === "assistant" || Boolean(e.note)
  assert.deepEqual(lastCounted(chat, counts).map((e) => e.content), ["Q2", "A2", "Q3", "A3", "Q4", "A4", "Q5", "A5", "Q6", "A6", "Q7"])
  // A note counts like an answer.
  const withNote = [q(1), a(1), q(2), a(2), q(3), a(3), note(9), q(4), a(4), q(5), a(5), q(6)]
  assert.deepEqual(lastCounted(withNote, counts).map((e) => e.content), ["Q2", "A2", "Q3", "A3", "N9", "Q4", "A4", "Q5", "A5", "Q6"])
  // A short chat: all of it.
  assert.deepEqual(lastCounted([q(1), a(1), q(2)], counts).map((e) => e.content), ["Q1", "A1", "Q2"])
})

test("the panel sends a free chat that way, the notes marked as notes; Pro without memory keeps the last messages", () => {
  const chat = [q(1), a(1), q(2), a(2), note(3), q(4), a(4), q(5), a(5), q(6), a(6), q(7), a(7), q(8)]
  const free = historyForModel(chat, "https://x.example", false, true)
  // A7, A6, A5, A4 and the note: the note is one of the five.
  assert.deepEqual(free.map((t) => t.content.split("\n").pop()), ["N3", "Q4", "A4", "Q5", "A5", "Q6", "A6", "Q7", "A7", "Q8"])
  const withNote = historyForModel([q(1), a(1), note(2), q(3), a(3), q(4)], "https://x.example", false, true)
  assert.match(withNote[2].content, /^\[Note the user wrote\]\nN2$/)
  // Not free, memory off: the last 12 messages without notes, as before.
  assert.equal(historyForModel(chat, "https://x.example").length, 12)
})

test("the server keeps the same for free, notes known by their mark", () => {
  const msgs = [
    { role: "user" as const, content: "Q1" }, { role: "assistant" as const, content: "A1" },
    { role: "user" as const, content: "[Note the user wrote]\nN1" },
    { role: "user" as const, content: "Q2" }, { role: "assistant" as const, content: "A2" },
    { role: "user" as const, content: "Q3" }, { role: "assistant" as const, content: "A3" },
    { role: "user" as const, content: "Q4" }, { role: "assistant" as const, content: "A4" },
    { role: "user" as const, content: "Q5" }, { role: "assistant" as const, content: "A5" },
    { role: "user" as const, content: "Q6" }
  ]
  assert.deepEqual(freeMemory(msgs).map((m) => m.content), ["[Note the user wrote]\nN1", "Q2", "A2", "Q3", "A3", "Q4", "A4", "Q5", "A5", "Q6"])
})
