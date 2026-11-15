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

/**
 * How long a capture may take (ms): our panel and circle are hidden meanwhile, so never long (107, the owner: on Gmail
 * they were gone for some 15 s). `gap`: a form of Safari's capture that hasn't answered by then gets the next one
 * started beside it; `total`: the background gives up; `wait`: the page stops waiting for the background; `full`: a
 * whole page's screens altogether (what's taken by then is the picture).
 */
export const SHOT_TIMES = { gap: 700, total: 3000, wait: 3600, full: 12_000 } as const

/**
 * The first answer `good` accepts among `tries`, each started `gap` ms after the one before unless that one has failed
 * already (then at once); all of them given up `total` ms from the start. A form that never answers (iPhone's Safari
 * left one so) can't hold the others back, and the wait is `total` whatever happens. `error`: the last failure's words.
 */
export function firstAnswer<T>(tries: Array<() => Promise<T>>, good: (value: T) => boolean, times: { gap: number; total: number }): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let done = false
    let started = 0
    let open = 0
    let last = tries.length ? "timeout" : "unavailable"
    let next: ReturnType<typeof setTimeout> | undefined
    const finish = (out: { ok: true; value: T } | { ok: false; error: string }) => {
      if (done) return
      done = true
      clearTimeout(next)
      clearTimeout(end)
      resolve(out)
    }
    const end = setTimeout(() => finish({ ok: false, error: last }), times.total)
    const start = () => {
      clearTimeout(next)
      if (done) return
      if (started >= tries.length) {
        if (open === 0) finish({ ok: false, error: last })
        return
      }
      const attempt = tries[started++]
      open++
      let work: Promise<T>
      try {
        work = Promise.resolve(attempt())
      } catch (err) {
        work = Promise.reject(err)
      }
      work.then((value) => {
        open--
        if (good(value)) return finish({ ok: true, value })
        last = "no image"
        start()
      }, (err) => {
        open--
        last = (err instanceof Error ? err.message : String(err)).slice(0, 160) || "failed"
        start()
      })
      if (started < tries.length) next = setTimeout(start, times.gap)
    }
    start()
  })
}

/** A new picture's id. */
export function newShotId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** A valid id (ours: letters, digits, _ and -; no path in it). */
export function validShotId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

// ------------------------------------------------------------ the whole page, screen by screen

/**
 * The next screen of a page `page` tall when `shown` CSS px of it are in the picture and the viewport is `view` tall now
 * (Safari's toolbars change it as the page scrolls): where to scroll, and the part of the screen that adds the next
 * rows (the last screen scrolls only to the page's end). Null when the page is all in.
 */
export function nextScreen(shown: number, page: number, view: number): { scrollY: number; from: number; height: number } | null {
  if (shown >= page || view <= 0) return null
  const scrollY = Math.max(0, Math.min(shown, page - view))
  const from = shown - scrollY
  const height = Math.min(view - from, page - shown)
  return height > 0 ? { scrollY, from, height } : null
}

/** The colour of the two marks put at the viewport's top and bottom left corners for a capture. */
export const MARK_RGB = [255, 0, 238] as const

/**
 * Where the page is in a capture, from a column of its pixels (RGBA) at the marks: the rows from the top mark's first to
 * the bottom mark's last. iPhone's Safari captures the whole screen (the status bar above the page, its toolbar below);
 * a Mac's, the page only. Null when the marks aren't both there.
 */
export function markedRows(column: ArrayLike<number>, height: number, tolerance = 48): { top: number; height: number } | null {
  const marked = (y: number) => MARK_RGB.every((v, c) => Math.abs(column[y * 4 + c] - v) <= tolerance)
  let first = -1
  let last = -1
  for (let y = 0; y < height; y++) if (marked(y)) {
    if (first < 0) first = y
    last = y
  }
  if (first < 0 || last - first < 8) return null
  return { top: first, height: last - first + 1 }
}

/** The picture's size for a capture `w`×`h` (device px), within the width and pixel caps. */
export function fitSize(w: number, h: number, maxWidth: number, maxPixels: number = SHOT_LIMITS.pixels): { w: number; h: number; scale: number } {
  let scale = Math.min(1, maxWidth / Math.max(1, w))
  if (w * scale * h * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h))
  // Rounded down: never over the cap.
  return { w: Math.max(1, Math.floor(w * scale)), h: Math.max(1, Math.floor(h * scale)), scale }
}

/**
 * The rows of a capture that are the page: iPhone's Safari gives the whole screen, the status bar's strip on top of the
 * page (its height is what's beyond the page's own, at the capture's scale); elsewhere all of it.
 */
export function pageRows(capture: { width: number; height: number }, view: { width: number; height: number }): { top: number; height: number } {
  const want = Math.round(view.height * (capture.width / Math.max(1, view.width)))
  const extra = capture.height - want
  return extra > 2 && extra < capture.height * 0.25 ? { top: extra, height: want } : { top: 0, height: capture.height }
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
