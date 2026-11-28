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
  assert.match(app, /return onReturn\(\(\) => \{[\s\S]{0,300}void sendBackground<[^>]+>\(\{ type: "agentGet" \}\)/)
  assert.match(readFileSync("src/content/agent/MyDetails.tsx", "utf8"), /const off = onReturn\(load\)/)
  assert.match(readFileSync("src/content/insert/store.ts", "utf8"), /import \{ sendBackground \} from "\.\.\/bgmsg"/)
})

test("the chat: a question the background never got is sent again once on a fresh port, then an error with «Повторить» and a reload — never a silent drop", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  // The port closed before a word came back: undelivered, not «lost» (the job never existed).
  assert.match(app, /if \(!heardAny && onUndelivered\) onUndelivered\(\)\s*else lostRef\.current\(\)/)
  assert.match(app, /listenChat\(port, history, \(\) => undeliveredRef\.current\(history, content, opts\)\)/)
  // Once again on its own (the ask runs whole: the chat saved, a new port), then the error.
  assert.match(app, /if \(!opts\.resent\) \{[^}]*askRef\.current\(content, \{[^}]*retry: true, resent: true \}\)/)
  assert.match(app, /finish\(history, "", \{ code: "LINK" \}\)/)
  assert.match(app, /case "LINK":\s*return t\("errLink"\)/)
  assert.match(app, /error\.code === "LINK" && <button[^>]*onClick=\{\(\) => location\.reload\(\)\}>\{t\("reloadPage"\)\}/)
  assert.match(app, /const RESUMABLE = \[[^\]]*"LINK"\]/)
  // The error card's own Retry asks the same question again.
  assert.match(app, /\{lastIsUser && error\.code !== "SEARCH_LIMIT"[^}]*\(\s*<button type="button" class="cf-secondary" onClick=\{\(\) => retry\(\)\}>/)
  const details = readFileSync("src/content/agent/MyDetails.tsx", "utf8")
  assert.match(details, /setData\(\(d\) => d \?\? \{ entries: \[\], lost: true \}\)/)
  assert.match(details, /data\?\.lost && \(/)
  for (const f of ["en", "ru", "uk", "de", "fr", "es", "it", "pt_BR", "tr", "ja", "ko", "zh_CN", "zh_TW", "ar", "vi"]) {
    const d = JSON.parse(readFileSync(`src/locales/${f}.json`, "utf8"))
    assert.ok(d.errLink?.trim() && d.reloadPage?.trim(), f)
  }
})

