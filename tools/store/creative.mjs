// Renders the App Store creative assets (iOS / iPadOS 27+): product page header (21:9,
// 3840 × 1646) and search results asset (3:2, 3840 × 2560), from a frame of the real UI
// recorded by preview-record.mjs. No prices, URLs or other platforms' logos (Apple's asset rules).
//   node tools/store/creative.mjs <recDir> <outDir> [lang:en|ru]
// Output: <outDir>/header.png, <outDir>/search.png (App Store Connect takes PNG for these)
import { chromium } from "playwright"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.CF_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [recArg, outArg, lang = "en"] = process.argv.slice(2)
const REC = resolve(recArg)
const OUT = resolve(outArg)
mkdirSync(OUT, { recursive: true })
const file = (p) => pathToFileURL(p).href

const COPY = {
  en: {
    header: ["Read less.", "Know more."],
    search: ["Summarize any", "page in Safari"],
    chips: ["Summarize", "Key takeaways", "Explain simply", "Translate"],
    pills: [["✦", "Key facts at a glance"], ["文", "Translate any page"], ["?", "Ask anything"]],
    host: "weeklyreview.com"
  },
  ru: {
    header: ["Читайте меньше.", "Знайте больше."],
    search: ["Перескажет любую", "страницу в Safari"],
    chips: ["Кратко", "Главное", "Объясни просто", "Перевести"],
    pills: [["✦", "Главное за секунды"], ["文", "Перевод страницы"], ["?", "Ответы на вопросы"]],
    host: "delovoyobzor.ru"
  }
}[lang]

// The summary answer, fully streamed: the last frame before the "keys" caption in the main take.
const main = JSON.parse(readFileSync(join(REC, "main.json"), "utf8"))
const keysAt = main.events.find((e) => e.type === "caption" && e.key === "keys").t
const summaryFrame = file(join(REC, "main", main.frames.filter((f) => f.t <= keysAt - 0.1).at(-1).f))

const svg = {
  signal: `<svg viewBox="0 0 18 12" width="54" height="36"><g fill="#000"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>`,
  wifi: `<svg viewBox="0 0 16 12" width="48" height="36"><path fill="#000" d="M8 2.2c2.4 0 4.6.9 6.3 2.4l1.2-1.3C13.4 1.4 10.8.3 8 .3S2.6 1.4.5 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.3-1.3A7.2 7.2 0 0 0 8 4c-1.9 0-3.7.7-5 1.9l1.3 1.3c1-.9 2.3-1.4 3.7-1.4zM8 9.4c-.7 0-1.3.3-1.8.7L8 12l1.8-1.9c-.5-.4-1.1-.7-1.8-.7z"/></svg>`,
  battery: `<svg viewBox="0 0 27 13" width="81" height="39"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="#000" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="#000"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="#000" opacity=".45"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M15 5l-7 7 7 7" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: `<svg viewBox="0 0 24 24" width="100%" height="100%"><g fill="#000"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="#fff" d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1z"/></svg>`
}

// iPhone screen (1290 × 2796 @3x: status 162 + web 2400 + Safari bar 234), frameless.
function phone(scale, left, top) {
  return `
  <div class="screen" style="left:${left}px;top:${top}px;transform:scale(${scale})">
    <div class="ios-status"><div class="t">9:41</div><div class="ic">${svg.signal}${svg.wifi}${svg.battery}</div></div>
    <img class="web" src="${summaryFrame}">
    <div class="ios-bar"><div class="btn">${svg.back}</div><div class="url"><span class="aa">aA</span><span>${COPY.host}</span></div><div class="btn">${svg.more}</div></div>
    <div class="home"></div><div class="island"></div>
  </div>`
}

