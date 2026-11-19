import type { VNode } from "preact"
import { useState } from "preact/hooks"

import { ClipFrame } from "./tips/ClipFrame"
import { say, tipsData } from "./tips/data"

/** A Tips clip on a tour card: the feature at work (the owner: show it, not only describe it). The app's clip, like
 * the Tips sheet's (ClipFrame); one still frame with Reduce Motion. Before the app has shared it, the card goes
 * without (its words say it all; the Tips sheet is where "open the app once" is said). */
export function TourClip({ name }: { name: string }): VNode | null {
  const [gone, setGone] = useState(false)
  const data = tipsData()
  if (!data || gone) return null
  const lang = say(data.clipLang)
  let still = false
  try {
    still = matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    // No media queries: it plays.
  }
  return <div class="cf-guide-clip"><ClipFrame name={name} lang={lang} still={still} motion={!still} onMissing={() => setGone(true)} /></div>
}
