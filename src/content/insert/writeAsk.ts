// A check or a rewrite asked of the background, so that it always ends (2.7 (107), the owner in Gmail: «Check повис на
// минуту и так ничего и не выдал»). The background answers within the request's deadline itself (writeDeadline); but
// Safari can put the background's page to sleep with the request in it, and then no answer comes at all: so the page
// stops waiting a moment after that deadline and says so. No imports but the shared helpers: the tests load it as it is.

import { writeDeadline, type WriteAsk, type WriteReply } from "../../shared/writing.ts"

export type SendBackground = <T>(message: unknown) => Promise<T | null>

// How long after the background's own deadline the page waits for its answer (a SLOW from it comes first when it's awake).
export const PAGE_MARGIN_MS = 1_500

/**
 * Ends with the answer; with SLOW once the deadline has passed and nothing came; with STOPPED after `stop()` (Cancel, or
 * the card going away). Either way the background is told to drop the request, so the server gives the answer back.
 */
export function askWriteWith(send: SendBackground, ask: WriteAsk): { reply: Promise<WriteReply>; stop: () => void } {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let ended = false
  let end: (reply: WriteReply) => void = () => undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const reply = new Promise<WriteReply>((resolve) => {
    end = (r) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      resolve(r)
    }
  })
  const drop = () => void send({ type: "qiWriteStop", id })
  timer = setTimeout(() => {
    drop()
    end({ ok: false, code: "SLOW" })
  }, writeDeadline(ask.action, ask.text.length, ask.live === true) + PAGE_MARGIN_MS)
  void send<WriteReply>({ type: "qiWrite", ask: { ...ask, id } }).then((r) => end(r ?? { ok: false, code: "NETWORK" }), () => end({ ok: false, code: "NETWORK" }))
  return {
    reply,
    stop: () => {
      if (ended) return
      drop()
      end({ ok: false, code: "STOPPED" })
    }
  }
}

// A tab left open across an update of the app (2.7 (107), C5: the owner's Check in Gmail ran a minute and gave nothing).
// The simulator showed it: Safari keeps the old page script running, and its storage and its background never answer
// again, so the request was never even sent. Its storage reads are given this long (they take milliseconds otherwise);
// then the card asks for the page to be reloaded.
export const STORE_WAIT_MS = 3_000

/** The extension behind this page was replaced (an update): it no longer answers. */
export class ExtensionGone extends Error {}

/** `work`, or ExtensionGone once `ms` have passed without it. */
export function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new ExtensionGone("no answer from the extension")), ms)))
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
