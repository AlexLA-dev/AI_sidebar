// A page translated in place (2.7), the background's part: each request from the page goes to /api/v2/translate with
// the install, the plan and a hash of the page's address and language (the address itself stays on the device), and
// the server's lines come back to the page as they arrive, on the page's "translate" port. Nothing goes without the one
// AI consent. The pill's steps go to the feature counters (usage.ts "translate_page"), counts only.

import { API_BASE } from "../shared/config"
import { urlKey } from "../shared/conversation"
import { sseData } from "../shared/sse"
import type { TranslateAsk, TranslateError, TranslateReply, TranslateStep } from "../shared/translate"

export interface TranslateDeps {
  installId: () => Promise<string>
  // The App Store transaction the server checks the plan with (null: free).
  entitlementJws: () => Promise<string | null>
  clientInfo: () => Promise<Record<string, unknown>>
  consented: () => Promise<boolean>
  // A page counted as an answer: the panel's usage line is asked again.
  statusChanged: () => void
}

const FIRST_BYTE_MS = 30_000
const CODES = new Set<TranslateError>(["LIMIT_REACHED", "PAGE_CAP", "BUSY", "UPSTREAM", "NETWORK", "UNAVAILABLE", "BAD_REQUEST", "CONSENT"])

/** The page's id for the server: the address (without its tracking parameters) and the language, hashed. */
export async function pageId(url: string, to: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${urlKey(url)}|${to}`))
  return Array.from(new Uint8Array(bytes).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
}

async function run(deps: TranslateDeps, ask: TranslateAsk, emit: (r: TranslateReply) => void, signal: AbortSignal): Promise<void> {
  const req = ask.req
  const fail = (code: TranslateError) => emit({ type: "error", req, code })
  if (!(await deps.consented())) return fail("CONSENT")
  const [installId, entitlement, client, page] = await Promise.all([deps.installId(), deps.entitlementJws(), deps.clientInfo(), pageId(ask.url, ask.to)])
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), FIRST_BYTE_MS)
  const stop = () => timeout.abort()
  signal.addEventListener("abort", stop)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/v2/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId, client, entitlement, page, to: ask.to, from: ask.from, first: ask.first, blocks: ask.blocks }),
      signal: timeout.signal
    })
  } catch {
    clearTimeout(timer)
    if (!signal.aborted) fail(timeout.signal.aborted ? "UPSTREAM" : "NETWORK")
    return
  }
  clearTimeout(timer)
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { code?: string }
    const code = CODES.has(body.code as TranslateError) ? (body.code as TranslateError) : res.status === 404 ? "UNAVAILABLE" : res.status >= 500 ? "UPSTREAM" : "BAD_REQUEST"
    if (code === "LIMIT_REACHED") deps.statusChanged()
    return fail(code)
  }
  let charged = false
  let got = false
  let ended = false
  try {
    for await (const data of sseData(res.body)) {
      let event: { type?: string; charged?: boolean; items?: unknown; ids?: unknown; code?: string }
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      if (event.type === "meta") {
        charged = event.charged === true
        if (charged) deps.statusChanged()
      } else if (event.type === "items" && Array.isArray(event.items)) {
        const items = event.items.filter((i): i is { id: string; text: string } => typeof i?.id === "string" && typeof i?.text === "string")
        if (items.length) {
          got = true
          emit({ type: "items", req, items })
        }
      } else if (event.type === "skip" && Array.isArray(event.ids)) {
        emit({ type: "skip", req, ids: event.ids.filter((id): id is string => typeof id === "string") })
      } else if (event.type === "done") {
        ended = true
        emit({ type: "done", req, charged })
      } else if (event.type === "error") {
        ended = true
        fail(CODES.has(event.code as TranslateError) ? (event.code as TranslateError) : "UPSTREAM")
      }
    }
  } catch {
    // the connection dropped
  } finally {
    signal.removeEventListener("abort", stop)
  }
  if (ended || signal.aborted) return
  // Cut off: what came stays, the rest is asked again.
  if (got) emit({ type: "done", req, charged })
  else fail("NETWORK")
}

/** The feature counter for a step of the pill (the page's surface). */
async function report(deps: TranslateDeps, step: TranslateStep): Promise<void> {
  const [installId, client] = await Promise.all([deps.installId(), deps.clientInfo()])
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "use", installId, client, f: "translate_page", a: step.a, s: "page" })
  }).catch(() => undefined)
}

export function startTranslate(deps: TranslateDeps): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "translate") return
    const running = new Map<number, AbortController>()
    port.onDisconnect.addListener(() => {
      for (const c of running.values()) c.abort()
      running.clear()
    })
    port.onMessage.addListener((message: TranslateAsk | { type: "cancel"; req: number }) => {
      if (message?.type === "cancel") {
        running.get(message.req)?.abort()
        running.delete(message.req)
        return
      }
      if (message?.type !== "translate" || typeof message.req !== "number" || !Array.isArray(message.blocks)) return
      const controller = new AbortController()
      running.set(message.req, controller)
      const emit = (reply: TranslateReply) => {
        if (controller.signal.aborted) return
        try {
          port.postMessage(reply)
        } catch {
          controller.abort()
        }
      }
      void run(deps, message, emit, controller.signal)
        .catch(() => emit({ type: "error", req: message.req, code: "NETWORK" }))
        .finally(() => running.delete(message.req))
    })
  })

  chrome.runtime.onMessage.addListener((message: TranslateStep, _sender, sendResponse) => {
    if (message?.type !== "trEvent") return false
    void report(deps, message)
    sendResponse({ ok: true })
    return false
  })
}
