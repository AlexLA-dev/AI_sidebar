// 123 (found by panel-ux-271): after switching to the ContextFlow app and back (the Calendar «Разрешить» flow), the tab
// got no answers from the extension until a reload. Messages are time-boxed and sent again when they didn't arrive;
// the panel reads again when the page comes back.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

type Behaviour = "answer" | "undelivered" | "silent"
function fakeChrome(plan: Behaviour[]) {
  const sent: unknown[] = []
  const runtime = {
    lastError: undefined as undefined | { message: string },
    sendMessage(message: unknown, cb: (r: unknown) => void) {
      sent.push(message)
      const b = plan.shift() ?? "answer"
      if (b === "answer") setTimeout(() => { runtime.lastError = undefined; cb({ ok: true, entries: [1] }) }, 5)
      else if (b === "undelivered") setTimeout(() => { runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." }; cb(undefined); runtime.lastError = undefined }, 5)
      // silent: the callback never comes (the background was put away mid-message)
    }
  }
  ;(globalThis as any).chrome = { runtime }
  return sent
}

test("a message that didn't arrive (the background put away) is sent again and answered", async () => {
  const { sendBackground } = await import("../src/content/bgmsg.ts")
  const sent = fakeChrome(["undelivered", "answer"])
  const r = await sendBackground<{ ok: boolean }>({ type: "formData" })
  assert.deepEqual(r, { ok: true, entries: [1] })
  assert.equal(sent.length, 2)
})

test("a read that got no answer in time is asked again; an action is never sent twice", async () => {
  const { sendBackground } = await import("../src/content/bgmsg.ts")
  let sent = fakeChrome(["silent", "answer"])
  const r = await sendBackground({ type: "formData" }, { timeoutMs: 30 })
  assert.ok(r, "the read came back on the second try")
  assert.equal(sent.length, 2)
  sent = fakeChrome(["silent", "answer"])
  const a = await sendBackground({ type: "agentStart", request: "x" }, { timeoutMs: 30 })
  assert.equal(a, null)
  assert.equal(sent.length, 1, "an action that may have been done isn't repeated")
  sent = fakeChrome(["undelivered", "answer"])
  assert.ok(await sendBackground({ type: "agentStart", request: "x" }, { timeoutMs: 30 }), "an action that never arrived is sent again")
  assert.equal(sent.length, 2)
})

test("the panel reads again when the page comes back from another app or tab", async () => {
  const { onReturn } = await import("../src/content/bgmsg.ts")
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = "hidden"
  const win = new EventTarget()
  ;(globalThis as any).document = doc
  ;(globalThis as any).window = win
  let n = 0
  const off = onReturn(() => n++)
  doc.dispatchEvent(new Event("visibilitychange"))
  assert.equal(n, 0, "hidden: nothing")
  doc.visibilityState = "visible"
  doc.dispatchEvent(new Event("visibilitychange"))
  const shown = Object.assign(new Event("pageshow"), { persisted: true })
  win.dispatchEvent(shown)
  assert.equal(n, 2)
  off()
  doc.dispatchEvent(new Event("visibilitychange"))
  assert.equal(n, 2)
  const app = readFileSync("src/content/App.tsx", "utf8")
  assert.match(app, /return onReturn\(\(\) => \{\s*void sendBackground<[^>]+>\(\{ type: "agentGet" \}\)/)
  assert.match(readFileSync("src/content/agent/MyDetails.tsx", "utf8"), /const off = onReturn\(load\)/)
  assert.match(readFileSync("src/content/insert/store.ts", "utf8"), /import \{ sendBackground \} from "\.\.\/bgmsg"/)
})
