// Whether a field sits on a dark page or a light one (2.7 (108), the owner on the live underlines: «переливающимся в
// нашем стиле»). The underlines are drawn on the page, so their line is made legible for the page's own background, not
// the panel's theme: a dark page under a light panel, or the other way round, is common (Gmail light in dark mode).
// Read once per field (the computed backgrounds from the field up to the page), not on every frame.

/** A computed colour, as `rgb()`/`rgba()` (commas or spaces) gives it; null for anything else (a keyword, color()). */
export function parseRgb(css: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(css.trim())
  if (!m) return null
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha }
}

/** Relative luminance (0 black, 1 white). */
export function luminance(c: { r: number; g: number; b: number }): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/**
 * The ground under a field from the backgrounds met going up from it (the field's own first): the first one mostly
 * opaque decides. With none (every one transparent), the canvas: dark only when the page asks for a dark scheme.
 */
export function groundOf(backgrounds: string[], canvasDark = false): "dark" | "light" {
  for (const b of backgrounds) {
    const c = parseRgb(b)
    if (c && c.a >= 0.5) return luminance(c) < 0.2 ? "dark" : "light"
  }
  return canvasDark ? "dark" : "light"
}

const grounds = new WeakMap<Element, "dark" | "light">()

/** The ground under `el` on its page, read once per field. */
export function fieldGround(el: Element): "dark" | "light" {
  const known = grounds.get(el)
  if (known) return known
  const win = el.ownerDocument.defaultView ?? window
  const backgrounds: string[] = []
  let n: Element | null = el
  for (let i = 0; n && i < 40; i++) {
    backgrounds.push(win.getComputedStyle(n).backgroundColor)
    n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)
  }
  const scheme = win.getComputedStyle(el.ownerDocument.documentElement).colorScheme || ""
  const canvasDark = /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || Boolean(win.matchMedia?.("(prefers-color-scheme: dark)").matches))
  const ground = groundOf(backgrounds, canvasDark)
  grounds.set(el, ground)
  return ground
}
