// Renders the takes recorded by tips-record.mjs into the short looping clips shown in the app's Tips
// (540 × 794, 30 fps, H.264, no audio): the panel area of the iPhone screen, a touch marker on every
// tap and swipe, a quick fade at both ends so the loop doesn't jump. Needs ffmpeg with libx264 on PATH.
//   node tools/store/tips-render.mjs <recDir> <outDir>
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const [recArg, outArg] = process.argv.slice(2)
const REC = resolve(recArg)
const OUT = resolve(outArg)
mkdirSync(OUT, { recursive: true })

const SCALE = 3 // the takes are captured at @3x of a 430 × 800 viewport
const TOP = 168 // CSS px: the panel's top edge (its header stays in the clip)
const W = 540
const H = 794
const K = (W / 430) // output px per CSS px
const FPS = 30
const HOLD = 1.0 // the last frame stays this long before the loop starts again, s
const FADE = 0.25
const MARK = 52 // touch marker, output px

// The touch marker (the same look as the App Store preview), drawn once as a transparent PNG.
const marker = join(OUT, ".marker.png")
{
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: MARK + 16, height: MARK + 16 } })
  await page.setContent(`<body style="margin:0;background:transparent"><div style="position:absolute;left:8px;top:8px;width:${MARK - 6}px;height:${MARK - 6}px;border-radius:50%;background:rgba(255,255,255,.6);border:3px solid rgba(37,99,235,.6);box-shadow:0 4px 14px rgba(16,38,96,.35)"></div></body>`)
  await page.screenshot({ path: marker, omitBackground: true })
  await browser.close()
}
const half = (MARK + 16) / 2

for (const file of readdirSync(REC).filter((f) => f.endsWith(".json")).sort()) {
  const name = file.replace(/\.json$/, "")
  const { frames, events } = JSON.parse(readFileSync(join(REC, file), "utf8"))
  const t0 = frames[0].t
  const end = events.find((e) => e.type === "end").t - t0 + HOLD
  // Frames come at irregular times: the concat demuxer gives each its real duration.
  const list = frames.map((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t - t0 : end
    return `file '${join(REC, name, f.f)}'\nduration ${Math.max(0.001, next - (f.t - t0)).toFixed(4)}`
  })
  list.push(`file '${join(REC, name, frames.at(-1).f)}'`)
  const listFile = join(OUT, `.${name}.txt`)
  writeFileSync(listFile, list.join("\n") + "\n")

  const x = (cssX) => (cssX * K - half).toFixed(1)
  const y = (cssY) => ((cssY - TOP) * K - half).toFixed(1)
  const marks = events.filter((e) => e.type === "tap" || e.type === "swipe")
  let graph = `[0:v]fps=${FPS},crop=${430 * SCALE}:${(800 - TOP) * SCALE}:0:${TOP * SCALE},scale=${W}:${H}:flags=lanczos,setsar=1[v0]`
  marks.forEach((e, i) => {
    const a = (e.t - t0).toFixed(3)
    const yExpr = e.type === "swipe" ? `'${y(e.y)}+${(e.dy * K).toFixed(1)}*min(1,max(0,(t-${a})/0.35))'` : y(e.y)
    const until = (e.t - t0 + (e.type === "swipe" ? 0.6 : 0.45)).toFixed(3)
    graph += `;[v${i}][1:v]overlay=x=${x(e.x)}:y=${yExpr}:eval=frame:enable='between(t,${a},${until})'[v${i + 1}]`
  })
  graph += `;[v${marks.length}]fade=t=in:st=0:d=${FADE}:color=white,fade=t=out:st=${(end - FADE).toFixed(3)}:d=${FADE}:color=white,format=yuv420p[out]`

  const out = join(OUT, `${name}.mp4`)
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-loop", "1", "-i", marker,
    "-filter_complex", graph, "-map", "[out]", "-t", end.toFixed(3),
    "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", "-an", out
  ])
  rmSync(listFile)
  const kb = (readFileSync(out).length / 1024).toFixed(0)
  console.log(`${name}.mp4  ${end.toFixed(1)} s  ${kb} KB`)
}
if (existsSync(marker)) rmSync(marker)
