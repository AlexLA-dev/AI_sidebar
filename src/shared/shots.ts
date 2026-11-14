// «Снимок страницы в заметке» (2.7, plan section 12): a note can keep a picture of the page it was written on, of what
// was on screen or of the whole page (Pro and Ultra), cropped later in the chat. Shared by the panel, the background and
// the tests.
// - The note keeps a small thumbnail and the crop frame (they go with the chat everywhere); the picture itself is a
//   compressed JPEG on the device and in the person's iCloud (the native side, its own zone, in parts), fetched only when
//   it's opened. Nothing goes to our server.
// - Visible area: Safari's own capture of the tab (tabs.captureVisibleTab), the panel and the circle hidden for a moment.
//   Whole page: scrolled screen by screen and stitched; what stays put (a sticky header, a bar) only in the first one;
//   at most SHOT_LIMITS.screens screens.

export type ShotKind = "visible" | "full"

/** On a note: the picture's id, what it shows, its size (px), a thumbnail (a small JPEG data URL), its crop. */
export interface Shot {
  id: string
  kind: ShotKind
  w: number
  h: number
  // How many parts the picture is kept in (iCloud records of SHOT_LIMITS.chunk base64 characters).
  parts: number
  th: string
  // The part kept after cropping, as fractions of the picture: [left, top, width, height].
  crop?: [number, number, number, number]
}

/** The panel's switch over the note field: on or off, and what it takes. Remembered on the device. */
export interface ShotPref {
  on: boolean
  kind: ShotKind
}

export const DEFAULT_SHOT_PREF: ShotPref = { on: false, kind: "visible" }
export const SHOT_PREF_KEY = "cf:shotPref"

export const SHOT_LIMITS = {
  // The whole page: at most this many screens.
  screens: 10,
  // The picture's width at most (px), and its pixels at most (iOS refuses canvases much bigger).
  width: 1170,
  fullWidth: 900,
  pixels: 12_000_000,
  quality: 0.72,
  // The thumbnail in the note.
  thumbWidth: 240,
  thumbHeight: 320,
  thumbQuality: 0.6,
  // Base64 characters per part: through the native bridge (as Tips clips are) and per iCloud record.
  chunk: 192 * 1024,
  // A picture made here and no longer on any note (deleted, or its chat emptied from Recently Deleted) goes after this.
  orphanDays: 7
} as const

/** A new picture's id. */
export function newShotId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** A valid id (ours: letters, digits, _ and -; no path in it). */
export function validShotId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

// ------------------------------------------------------------ the whole page, screen by screen

export interface StitchStep {
  // Where the page is scrolled to for this screen (CSS px).
  scrollY: number
  // What of this screen goes into the picture: from `from` down `height` CSS px of the visible area, placed at `to`.
  from: number
  to: number
  height: number
}

/**
 * The screens of a page `pageHeight` tall seen `viewHeight` at a time, at most `screens`: each screen scrolled to, and
 * the part of it that goes into the picture (the last screen scrolls only to the page's end: its part is what the one
 * before didn't show). `top`: the height of what stays at the top (a sticky header): left out of every screen but the
 * first, as the page under it is shown by the screen before.
 */
export function stitchPlan(pageHeight: number, viewHeight: number, screens: number = SHOT_LIMITS.screens, top = 0): { steps: StitchStep[]; height: number; cut: boolean } {
  const view = Math.max(1, Math.floor(viewHeight))
  const sticky = Math.max(0, Math.min(Math.floor(top), Math.floor(view / 2)))
  const page = Math.max(view, Math.floor(pageHeight))
  // Each screen after the first adds what's below the sticky part.
  const add = view - sticky
  const steps: StitchStep[] = [{ scrollY: 0, from: 0, to: 0, height: view }]
  let shown = view
  while (shown < page && steps.length < screens) {
    // Scrolled so the page's next unseen pixel is just under the sticky part, but never past the end.
    const want = shown - sticky
    const scrollY = Math.min(want, page - view)
    const from = sticky + (want - scrollY)
    const height = Math.min(add - (want - scrollY), page - shown)
    if (height <= 0) break
    steps.push({ scrollY, from, to: shown, height })
    shown += height
  }
  return { steps, height: shown, cut: shown < page }
}

