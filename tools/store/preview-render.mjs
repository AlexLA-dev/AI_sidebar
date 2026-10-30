// Renders the App Store app preview for iPhone 6.9"/6.5" (886 × 1920, 30 fps, ≤ 30 s)
// from the takes recorded by preview-record.mjs. Same look as the screenshots (compose.mjs):
// caption on top, the real UI below (no device frame: previews must be screen captures),
// a touch marker on every tap and a closing card. Needs ffmpeg with libx264 on PATH.
//   node tools/store/preview-render.mjs <recDir> <out.mp4> [lang:en|ru]
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.CF_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [recArg, outArg, lang = "en"] = process.argv.slice(2)
const REC = resolve(recArg)
const OUT = resolve(outArg)
const TMP = join(dirname(OUT), `.preview-${lang}`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, "frames"), { recursive: true })
const file = (p) => pathToFileURL(p).href

const FPS = 30
const W = 886
const H = 1920
const XFADE = 0.3 // cross-fade between takes, s
const END = 2.4 // closing card, s
const CAP_OUT = 0.18 // old caption fades out, s
const CAP_IN = 0.27 // then the new one rises in, s

// Captions match the screenshot set (tools/store/compose.mjs).
const COPY = {
  en: {
    summary: ["Summarize any", "page in Safari"],
    keys: ["Get key facts", "at a glance"],
    selection: ["Explain any", "selected text"],
    ask: ["Ask anything", "about the page"],
    translate: ["Translate any", "page instantly"],
    notes: ["Keep notes", "right in the chat"],
    free: "5 free answers a day",
    nosignup: "No sign-up needed",
    host: "weeklyreview.com",
    foreignHost: "delovoyobzor.ru"
  },
  ru: {
    summary: ["Перескажет любую", "страницу в Safari"],
    keys: ["Покажет главное", "за секунды"],
    selection: ["Объяснит любой", "выделенный текст"],
    ask: ["Ответит на вопросы", "по странице"],
    translate: ["Переведёт страницу", "на русский"],
    notes: ["Заметки", "прямо в чате"],
    free: "5 бесплатных ответов в день",
    nosignup: "Без регистрации",
    host: "delovoyobzor.ru",
    foreignHost: "weeklyreview.com"
  }
}[lang]
const [appName, appTagline] = readFileSync(join(root, `store/metadata/${lang === "ru" ? "ru" : "en-US"}/name.txt`), "utf8").trim().split(/:\s*/)

// Takes in play order; `from` trims the start (seconds within the take), each runs to its end.
// (Translation is in the screenshots; the 30 s preview shows notes instead.)
const SEGMENTS = [
  { take: "main", from: 0.2 },
  { take: "selection", from: 0.15 },
  { take: "notes", from: 0.45 }
]

// ------------------------------------------------------------ timeline
let start = 0
for (const s of SEGMENTS) {
  const rec = JSON.parse(readFileSync(join(REC, `${s.take}.json`), "utf8"))
  s.frames = rec.frames
  s.events = rec.events
  s.to = rec.events.find((e) => e.type === "end").t
  s.start = start
  s.dur = s.to - s.from
  start += s.dur - XFADE
}
const endStart = start
const TOTAL = endStart + XFADE + END
if (TOTAL > 30) throw new Error(`preview is ${TOTAL.toFixed(2)} s, App Store allows 30 s`)

const local = (s, t) => t - s.start + s.from
const frameAt = (s, lt) => {
  let f = s.frames[0]
  for (const x of s.frames) { if (x.t <= lt) f = x; else break }
  return join(REC, s.take, f.f)
}
const captionAt = (s, lt) => {
  let key = null
  let since = -Infinity
  for (const e of s.events) if (e.type === "caption" && e.t <= Math.max(lt, s.from)) { key = e.key; since = e.t }
  return { key, since }
}
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3))