const ribbon = (W, H, opacity) => `
  <svg class="ribbon" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="rib" x1="0" x2="${W}" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7DD3FC"/><stop offset=".5" stop-color="#3B82F6"/><stop offset="1" stop-color="#818CF8"/></linearGradient>
    <filter id="soft" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${W * 3}" height="${H * 3}"><feGaussianBlur stdDeviation="${Math.round(H * 0.06)}"/></filter></defs>
    <path d="M-300,${H * 0.72} C${W * 0.3},${H * 0.45} ${W * 0.62},${H * 0.95} ${W + 300},${H * 0.5}" fill="none" stroke="url(#rib)" stroke-width="${Math.round(H * 0.2)}" opacity="${opacity}" filter="url(#soft)"/>
  </svg>`

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { overflow: hidden; }
body { position: relative; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
.ribbon { position: absolute; inset: 0; }
.screen { position: absolute; width: 1290px; height: 2796px; transform-origin: 0 0; border-radius: 190px; overflow: hidden; background: #fff; }
.web { position: absolute; left: 0; top: 162px; width: 1290px; height: 2400px; }
.ios-status { position: absolute; top: 0; left: 0; right: 0; height: 162px; display: flex; align-items: center; justify-content: space-between; padding: 22px 96px 0 150px; font: 600 52px Inter, sans-serif; color: #000; }
.ios-status .ic { display: flex; align-items: center; gap: 18px; }
.island { position: absolute; top: 33px; left: 50%; width: 375px; height: 111px; margin-left: -187px; border-radius: 60px; background: #000; }
.ios-bar { position: absolute; left: 0; right: 0; top: 2562px; height: 234px; display: flex; align-items: flex-start; gap: 24px; padding: 30px 40px 0; }
.ios-bar .btn { flex: none; width: 138px; height: 138px; border-radius: 50%; padding: 36px; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10); }
.ios-bar .url { flex: 1; height: 138px; border-radius: 69px; display: flex; align-items: center; justify-content: center; font: 500 46px Inter, sans-serif; color: #000; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10); position: relative; }
.ios-bar .url .aa { position: absolute; left: 44px; font-weight: 600; font-size: 40px; }
.home { position: absolute; bottom: 24px; left: 50%; width: 420px; height: 15px; margin-left: -210px; border-radius: 8px; background: #000; }
h1 { position: absolute; font-weight: 800; line-height: 1.04; letter-spacing: -0.03em; font-optical-sizing: auto; }
.l2 { background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); -webkit-background-clip: text; background-clip: text; color: transparent; }
.dark h1 { color: #fff; }
.dark .l2 { background: linear-gradient(90deg, #7DD3FC, #93C5FD 55%, #A5B4FC); -webkit-background-clip: text; background-clip: text; }
.chip { position: absolute; display: flex; align-items: center; gap: 26px; padding: 30px 54px 30px 30px; border-radius: 999px; background: rgba(255,255,255,.97); color: #0B1530; font: 600 56px/1 Inter, sans-serif; white-space: nowrap; box-shadow: 0 30px 70px rgba(0,0,0,.35); }
.chip i, .pill i { flex: none; display: grid; place-items: center; border-radius: 50%; font-style: normal; font-weight: 700; color: #fff; background: linear-gradient(135deg, #38BDF8, #2563EB); }
.chip i { width: 76px; height: 76px; padding: 18px; }
.pill { display: flex; align-items: center; gap: 30px; padding: 26px 60px 26px 26px; border-radius: 999px; background: rgba(255,255,255,.97); color: #0B1530; font: 600 78px/1 Inter, sans-serif; white-space: nowrap; box-shadow: 0 26px 60px rgba(20,45,110,.20), 0 2px 8px rgba(20,45,110,.10); }
.pill i { width: 112px; height: 112px; font-size: 58px; }
`

const page = (W, H, body, cls = "") => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=block" rel="stylesheet">
<style>html,body{width:${W}px;height:${H}px}${CSS}</style></head><body class="${cls}">${body}
<script>
// Status bar and Safari bar take the colour of the page right under them.
const img = document.querySelector("img.web")
const paint = () => {
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight
  const g = c.getContext("2d"); g.drawImage(img, 0, 0)
  const at = (y) => { const [r, gg, b] = g.getImageData(10, y, 1, 1).data; return "rgb(" + r + "," + gg + "," + b + ")" }
  document.querySelector(".ios-status").style.background = at(2)
  document.querySelector(".ios-bar").style.background = at(img.naturalHeight - 2)
}
// Captions shrink until they fit their area (longer languages must not reach the edge or the phone).
const fit = () => {
  for (const h of document.querySelectorAll("h1[data-max]")) {
    let size = parseFloat(getComputedStyle(h).fontSize)
    while (h.getBoundingClientRect().width > Number(h.dataset.max) && size > 60) h.style.fontSize = (size -= 4) + "px"
  }
}
;(async () => {
  await document.fonts.ready
  fit()
  if (!img.complete) await new Promise((r) => img.addEventListener("load", r))
  paint()
  document.body.dataset.ready = "1"
})()
</script></body></html>`

// ---------------------------------------------------------------- header 21:9
// Safe area, checked in App Store Connect's Preview: on iPhone the top ~22% sits under the
// status bar, Dynamic Island and Back / Share; iPad shows only the middle band (about 14–86%
// of the height) with its tab bar over the top centre. Key content stays in y 540–1400 and
// x 440–3400.
function header() {
  const W = 3840, H = 1646
  const top = 540
  const ph = 1400 - top
  const k = ph / 2796
  const pw = 1290 * k
  const px = (W - pw) / 2
  const mid = top + ph / 2
  const chips = COPY.chips.map((c, i) => `<div class="chip" style="left:${px + pw + 140 + (i % 2) * 80}px;top:${mid - 330 + i * 170}px"><i>${svg.sparkle}</i>${c}</div>`).join("")
  const body = `
  <div style="position:absolute;inset:0;background:radial-gradient(110% 120% at 50% 60%, #1B3A86 0%, #0B1633 55%, #070D1F 100%)"></div>
  ${ribbon(W, H, 0.55)}
  <div style="position:absolute;left:${px - 30}px;top:${top - 30}px;width:${pw + 60}px;height:${ph + 60}px;border-radius:110px;box-shadow:0 0 200px rgba(59,130,246,.55)"></div>
  ${phone(k, px, top)}
  <h1 data-max="${px - 140 - 440}" style="right:${W - px + 140}px;top:${mid}px;transform:translateY(-50%);font-size:150px;text-align:right;white-space:nowrap"><span>${COPY.header[0]}</span><br><span class="l2">${COPY.header[1]}</span></h1>
  ${chips}`
  return { W, H, html: page(W, H, body, "dark") }
}

// ------------------------------------------------------------ search 3:2
function search() {
  const W = 3840, H = 2560
  const k = 2330 / 2796
  const pw = 1290 * k
  const px = W - pw - 330
  const pills = COPY.pills.map(([icon, text]) => `<div class="pill"><i>${icon}</i><span>${text}</span></div>`).join("")
  const body = `
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,#F4F9FF 0%,#E7F0FF 55%,#E3EEFF 100%)"></div>
  ${ribbon(W, H, 0.5)}
  <div style="position:absolute;left:${px}px;top:115px;width:${pw}px;height:2330px;border-radius:160px;box-shadow:0 0 0 6px rgba(11,21,48,.06),0 90px 200px rgba(16,38,96,.30),0 30px 70px rgba(16,38,96,.18)"></div>
  ${phone(k, px, 115)}
  <h1 data-max="${px - 140 - 300}" style="left:300px;top:520px;font-size:224px;color:#0B1530;white-space:nowrap"><span>${COPY.search[0]}</span><br><span class="l2">${COPY.search[1]}</span></h1>
  <div style="position:absolute;left:300px;top:1200px;display:flex;flex-direction:column;align-items:flex-start;gap:56px">${pills}</div>`
  return { W, H, html: page(W, H, body) }
}

const LINUX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const browser = await chromium.launch({
  ...(existsSync(LINUX_CHROME) ? { executablePath: LINUX_CHROME } : {}),
  args: ["--allow-file-access-from-files", "--font-render-hinting=none"]
})
for (const [name, spec] of [["header", header()], ["search", search()]]) {
  const htmlFile = join(OUT, `.${name}.html`)
  writeFileSync(htmlFile, spec.html)
  const p = await browser.newPage({ viewport: { width: spec.W, height: spec.H }, deviceScaleFactor: 1 })
  await p.goto(file(htmlFile))
  await p.waitForFunction(() => document.body.dataset.ready === "1")
  await p.evaluate(() => document.fonts.ready)
  await p.waitForTimeout(300)
  const out = join(OUT, `${name}.png`)
  await p.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: spec.W, height: spec.H } })
  await p.close()
  console.log(`${name}: ${spec.W}×${spec.H} → ${out}`)
}
await browser.close()
