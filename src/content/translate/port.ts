// The page's side of in-page translation (2.7): requests to the background on one "translate" port (connected again
// when Safari has stopped the background), and the translations kept on this device for a page's address and language,
// so "Original" and translating again, or the page opened again, need no server (and count nothing).

import type { TranslateReply } from "../../shared/translate"
import type { Ask, TranslationCache } from "./engine"

export function portAsk(): Ask {
  let port: chrome.runtime.Port | null = null
  let seq = 0
  const waiting = new Map<number, (r: TranslateReply) => void>()
  const connect = (): chrome.runtime.Port => {
    const p = chrome.runtime.connect({ name: "translate" })
    p.onMessage.addListener((reply: TranslateReply) => waiting.get(reply?.req)?.(reply))
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (port === p) port = null
      for (const [req, on] of [...waiting]) on({ type: "error", req, code: "NETWORK" })
    })
    return p
  }
  return (ask, on) => {
    const req = ++seq
    waiting.set(req, (reply) => {
      if (reply.type === "done" || reply.type === "error") waiting.delete(req)
      on(reply)
    })
    try {
      port ??= connect()
      port.postMessage({ type: "translate", req, ...ask })
    } catch {
      port = null
      waiting.delete(req)
      setTimeout(() => on({ type: "error", req, code: "NETWORK" }), 0)
    }
    return () => {
      waiting.delete(req)
      try {
        port?.postMessage({ type: "cancel", req })
      } catch {
        // gone already
      }
    }
  }
}

const INDEX = "cf:trPages"
// Pages kept, and how much of each (the latest translations first): a few long articles' worth on the device.
const PAGES = 10
const PAGE_CHARS = 160_000

/** A short key for a page's address and language (FNV-1a, 52 bits: only this device's storage keys). */
function key(url: string, to: string): string {
  let h = 0xcbf29ce484222325n
  for (const ch of `${url}|${to}`) {
    h ^= BigInt(ch.codePointAt(0) ?? 0)
    h = (h * 0x100000001b3n) & 0xfffffffffffffn
  }
  return `cf:tr:${h.toString(36)}`
}

export const storageCache: TranslationCache = {
  async load(url, to) {
    const k = key(url, to)
    const stored = (await chrome.storage.local.get(k))[k] as { items?: Array<[string, string]> } | undefined
    return new Map((stored?.items ?? []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string"))
  },
  save(url, to, entries) {
    const k = key(url, to)
    const items: Array<[string, string]> = []
    let chars = 0
    for (const entry of [...entries].reverse()) {
      chars += entry[0].length + entry[1].length
      if (chars > PAGE_CHARS) break
      items.push(entry)
    }
    void (async () => {
      const index = ((await chrome.storage.local.get(INDEX))[INDEX] as Array<{ k: string; at: number }> | undefined) ?? []
      const next = [{ k, at: Date.now() }, ...index.filter((e) => e?.k !== k)]
      const gone = next.slice(PAGES).map((e) => e.k)
      await chrome.storage.local.set({ [k]: { items: items.reverse() }, [INDEX]: next.slice(0, PAGES) })
      if (gone.length) await chrome.storage.local.remove(gone)
    })().catch(() => undefined)
  }
}