test("a silent tab (no answer at all after another app): the quiet watchdog treats an unheard question as undelivered; coming back probes the link and says so at once", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  // The quiet watchdog (20 s, and on coming back) goes through the pending question first. 2.8.1 (the director): a
  // question whose connection said nothing for the whole 20 s isn't sent again — the tab's link is gone (a tab left
  // open across an update): straight to «lost its link» with Reload (about 20–25 s, was about 75 s). Coming back from
  // the background (6 s quiet) still asks again once.
  // F1: the silence is checked first — the background answering «alive» means the question went astray (asked again
  // once); no answer in PROBE_MS means the link is gone.
  assert.match(app, /const check = \(ms: number\) => \{\s*if \(probing \|\| !quiet\(ms\)\) return/)
  assert.match(app, /setInterval\(\(\) => check\(SILENT_MS\), 5_000\)/)
  assert.match(app, /sendBackground<boolean>\(\{ type: "alive" \}, \{ tries: 1, timeoutMs: PROBE_MS \}\)/)
  assert.match(app, /if \(portRef\.current !== port \|\| heardRef\.current !== heard\) return[\s\S]{0,160}quietRef\.current\(alive === null\)/)
  // The director's review of #268: coming back checks the link too (no resend into a dead tab).
  assert.match(app, /if \(document\.visibilityState === "visible"\) check\(6_000\)/)
  assert.match(app, /const quietRef = useRef\(\(silent = false\) => \{\s*const p = pendingAskRef\.current\s*if \(p\) undeliveredRef\.current\(p\.history, p\.content, silent \? \{ \.\.\.p\.opts, resent: true \} : p\.opts\)\s*else lostRef\.current\(\)/)
  // A resent question is the error at once: no second fresh connection.
  assert.match(app, /if \(!opts\.resent\) \{[\s\S]{0,260}?return\s*\}\s*setLinkLost\(true\)\s*finish\(history, "", \{ code: "LINK" \}\)/)
  // Anything heard clears it (the question got there) and the link is fine.
  assert.match(app, /heardAny = true\s*pendingAskRef\.current = null\s*if \(linkLostRef\.current\) setLinkLost\(false\)/)
  // On coming back: no answer to agentGet → the link is gone, said in the chat with «Повторить» and a reload.
  assert.match(app, /sendBackground<\{ state: PanelAgent \| null \}>\(\{ type: "agentGet" \}\)\.then\(\(r\) => \{\s*setLinkLost\(r === null\)/)
  assert.match(app, /\{linkLost && !error && \(\s*<div class="cf-card error" role="status">\s*<p>\{t\("errLink"\)\}<\/p>/)
  assert.match(app, /onClick=\{recheckLink\}><Icon\.Retry \/> \{t\("retry"\)\}/)
  // Known gone: a question errors at once, a task says so before waiting on a background that can't hear it.
  assert.match(app, /if \(linkLostRef\.current && opts\.resent === undefined\) \{[^}]*undeliveredRef\.current\(history, content, \{ \.\.\.opts, resent: true \}\)/)
  assert.match(app, /if \(linkLostRef\.current\) \{\s*setAgentStartError\(t\("errLink"\)\)/)
})

test("a tab whose link is gone: saving the consent ends in the lost-link card after a few seconds, brought into view (2.8.1)", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  assert.match(app, /const consentSaved = \(\): Promise<boolean> => \{[\s\S]{0,80}?Promise\.race\(\[giveConsent\(\)\.then\(\(\) => true, \(\) => false\), new Promise<boolean>\(\(done\) => setTimeout\(\(\) => done\(false\), 6_000\)\)\]\)/)
  assert.match(app, /if \(!\(await consentSaved\(\)\)\) \{\s*setPending\(null\)\s*setLinkLost\(true\)\s*return\s*\}/)
  assert.match(app, /void consentSaved\(\)\.then\(\(saved\) => \{\s*if \(!saved\) return setLinkLost\(true\)/)
  assert.match(app, /if \(linkLost\) requestAnimationFrame\(\(\) => listRef\.current\?\.scrollTo/)
})

test("F1 (2.8.1): a question's wait starts at its connection, never at the ask; the background confirms a question at once", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  const bg = readFileSync("src/background/index.ts", "utf8")
  // No cut-off counted from the ask (it counted the plan's status and the page's read: a cold background ended a healthy
  // question with «lost its link»).
  assert.doesNotMatch(app, /STUCK_MS|askedAtRef/)
  // Every connection starts its own wait: chat (a question, Ask your chats, a retry) and Find similar.
  assert.match(app, /const listenChat = \(port[\s\S]{0,120}?\) => \{\s*heardRef\.current = Date\.now\(\)/)
  assert.match(app, /const listenSimilar = \(port[\s\S]{0,120}?\) => \{\s*heardRef\.current = Date\.now\(\)/)
  assert.match(app, /const SILENT_MS = 20_000/)
  assert.match(app, /const PROBE_MS = 10_000/)
  // The background says «here» on every question's port before anything slower, and answers the check.
  assert.match(bg, /function servePort\([\s\S]{0,900}?send\(\{ type: "beat" \}\)\s*if \(spec\) \{/)
  assert.match(bg, /case "alive":\s*sendResponse\(true\)\s*return false/)
})
