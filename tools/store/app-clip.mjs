// The "Your chats in the app" clip in the app's Tips (TipClips/<en|ru>/appchat.mp4): a Simulator screen recording
// turned into a clip like tips-render.mjs makes (540 × 794, 30 fps, H.264, a touch marker on every tap, white fade
// at both ends). Long still stretches (the time it takes to drive the Simulator) are cut down to a short pause, and
// each tap's marker shows just before the screen changes.
//   1. Demo chats: node tools/store/app-clip-chats.mjs <en|ru> chats.json, copied to the app's App Group Chats/
//      (xcrun simctl get_app_container <udid> com.contextflow.app group.com.contextflow.shared).
//   2. A Debug build on the Simulator against the stand: -CFApiBase http://localhost:8787 (tools/preview, STREAM_DELAY_MS=22),
//      the chat open and its question field focused (a typed key hides the on-screen keyboard).
//   3. xcrun simctl io <udid> recordVideo --codec=h264 raw.mp4 while asking, then Tag, a tag and Done; note when the
//      recording started and when each tap was sent (host seconds) in taps.json.
//   4. node tools/store/app-clip.mjs raw.mp4 taps.json appchat.mp4 200   (the clip shows the screen from 200 pt down)
// taps.json: { start: <host s when the recording started>, taps: [{ t: <host s>, x: <pt>, y: <pt> }] }
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"

const [raw, tapsFile, out, cropArg] = process.argv.slice(2)
const { start, taps } = JSON.parse(readFileSync(tapsFile, "utf8"))
const W = 540, H = 794, FPS = 30
const HOLD = Number(process.env.HOLD ?? 0.7) // a still stretch keeps this much after a change…
const LEAD = 0.4 // …and this much before the next one (the marker shows in it)
const END_HOLD = 1.2
const START_LEAD = 1.0 // still time kept before the first change
const FADE = 0.25
const MARK = 52

const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", raw]))
const srcW = probe.streams[0].width, srcH = probe.streams[0].height, dur = Number(probe.format.duration)
const PX = srcW / 402 // px per pt (iPhone 17: 402 pt wide)
const cropH = Math.round(srcW * H / W / 2) * 2
const cropTop = cropArg !== undefined ? Math.round(Number(cropArg) * PX) : srcH - cropH
const K = W / srcW

// Still stretches.
const log = spawnSync("ffmpeg", ["-v", "info", "-i", raw, "-vf", "scale=402:-2,freezedetect=n=-55dB:d=0.3", "-an", "-f", "null", "-"], { encoding: "utf8" }).stderr
const freezes = []
let fs = null
for (const line of log.split("\n")) {
  const s = /freeze_start: ([\d.]+)/.exec(line)
  const e = /freeze_end: ([\d.]+)/.exec(line)
  if (s) fs = Number(s[1])
  if (e && fs !== null) { freezes.push([fs, Number(e[1])]); fs = null }
}
if (fs !== null) freezes.push([fs, dur])

// What to keep: everything that moves, and a short pause around each change.
const cuts = []
for (const [a, b] of freezes) {
  const from = a === 0 ? 0 : a + HOLD
  const to = b >= dur - 0.05 ? Math.max(from, dur - Math.max(0, (b - a) - END_HOLD)) : b - LEAD
  if (b >= dur - 0.05) { if (b - a > END_HOLD) cuts.push([a + END_HOLD, dur]); continue }
  if (a === 0) { if (b > START_LEAD) cuts.push([0, b - START_LEAD]); continue }
  if (to - from > 0.05) cuts.push([from, to])
}
const keep = []
let at = 0
for (const [a, b] of cuts) { if (a > at) keep.push([at, a]); at = Math.max(at, b) }
if (at < dur) keep.push([at, dur])
const outTime = (t) => { let o = 0; for (const [a, b] of keep) { if (t >= b) o += b - a; else if (t >= a) return o + (t - a); else break } return o }
const kept = keep.reduce((n, [a, b]) => n + (b - a), 0)
const lastStill = freezes.length && freezes.at(-1)[1] >= dur - 0.05 ? Math.min(END_HOLD, dur - freezes.at(-1)[0]) : 0
const pad = Math.max(0, END_HOLD - lastStill)
const total = kept + pad

// Each tap: the first change on screen after it was sent.
const changes = freezes.map(([, b]) => b).filter((b) => b < dur - 0.05)
const marks = taps.map((tap) => {
  const sent = tap.t - start
  const change = changes.find((c) => c >= sent - 0.3) ?? sent
  const shown = outTime(Math.max(0, change - 0.35))
  return { x: tap.x * PX * K, y: (tap.y * PX - cropTop) * K, from: shown, to: shown + 0.45 }
})

if (process.env.DEBUG) console.log(JSON.stringify({ freezes: freezes.map(f => f.map(x => +x.toFixed(2))), keep: keep.map(k => k.map(x => +x.toFixed(2))), marks: marks.map(m => [+m.from.toFixed(2), Math.round(m.x), Math.round(m.y)]), taps: taps.map(t => +(t.t - start).toFixed(2)) }))
const dir = mkdtempSync(join(tmpdir(), "sim-clip-"))
const marker = join(dir, "marker.png")
{
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: MARK + 16, height: MARK + 16 } })
  await page.setContent(`<body style="margin:0;background:transparent"><div style="position:absolute;left:8px;top:8px;width:${MARK - 6}px;height:${MARK - 6}px;border-radius:50%;background:rgba(255,255,255,.6);border:3px solid rgba(37,99,235,.6);box-shadow:0 4px 14px rgba(16,38,96,.35)"></div></body>`)
  await page.screenshot({ path: marker, omitBackground: true })
  await browser.close()
}
const half = (MARK + 16) / 2
const select = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+")
let graph = `[0:v]fps=${FPS},select='${select}',setpts=N/${FPS}/TB,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},crop=${srcW}:${cropH}:0:${cropTop},scale=${W}:${H}:flags=lanczos,setsar=1[v0]`
marks.forEach((m, i) => {
  graph += `;[v${i}][1:v]overlay=x=${(m.x - half).toFixed(1)}:y=${(m.y - half).toFixed(1)}:enable='between(t,${m.from.toFixed(3)},${m.to.toFixed(3)})'[v${i + 1}]`
})
graph += `;[v${marks.length}]fade=t=in:st=0:d=${FADE}:color=white,fade=t=out:st=${(total - FADE).toFixed(3)}:d=${FADE}:color=white,format=yuv420p[out]`
writeFileSync(join(dir, "graph.txt"), graph)
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-loop", "1", "-i", marker, "-filter_complex", graph, "-map", "[out]", "-t", total.toFixed(3),
  "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", "-an", out])
rmSync(dir, { recursive: true })
console.log(`${out}: ${total.toFixed(1)} s from ${dur.toFixed(1)} s, ${marks.length} taps, ${(readFileSync(out).length / 1024).toFixed(0)} KB`)
