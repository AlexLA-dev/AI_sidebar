// A Tips clip in the panel (2.6 (91)): a frame of the extension's clip page (src/pages/clip.ts), which plays the
// app's clip from the App Group. Nothing of it is in the extension, and a page's media rules don't reach it. Before
// the app has run since the install or the update, the card says so in a line instead.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"

// The build's target (only Safari has the app the clips come from); read here alone, so the Tips sheet bundles
// without the rest of the config.
declare const __TARGET__: "safari" | "chrome"
const SAFARI = typeof __TARGET__ === "undefined" || __TARGET__ === "safari"

export function clipSrc(name: string, lang: string, still: boolean, motion = true): string {
  return chrome.runtime.getURL(`dist/clip.html?name=${encodeURIComponent(name)}&lang=${lang === "ru" ? "ru" : "en"}${still ? "&still=1" : ""}${motion ? "" : "&motion=0"}`)
}

export function ClipFrame({ name, lang, still, active, motion = true, onMissing }: {
  name: string
  lang: string
  still: boolean
  // On screen: it plays (a still one too); off screen: paused.
  active?: boolean
  motion?: boolean
  onMissing?: () => void
}): VNode | null {
  const ref = useRef<HTMLIFrameElement>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || (e.data as { cfClip?: string } | null)?.cfClip !== "missing") return
      setMissing(true)
      onMissing?.()
    }
    window.addEventListener("message", heard)
    return () => window.removeEventListener("message", heard)
  }, [])
  useEffect(() => {
    if (active === undefined) return
    ref.current?.contentWindow?.postMessage({ cfClip: active ? "play" : "pause" }, "*")
  }, [active])
  // Only Safari has the app the clips come from.
  if (!SAFARI) return null
  if (missing) return <p class="cf-clip-missing">{t("tipClipNeedsApp")}</p>
  return <iframe ref={ref} class="cf-clip-frame" src={clipSrc(name, lang, still, motion)} title="" aria-hidden="true" tabIndex={-1} />
}
