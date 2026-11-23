// The build's API address (a build-time constant; absent where this runs without the build, as in tests).
declare const __API_BASE__: string | undefined
const STAND_BASE: string = typeof __API_BASE__ === "string" ? __API_BASE__ : ""

// Messages from the panel to the extension's background, made to survive Safari putting it away (2.7.1, 123: after
// switching to the ContextFlow app and back — the Calendar «Разрешить» flow — the tab got no answers until a reload:
// «Мои данные» stayed empty). Every try is time-boxed; a message that wasn't delivered (no receiver, the background
// gone) is sent again, which also wakes the background; a read that got no answer in time is asked again; an action
// that may have been done is never sent twice.

export interface SendOptions {
  // How long one try waits for the answer.
  timeoutMs?: number
  // Tries in all.
  tries?: number
  // Safe to send again when no answer came in time (a read: nothing changes on the other side).
  idempotent?: boolean
}

// Messages that only read: asked again after a silent try.
const READS = /^(formData|agentGet|agentAccess|agentNoticeGet|agentDeferred|agentPing|status|getStatus|getSettings|settings|usage|templates|qiTemplates|listChats|threads|thread|notes|cookieSettings|watchList|reminders)$/

type Try = { kind: "answer"; value: unknown } | { kind: "undelivered" } | { kind: "silent" }

// The extension's messaging, read where it is (also from the tests, which have no extension types).
interface Runtime {
  lastError?: { message?: string }
  sendMessage(message: unknown, callback: (response: unknown) => void): void
}
const runtimeId = (): string => String((globalThis as unknown as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id ?? "none")
const runtime = (): Runtime | undefined => (globalThis as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime

function once(message: unknown, timeoutMs: number): Promise<Try> {
  return new Promise((resolve) => {
    let done = false
    const finish = (t: Try) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(t)
    }
    const timer = setTimeout(() => finish({ kind: "silent" }), timeoutMs)
    try {
      const rt = runtime()
      if (!rt) return finish({ kind: "undelivered" })
      rt.sendMessage(message, (response: unknown) => {
        const err = rt.lastError
        // «Could not establish connection», «receiving end does not exist»: it never arrived.
        if (err) finish({ kind: "undelivered" })
        else finish({ kind: "answer", value: response ?? null })
      })
    } catch {
      finish({ kind: "undelivered" })
    }
  })
}

/** Sends to the background; `null` when no answer came after every try. */
export async function sendBackground<T>(message: unknown, opts: SendOptions = {}): Promise<T | null> {
  const type = (message as { type?: unknown } | null)?.type
  const idempotent = opts.idempotent ?? (typeof type === "string" && READS.test(type))
  const tries = Math.max(1, opts.tries ?? 3)
  const timeoutMs = opts.timeoutMs ?? (idempotent ? 5_000 : 30_000)
  for (let i = 0; i < tries; i++) {
    const t = await once(message, timeoutMs)
    if (t.kind !== "answer") standTrace(`send ${String(type)} try ${i + 1}: ${t.kind} id=${runtimeId()}`)
    if (t.kind === "answer") return t.value as T | null
    if (t.kind === "silent" && !idempotent) return null
    await new Promise((ok) => setTimeout(ok, 250 * (i + 1)))
  }
  return null
}

/** Calls `fn` when the page comes back into view (another app, another tab, the back/forward cache). */
export function onReturn(fn: () => void): () => void {
  const seen = () => document.visibilityState === "visible" && fn()
  const shown = (e: PageTransitionEvent) => e.persisted && fn()
  document.addEventListener("visibilitychange", seen)
  window.addEventListener("pageshow", shown)
  return () => {
    document.removeEventListener("visibilitychange", seen)
    window.removeEventListener("pageshow", shown)
  }
}

// ------------------------------------------------------------ the stand's trace (test builds against a local stand)

/** A line to the local stand's log (test builds only: the API on localhost); real builds send nothing. */
export function standTrace(what: string): void {
  const base = STAND_BASE
  if (!/^http:\/\/localhost:\d+$/.test(base)) return
  void fetch(`${base}/__trace`, { method: "POST", body: `panel ${what}` }).catch(() => undefined)
}
