// Composes App Store screenshots from the raw UI captures made by capture.mjs.
//   node tools/store/compose.mjs <rawDir> <outDir> <lang:en|ru>
// Output: <outDir>/{iphone,ipad,mac}/NN-name.png + strip.png (all screens side by side, for review).
//
// Every set is laid out as one wide "panorama": the background gradient and the
// flowing brand ribbon run continuously across the screens, so neighbouring
// screenshots join up in the App Store carousel. Each screen is rendered on its
// own with the panorama shifted by -index × width.
import { chromium } from "playwright"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// CF_ROOT lets the script run from a folder that has Playwright installed.
const root = process.env.CF_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [rawArg, outArg, lang = "en"] = process.argv.slice(2)
const RAW = resolve(rawArg)
const OUT = resolve(outArg)
const TMP = join(OUT, ".tmp")
mkdirSync(TMP, { recursive: true })
const file = (p) => pathToFileURL(p).href
const APP_ICON = file(join(root, "ContextFlow/Shared (App)/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png"))
const EXT_ICON = file(join(root, "extension/icons/icon-128.png"))

// ------------------------------------------------------------------- copy

const COPY = {
  en: {
    summary: ["Summarize any", "page in Safari"],
    keys: ["Get key facts", "at a glance"],
    selection: ["Explain any", "selected text"],
    ask: ["Ask anything", "about the page"],
    translate: ["Translate any", "page instantly"],
    free: "5 free answers a day",
    nosignup: "No sign-up needed",
    private: "No account. No tracking.",
    langs: "Русский → English",
    langsMac: "Русский → English",
    shortcut: "⌃⇧E opens the panel",
    host: "weeklyreview.com",
    foreignHost: "delovoyobzor.ru"
  },
  ru: {
    summary: ["Перескажет любую", "страницу в Safari"],
    keys: ["Покажет главное", "за секунды"],
    selection: ["Объяснит любой", "выделенный текст"],
    ask: ["Ответит на вопросы", "по странице"],
    translate: ["Переведёт страницу", "на русский"],
    free: "5 бесплатных ответов в день",
    nosignup: "Без регистрации",
    private: "Без аккаунта и трекинга",
    langs: "English → Русский",
    langsMac: "English → Русский",
    shortcut: "⌃⇧E — открыть панель",
    host: "delovoyobzor.ru",
    foreignHost: "weeklyreview.com"
  }
}[lang]

// ----------------------------------------------------------------- devices

const DEVICES = {
  iphone: { W: 1290, H: 2796, captionTop: 230, captionMax: 1130, captionSize: 124 },
  ipad: { W: 2064, H: 2752, captionTop: 150, captionMax: 1800, captionSize: 150 },
  mac: { W: 2880, H: 1800, captionTop: 105, captionMax: 2500, captionSize: 112, oneLine: true }
}

const SETS = {
  iphone: [
    { name: "summary", shot: "iphone-summary", caption: COPY.summary, icon: true,
      pills: [{ text: COPY.free, icon: "✦", x: 50, y: 730 }, { text: COPY.nosignup, icon: "✓", right: 50, y: 880 }] },
    { name: "keys", shot: "iphone-keys", caption: COPY.keys, zoom: { rectFile: "iphone-keys", selector: ".md table", pad: 10, width: 1110, y: 1560, tilt: -1.5 } },
    { name: "selection", shot: "iphone-selection", caption: COPY.selection },
    { name: "ask", shot: "iphone-ask-dark", caption: COPY.ask, dark: true, pills: [{ text: COPY.private, icon: "✓", x: 50, y: 730 }] },
    { name: "translate", shot: "iphone-translate", caption: COPY.translate, foreign: true, pills: [{ text: COPY.langs, icon: "文", x: 50, y: 780 }] }
  ],
  ipad: [
    { name: "summary", shot: "ipad-summary", caption: COPY.summary, pills: [{ text: COPY.free, icon: "✦", x: 70, y: 2540 }] },
    { name: "selection", shot: "ipad-selection", caption: COPY.selection },
    { name: "translate", shot: "ipad-translate", caption: COPY.translate, foreign: true, pills: [{ text: COPY.langs, icon: "文", x: 70, y: 2540 }] },
    { name: "ask", shot: "ipad-ask-dark", caption: COPY.ask, dark: true, pills: [{ text: COPY.private, icon: "✓", x: 70, y: 2540 }] }
  ],
  mac: [
    { name: "summary", shot: "mac-summary", caption: COPY.summary, pills: [{ text: COPY.shortcut, icon: "⌘", x: 110, y: 1560 }] },
    { name: "selection", shot: "mac-selection", caption: COPY.selection, bubble: { rectFile: "mac-bubble", shot: "mac-bubble", selector: ".cf-bubble", zoom: 2.1 } },
    { name: "translate", shot: "mac-translate", caption: COPY.translate, foreign: true, pills: [{ text: COPY.langsMac, icon: "文", x: 110, y: 1560 }] },
    { name: "ask", shot: "mac-ask-dark", caption: COPY.ask, dark: true, pills: [{ text: COPY.private, icon: "✓", x: 110, y: 1560 }] }
  ]
}