function state(t) {
  const layers = []
  const taps = []
  let caption = null
  let prevCaption = null
  for (const [i, s] of SEGMENTS.entries()) {
    if (t < s.start || t > s.start + s.dur) continue
    const lt = local(s, t)
    const fadeIn = i === 0 ? 1 : ease((t - s.start) / XFADE)
    layers.push({ src: file(frameAt(s, lt)), host: s.foreign ? COPY.foreignHost : COPY.host, opacity: fadeIn })
    for (const e of s.events) {
      const age = lt - e.t
      if (e.type === "tap" && age >= 0 && age < 0.55) taps.push({ x: e.x, y: e.y, o: Math.min(1, age / 0.08) * (1 - ease((age - 0.25) / 0.3)), k: 0.75 + 0.25 * ease(age / 0.2) })
      // A swipe: the finger lands, slides `dy` and lifts.
      if (e.type === "swipe" && age >= 0 && age < 0.8) taps.push({ x: e.x, y: e.y + e.dy * ease((age - 0.12) / 0.35), o: Math.min(1, age / 0.08) * (1 - ease((age - 0.5) / 0.3)), k: 0.9 })
    }
    // Caption: the newest segment wins. On a change the old line fades out first, then the new one rises in.
    const c = captionAt(s, lt)
    const atCut = i > 0 && t - s.start < CAP_OUT + CAP_IN
    const p = atCut ? SEGMENTS[i - 1].events.filter((e) => e.type === "caption").at(-1) : s.events.filter((e) => e.type === "caption" && e.t < c.since).at(-1)
    const age = atCut ? t - s.start : p ? lt - c.since : Infinity
    caption = { key: c.key, k: ease((age - CAP_OUT) / CAP_IN) }
    prevCaption = p && age < CAP_OUT ? { key: p.key, o: 1 - age / CAP_OUT } : null
  }
  const end = ease((t - endStart) / 0.45)
  return {
    layers, taps, end,
    caption: caption && { k: caption.k, lines: COPY[caption.key] },
    prev: prevCaption && { o: prevCaption.o, lines: COPY[prevCaption.key] }
  }
}

