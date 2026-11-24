// 2.8 (В7.1), the director's first acceptance on iPad (shot 13): «Remind me when my 5 answers are back» → the system's
// first-time question → Allow → the card said the reminder couldn't be set, with no way to try again. The question can
// outlast the panel's wait, and Safari may put the page away under it: no answer is not a failure to give up on.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { before, test } from "node:test"

import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let card: Record<string, (...args: any[]) => any>
before(async () => {
  ;(globalThis as { chrome?: unknown }).chrome = { i18n: undefined }
  const out = join(mkdtempSync(join(tmpdir(), "cf-answers-back-")), "card.mjs")
  await build({ entryPoints: [join(root, "src/content/ux/AnswersBack.tsx")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } })
  card = await import(pathToFileURL(out).href)
})

type Sent = { message: Record<string, unknown>; opts: { timeoutMs: number; tries: number } }
const sender = (replies: Array<{ outcome?: string } | null>) => {
  const sent: Sent[] = []
  const send = async (message: Record<string, unknown>, opts: Sent["opts"]) => {
    sent.push({ message, opts })
    return replies.shift() ?? null
  }
  return { sent, send }
}

test("first-time permission: the question's answer never comes back, the grant is found by asking again without it", async () => {
  const { sent, send } = sender([null, { outcome: "scheduled" }])
  const at = Date.now() + 3_600_000
  assert.equal(await card.askAnswersBack(at, 5, "https://example.com/a", true, send, 0), "scheduled")
  assert.equal(sent.length, 2)
  // The first carries the question, waits longer than the background does for it (90 s), and isn't sent twice.
  assert.deepEqual([sent[0].message.ask, sent[0].opts.tries, sent[0].opts.timeoutMs > 90_000], [true, 1, true])
  // Then without the question: the same reminder (set at most once), the same time and page.
  assert.deepEqual([sent[1].message.ask, sent[1].message.chat, sent[1].message.message, sent[1].message.at, sent[1].message.url], [false, "cf-limit", "answers-back", at, "https://example.com/a"])
})

test("an answer is taken as it is: set, notifications off, or not asked (the app's ask then)", async () => {
  for (const outcome of ["scheduled", "denied", "not-asked"]) {
    const { sent, send } = sender([{ outcome }])
    assert.equal(await card.askAnswersBack(Date.now() + 1000, 5, "https://example.com", true, send, 0), outcome)
    assert.equal(sent.length, 1)
  }
  // Nothing at all both times: failed, and the card keeps a way to try again.
  const { send } = sender([null, null])
  assert.equal(await card.askAnswersBack(Date.now() + 1000, 5, "https://example.com", true, send, 0), "failed")
  const src = readFileSync(join(root, "src/content/ux/AnswersBack.tsx"), "utf8")
  assert.match(src, /state === "failed" \? \([\s\S]{0,300}onClick=\{\(\) => void ask\(\)\}>\{t\("retry"\)\}/)
  // Back on the page after a try that got no answer: set again, without the question.
  assert.match(src, /kept\[ASKED\] !== resetsAt && stateRef\.current !== "failed"/)
})
