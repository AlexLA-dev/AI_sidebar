// The Tips clips for the panel (2.6 (91), the owner: from the app on the same device, not in the extension): the app
// puts its clips in the App Group (TipClipShare.swift); here they come from the native handler in parts (`tipClip`)
// and are kept a while for the clip page (src/pages/clip.ts). Only Safari has the app; elsewhere there are none.

import { TARGET } from "../shared/config"
import { clipLanguage } from "../shared/clipLanguage"
import { callNative } from "./native"

type Part = { ok: boolean; total?: number; offset?: number; length?: number; data?: string }
export type TipClipReply = { ok: true; data: string } | { ok: false }

// A few at a time (a clip is ~70–180 KB): the open Tips cards and the tour's.
const kept = new Map<string, string>()
const KEEP = 12

/** A clip's bytes (base64), or not ok when the app hasn't shared it (not opened since the install or the update). */
export async function tipClip(name: string, lang: string): Promise<TipClipReply> {
  if (TARGET !== "safari" || !/^[a-z0-9-]{1,40}$/.test(name)) return { ok: false }
  // The panel's language, any (build 95): the app picks the folder, its clips or the next language's, else English.
  const which = clipLanguage(lang)
  const key = `${which}/${name}`
  const hit = kept.get(key)
  if (hit) return { ok: true, data: hit }
  const parts: string[] = []
  let offset = 0
  let total = Infinity
  // At most 8 MB (a clip is far less): a misbehaving answer can't loop for ever.
  while (offset < total && offset < 8 << 20) {
    const part = await callNative<Part>("tipClip", { name, lang: which, offset }, 6000)
    if (!part?.ok || typeof part.data !== "string" || typeof part.total !== "number" || !part.length) return { ok: false }
    parts.push(part.data)
    total = part.total
    offset += part.length
  }
  const data = parts.join("")
  kept.set(key, data)
  if (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
  return { ok: true, data }
}
