// «Снимок страницы в заметке» (2.7), the page's part: the picture of what's on screen (Safari's capture, through the
// background), or of the whole page, screen by screen and stitched here. The panel and the ✦ circle (everything of
// ours, in one host) hide for the moment it takes, so they're not in it. What stays put at the top of the page (a
// sticky header) is in the picture once, at its top; what stays at the bottom (a cookie bar) isn't in a whole page's.

import { fitSize, markedRows, MARK_RGB, newShotId, nextScreen, pageRows, SHOT_LIMITS, SHOT_TIMES, windowScrolls, type Shot, type ShotKind } from "../shared/shots"
import { HOST_TAG } from "./page"
import { panelRoot } from "./root"

export type ShotFailure = "UNAVAILABLE" | "FAILED"

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function send<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply: T) => {
        void chrome.runtime.lastError
        resolve(reply ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("image"))
    img.src = src
  })
}

/** Everything of ours on the page: hidden while the picture is taken. */
function ourHost(): HTMLElement | null {
  return (panelRoot()?.host as HTMLElement | undefined) ?? (document.querySelector(HOST_TAG) as HTMLElement | null)
}

/** The page's own elements that stay put on screen (fixed, sticky): hidden for the screens after the first. */
function staying(): HTMLElement[] {
  const out: HTMLElement[] = []
  const all = document.body?.querySelectorAll<HTMLElement>("*") ?? []
  // A very heavy page: its first 6000 elements (headers and bars come early), and never longer than a moment (107: a
  // mail app's page has tens of thousands, each style read costing a layout, all with our panel hidden).
  const until = Date.now() + 150
  let n = 0
  for (const el of Array.from(all).slice(0, 6000)) {
    if (++n % 200 === 0 && Date.now() > until) break
    if (el.tagName.toLowerCase() === HOST_TAG) continue
    const pos = getComputedStyle(el).position
    if (pos !== "fixed" && pos !== "sticky") continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) out.push(el)
    if (out.length > 200) break
  }
  return out
}

/** Mark size (CSS px): the marks sit in the viewport's left corners, top and bottom, for the capture only. */
const MARK = 4

/** Marks at the viewport's top and bottom left corners: they tell where the page is in the capture. */
function placeMarks(): () => void {
  const marks = (["top", "bottom"] as const).map((side) => {
    const el = document.createElement("div")
    el.setAttribute("aria-hidden", "true")
    el.style.cssText = `all:initial;display:block;position:fixed;left:0;${side}:0;width:${MARK}px;height:${MARK}px;background:rgb(${MARK_RGB.join(",")});z-index:2147483647;pointer-events:none`
    document.documentElement.appendChild(el)
    return el
  })
  return () => marks.forEach((m) => m.remove())
}

/** The rows of a capture that are the page, from the marks; else from its size (the page is all of it, or below). */
function pageIn(img: HTMLImageElement): { top: number; height: number } {
  const c = document.createElement("canvas")
  c.width = 1
  c.height = img.naturalHeight
  const ctx = c.getContext("2d", { willReadFrequently: true })!
  const x = Math.max(1, Math.floor((img.naturalWidth / window.innerWidth) * MARK / 2))
  ctx.drawImage(img, x, 0, 1, img.naturalHeight, 0, 0, 1, img.naturalHeight)
  return markedRows(ctx.getImageData(0, 0, 1, img.naturalHeight).data, img.naturalHeight)
    ?? pageRows({ width: img.naturalWidth, height: img.naturalHeight }, { width: window.innerWidth, height: window.innerHeight })
}

/** The marks painted over in the picture: each corner patch takes the pixels just beside it. */
function unmark(ctx: CanvasRenderingContext2D, rows: Array<{ y: number; h: number }>, size: number): void {
  for (const r of rows) if (r.h > 0) ctx.drawImage(ctx.canvas, size, r.y, size, r.h, 0, r.y, size, r.h)
}

async function capture(): Promise<HTMLImageElement> {
  // Never longer than this: everything of ours is hidden meanwhile (the background gives up a little sooner).
  const reply = await Promise.race([
    send<{ ok: boolean; data?: string; code?: ShotFailure; error?: string }>({ type: "shotCapture" }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SHOT_TIMES.wait))
  ])
  if (!reply?.ok || !reply.data) throw Object.assign(new Error(reply?.error ?? "capture"), { code: reply?.code ?? "FAILED", detail: reply?.error ?? (reply ? "" : "no reply") })
  return loadImage(reply.data)
}

