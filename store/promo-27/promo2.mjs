// ContextFlow 2.7: in-app purchase promotional images, version 2 (1024 × 1024).
// Built like the store's banners (tools/store/creative26.mjs): crisp, enlarged fragments of the real panel,
// each in a card with the banners' radius, thin blue outline and soft shadow, composed as artwork: no phone,
// no full screen, no headline. Monthly sits on the light field of the search asset, yearly on the deep blue
// field of the header. The plan's pill (Pro blue, Ultra violet, Own key graphite) as on the screenshots.
// Apple: no screenshots, not the app icon, no overlay text, nothing important in the lower-left corner.
//   node promo2.mjs <raw> <bannerRaw> <outDir>
import { chromium } from "playwright"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const [rawArg, bannerArg, outArg] = process.argv.slice(2)
const RAW = resolve(rawArg), BANNER = resolve(bannerArg), OUT = resolve(outArg)
mkdirSync(OUT, { recursive: true })
const file = (p) => pathToFileURL(p).href
const meta = (dir, shot) => JSON.parse(readFileSync(join(dir, shot + ".json"), "utf8"))

// A fragment of a capture: box in CSS px of that capture (or an element's rect plus pad), drawn w px wide.
function frag({ dir = RAW, shot, sel, box, pad = 8, left, top, w, z = 2, radius = 16, rot = 0, cls = "" }) {
  const m = meta(dir, shot)
  if (!box) {
    const r = m[sel]
    if (!r) throw new Error(`${shot}: ${sel} not captured`)
    box = [r.x - pad, r.y - pad, r.x + r.width + pad, r.y + r.height + pad]
  }
  const [x0, y0, x1, y1] = box
  const f = w / (x1 - x0), h = (y1 - y0) * f
  const sc = m.scale
  // The capture is sc px per CSS px: its full width in CSS px is the PNG's width / sc.
  const png = join(dir, shot + ".png")
  const fullW = Number(readFileSync(png).readUInt32BE(16)) / sc
  return { h, html: `<div class="card ${cls}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;border-radius:${radius * f}px;z-index:${z};${rot ? `transform:rotate(${rot}deg);` : ""}">
    <div style="width:100%;height:100%;background:url('${file(png)}') ${-x0 * f}px ${-y0 * f}px / ${fullW * f}px auto no-repeat"></div></div>` }
}

const FIELD = {
  // search.png: light, with soft cyan, blue and lavender glows.
  light: `<div class="field" style="background:linear-gradient(180deg,#F4F9FF 0%,#E7F0FF 55%,#E3EEFF 100%)"></div>
    <div class="glow" style="left:-160px;top:520px;width:760px;height:420px;background:#7DD3FC;opacity:.55"></div>
    <div class="glow" style="left:300px;top:640px;width:700px;height:360px;background:#3B82F6;opacity:.32"></div>
    <div class="glow" style="left:620px;top:380px;width:560px;height:420px;background:#A5B4FC;opacity:.55"></div>`,
  // header.png: deep navy to royal blue, with its blue light.
  dark: `<div class="field" style="background:radial-gradient(110% 120% at 50% 60%, #1B3A86 0%, #0B1633 55%, #070D1F 100%)"></div>
    <div class="glow" style="left:-120px;top:560px;width:760px;height:380px;background:#38BDF8;opacity:.28"></div>
    <div class="glow" style="left:380px;top:620px;width:760px;height:380px;background:#6366F1;opacity:.3"></div>
    <div class="glow" style="left:260px;top:220px;width:620px;height:520px;background:#2563EB;opacity:.28"></div>`
}

