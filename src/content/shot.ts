// «Снимок страницы в заметке» (2.7), the page's part: the picture of what's on screen (Safari's capture, through the
// background), or of the whole page, screen by screen and stitched here. The panel and the ✦ circle (everything of
// ours, in one host) hide for the moment it takes, so they're not in it. What stays put at the top of the page (a
// sticky header) is in the picture once, at its top; what stays at the bottom (a cookie bar) isn't in a whole page's.

import { fitSize, newShotId, SHOT_LIMITS, stitchPlan, type Shot, type ShotKind } from "../shared/shots"
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
  // A very heavy page: its first 6000 elements (headers and bars come early).
  for (const el of Array.from(all).slice(0, 6000)) {
    if (el.tagName.toLowerCase() === HOST_TAG) continue
    const pos = getComputedStyle(el).position
    if (pos !== "fixed" && pos !== "sticky") continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) out.push(el)
    if (out.length > 200) break
  }
  return out
}

async function capture(): Promise<HTMLImageElement> {
  const reply = await send<{ ok: boolean; data?: string; code?: ShotFailure }>({ type: "shotCapture" })
  if (!reply?.ok || !reply.data) throw Object.assign(new Error("capture"), { code: reply?.code ?? "FAILED" })
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
  { ok: true; shot: Omit<Shot, "parts">; data: string; cut: boolean; screens: number } | { ok: false; code: ShotFailure }
> {
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
    if (kind === "visible") {
      const img = await capture()
      const size = fitSize(img.naturalWidth, img.naturalHeight, SHOT_LIMITS.width)
      canvas = document.createElement("canvas")
      canvas.width = size.w
      canvas.height = size.h
      canvas.getContext("2d")!.drawImage(img, 0, 0, size.w, size.h)
    } else {
      const view = window.innerHeight
      const page = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
      const plan = stitchPlan(page, view)
      cut = plan.cut
      screens = plan.steps.length
      let ctx: CanvasRenderingContext2D | null = null
      let scale = 1
      let lastShot = 0
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]
        progress?.(i + 1, plan.steps.length)
        window.scrollTo({ left: 0, top: step.scrollY, behavior: "instant" as ScrollBehavior })
        // What stays put at the bottom (a cookie bar, a "Buy" bar) would land mid-picture: never in it. What stays at
        // the top (a header) is in the first screen only.
        if (i <= 1) for (const el of staying()) {
          if (hidden.some((h) => h.el === el) || (i === 0 && el.getBoundingClientRect().top < view * 0.5)) continue
          hidden.push({ el, was: el.style.visibility })
          el.style.setProperty("visibility", "hidden", "important")
        }
        // The page settles (lazy pictures, the scroll's last frame); and captures are at most two a second.
        await frame()
        await frame()
        await wait(Math.max(160, 520 - (Date.now() - lastShot)))
        const img = await capture()
        lastShot = Date.now()
        // Device pixels per CSS pixel, and where this screen's part really is (a page may not scroll exactly there).
        const dpr = img.naturalHeight / view
        const actual = window.scrollY
        const from = Math.max(0, Math.min(view - step.height, step.to - actual))
        if (!ctx) {
          const size = fitSize(img.naturalWidth, plan.height * dpr, SHOT_LIMITS.fullWidth)
          scale = size.scale
          canvas = document.createElement("canvas")
          canvas.width = size.w
          canvas.height = size.h
          ctx = canvas.getContext("2d")!
          ctx.fillStyle = "#fff"
          ctx.fillRect(0, 0, size.w, size.h)
        }
        ctx.drawImage(img, 0, from * dpr, img.naturalWidth, step.height * dpr, 0, Math.round(step.to * dpr * scale), Math.round(img.naturalWidth * scale), Math.round(step.height * dpr * scale))
      }
      canvas = canvas!
    }
    const data = jpeg(canvas, SHOT_LIMITS.quality)
    return { ok: true, shot: { id: newShotId(), kind, w: canvas.width, h: canvas.height, th: thumbnail(canvas) }, data, cut, screens }
  } catch (err) {
    return { ok: false, code: ((err as { code?: ShotFailure }).code) ?? "FAILED" }
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
