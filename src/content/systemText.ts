// The system text size on iPhone and iPad (Settings → Display & Brightness → Text Size, and Accessibility → Larger
// Text), as a scale for the panel (2.7.1, after the VoiceOver pass: the panel kept its own px sizes and ignored it).
//
// WebKit on iOS resolves `font: -apple-system-body` to the Dynamic Type body size: 17px at the default «Large», 19–23px
// for the three larger steps, 28–53px for the accessibility sizes. The panel is laid out in px (the host page's root
// size must not move it), so the scale is applied with CSS `zoom` on the panel's parts (styles.css, `--ui`), which
// enlarges text and tap areas together and still fits the panel's width.
//
// Never below 1: the smaller system sizes keep the layout the owner approved. Capped at 1.65 (the first accessibility
// size): beyond it the iPhone panel would hold only a few words per line; larger sizes get that cap.
import { useEffect, useState } from "preact/hooks"

export const DEFAULT_BODY_PX = 17
export const MAX_UI_SCALE = 1.65

export function scaleFor(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= DEFAULT_BODY_PX) return 1
  return Math.min(MAX_UI_SCALE, Math.round((bodyPx / DEFAULT_BODY_PX) * 100) / 100)
}

/** The body size the system font keyword resolves to here, in px (NaN when the keyword isn't supported). */
export function measureSystemBody(host: ParentNode & Node): number {
  const doc = host.ownerDocument ?? document
  const probe = doc.createElement("span")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body"
  probe.textContent = "x"
  host.appendChild(probe)
  const px = parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  return px
}

/** The panel's scale on touch devices; 1 elsewhere (the Mac has no system text size for web content). */
export function useSystemTextScale(touch: boolean, host: (ParentNode & Node) | null): number {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (!touch || !host) return
    const read = () => setScale(scaleFor(measureSystemBody(host)))
    read()
    // Changing the size in Settings and coming back fires these; the page itself doesn't reload.
    const onVisible = () => { if (document.visibilityState === "visible") read() }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("resize", read)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("resize", read)
    }
  }, [touch, host])
  return scale
}
