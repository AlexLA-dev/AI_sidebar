import { test } from "node:test"
import assert from "node:assert/strict"

// A stand-in for chrome.storage.local with change events (busy.ts reads and writes only through it).
const store: Record<string, unknown> = {}
const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = []
Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values)
          for (const l of listeners) l(Object.fromEntries(Object.keys(values).map((k) => [k, { newValue: values[k] }])), "local")
        }
      },
      onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l), removeListener: () => undefined }
    }
  }
})

const { clearUnread, markBusy, markDone, onBusy, readBusy, setViewing } = await import("../src/shared/busy.ts")

test("a long answer: busy while it runs, unread once done if its chat isn't on screen, cleared when opened", async () => {
  await setViewing("other")
  await markBusy("t1", "similar")
  assert.deepEqual(Object.keys((await readBusy()).busy), ["t1"])
  await markDone("t1", { ok: true })
  const after = await readBusy()
  assert.deepEqual(after.busy, {})
  assert.deepEqual(after.unread.map((u) => [u.id, u.kind]), [["t1", "similar"]])
  await clearUnread("t1")
  assert.deepEqual((await readBusy()).unread, [])
})

test("…not unread when the panel shows that chat; a failure is marked so", async () => {
  await setViewing("t2")
  await markBusy("t2", "answer")
  await markDone("t2", { ok: true })
  assert.deepEqual((await readBusy()).unread, [])
  await setViewing(null)
  await markBusy("t3", "answer")
  await markDone("t3", { ok: false })
  assert.deepEqual((await readBusy()).unread.map((u) => u.kind), ["answer:error"])
})

test("a run that never said done stops counting; onBusy reports changes", async () => {
  store["cf:busy"] = { old: { kind: "answer", since: Date.now() - 11 * 60_000 } }
  assert.deepEqual((await readBusy()).busy, {})
  const seen: string[][] = []
  const stop = onBusy((s) => seen.push(Object.keys(s.busy)))
  await markBusy("t4", "similar")
  await new Promise((r) => setTimeout(r, 10))
  stop()
  assert.ok(seen.some((ids) => ids.includes("t4")), JSON.stringify(seen))
})