// ------------------------------------------------------------------- icons

const svg = {
  signal: (c) => `<svg viewBox="0 0 18 12" width="54" height="36"><g fill="${c}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>`,
  wifi: (c) => `<svg viewBox="0 0 16 12" width="48" height="36"><path fill="${c}" d="M8 2.2c2.4 0 4.6.9 6.3 2.4l1.2-1.3C13.4 1.4 10.8.3 8 .3S2.6 1.4.5 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.3-1.3A7.2 7.2 0 0 0 8 4c-1.9 0-3.7.7-5 1.9l1.3 1.3c1-.9 2.3-1.4 3.7-1.4zM8 9.4c-.7 0-1.3.3-1.8.7L8 12l1.8-1.9c-.5-.4-1.1-.7-1.8-.7z"/></svg>`,
  battery: (c) => `<svg viewBox="0 0 27 13" width="81" height="39"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="${c}" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="${c}"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="${c}" opacity=".45"/></svg>`,
  back: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M15 5l-7 7 7 7" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fwd: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M9 5l7 7-7 7" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><g fill="${c}"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>`,
  lock: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="${c}" d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H7zm2 0h6V8a3 3 0 0 0-6 0v2z"/></svg>`,
  sidebar: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M9 5v14" stroke="${c}" stroke-width="1.8"/></svg>`,
  share: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 3v12M8 7l4-4 4 4M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 5v14M5 12h14" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`,
  tabs: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="7" width="13" height="13" rx="2.5" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 4h10a3 3 0 0 1 3 3v10" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  reload: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

// --------------------------------------------------------------- panorama

// One continuous background for the whole set: soft sky gradient + a flowing ribbon.
function panorama(device, count, index, dark) {
  const { W, H } = device
  const TW = W * count
  // Ribbon passes behind the devices at varying heights (Catmull-Rom → cubic Bézier).
  const ys = [0.6, 0.47, 0.66, 0.5, 0.63, 0.48, 0.6]
  const pts = [[-W * 0.5, H * ys[0]]]
  for (let i = 0; i <= count; i++) pts.push([i * W + (i === count ? W * 0.5 : W * 0.5), H * ys[(i + 1) % ys.length]])
  pts.unshift([-W, H * 0.62])
  pts.push([TW + W, H * 0.55])
  let d = `M${pts[1][0]},${pts[1][1]}`
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`
  }
  const sw = Math.round(Math.min(W, H) * 0.16)
  const op = dark ? 0.75 : 0.55
  return `
  <div class="bg" style="left:${-index * W}px;width:${TW}px">
    <svg width="${TW}" height="${H}" viewBox="0 0 ${TW} ${H}">
      <defs>
        <linearGradient id="rib" x1="0" x2="${TW}" y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#7DD3FC"/><stop offset=".35" stop-color="#3B82F6"/>
          <stop offset=".65" stop-color="#818CF8"/><stop offset="1" stop-color="#38BDF8"/>
        </linearGradient>
        <filter id="soft" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="${Math.round(sw / 4)}"/></filter>
      </defs>
      <path d="${d}" fill="none" stroke="url(#rib)" stroke-width="${sw}" stroke-linecap="round" opacity="${op}" filter="url(#soft)"/>
      <path d="${d}" fill="none" stroke="url(#rib)" stroke-width="${Math.round(sw / 22)}" stroke-linecap="round" opacity="${dark ? 0.9 : 0.7}" transform="translate(0 ${-sw * 0.42})"/>
      <path d="${d}" fill="none" stroke="url(#rib)" stroke-width="${Math.round(sw / 40)}" stroke-linecap="round" opacity="${dark ? 0.6 : 0.35}" transform="translate(0 ${sw * 0.5})"/>
    </svg>
  </div>`
}

// ------------------------------------------------------------- components

function caption(device, lines, dark, size) {
  const [a, b] = lines
  const text = device.oneLine ? `<span class="l1">${a}</span> <span class="l2">${b}</span>` : `<span class="l1">${a}</span><br><span class="l2">${b}</span>`
  return `<h1 class="cap ${dark ? "on-dark" : ""}" style="top:${device.captionTop}px;font-size:${size}px;max-width:${device.captionMax}px">${text}</h1>`
}

function pills(list = [], dark, scale = 1) {
  return list
    .map((p) => {
      const pos = p.right != null ? `right:${p.right}px` : `left:${p.x}px`
      return `<div class="pill ${dark ? "on-dark" : ""}" style="${pos};top:${p.y}px;transform:scale(${scale});transform-origin:${p.right != null ? "right" : "left"} top"><i>${p.icon}</i><span>${p.text}</span></div>`
    })
    .join("")
}

// iPhone 6.9" at @3x: 1290 × 2796 screen; scaled into the slot.
function iphone(shot, dark, host) {
  const fg = dark ? "#fff" : "#000"
  const scale = 0.748
  const sw = 1290 * scale
  const bezel = 30
  const left = (1290 - sw) / 2 - bezel
  return `
  <div class="phone" style="left:${left}px;top:${560}px;width:${sw + bezel * 2}px;height:${2796 * scale + bezel * 2}px">
    <div class="phone-screen" style="width:1290px;height:2796px;transform:scale(${scale})">
      <div class="ios-status" data-sample="top" style="color:${fg}">
        <div class="t">9:41</div>
        <div class="ic">${svg.signal(fg)}${svg.wifi(fg)}${svg.battery(fg)}</div>
      </div>
      <img class="web" src="${file(join(RAW, shot + ".png"))}" style="top:162px;width:1290px;height:2400px">
      <div class="ios-bar ${dark ? "dark" : ""}" data-sample="bottom">
        <div class="btn">${svg.back(fg)}</div>
        <div class="url"><span class="aa">aA</span><span>${host}</span><span class="rl">${svg.reload(fg)}</span></div>
        <div class="btn">${svg.more(fg)}</div>
      </div>
      <div class="home" style="background:${fg}"></div>
      <div class="island"></div>
    </div>
  </div>`
}

// iPad 13" at @2x: 2064 × 2752 screen (status 48 + toolbar 124 + page 2580).
function ipad(shot, dark, host) {
  const fg = dark ? "#f2f2f7" : "#1c1c1e"
  const scale = 0.76
  const sw = 2064 * scale
  const bezel = 44
  const left = (2064 - sw) / 2 - bezel
  return `
  <div class="tablet" style="left:${left}px;top:${500}px;width:${sw + bezel * 2}px;height:${2752 * scale + bezel * 2}px">
    <div class="tablet-screen" style="width:2064px;height:2752px;transform:scale(${scale})">
      <div class="ipad-top ${dark ? "dark" : ""}">
        <div class="st" style="color:${fg}"><b>9:41</b>&nbsp;&nbsp;${lang === "ru" ? "Пт 23 окт." : "Fri Oct 23"}<span class="ic">${svg.wifi(fg)}${svg.battery(fg)}</span></div>
        <div class="tb">
          <div class="grp"><i>${svg.sidebar(fg)}</i><i>${svg.back(fg)}</i><i class="dim">${svg.fwd(fg)}</i></div>
          <div class="url"><i>${svg.lock(fg)}</i><span>${host}</span></div>
          <div class="grp"><i class="ext"><img src="${EXT_ICON}"></i><i>${svg.share(fg)}</i><i>${svg.plus(fg)}</i><i>${svg.tabs(fg)}</i></div>
        </div>
      </div>
      <img class="web" src="${file(join(RAW, shot + ".png"))}" style="top:172px;width:2064px;height:2580px">
    </div>
  </div>`
}

// Safari window on macOS at @2x: 2360 × (104 toolbar + 1520 page).
const MAC_W = 2360
const MAC_H = 1520
function macWindow(shot, dark, host, extra = "") {
  const fg = dark ? "#e5e5ea" : "#3a3a3c"
  const scale = 0.9
  const left = (2880 - MAC_W * scale) / 2
  return `
  <div class="win ${dark ? "dark" : ""}" style="left:${left}px;top:290px;width:${MAC_W}px;height:${MAC_H + 104}px;transform:scale(${scale})">
    <div class="mac-tb">
      <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div class="grp"><i>${svg.sidebar(fg)}</i><i>${svg.back(fg)}</i><i class="dim">${svg.fwd(fg)}</i></div>
      <div class="url"><i>${svg.lock(fg)}</i><span>${host}</span></div>
      <div class="grp right"><i class="ext"><img src="${EXT_ICON}"></i><i>${svg.share(fg)}</i><i>${svg.plus(fg)}</i><i>${svg.tabs(fg)}</i></div>
    </div>
    <img class="web" src="${file(join(RAW, shot + ".png"))}" style="top:104px;width:${MAC_W}px;height:${MAC_H}px">
    ${extra}
  </div>`
}

// Enlarged copy of one UI element (cropped from the capture) floating over the device.
function zoomCard(spec, slotW, dark) {
  const meta = JSON.parse(readFileSync(join(RAW, spec.rectFile + ".json"), "utf8"))
  const r = meta[spec.selector]
  const s = meta.scale
  const crop = { x: (r.x - spec.pad) * s, y: (r.y - spec.pad) * s, w: (r.width + spec.pad * 2) * s, h: (r.height + spec.pad * 2) * s }
  const k = spec.width / crop.w
  const shot = spec.shot ?? spec.rectFile
  return `<div class="zoom ${dark ? "on-dark" : ""}" style="left:${(slotW - spec.width) / 2}px;top:${spec.y}px;width:${spec.width}px;height:${crop.h * k}px;transform:rotate(${spec.tilt ?? 0}deg)">
    <div style="width:100%;height:100%;background:url('${file(join(RAW, shot + ".png"))}') ${-crop.x * k}px ${-crop.y * k}px / ${1290 * k}px auto no-repeat"></div>
  </div>`
}

// The Mac selection bubble, enlarged in place (it disappears in the real UI once clicked).
function bubbleZoom(spec) {
  const meta = JSON.parse(readFileSync(join(RAW, spec.rectFile + ".json"), "utf8"))
  const r = meta[spec.selector]
  const s = meta.scale
  const crop = { x: r.x * s, y: r.y * s, w: r.width * s, h: r.height * s }
  const k = spec.zoom
  // Window-local coordinates (the window itself is scaled by 0.8 later).
  const cx = crop.x + crop.w / 2
  const top = 104 + crop.y + crop.h * 0.2
  return `<div class="zoom bubble" style="left:${Math.max(40, cx - (crop.w * k) / 2)}px;top:${top}px;width:${crop.w * k}px;height:${crop.h * k}px">
    <div style="width:100%;height:100%;background:url('${file(join(RAW, spec.shot + ".png"))}') ${-crop.x * k}px ${-crop.y * k}px / ${MAC_W * k}px auto no-repeat"></div>
  </div>`
}

// ------------------------------------------------------------------- page

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: var(--W); height: var(--H); overflow: hidden; }
body { position: relative; background: linear-gradient(180deg, #F4F9FF 0%, #E7F0FF 55%, #E3EEFF 100%); font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
body.dark { background: radial-gradient(120% 70% at 50% 62%, #16306F 0%, #0B1633 48%, #070D1F 100%); }
.bg { position: absolute; top: 0; height: 100%; }
.bg svg { display: block; }
.cap { position: absolute; left: 0; right: 0; margin: 0 auto; text-align: center; font-family: "Inter Display", Inter, sans-serif; font-weight: 800; line-height: 1.06; letter-spacing: -0.025em; color: #0B1530; }
.cap .l2 { background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); -webkit-background-clip: text; background-clip: text; color: transparent; }
.cap.on-dark { color: #fff; }
.cap.on-dark .l2 { background: linear-gradient(90deg, #7DD3FC, #93C5FD 60%, #A5B4FC); -webkit-background-clip: text; background-clip: text; }
.appicon { position: absolute; left: 50%; transform: translateX(-50%); border-radius: 23%; box-shadow: 0 14px 40px rgba(37, 99, 235, .28); }
.pill { position: absolute; z-index: 5; display: flex; align-items: center; gap: 20px; padding: 20px 38px 20px 20px; border-radius: 999px; background: rgba(255,255,255,.96); color: #0B1530; font: 600 44px/1.1 Inter, sans-serif; letter-spacing: -0.01em; white-space: nowrap; box-shadow: 0 26px 60px rgba(20, 45, 110, .22), 0 2px 8px rgba(20, 45, 110, .10); }
.pill i { flex: none; width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 38px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #38BDF8, #2563EB); }
.pill.on-dark { background: rgba(23, 33, 64, .92); color: #fff; border: 2px solid rgba(147, 197, 253, .25); box-shadow: 0 26px 60px rgba(0,0,0,.45); }

/* iPhone */
.phone { position: absolute; z-index: 2; border-radius: 172px; padding: 30px; background: #0b0b0d; box-shadow: 0 0 0 6px #3a3b40, 0 0 0 9px #1a1a1d, 0 70px 140px rgba(16, 38, 96, .35), 0 20px 50px rgba(16, 38, 96, .25); }
body.dark .phone { box-shadow: 0 0 0 6px #4a4c55, 0 0 0 9px #22232a, 0 70px 160px rgba(0,0,0,.6), 0 0 120px rgba(59,130,246,.35); }
.phone-screen { position: absolute; left: 30px; top: 30px; transform-origin: 0 0; border-radius: 190px; overflow: hidden; background: #fff; }
.web { position: absolute; left: 0; display: block; }
.ios-status { position: absolute; top: 0; left: 0; right: 0; height: 162px; display: flex; align-items: center; justify-content: space-between; padding: 22px 96px 0 150px; font: 600 52px Inter, sans-serif; letter-spacing: -0.01em; }
.ios-status .ic { display: flex; align-items: center; gap: 18px; }
.island { position: absolute; top: 33px; left: 50%; width: 375px; height: 111px; margin-left: -187px; border-radius: 60px; background: #000; }
.ios-bar { position: absolute; left: 0; right: 0; top: 2562px; height: 234px; display: flex; align-items: flex-start; gap: 24px; padding: 30px 40px 0; }
.ios-bar .btn { flex: none; width: 138px; height: 138px; border-radius: 50%; padding: 36px; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10), inset 0 0 0 1.5px rgba(0,0,0,.05); }
.ios-bar .url { flex: 1; height: 138px; border-radius: 69px; display: flex; align-items: center; justify-content: center; gap: 22px; font: 500 46px Inter, sans-serif; color: #000; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10), inset 0 0 0 1.5px rgba(0,0,0,.05); position: relative; }
.ios-bar .url .aa { position: absolute; left: 44px; font-weight: 600; font-size: 40px; }
.ios-bar .url .rl { position: absolute; right: 40px; width: 52px; height: 52px; }
.ios-bar.dark .btn, .ios-bar.dark .url { background: rgba(44,44,46,.96); color: #fff; box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.08); }
.home { position: absolute; bottom: 24px; left: 50%; width: 420px; height: 15px; margin-left: -210px; border-radius: 8px; }

/* iPad */
.tablet { position: absolute; z-index: 2; border-radius: 96px; background: #0b0b0d; box-shadow: 0 0 0 5px #3a3b40, 0 0 0 8px #1a1a1d, 0 80px 160px rgba(16, 38, 96, .32), 0 24px 60px rgba(16, 38, 96, .22); }
body.dark .tablet { box-shadow: 0 0 0 5px #4a4c55, 0 0 0 8px #22232a, 0 80px 180px rgba(0,0,0,.6), 0 0 140px rgba(59,130,246,.35); }
.tablet-screen { position: absolute; left: 44px; top: 44px; transform-origin: 0 0; border-radius: 70px; overflow: hidden; background: #fff; }
.ipad-top { position: absolute; top: 0; left: 0; right: 0; height: 172px; background: #f6f6f8; border-bottom: 2px solid #e2e2e6; }
.ipad-top.dark { background: #1c1c1e; border-color: #2c2c2e; }
.ipad-top .st { height: 48px; display: flex; align-items: center; padding: 6px 44px 0; font: 500 28px Inter, sans-serif; }
.ipad-top .st .ic { margin-left: auto; display: flex; gap: 12px; transform: scale(.75); transform-origin: right center; }
.ipad-top .tb { height: 124px; display: flex; align-items: center; padding: 0 36px; gap: 30px; }
.ipad-top .grp { display: flex; gap: 34px; }
.ipad-top .grp i, .mac-tb .grp i { display: block; width: 52px; height: 52px; }
.grp i.dim { opacity: .35; }
.grp i.ext { border-radius: 12px; background: rgba(37,99,235,.14); padding: 6px; }
.grp i.ext img { width: 100%; height: 100%; display: block; }
.ipad-top .url { flex: 1; margin: 0 auto; max-width: 980px; height: 76px; border-radius: 20px; background: #e9e9ed; display: flex; align-items: center; justify-content: center; gap: 14px; font: 500 32px Inter, sans-serif; color: #1c1c1e; }
.ipad-top.dark .url { background: #2c2c2e; color: #f2f2f7; }
.ipad-top .url i, .mac-tb .url i { display: block; width: 30px; height: 30px; }

/* Mac */
.win { position: absolute; z-index: 2; transform-origin: 0 0; border-radius: 26px; overflow: hidden; background: #fff; box-shadow: 0 0 0 2px rgba(0,0,0,.12), 0 90px 180px rgba(16, 38, 96, .35), 0 30px 70px rgba(16, 38, 96, .22); }
.win.dark { box-shadow: 0 0 0 2px rgba(255,255,255,.14), 0 90px 200px rgba(0,0,0,.6), 0 0 160px rgba(59,130,246,.35); }
.mac-tb { position: absolute; top: 0; left: 0; right: 0; height: 104px; display: flex; align-items: center; gap: 44px; padding: 0 36px; background: #f6f6f6; border-bottom: 2px solid #dedede; }
.win.dark .mac-tb { background: #2a2a2d; border-color: #3a3a3d; }
.mac-tb .lights { display: flex; gap: 16px; }
.mac-tb .lights i { width: 26px; height: 26px; border-radius: 50%; display: block; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.mac-tb .grp { display: flex; gap: 30px; align-items: center; }
.mac-tb .grp i { width: 40px; height: 40px; }
.mac-tb .grp i.ext { width: 54px; height: 54px; }
.mac-tb .grp.right { margin-left: auto; }
.mac-tb .url { position: absolute; left: 50%; width: 900px; margin-left: -450px; height: 64px; border-radius: 16px; background: #e8e8ea; display: flex; align-items: center; justify-content: center; gap: 12px; font: 500 30px Inter, sans-serif; color: #2c2c2e; }
.win.dark .mac-tb .url { background: #3a3a3d; color: #f2f2f7; }

.zoom { position: absolute; z-index: 4; border-radius: 40px; overflow: hidden; background: #fff; box-shadow: 0 0 0 3px rgba(37,99,235,.18), 0 40px 90px rgba(20, 45, 110, .30), 0 8px 24px rgba(20, 45, 110, .14); }
.zoom.bubble { border-radius: 36px; }
`

function page(device, count, index, spec, size) {
  const dark = Boolean(spec.dark)
  const host = spec.foreign ? COPY.foreignHost : COPY.host
  let body = panorama(device, count, index, dark)
  body += caption(device, spec.caption, dark, size)
  if (spec.icon) body += `<img class="appicon" src="${APP_ICON}" style="top:70px;width:132px;height:132px">`
  if (device === DEVICES.iphone) {
    body += iphone(spec.shot, dark, host)
    if (spec.zoom) body += zoomCard(spec.zoom, device.W, dark)
    body += pills(spec.pills, dark)
  } else if (device === DEVICES.ipad) {
    body += ipad(spec.shot, dark, host)
    body += pills(spec.pills, dark, 1.25)
  } else {
    body += macWindow(spec.shot, dark, host, spec.bubble ? bubbleZoom(spec.bubble) : "")
    body += pills(spec.pills, dark, 1.3)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{--W:${device.W}px;--H:${device.H}px}${CSS}</style></head>
<body class="${dark ? "dark" : ""}">${body}
<script>
// Status bar takes the colour of the page right under it (dimmed by the sheet backdrop or not).
for (const el of document.querySelectorAll("[data-sample]")) {
  const img = el.parentElement.querySelector("img.web")
  const run = () => {
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight
    const g = c.getContext("2d"); g.drawImage(img, 0, 0)
    const y = el.dataset.sample === "top" ? 2 : img.naturalHeight - 2
    const [r, gg, b] = g.getImageData(10, y, 1, 1).data
    el.style.background = "rgb(" + r + "," + gg + "," + b + ")"
  }
  img.complete ? run() : img.addEventListener("load", run)
}
</script></body></html>`
}

// --------------------------------------------------------------- render

const browser = await chromium.launch({
  executablePath: existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined,
  args: ["--allow-file-access-from-files", "--font-render-hinting=none"]
})

// One caption size per set: the largest that fits every caption line (uniform typography).
async function fitSize(device, specs) {
  const p = await browser.newPage({ viewport: { width: device.W, height: 400 } })
  await p.setContent(`<style>${CSS}</style><div id="m"></div>`)
  const size = await p.evaluate(async ({ lines, max, base, one }) => {
    await document.fonts.load(`800 100px "Inter Display"`)
    const span = document.createElement("span")
    span.style.cssText = `font-family:"Inter Display";font-weight:800;letter-spacing:-0.025em;white-space:nowrap;position:absolute`
    document.body.appendChild(span)
    let s = base
    for (; s > 40; s -= 2) {
      span.style.fontSize = s + "px"
      const ok = lines.every((l) => { span.textContent = l; return span.getBoundingClientRect().width <= max })
      if (ok) break
    }
    return s
  }, { lines: specs.flatMap((s) => (device.oneLine ? [s.caption.join(" ")] : s.caption)), max: device.captionMax - 40, base: device.captionSize, one: device.oneLine })
  await p.close()
  return size
}

for (const [kind, specs] of Object.entries(SETS)) {
  const device = DEVICES[kind]
  const size = await fitSize(device, specs)
  const dir = join(OUT, kind)
  mkdirSync(dir, { recursive: true })
  const outputs = []
  for (const [i, spec] of specs.entries()) {
    const html = join(TMP, `${kind}-${i}.html`)
    writeFileSync(html, page(device, specs.length, i, spec, size))
    const p = await browser.newPage({ viewport: { width: device.W, height: device.H }, deviceScaleFactor: 1 })
    await p.goto(file(html))
    await p.evaluate(() => document.fonts.ready)
    await p.waitForTimeout(250)
    const out = join(dir, `${String(i + 1).padStart(2, "0")}-${spec.name}.png`)
    await p.screenshot({ path: out, clip: { x: 0, y: 0, width: device.W, height: device.H } })
    await p.close()
    outputs.push(out)
  }
  // Review strip: all screens of the set side by side, downscaled.
  const strip = await browser.newPage({ viewport: { width: 2400, height: 800 } })
  const h = Math.round((2400 / (device.W * specs.length + 40 * (specs.length - 1))) * device.H)
  await strip.setViewportSize({ width: 2400, height: h })
  const stripHtml = join(TMP, `${kind}-strip.html`)
  writeFileSync(stripHtml, `<body style="margin:0;display:flex;gap:${Math.round((40 * 2400) / (device.W * specs.length))}px;background:#fff">${outputs.map((o) => `<img src="${file(o)}" style="flex:1;min-width:0;height:auto">`).join("")}</body>`)
  await strip.goto(file(stripHtml))
  await strip.waitForTimeout(400)
  await strip.screenshot({ path: join(dir, "strip.png") })
  await strip.close()
  console.log(`${kind}: ${outputs.length} screens, caption ${size}px → ${dir}`)
}
await browser.close()
