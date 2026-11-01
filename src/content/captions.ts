// Captions of videos embedded in a page with the standard HTML5 player (<video> with <track>).
// Players that draw their own captions (YouTube embeds, Vimeo…) aren't covered.

import { formatTranscript, type Segment } from "./youtube.ts"

export interface CaptionsRead {
  name: string
  text: string
  duration: number
}

/** "00:01:02.500" or "01:02.500" → ms (NaN otherwise). */
function vttTime(text: string): number {
  const m = text.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/)
  if (!m) return NaN
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"))
}

/** Cues of a WebVTT (or SRT) file, tags removed and repeats (rolling captions) dropped. */
export function parseVtt(raw: string): Segment[] {
  const segments: Segment[] = []
  for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n")
    const at = lines.findIndex((l) => l.includes("-->"))
    if (at < 0) continue
    const start = vttTime(lines[at].split("-->")[0])
    const text = lines.slice(at + 1).join(" ").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
    if (!text || !Number.isFinite(start)) continue
    if (segments.length && segments[segments.length - 1].text === text) continue
    segments.push({ start, text })
  }
  return segments
}

function cueSegments(track: TextTrack): Segment[] {
  const segments: Segment[] = []
  for (const cue of Array.from(track.cues ?? [])) {
    const text = ((cue as VTTCue).text ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
    if (text && segments[segments.length - 1]?.text !== text) segments.push({ start: cue.startTime * 1000, text })
  }
  return segments
}

/** The track to read: the page's language, else the default one, else the first. */
function pickTrack(video: HTMLVideoElement, language: string): HTMLTrackElement | null {
  const tracks = [...video.querySelectorAll<HTMLTrackElement>("track")].filter((t) => /^(subtitles|captions)$/i.test(t.kind || "subtitles") && t.src)
  const lang = language.slice(0, 2).toLowerCase()
  return tracks.find((t) => t.srclang?.toLowerCase().startsWith(lang)) ?? tracks.find((t) => t.default) ?? tracks[0] ?? null
}

function videoName(video: HTMLVideoElement, track: HTMLTrackElement | null): string {
  const figure = video.closest("figure")?.querySelector("figcaption")?.textContent?.trim()
  return (video.getAttribute("title") || video.getAttribute("aria-label") || figure || track?.label || "").slice(0, 120)
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: "include" })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/** Cues the browser loaded for the track (switching it to "hidden" loads them without showing them). */
async function loadedCues(track: HTMLTrackElement, timeoutMs: number): Promise<Segment[]> {
  const textTrack = track.track
  if (!textTrack) return []
  const mode = textTrack.mode
  if (mode === "disabled") textTrack.mode = "hidden"
  const deadline = Date.now() + timeoutMs
  while (track.readyState < 2 && track.readyState !== 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  const segments = cueSegments(textTrack)
  if (mode === "disabled") textTrack.mode = "disabled"
  return segments
}

/**
 * Captions of the largest video on the page that has them (null when none has), within `timeoutMs`.
 * Also reads tracks a player added from script while they are on (no <track> element).
 */
export async function readCaptions(doc: Document, language: string, timeoutMs = 3_000): Promise<CaptionsRead | null> {
  const videos = [...doc.querySelectorAll<HTMLVideoElement>("video")]
    .map((v) => ({ v, area: v.clientWidth * v.clientHeight }))
    .sort((a, b) => b.area - a.area)
    .map((x) => x.v)
  for (const video of videos) {
    const track = pickTrack(video, language)
    let segments: Segment[] = []
    if (track) {
      const body = await fetchText(track.src)
      segments = body ? parseVtt(body) : []
      if (!segments.length) segments = await loadedCues(track, timeoutMs)
    } else {
      const live = Array.from(video.textTracks ?? []).find((t) => /^(subtitles|captions)$/.test(t.kind) && t.mode !== "disabled" && (t.cues?.length ?? 0) > 0)
      if (live) segments = cueSegments(live)
    }
    if (segments.length) {
      const duration = Number.isFinite(video.duration) ? video.duration * 1000 : segments[segments.length - 1].start
      return { name: videoName(video, track), text: formatTranscript(segments), duration }
    }
  }
  return null
}

/** True when some video on the page has caption tracks (worth a "reading captions" moment). */
export function hasCaptionTracks(doc: Document): boolean {
  return Boolean(doc.querySelector("video track[src]"))
}