function jpeg(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL("image/jpeg", quality)
}

/** The thumbnail kept in the note: the picture's top, at most SHOT_LIMITS.thumbWidth × thumbHeight. */
function thumbnail(source: HTMLCanvasElement): string {
  const w = Math.min(SHOT_LIMITS.thumbWidth, source.width)
  const scale = w / source.width
  const h = Math.min(SHOT_LIMITS.thumbHeight, Math.round(source.height * scale))
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  c.getContext("2d")!.drawImage(source, 0, 0, source.width, h / scale, 0, 0, w, h)
  return jpeg(c, SHOT_LIMITS.thumbQuality)
}

/**
 * The picture of the page: what's on screen, or the whole page (at most SHOT_LIMITS.screens screens; `cut` when it went
 * on further). `progress` hears each screen of a whole page.
 */
export async function takeShot(kind: ShotKind, progress?: (screen: number, of: number) => void): Promise<
  { ok: true; shot: Omit<Shot, "parts">; data: string; cut: boolean; screens: number } | { ok: false; code: ShotFailure; detail?: string }
> {
  // The extension was updated while this tab stayed open: nothing answers here any more, so nothing is hidden for it.
  if (!chrome.runtime?.id) return { ok: false, code: "UNAVAILABLE", detail: "no extension" }
  const host = ourHost()
  const hostVisibility = host?.style.visibility ?? ""
  const startX = window.scrollX
  const startY = window.scrollY
  const hidden: Array<{ el: HTMLElement; was: string }> = []
  try {
    if (host) host.style.setProperty("visibility", "hidden", "important")
    await frame()
    await frame()
    await wait(60)
    let canvas: HTMLCanvasElement
    let cut = false
    let screens = 1
    // A page whose window doesn't scroll (a mail app: its own scroller holds the text) is all on screen: its whole
    // page is what's visible, taken once, with nothing of the page hidden.
    const whole = kind === "full" && windowScrolls(document, window)
    const unplace = placeMarks()
    try {
      if (!whole) {
        const img = await capture()
        const rows = pageIn(img)
        const size = fitSize(img.naturalWidth, rows.height, SHOT_LIMITS.width)
        canvas = document.createElement("canvas")
        canvas.width = size.w
        canvas.height = size.h
        const ctx = canvas.getContext("2d")!
        ctx.drawImage(img, 0, rows.top, img.naturalWidth, rows.height, 0, 0, size.w, size.h)
        const mark = Math.ceil((size.w / window.innerWidth) * MARK) + 1
        unmark(ctx, [{ y: 0, h: mark }, { y: size.h - mark, h: mark }], mark)
      } else {
        const page = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
        // At most so many screens, as tall as the viewport is now (or a little more, should Safari's bars fold away).
        const most = Math.min(page, Math.ceil(window.innerHeight * 1.25) * SHOT_LIMITS.screens)
        let ctx: CanvasRenderingContext2D | null = null
        let scale = 1
        let dpr = 1
        let shown = 0
        let lastShot = 0
        let still = false
        const marks: Array<{ y: number; h: number }> = []
        const began = Date.now()
        for (let i = 0; i < SHOT_LIMITS.screens; i++) {
          const step = nextScreen(shown, page, window.innerHeight)
          if (!step) break
          // The screens altogether never take longer than this: what's taken by then is the picture.
          if (i > 0 && Date.now() - began > SHOT_TIMES.full) break
          progress?.(i + 1, Math.min(SHOT_LIMITS.screens, i + 1 + Math.ceil((page - shown - step.height) / Math.max(1, window.innerHeight))))
          window.scrollTo({ left: 0, top: step.scrollY, behavior: "instant" as ScrollBehavior })
          // What stays put at the bottom (a cookie bar, a "Buy" bar) would land mid-picture: never in it. What stays at
          // the top (a header) is in the first screen only.
          if (i <= 1) for (const el of staying()) {
            if (hidden.some((h) => h.el === el) || (i === 0 && el.getBoundingClientRect().top < window.innerHeight * 0.5)) continue
            hidden.push({ el, was: el.style.visibility })
            el.style.setProperty("visibility", "hidden", "important")
          }
          // The page settles (lazy pictures, the scroll's last frame, Safari's bars); captures at most two a second.
          await frame()
          await frame()
          await wait(Math.max(200, 520 - (Date.now() - lastShot)))
          // The page didn't move (its own scroller holds the text, the window has none: a mail app): one screen is all.
          if (i > 0 && window.scrollY < step.scrollY - 1 && shown - window.scrollY >= window.innerHeight - 1) {
            still = true
            break
          }
          let img: HTMLImageElement
          try {
            img = await capture()
          } catch (err) {
            // A later screen that can't be taken leaves the picture with the screens before it.
            if (i === 0) throw err
            break
          }
          lastShot = Date.now()
          // Where the page is in this capture, and where this screen's new rows really are (the page may not have
          // scrolled exactly there, and the viewport may be another height than a moment ago).
          const rows = pageIn(img)
          // The scale from the width (it doesn't change), the viewport's height as captured from the marks (Safari's bar
          // may have moved since).
          dpr = img.naturalWidth / window.innerWidth
          const view = Math.round(rows.height / dpr)
          const from = Math.max(0, shown - window.scrollY)
          const height = Math.min(view - from, page - shown)
          if (height <= 0) break
          if (!ctx) {
            const size = fitSize(img.naturalWidth, most * dpr, SHOT_LIMITS.fullWidth)
            scale = size.scale
            canvas = document.createElement("canvas")
            canvas.width = size.w
            canvas.height = size.h
            ctx = canvas.getContext("2d")!
            ctx.fillStyle = "#fff"
            ctx.fillRect(0, 0, size.w, size.h)
          }
          const y = Math.round(shown * dpr * scale)
          const h = Math.min(Math.round(height * dpr * scale), canvas!.height - y)
          if (h <= 0) break
          ctx.drawImage(img, 0, rows.top + from * dpr, img.naturalWidth, (h / scale), 0, y, Math.round(img.naturalWidth * scale), h)
          // The marks: the top one when this part starts at the viewport's top, the bottom one when it reaches its end.
          const mark = Math.ceil(dpr * scale * MARK) + 1
          if (from < MARK) marks.push({ y, h: Math.min(h, mark) })
          if (from + height > view - MARK) marks.push({ y: Math.max(y, y + h - mark), h: Math.min(h, mark) })
          shown += height
          screens = i + 1
        }
        cut = shown < page && !still
        if (!ctx) throw Object.assign(new Error("no screen"), { code: "FAILED" })
        unmark(ctx, marks, Math.ceil(dpr * scale * MARK) + 1)
        // Down to what was taken.
        const total = Math.min(canvas!.height, Math.round(shown * dpr * scale))
        if (total < canvas!.height) {
          const done = document.createElement("canvas")
          done.width = canvas!.width
          done.height = total
          done.getContext("2d")!.drawImage(canvas!, 0, 0, canvas!.width, total, 0, 0, canvas!.width, total)
          canvas = done
        }
      }
    } finally {
      unplace()
    }
    canvas = canvas!
    const data = jpeg(canvas, SHOT_LIMITS.quality)
    return { ok: true, shot: { id: newShotId(), kind: whole ? "full" : "visible", w: canvas.width, h: canvas.height, th: thumbnail(canvas) }, data, cut, screens }
  } catch (err) {
    return { ok: false, code: ((err as { code?: ShotFailure }).code) ?? "FAILED", detail: (err as { detail?: string }).detail ?? (err instanceof Error ? err.message : "") }
  } finally {
    for (const h of hidden) {
      if (h.was) h.el.style.visibility = h.was
      else h.el.style.removeProperty("visibility")
    }
    if (kind === "full") window.scrollTo({ left: startX, top: startY, behavior: "instant" as ScrollBehavior })
    if (host) {
      if (hostVisibility) host.style.visibility = hostVisibility
      else host.style.removeProperty("visibility")
    }
  }
}

/** Keeps the picture (the background: the native side, or this extension's storage); its number of parts. */
export async function keepShot(id: string, data: string): Promise<number | null> {
  const reply = await send<{ ok: boolean; parts?: number }>({ type: "shotPut", id, data })
  return reply?.ok && typeof reply.parts === "number" ? reply.parts : null
}

/** A note's picture to look at (from here, the App Group or iCloud). */
export async function openShot(shot: Shot): Promise<string | null> {
  const reply = await send<{ ok: boolean; data?: string }>({ type: "shotGet", id: shot.id, parts: shot.parts })
  return reply?.ok && reply.data ? reply.data : null
}