// ---------------------------------------------------------------- stage
const svg = {
  signal: (c) => `<svg viewBox="0 0 18 12" width="54" height="36"><g fill="${c}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>`,
  wifi: (c) => `<svg viewBox="0 0 16 12" width="48" height="36"><path fill="${c}" d="M8 2.2c2.4 0 4.6.9 6.3 2.4l1.2-1.3C13.4 1.4 10.8.3 8 .3S2.6 1.4.5 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.3-1.3A7.2 7.2 0 0 0 8 4c-1.9 0-3.7.7-5 1.9l1.3 1.3c1-.9 2.3-1.4 3.7-1.4zM8 9.4c-.7 0-1.3.3-1.8.7L8 12l1.8-1.9c-.5-.4-1.1-.7-1.8-.7z"/></svg>`,
  battery: (c) => `<svg viewBox="0 0 27 13" width="81" height="39"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="${c}" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="${c}"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="${c}" opacity=".45"/></svg>`,
  back: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M15 5l-7 7 7 7" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><g fill="${c}"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>`,
  reload: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

// iPhone screen (1290 × 2796 @3x: status 162 + web 2400 + Safari bar 234), scaled into the stage.
const SCREEN_TOP = 300
const K = (H - SCREEN_TOP - 60) / 2796
const SCREEN_LEFT = (W - 1290 * K) / 2

const screen = (id) => `
<div class="screen" id="${id}" style="left:${SCREEN_LEFT}px;top:${SCREEN_TOP}px;transform:scale(${K})">
  <div class="ios-status"><div class="t">9:41</div><div class="ic">${svg.signal("#000")}${svg.wifi("#000")}${svg.battery("#000")}</div></div>
  <img class="web" style="top:162px">
  <div class="ios-bar">
    <div class="btn">${svg.back("#000")}</div>
    <div class="url"><span class="aa">aA</span><span class="host"></span><span class="rl">${svg.reload("#000")}</span></div>
    <div class="btn">${svg.more("#000")}</div>
  </div>
  <div class="home"></div><div class="island"></div>
</div>`

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=block" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
body { position: relative; background: linear-gradient(180deg, #F4F9FF 0%, #E7F0FF 55%, #E3EEFF 100%); font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
.ribbon { position: absolute; inset: 0; }
.cap { position: absolute; left: 0; right: 0; top: 92px; text-align: center; font-weight: 800; font-size: 72px; line-height: 1.06; letter-spacing: -0.025em; color: #0B1530; font-optical-sizing: auto; will-change: transform, opacity; }
.cap .l2 { background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); -webkit-background-clip: text; background-clip: text; color: transparent; }
.screen { position: absolute; width: 1290px; height: 2796px; transform-origin: 0 0; border-radius: 190px; overflow: hidden; background: #fff; box-shadow: 0 0 0 4px rgba(11,21,48,.08), 0 90px 200px rgba(16,38,96,.30), 0 30px 70px rgba(16,38,96,.18); }
.web { position: absolute; left: 0; width: 1290px; height: 2400px; display: block; }
.ios-status { position: absolute; top: 0; left: 0; right: 0; height: 162px; display: flex; align-items: center; justify-content: space-between; padding: 22px 96px 0 150px; font: 600 52px Inter, sans-serif; letter-spacing: -0.01em; color: #000; }
.ios-status .ic { display: flex; align-items: center; gap: 18px; }
.island { position: absolute; top: 33px; left: 50%; width: 375px; height: 111px; margin-left: -187px; border-radius: 60px; background: #000; }
.ios-bar { position: absolute; left: 0; right: 0; top: 2562px; height: 234px; display: flex; align-items: flex-start; gap: 24px; padding: 30px 40px 0; }
.ios-bar .btn { flex: none; width: 138px; height: 138px; border-radius: 50%; padding: 36px; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10), inset 0 0 0 1.5px rgba(0,0,0,.05); }
.ios-bar .url { flex: 1; height: 138px; border-radius: 69px; display: flex; align-items: center; justify-content: center; gap: 22px; font: 500 46px Inter, sans-serif; color: #000; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10), inset 0 0 0 1.5px rgba(0,0,0,.05); position: relative; }
.ios-bar .url .aa { position: absolute; left: 44px; font-weight: 600; font-size: 40px; }
.ios-bar .url .rl { position: absolute; right: 40px; width: 52px; height: 52px; }
.home { position: absolute; bottom: 24px; left: 50%; width: 420px; height: 15px; margin-left: -210px; border-radius: 8px; background: #000; }
#taps { position: absolute; inset: 0; z-index: 10; }
.tap { position: absolute; width: 84px; height: 84px; margin: -42px 0 0 -42px; border-radius: 50%; background: rgba(255,255,255,.55); border: 3px solid rgba(37,99,235,.55); box-shadow: 0 6px 22px rgba(16,38,96,.35); }
#end { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; background: linear-gradient(180deg, rgba(244,249,255,.97) 0%, rgba(231,240,255,.97) 60%, rgba(227,238,255,.97) 100%); }
#end img { width: 230px; height: 230px; border-radius: 23%; box-shadow: 0 24px 60px rgba(37,99,235,.30); }
#end h1 { font-weight: 800; font-size: 84px; letter-spacing: -0.03em; color: #0B1530; text-align: center; line-height: 1.05; }
#end h1 span { display: block; background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); -webkit-background-clip: text; background-clip: text; color: transparent; }
#end .pills { display: flex; flex-direction: column; align-items: center; gap: 22px; margin-top: 16px; }
.pill { display: flex; align-items: center; gap: 16px; padding: 14px 30px 14px 14px; border-radius: 999px; background: #fff; color: #0B1530; font: 600 34px/1.1 Inter, sans-serif; white-space: nowrap; box-shadow: 0 18px 44px rgba(20,45,110,.18); }
.pill i { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 28px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #38BDF8, #2563EB); }
</style></head><body>
<svg class="ribbon" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="rib" x1="0" x2="${W}" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7DD3FC"/><stop offset=".5" stop-color="#3B82F6"/><stop offset="1" stop-color="#818CF8"/></linearGradient>
  <filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="40"/></filter></defs>
  <path d="M-200,${H * 0.62} C${W * 0.3},${H * 0.48} ${W * 0.7},${H * 0.72} ${W + 200},${H * 0.55}" fill="none" stroke="url(#rib)" stroke-width="180" opacity=".5" filter="url(#soft)"/>
</svg>
<h1 class="cap" id="c0"></h1><h1 class="cap" id="c1"></h1>
${screen("s0")}${screen("s1")}
<div id="taps"></div>
<div id="end"><img src="${file(join(root, "ContextFlow/Shared (App)/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png"))}">
  <h1>${appName}<span>${appTagline ?? ""}</span></h1>
  <div class="pills"><div class="pill"><i>✦</i>${COPY.free}</div><div class="pill"><i>✓</i>${COPY.nosignup}</div></div>
</div>
<script>
const probe = document.createElement("canvas"); probe.width = probe.height = 1
const pg = probe.getContext("2d", { willReadFrequently: true })
const sample = (img, y) => { pg.drawImage(img, 10, y, 1, 1, 0, 0, 1, 1); const [r, g, b] = pg.getImageData(0, 0, 1, 1).data; return "rgb(" + r + "," + g + "," + b + ")" }
const capHtml = (l) => l ? '<span class="l1">' + l[0] + '</span><br><span class="l2">' + l[1] + "</span>" : ""
window.setState = async (s) => {
  for (const [i, id] of ["s0", "s1"].entries()) {
    const el = document.getElementById(id), L = s.layers[i]
    el.style.display = L ? "block" : "none"
    if (!L) continue
    el.style.opacity = L.opacity
    el.style.zIndex = 2 + i
    const img = el.querySelector("img.web")
    if (img.dataset.src !== L.src) { img.src = L.src; img.dataset.src = L.src; await img.decode() }
    el.querySelector(".ios-status").style.background = sample(img, 2)
    el.querySelector(".ios-bar").style.background = sample(img, 2398)
    el.querySelector(".host").textContent = L.host
  }
  const [c0, c1] = [document.getElementById("c0"), document.getElementById("c1")]
  c0.innerHTML = capHtml(s.caption && s.caption.lines)
  c0.style.opacity = s.caption ? s.caption.k : 0
  c0.style.transform = "translateY(" + (1 - (s.caption ? s.caption.k : 1)) * 26 + "px)"
  c1.innerHTML = capHtml(s.prev && s.prev.lines)
  c1.style.opacity = s.prev ? s.prev.o : 0
  c1.style.transform = "translateY(" + -(s.prev ? 1 - s.prev.o : 0) * 18 + "px)"
  document.getElementById("taps").innerHTML = s.taps.map((t) => '<div class="tap" style="left:' + t.x + "px;top:" + t.y + "px;opacity:" + t.o + ";transform:scale(" + t.k + ')"></div>').join("")
  const end = document.getElementById("end")
  end.style.opacity = s.end
  end.style.display = s.end > 0 ? "flex" : "none"
  end.style.transform = "scale(" + (0.96 + 0.04 * s.end) + ")"
}
</script></body></html>`

const stageFile = join(TMP, "stage.html")
writeFileSync(stageFile, html)

const LINUX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const browser = await chromium.launch({
  ...(existsSync(LINUX_CHROME) ? { executablePath: LINUX_CHROME } : {}),
  args: ["--allow-file-access-from-files", "--font-render-hinting=none"]
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await page.goto(file(stageFile))
await page.evaluate(() => document.fonts.ready)

// Tap positions: CSS px inside the 430 × 800 web view → stage px.
const toStage = (x, y) => ({ x: SCREEN_LEFT + x * 3 * K, y: SCREEN_TOP + (162 + y * 3) * K })

const count = Math.round(TOTAL * FPS)
for (let n = 0; n < count; n++) {
  const s = state(n / FPS)
  s.taps = s.taps.map((t) => ({ ...t, ...toStage(t.x, t.y) }))
  await page.evaluate((st) => window.setState(st), s)
  await page.screenshot({ path: join(TMP, "frames", `${String(n).padStart(5, "0")}.png`) })
  if (n % 150 === 0) console.log(`frame ${n}/${count}`)
}
await browser.close()

// H.264 High@4.0, 30 fps, constant 10 Mbps (Apple's preview spec; mostly static frames would
// otherwise come out far below it) + silent stereo AAC (App Store previews need an audio track).
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-framerate", String(FPS), "-i", join(TMP, "frames", "%05d.png"),
  "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
  "-map", "0:v", "-map", "1:a", "-shortest",
  "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-b:v", "10M", "-minrate", "10M", "-maxrate", "10M", "-bufsize", "10M", "-x264-params", "nal-hrd=cbr",
  "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
  OUT
], { stdio: "inherit" })
console.log(`preview ${TOTAL.toFixed(2)} s → ${OUT}`)