const pill = (label, kind, left, top) => `<div class="pill ${kind}" style="left:${left}px;top:${top}px">${label}</div>`

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1024px; height: 1024px; overflow: hidden; }
body { position: relative; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
.field { position: absolute; inset: 0; }
.glow { position: absolute; border-radius: 50%; filter: blur(110px); }
.card { position: absolute; overflow: hidden; background: #fff; transform-origin: 50% 50%;
  box-shadow: 0 0 0 3px rgba(37,99,235,.5), 0 30px 70px rgba(20,45,110,.30), 0 6px 18px rgba(20,45,110,.14); }
.dark .card { box-shadow: 0 0 0 3px rgba(147,197,253,.75), 0 34px 80px rgba(0,0,0,.55), 0 0 70px rgba(59,130,246,.40); }
.card.back { filter: saturate(.96); }
.pill { position: absolute; z-index: 9; padding: 14px 34px 15px; border-radius: 999px; font: 800 44px/1 Inter, sans-serif; letter-spacing: .02em; color: #fff; }
.pill.pro { background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); box-shadow: 0 14px 34px rgba(37,99,235,.38); }
.pill.ultra { background: linear-gradient(90deg, #A78BFA, #7C3AED 70%, #4F46E5); box-shadow: 0 14px 34px rgba(124,58,237,.40); }
.pill.key { background: linear-gradient(90deg, #64748B, #334155 70%, #1E293B); box-shadow: 0 14px 34px rgba(15,23,42,.35); }
.dark .pill.key { background: linear-gradient(90deg, #94A3B8, #475569 70%, #334155); }
`

const page = (body, dark) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=block" rel="stylesheet">
<style>${CSS}</style></head><body class="${dark ? "dark" : ""}">${FIELD[dark ? "dark" : "light"]}${body}
<script>document.fonts.ready.then(() => { document.body.dataset.ready = "1" })</script></body></html>`

// ---------------------------------------------------------------- the three stories
// Pro: a summary with bold figures over the chats list with its tags, and a PDF's chip. The summary leads.
function pro() {
  const list = frag({ shot: "iphone-chatlist", box: BOX.chatlist, left: 64, top: 220, w: 600, z: 1, cls: "back" })
  const chip = frag({ shot: "iphone-pdf", sel: ".cf-used", pad: 6, left: 694, top: 250, w: 286, z: 4, radius: 18 })
  const sum = frag({ shot: "iphone-keypoints", box: [6, 380, 424, 600], left: 330, top: 496, w: 650, z: 3 })
  return pill("Pro", "pro", 64, 136) + list.html + chip.html + sum.html
}

// Ultra: a Find similar result with "✓ Cheaper, in stock" (no prices, as on the banners), over the Listen player.
function ultra() {
  const item = frag({ dir: BANNER, shot: "iphone-similar", box: [8, 320, 422, 562], left: 64, top: 220, w: 860, z: 3 })
  const player = frag({ shot: "mac-listen", box: [761, 562, 1159, 630], left: 300, top: 220 + item.h + 28, w: 680, z: 4, radius: 18 })
  return pill("Ultra", "ultra", 64, 136) + item.html + player.html
}

// Own key: Settings' own key section (the key masked, the providers named as the panel names them, no logos),
// over the answer it gives.
function byok() {
  const set = frag({ shot: "iphone-ownkey", box: BOX.ownkey, left: 64, top: 220, w: 760, z: 3 })
  const ans = frag({ shot: "iphone-askpage", box: [6, 386, 424, 494], left: 380, top: 220 + set.h + 30, w: 600, z: 4 })
  return pill("Own key", "key", 64, 136) + set.html + ans.html
}

// Crops that depend on the new captures (CSS px), set once they're looked at.
const BOX = JSON.parse(readFileSync(new URL("./boxes.json", import.meta.url), "utf8"))

const ITEMS = [
  ["com.contextflow.pro.monthly", "pro-monthly", pro, false],
  ["com.contextflow.pro.yearly", "pro-yearly", pro, true],
  ["com.contextflow.ultra.monthly", "ultra-monthly", ultra, false],
  ["com.contextflow.ultra.yearly", "ultra-yearly", ultra, true],
  ["com.contextflow.byok.monthly", "byok-monthly", byok, false],
  ["com.contextflow.byok.yearly", "byok-yearly", byok, true]
]
const only = process.env.ONLY?.split(",")
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] })
const p = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 2 })
for (const [id, name, build, dark] of ITEMS) {
  if (only && !only.some((o) => name.startsWith(o))) continue
  const f = join(OUT, "raw", `.${name}.html`)
  mkdirSync(join(OUT, "raw"), { recursive: true })
  writeFileSync(f, page(build(), dark))
  await p.goto(file(f))
  await p.waitForFunction(() => document.body.dataset.ready === "1")
  await p.waitForTimeout(250)
  await p.screenshot({ path: join(OUT, "raw", `${name}@2x.png`), clip: { x: 0, y: 0, width: 1024, height: 1024 } })
  console.log(id, "→", name)
}
await browser.close()