/** The picture's size for a capture `w`×`h` (device px), within the width and pixel caps. */
export function fitSize(w: number, h: number, maxWidth: number, maxPixels: number = SHOT_LIMITS.pixels): { w: number; h: number; scale: number } {
  let scale = Math.min(1, maxWidth / Math.max(1, w))
  if (w * scale * h * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h))
  // Rounded down: never over the cap.
  return { w: Math.max(1, Math.floor(w * scale)), h: Math.max(1, Math.floor(h * scale)), scale }
}

// ------------------------------------------------------------ cropping

/** A crop frame kept inside the picture and not smaller than 5 % of it each way; null when it's the whole picture. */
export function cleanCrop(c: readonly number[] | null | undefined): Shot["crop"] | undefined {
  if (!c || c.length !== 4 || c.some((v) => typeof v !== "number" || !Number.isFinite(v))) return undefined
  let [x, y, w, h] = c
  x = Math.min(Math.max(0, x), 0.95)
  y = Math.min(Math.max(0, y), 0.95)
  w = Math.min(Math.max(0.05, w), 1 - x)
  h = Math.min(Math.max(0.05, h), 1 - y)
  const round = (v: number) => Math.round(v * 10_000) / 10_000
  if (x < 0.001 && y < 0.001 && w > 0.999 && h > 0.999) return undefined
  return [round(x), round(y), round(w), round(h)]
}

/**
 * A crop frame moved by a drag: the whole frame (`edge` "move") or one of its corners, by (dx, dy) as fractions of
 * the picture; kept inside it, at least 5 % each way.
 */
export function dragCrop(c: [number, number, number, number], edge: "move" | "nw" | "ne" | "sw" | "se", dx: number, dy: number): [number, number, number, number] {
  let [x, y, w, h] = c
  const min = 0.05
  if (edge === "move") {
    x = Math.min(Math.max(0, x + dx), 1 - w)
    y = Math.min(Math.max(0, y + dy), 1 - h)
    return [x, y, w, h]
  }
  let left = x
  let top = y
  let right = x + w
  let bottom = y + h
  if (edge === "nw" || edge === "sw") left = Math.min(Math.max(0, left + dx), right - min)
  if (edge === "ne" || edge === "se") right = Math.max(Math.min(1, right + dx), left + min)
  if (edge === "nw" || edge === "ne") top = Math.min(Math.max(0, top + dy), bottom - min)
  if (edge === "sw" || edge === "se") bottom = Math.max(Math.min(1, bottom + dy), top + min)
  return [left, top, right - left, bottom - top]
}

/** CSS that shows only the crop of a picture in a box: the image's size and offset in % of the box. */
export function cropView(crop: Shot["crop"]): { width: string; left: string; top: string; ratio: number } | null {
  if (!crop) return null
  const [x, y, w, h] = crop
  return { width: `${100 / w}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%`, ratio: w / h }
}

// ------------------------------------------------------------ the pictures made here, and which can go

/** Pictures made on this device (id → when, ms; its parts): only these are ever deleted here. */
export type MadeShots = Record<string, { at: number; parts: number }>

/** The pictures referred to by any note of any chat (Recently Deleted's too). */
export function shotsInUse(threads: Record<string, { m?: Array<{ shot?: Shot }> }>): Set<string> {
  const used = new Set<string>()
  for (const t of Object.values(threads)) for (const m of t.m ?? []) if (m.shot?.id) used.add(m.shot.id)
  return used
}

/** The pictures made here that no note has had for SHOT_LIMITS.orphanDays: they can be deleted. */
export function orphanShots(made: MadeShots, used: Set<string>, now = Date.now()): string[] {
  const days = SHOT_LIMITS.orphanDays * 24 * 3600_000
  return Object.entries(made).filter(([id, s]) => !used.has(id) && now - s.at >= days).map(([id]) => id)
}

/** A base64 text in parts of `size` characters. */
export function chunks(text: string, size: number = SHOT_LIMITS.chunk): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length ? out : [""]
}
