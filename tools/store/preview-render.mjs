// Renders an App Store app preview for iPhone 6.9"/6.5" (886 × 1920), iPad 13" (1200 × 1600) or
// Mac (1920 × 1080), 30 fps, ≤ 30 s, from the takes recorded by preview-record.mjs. Same look as the
// screenshots (compose.mjs): caption on top, the real UI below, a touch marker on every tap (a pointer
// and the shortcut keys on the Mac) and a closing card. The last shot pulls back from this device's
// screen to iPhone, iPad and Mac showing the same chat. Device frames there go past Apple's "screen
// capture only" rule for previews, on purpose: it is the one way to show the chat on every device.
// Needs ffmpeg with libx264 on PATH.
//   node tools/store/preview-render.mjs <recDir> <out.mp4> [lang:en|ru] [iphone|ipad|mac]
// <recDir> holds the takes of each device in iphone/, ipad/ and mac/ (the closing shot uses all three).
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.CF_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [recArg, outArg, lang = "en", device = "iphone"] = process.argv.slice(2)
const RECS = resolve(recArg)
const REC = join(RECS, device)
const OUT = resolve(outArg)
const TMP = join(dirname(OUT), `.preview-${lang}-${device}`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, "frames"), { recursive: true })
const file = (p) => pathToFileURL(p).href

const FPS = 30
const XFADE = 0.3 // cross-fade between takes, s
const PPO = process.env.SET === "ppo"
const SYNC = PPO ? 3.7 : 4.5 // closing shot: the chat on every device, s
const HOLD = 0.35 // ...this device alone before the camera pulls back, s
const PULL = process.env.SET === "ppo" ? 1.8 : 2.1 // ...the pull-back, s
const END = PPO ? 2.1 : 2.4 // closing card, s
const CAP_OUT = 0.18 // old caption fades out, s
const CAP_IN = 0.27 // then the new one rises in, s

// Screens as the screenshots draw them (compose.mjs): size, where the recorded page sits on it,
// screen px per CSS px of the page, corner radius.
const SCREENS = {
  iphone: { w: 1290, h: 2796, top: 162, page: 2400, css: 3, radius: 190 },
  ipad: { w: 2064, h: 2752, top: 172, page: 2580, css: 2064 / 826, radius: 70 },
  mac: { w: 2360, h: 1624, top: 104, page: 1520, css: 2, radius: 26 }
}
// The video frame: size, caption (and where it ends), where the screen sits in the regular shots, the tap marker.
const FRAMES = {
  iphone: { W: 886, H: 1920, capTop: 92, capSize: 72, capEnd: 250, screenTop: 300, bottom: 60, tap: 84 },
  ipad: { W: 1200, H: 1600, capTop: 70, capSize: 70, capEnd: 225, screenTop: 262, bottom: 50, tap: 70 },
  mac: { W: 1920, H: 1080, capTop: 46, capSize: 60, capEnd: 118, oneLine: true, screenTop: 150, bottom: 40 }
}
const S = SCREENS[device]
const F = FRAMES[device]
if (!S) throw new Error(`unknown device ${device}`)
const { W, H } = F

// Captions match the screenshot set (tools/store/compose.mjs).
const COPY = {
  en: {
    summary: ["Summarize any", "page in Safari"],
    select: ["Select text, ask", "or save a note"],
    follows: ["One chat follows", "you page to page"],
    notes: ["Keep notes", "right in the chat"],
    sync: ["Same chats on", "iPhone, iPad, Mac"],
    price: ["Know when", "a price drops"],
    copies: ["Your last 5 copies", "in any Safari field"],
    fill: ["Templates fill in", "names and dates"],
    synced: "Synced through iCloud",
    end: ["AI, notes and templates in Safari", "On iPhone, iPad and Mac"],
    banner: { title: "Changed: Price", body: "Now: $99", time: "now" },
    host: "weeklyreview.com",
    host2: "techledger.com",
    shopHost: "soundhouse.store",
    mailHost: "mail.northwind.studio"
  },
  ru: {
    summary: ["Пересказ страницы", "прямо в Safari"],
    select: ["Выделите текст:", "вопрос или заметка"],
    follows: ["Чат идёт с вами", "по всем сайтам"],
    notes: ["Заметки", "прямо в чате"],
    sync: ["Одни чаты на", "iPhone, iPad и Mac"],
    price: ["Узнаете, когда", "цена упадёт"],
    copies: ["Последние 5 копий", "в любом поле Safari"],
    fill: ["Шаблон сам впишет", "имя и дату"],
    synced: "Синхронизация через iCloud",
    end: ["ИИ, заметки и шаблоны в Safari", "На iPhone, iPad и Mac"],
    banner: { title: "Изменилось: Цена", body: "Сейчас: 10 990 ₽", time: "сейчас" },
    host: "delovoyobzor.ru",
    host2: "tehrynok.ru",
    shopHost: "zvukodom.store",
    mailHost: "mail.sevveter.studio"
  }
}[lang]
// The iPad's status bar day: the takes' page dates show the day they were recorded (today).
COPY.date = (() => {
  const d = new Date()
  if (lang === "ru") {
    const s = d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" }).replace(",", "")
    return s[0].toUpperCase() + s.slice(1)
  }
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "")
})()
const [appName, appTagline] = readFileSync(join(root, `store/metadata/${lang === "ru" ? "ru" : "en-US"}/name.txt`), "utf8").trim().split(/:\s*/)

// Takes in play order; `from` trims the start (seconds within the take), each runs to its end; `host` is
// the site in the address bar. The 30 s preview ends on the chat on every device.
// The 2.6 page test (SET=ppo, iPhone and iPad): summary → price drop with the notification → a field filled from
// the last copies → a template filled from the page → the same chats on every device (Mac with its sidebar).
const SEGMENTS = process.env.SET === "ppo"
  ? [
      { take: "main", from: 1.3, host: COPY.host },
      { take: "watch", from: 0.6, host: COPY.shopHost },
      { take: "copies", from: 0.4, host: COPY.mailHost },
      { take: "fill", from: 0.35, host: COPY.mailHost }
    ]
  : [
      { take: "main", from: 0.7, host: COPY.host },
      { take: "select", from: 0.5, host: COPY.host },
      { take: "follows", from: 0.8, host: COPY.host2 },
      { take: "notes", from: 0.55, host: COPY.host }
    ]
const LAST_CAPTION = SEGMENTS.at(-1).take === "notes" ? "notes" : SEGMENTS.at(-1).take === "fill" ? "fill" : "notes"

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
const syncStart = start + XFADE
const endStart = syncStart + SYNC - XFADE
const TOTAL = endStart + XFADE + END
if (TOTAL > 30 && !process.env.FRAME) throw new Error(`preview is ${TOTAL.toFixed(2)} s, App Store allows 30 s`)

const local = (s, t) => t - s.start + s.from
const frameAt = (s, lt) => {
  let f = s.frames[0]
  for (const x of s.frames) { if (x.t <= lt) f = x; else break }
  return join(REC, s.take, f.f)
}
// The chat every device shows in the closing shot: the end of its own notes take.
const lastNote = (k) => {
  const rec = JSON.parse(readFileSync(join(RECS, k, "notes.json"), "utf8"))
  return file(join(RECS, k, "notes", rec.frames.at(-1).f))
}
const captionAt = (s, lt) => {
  let key = null
  let since = -Infinity
  for (const e of s.events) if (e.type === "caption" && e.t <= Math.max(lt, s.from)) { key = e.key; since = e.t }
  return { key, since }
}
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3))
const easeInOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

// The Mac pointer: it glides from the previous click when they come close together, clicks, then fades.
function pointer(events, lt) {
  const ps = events.filter((e) => e.type === "tap" || e.type === "point")
  const i = ps.findLastIndex((e) => e.t - 0.4 <= lt)
  if (i < 0) return null
  const e = ps[i]
  const prev = ps[i - 1]
  const next = ps[i + 1]
  const chained = prev && e.t - prev.t < 1.6
  if (lt > e.t + 0.8 && !(next && next.t - e.t < 1.6)) return null
  const k = chained ? easeInOut((lt - (e.t - 0.4)) / 0.4) : 1
  const x = chained ? prev.x + (e.x - prev.x) * k : e.x
  const y = chained ? prev.y + (e.y - prev.y) * k : e.y
  const o = (chained ? 1 : ease((lt - (e.t - 0.4)) / 0.12)) * (next && next.t - e.t < 1.6 ? 1 : 1 - ease((lt - e.t - 0.5) / 0.3))
  const age = lt - e.t
  return { x, y, o, ripple: e.type === "tap" && age >= 0 && age < 0.45 ? age / 0.45 : null }
}

function state(t) {
  const layers = []
  const taps = []
  let cursor = null
  let keys = null
  let caption = null
  let prevCaption = null
  let banner = null
  for (const [i, s] of SEGMENTS.entries()) {
    if (t < s.start || t > s.start + s.dur) continue
    const lt = local(s, t)
    const fadeIn = i === 0 ? 1 : ease((t - s.start) / XFADE)
    layers.push({ src: file(frameAt(s, lt)), opacity: fadeIn, host: s.host })
    for (const e of s.events) {
      const age = lt - e.t
      if (F.tap && e.type === "tap" && age >= 0 && age < 0.55) taps.push({ x: e.x, y: e.y, o: Math.min(1, age / 0.08) * (1 - ease((age - 0.25) / 0.3)), k: 0.75 + 0.25 * ease(age / 0.2) })
      // A swipe: the finger lands, slides `dy` and lifts.
      if (F.tap && e.type === "swipe" && age >= 0 && age < 0.8) taps.push({ x: e.x, y: e.y + e.dy * ease((age - 0.12) / 0.35), o: Math.min(1, age / 0.08) * (1 - ease((age - 0.5) / 0.3)), k: 0.9 })
      if (e.type === "keys" && age >= 0 && age < 1.2) keys = { text: e.text, o: ease(age / 0.15) * (1 - ease((age - 0.9) / 0.3)) }
      // The notification the app sends when the check finds the new price: slides down and stays.
      if (e.type === "banner" && age >= 0) banner = { k: ease(age / 0.4), o: i === SEGMENTS.length - 1 ? 1 : 1 }
    }
    if (!F.tap) cursor = pointer(s.events, lt) ?? cursor
    // Caption: the newest segment wins. On a change the old line fades out first, then the new one rises in.
    const c = captionAt(s, lt)
    const atCut = i > 0 && t - s.start < CAP_OUT + CAP_IN
    const p = atCut ? SEGMENTS[i - 1].events.filter((e) => e.type === "caption").at(-1) : s.events.filter((e) => e.type === "caption" && e.t < c.since).at(-1)
    const age = atCut ? t - s.start : p ? lt - c.since : Infinity
    caption = { key: c.key, k: ease((age - CAP_OUT) / CAP_IN) }
    prevCaption = p && age < CAP_OUT ? { key: p.key, o: 1 - age / CAP_OUT } : null
  }
  // Closing shot: the notes caption gives way to "on all your devices" as the camera pulls back.
  let pull = null
  let camIn = 1
  if (t >= syncStart) {
    const age = t - syncStart
    pull = easeInOut((age - HOLD) / PULL)
    caption = { key: "sync", k: ease((age - CAP_OUT) / CAP_IN) }
    prevCaption = age < CAP_OUT ? { key: LAST_CAPTION, o: 1 - age / CAP_OUT } : null
    // From another take than the chat on every device: the closing shot fades in over its last frame.
    if (LAST_CAPTION !== "notes") {
      camIn = ease(age / 0.35)
      const s = SEGMENTS.at(-1)
      if (camIn < 1) layers.push({ src: file(frameAt(s, s.to)), opacity: 1, host: s.host })
    }
  }
  const end = ease((t - endStart) / 0.45)
  return {
    layers, taps, cursor, keys, pull, end, banner, camIn,
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
  fwd: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M9 5l7 7-7 7" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><g fill="${c}"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>`,
  reload: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lock: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="${c}" d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H7zm2 0h6V8a3 3 0 0 0-6 0v2z"/></svg>`,
  sidebar: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M9 5v14" stroke="${c}" stroke-width="1.8"/></svg>`,
  share: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 3v12M8 7l4-4 4 4M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 5v14M5 12h14" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`,
  tabs: (c) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="7" width="13" height="13" rx="2.5" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 4h10a3 3 0 0 1 3 3v10" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  cursor: `<svg viewBox="0 0 24 32" width="100%" height="100%"><path d="M2 2v24l6.5-6.2 4.2 9.6 4.1-1.8-4.1-9.3H22z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  devices: `<svg viewBox="0 0 24 24" width="32" height="32"><rect x="1.5" y="5" width="13" height="9" rx="1.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M0 17.5h16" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="16.5" y="7.5" width="7" height="12.5" rx="1.8" fill="#fff"/></svg>`
}
// Icons of the closing card's two lines (COPY.end).
const CARD_ICONS = ["✦", svg.devices]
const EXT_ICON = file(join(root, "extension/icons/icon-128.png"))

// A device's screen at its own resolution (scaled by the caller): Safari's chrome around the recorded page.
function screen(k, attrs) {
  const s = SCREENS[k]
  const page = `<img class="web" style="top:${s.top}px;width:${s.w}px;height:${s.page}px">`
  if (k === "iphone") return `
<div class="scr iphone" ${attrs}>
  <div class="ios-status"><div class="t">9:41</div><div class="ic">${svg.signal("#000")}${svg.wifi("#000")}${svg.battery("#000")}</div></div>
  ${page}
  <div class="ios-bar">
    <div class="btn">${svg.back("#000")}</div>
    <div class="url"><span class="aa">aA</span><span class="host">${COPY.host}</span><span class="rl">${svg.reload("#000")}</span></div>
    <div class="btn">${svg.more("#000")}</div>
  </div>
  <div class="home"></div><div class="island"></div>
</div>`
  const fg = k === "ipad" ? "#1c1c1e" : "#3a3a3c"
  if (k === "ipad") return `
<div class="scr ipad" ${attrs}>
  <div class="ipad-top">
    <div class="st"><b>9:41</b>&nbsp;&nbsp;${COPY.date}<span class="ic">${svg.wifi(fg)}${svg.battery(fg)}</span></div>
    <div class="tb">
      <div class="grp"><i>${svg.sidebar(fg)}</i><i>${svg.back(fg)}</i><i class="dim">${svg.fwd(fg)}</i></div>
      <div class="url"><i>${svg.lock(fg)}</i><span class="host">${COPY.host}</span></div>
      <div class="grp"><i class="ext"><img src="${EXT_ICON}"></i><i>${svg.share(fg)}</i><i>${svg.plus(fg)}</i><i>${svg.tabs(fg)}</i></div>
    </div>
  </div>
  ${page}
</div>`
  return `
<div class="scr mac" ${attrs}>
  <div class="mac-tb">
    <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    <div class="grp"><i>${svg.sidebar(fg)}</i><i>${svg.back(fg)}</i><i class="dim">${svg.fwd(fg)}</i></div>
    <div class="url"><i>${svg.lock(fg)}</i><span class="host">${COPY.host}</span></div>
    <div class="grp right"><i class="ext"><img src="${EXT_ICON}"></i><i>${svg.share(fg)}</i><i>${svg.plus(fg)}</i><i>${svg.tabs(fg)}</i></div>
  </div>
  ${page}
</div>`
}

// The regular shots: this device's screen, scaled into the stage below the caption.
const K = (H - F.screenTop - F.bottom) / S.h
const SCREEN_LEFT = (W - S.w * K) / 2
const SCREEN_TOP = F.screenTop
const R0 = { x: SCREEN_LEFT, y: SCREEN_TOP, w: S.w * K }

// The closing shot: device frames around the same screens. Sizes are fractions of the screen width.
const BEZEL = { iphone: 0.035, ipad: 0.03, mac: 0.022 }
const CHIN = 0.04 // MacBook: the band under the screen,
const BASE_H = 0.04 // the base,
const BASE_OUT = 0.08 // and how far it sticks out on each side
function box(k, w) {
  const b = BEZEL[k] * w
  const h = (w * SCREENS[k].h) / SCREENS[k].w
  return k === "mac"
    ? { w: w + 2 * b + 2 * BASE_OUT * w, h: b + h + CHIN * w + BASE_H * w, sx: b + BASE_OUT * w, sy: b }
    : { w: w + 2 * b, h: h + 2 * b, sx: b, sy: b }
}
// Final framing, per video shape: Mac on top with iPad and iPhone below (portrait), or the three in a row
// (Mac). Each device: its box (frame included) and its screen rectangle, in stage px.
function layout() {
  const place = (k, w, x, y) => { const b = box(k, w); return { k, w, x: x + b.sx, y: y + b.sy, box: { x, y, w: b.w, h: b.h } } }
  if (device === "mac") {
    const size = { ipad: 429, mac: 840, iphone: 243 }
    const gap = 50
    const order = ["ipad", "mac", "iphone"]
    const boxes = order.map((k) => box(k, size[k]))
    const rowW = boxes.reduce((a, b) => a + b.w, 0) + gap * 2
    const rowH = Math.max(...boxes.map((b) => b.h))
    const baseline = 140 + (800 - rowH) / 2 + rowH
    let x = (W - rowW) / 2
    return Object.fromEntries(order.map((k, i) => { const p = place(k, size[k], x, baseline - boxes[i].h); x += boxes[i].w + gap; return [k, p] }))
  }
  const [areaTop, areaBottom, size] = device === "iphone"
    ? [300, 1680, { mac: 690, ipad: 450, iphone: 258 }]
    : [245, 1440, { mac: 700, ipad: 420, iphone: 240 }]
  const gap = 44
  const vgap = 70
  const m = box("mac", size.mac), a = box("ipad", size.ipad), c = box("iphone", size.iphone)
  const rowH = Math.max(a.h, c.h)
  const top = areaTop + (areaBottom - areaTop - (m.h + vgap + rowH)) / 2
  const rowX = (W - (a.w + gap + c.w)) / 2
  const baseline = top + m.h + vgap + rowH
  return {
    mac: place("mac", size.mac, (W - m.w) / 2, top),
    ipad: place("ipad", size.ipad, rowX, baseline - a.h),
    iphone: place("iphone", size.iphone, rowX + a.w + gap, baseline - c.h)
  }
}
const GROUP = layout()
const R1 = GROUP[device]
const PILL_Y = { iphone: 1745, ipad: 1478, mac: 966 }[device]

function frameHtml(g) {
  const s = SCREENS[g.k]
  const k = g.w / s.w
  const r = s.radius * k
  const b = BEZEL[g.k] * g.w
  const frame = g.k === "mac"
    ? `<div class="bz" style="left:${g.x - g.box.x - b}px;top:0;width:${g.w + 2 * b}px;height:${b + (g.w * s.h) / s.w + CHIN * g.w}px;border-radius:${r + b}px ${r + b}px ${0.012 * g.w}px ${0.012 * g.w}px"></div>
       <div class="base" style="left:0;bottom:0;width:${g.box.w}px;height:${BASE_H * g.w}px;border-radius:0 0 ${BASE_H * g.w}px ${BASE_H * g.w}px / 0 0 ${BASE_H * g.w * 0.9}px ${BASE_H * g.w * 0.9}px"><i style="width:${0.16 * g.w}px;height:${BASE_H * g.w * 0.32}px"></i></div>`
    : `<div class="bz" style="inset:0;border-radius:${r + b}px;box-shadow:0 0 0 ${b * 0.16}px #3a3b40, 0 ${g.w * 0.05}px ${g.w * 0.12}px rgba(16,38,96,.32)"></div>`
  return `
<div class="dev" id="dev-${g.k}" style="left:${g.box.x}px;top:${g.box.y}px;width:${g.box.w}px;height:${g.box.h}px">
  <div class="frame">${frame}</div>
  ${screen(g.k, `style="left:${g.x - g.box.x}px;top:${g.y - g.box.y}px;transform:scale(${k})"`)}
</div>`
}

const capHtml = (l) => !l ? "" : F.oneLine
  ? `<span class="l1">${l[0]}</span> <span class="l2">${l[1]}</span>`
  : `<span class="l1">${l[0]}</span><br><span class="l2">${l[1]}</span>`

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=block" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
body { position: relative; background: linear-gradient(180deg, #F4F9FF 0%, #E7F0FF 55%, #E3EEFF 100%); font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
.ribbon { position: absolute; inset: 0; }
.cap { position: absolute; left: 0; right: 0; top: ${F.capTop}px; z-index: 5; text-align: center; font-weight: 800; font-size: ${F.capSize}px; line-height: 1.06; letter-spacing: -0.025em; color: #0B1530; font-optical-sizing: auto; will-change: transform, opacity; }
.cap .l2 { background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); -webkit-background-clip: text; background-clip: text; color: transparent; }
.scr { position: absolute; width: ${S.w}px; transform-origin: 0 0; overflow: hidden; background: #fff; }
.scr.iphone { width: 1290px; height: 2796px; border-radius: 190px; }
.scr.ipad { width: 2064px; height: 2752px; border-radius: 70px; }
.scr.mac { width: 2360px; height: 1624px; border-radius: 26px; }
.web { position: absolute; left: 0; display: block; }
.ios-status { position: absolute; top: 0; left: 0; right: 0; height: 162px; display: flex; align-items: center; justify-content: space-between; padding: 22px 96px 0 150px; font: 600 52px Inter, sans-serif; letter-spacing: -0.01em; color: #000; }
.ios-status .ic { display: flex; align-items: center; gap: 18px; }
.island { position: absolute; top: 33px; left: 50%; width: 375px; height: 111px; margin-left: -187px; border-radius: 60px; background: #000; }
.ios-bar { position: absolute; left: 0; right: 0; top: 2562px; height: 234px; display: flex; align-items: flex-start; gap: 24px; padding: 30px 40px 0; }
.ios-bar .btn { flex: none; width: 138px; height: 138px; border-radius: 50%; padding: 36px; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10), inset 0 0 0 1.5px rgba(0,0,0,.05); }
.ios-bar .url { flex: 1; height: 138px; border-radius: 69px; display: flex; align-items: center; justify-content: center; gap: 22px; font: 500 46px Inter, sans-serif; color: #000; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10), inset 0 0 0 1.5px rgba(0,0,0,.05); position: relative; }
.ios-bar .url .aa { position: absolute; left: 44px; font-weight: 600; font-size: 40px; }
.ios-bar .url .rl { position: absolute; right: 40px; width: 52px; height: 52px; }
.home { position: absolute; bottom: 24px; left: 50%; width: 420px; height: 15px; margin-left: -210px; border-radius: 8px; background: #000; }
.ipad-top { position: absolute; top: 0; left: 0; right: 0; height: 172px; background: #f6f6f8; border-bottom: 2px solid #e2e2e6; }
.ipad-top .st { height: 48px; display: flex; align-items: center; padding: 6px 44px 0; font: 500 28px Inter, sans-serif; color: #1c1c1e; }
.ipad-top .st .ic { margin-left: auto; display: flex; gap: 12px; transform: scale(.75); transform-origin: right center; }
.ipad-top .tb { height: 124px; display: flex; align-items: center; padding: 0 36px; gap: 30px; }
.ipad-top .grp { display: flex; gap: 34px; }
.ipad-top .grp i, .mac-tb .grp i { display: block; width: 52px; height: 52px; }
.grp i.dim { opacity: .35; }
.grp i.ext { border-radius: 12px; background: rgba(37,99,235,.14); padding: 6px; }
.grp i.ext img { width: 100%; height: 100%; display: block; }
.ipad-top .url { flex: 1; margin: 0 auto; max-width: 980px; height: 76px; border-radius: 20px; background: #e9e9ed; display: flex; align-items: center; justify-content: center; gap: 14px; font: 500 32px Inter, sans-serif; color: #1c1c1e; }
.ipad-top .url i, .mac-tb .url i { display: block; width: 30px; height: 30px; }
.mac-tb { position: absolute; top: 0; left: 0; right: 0; height: 104px; display: flex; align-items: center; gap: 44px; padding: 0 36px; background: #f6f6f6; border-bottom: 2px solid #dedede; }
.mac-tb .lights { display: flex; gap: 16px; }
.mac-tb .lights i { width: 26px; height: 26px; border-radius: 50%; display: block; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.mac-tb .grp { display: flex; gap: 30px; align-items: center; }
.mac-tb .grp i { width: 40px; height: 40px; }
.mac-tb .grp i.ext { width: 54px; height: 54px; }
.mac-tb .grp.right { margin-left: auto; }
.mac-tb .url { position: absolute; left: 50%; width: 900px; margin-left: -450px; height: 64px; border-radius: 16px; background: #e8e8ea; display: flex; align-items: center; justify-content: center; gap: 12px; font: 500 30px Inter, sans-serif; color: #2c2c2e; }
/* Devices coming down from above slide out from under the caption instead of running through it. */
#cam { position: absolute; inset: 0; z-index: 3; display: none; -webkit-mask-image: linear-gradient(180deg, transparent ${F.capEnd}px, #000 ${F.capEnd + 36}px); mask-image: linear-gradient(180deg, transparent ${F.capEnd}px, #000 ${F.capEnd + 36}px); }
#world { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; }
.dev { position: absolute; }
.frame { position: absolute; inset: 0; }
.bz { position: absolute; background: #0b0b0d; }
.base { position: absolute; background: linear-gradient(180deg, #e6e8ec 0%, #c9ccd2 55%, #a7abb3 100%); box-shadow: 0 18px 40px rgba(16,38,96,.25); display: flex; justify-content: center; }
.base i { display: block; background: rgba(0,0,0,.14); border-radius: 0 0 12px 12px; }
#taps { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
.tap { position: absolute; width: ${F.tap ?? 84}px; height: ${F.tap ?? 84}px; margin: -${(F.tap ?? 84) / 2}px 0 0 -${(F.tap ?? 84) / 2}px; border-radius: 50%; background: rgba(255,255,255,.55); border: 3px solid rgba(37,99,235,.55); box-shadow: 0 6px 22px rgba(16,38,96,.35); }
#cursor { position: absolute; z-index: 11; width: 26px; height: 35px; display: none; filter: drop-shadow(0 3px 6px rgba(0,0,0,.3)); }
#ripple { position: absolute; z-index: 10; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; border: 3px solid rgba(37,99,235,.7); display: none; }
#keys { position: absolute; z-index: 11; left: 0; right: 0; display: none; justify-content: center; gap: 14px; }
#keys b { min-width: 78px; height: 78px; padding: 0 18px; border-radius: 16px; display: grid; place-items: center; font: 600 38px Inter, sans-serif; color: #0B1530; background: #fff; box-shadow: 0 4px 0 #c7cdd8, 0 16px 36px rgba(16,38,96,.28); }
#synced { position: absolute; z-index: 6; left: 0; right: 0; top: ${PILL_Y}px; display: flex; justify-content: center; opacity: 0; }
#banner { position: absolute; z-index: 9; display: none; align-items: center; gap: 0.75em; padding: 0.75em 0.95em; border-radius: 1.5em; background: rgba(248,248,250,.99); box-shadow: 0 18px 44px rgba(20,45,110,.30); color: #000; line-height: 1.25; }
#banner img { flex: none; width: 2.3em; height: 2.3em; border-radius: 0.55em; }
#banner .bt { flex: 1; display: flex; flex-direction: column; }
#banner b { font-weight: 650; }
#banner i { align-self: flex-start; font-style: normal; color: #8a8a8e; font-size: .85em; }
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
  <path d="M-200,${H * 0.62} C${W * 0.3},${H * 0.48} ${W * 0.7},${H * 0.72} ${W + 200},${H * 0.55}" fill="none" stroke="url(#rib)" stroke-width="${Math.round(Math.min(W, H) * 0.2)}" opacity=".5" filter="url(#soft)"/>
</svg>
<h1 class="cap" id="c0"></h1><h1 class="cap" id="c1"></h1>
${screen(device, `id="s0" style="left:${SCREEN_LEFT}px;top:${SCREEN_TOP}px;transform:scale(${K})"`)}
${screen(device, `id="s1" style="left:${SCREEN_LEFT}px;top:${SCREEN_TOP}px;transform:scale(${K})"`)}
<div id="cam"><div id="world">${Object.values(GROUP).map(frameHtml).join("")}</div></div>
<div id="synced"><div class="pill"><i>☁︎</i>${COPY.synced}</div></div>
<div id="banner" style="left:${SCREEN_LEFT + S.w * K * 0.03}px;top:${SCREEN_TOP + S.top * K}px;width:${S.w * K * 0.94}px;font-size:${Math.round(S.w * K * 0.043)}px">
  <img src="${file(join(root, "ContextFlow/Shared (App)/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png"))}"><div class="bt"><b>${COPY.banner?.title ?? ""}</b><span>${COPY.banner?.body ?? ""}</span></div><i>${COPY.banner?.time ?? ""}</i></div>
<div id="taps"></div><div id="ripple"></div><div id="cursor">${svg.cursor}</div>
<div id="keys" style="top:${SCREEN_TOP + S.h * K - 150}px"></div>
<div id="end"><img src="${file(join(root, "ContextFlow/Shared (App)/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png"))}">
  <h1>${appName}<span>${appTagline ?? ""}</span></h1>
  <div class="pills">${COPY.end.map((text, i) => `<div class="pill"><i>${CARD_ICONS[i]}</i>${text}</div>`).join("")}</div>
</div>
<script>
const DEVICE = ${JSON.stringify(device)}
const R0 = ${JSON.stringify(R0)}, R1 = ${JSON.stringify({ x: R1.x, y: R1.y, w: R1.w })}
const SHOTS = ${JSON.stringify(Object.fromEntries(["iphone", "ipad", "mac"].map((k) => [k, lastNote(k)])))}
const probe = document.createElement("canvas"); probe.width = probe.height = 1
const pg = probe.getContext("2d", { willReadFrequently: true })
const sample = (img, y) => { pg.drawImage(img, 10, y, 1, 1, 0, 0, 1, 1); const [r, g, b] = pg.getImageData(0, 0, 1, 1).data; return "rgb(" + r + "," + g + "," + b + ")" }
const capHtml = ${capHtml.toString()}
const F = ${JSON.stringify({ oneLine: !!F.oneLine })}
// The iPhone's status and Safari bars take the colour of the page edge under them.
async function show(scr, src) {
  const img = scr.querySelector("img.web")
  if (img.dataset.src === src) return
  img.src = src; img.dataset.src = src; await img.decode()
  if (!scr.classList.contains("iphone")) return
  scr.querySelector(".ios-status").style.background = sample(img, 2)
  scr.querySelector(".ios-bar").style.background = sample(img, img.naturalHeight - 2)
}
const shadow = (f) => "0 0 0 4px rgba(11,21,48," + 0.08 * f + "), 0 90px 200px rgba(16,38,96," + 0.30 * f + "), 0 30px 70px rgba(16,38,96," + 0.18 * f + ")"
const ready = Promise.all(Object.entries(SHOTS).map(([k, src]) => show(document.querySelector("#dev-" + k + " .scr"), src)))
window.setState = async (s) => {
  await ready
  for (const [i, id] of ["s0", "s1"].entries()) {
    const el = document.getElementById(id), L = s.layers[i]
    el.style.display = L && (s.pull === null || s.camIn < 1) ? "block" : "none"
    if (!L) continue
    el.style.opacity = L.opacity
    el.style.zIndex = 2 + i
    el.style.boxShadow = shadow(1)
    for (const h of el.querySelectorAll(".host")) h.textContent = L.host
    await show(el, L.src)
  }
  // Camera: this device's screen goes from its place in the regular shots to its place in the group;
  // the size changes geometrically, the position in step with it, so the pull-back reads as one zoom.
  const world = document.getElementById("world")
  document.getElementById("cam").style.display = s.pull === null ? "none" : "block"
  document.getElementById("cam").style.opacity = s.camIn
  const bn = document.getElementById("banner")
  bn.style.display = s.banner && s.pull === null ? "flex" : "none"
  if (s.banner) { bn.style.opacity = s.banner.k; bn.style.transform = "translateY(" + (1 - s.banner.k) * -60 + "%)" }
  if (s.pull !== null) {
    const p = s.pull
    const w = R0.w * Math.pow(R1.w / R0.w, p)
    const q = (w - R0.w) / (R1.w - R0.w)
    const x = R0.x + (R1.x - R0.x) * q, y = R0.y + (R1.y - R0.y) * q
    const k = w / R1.w
    world.style.transform = "translate(" + (x - R1.x * k) + "px," + (y - R1.y * k) + "px) scale(" + k + ")"
    const own = Math.min(1, p / 0.35)
    for (const dev of world.querySelectorAll(".dev")) {
      const mine = dev.id === "dev-" + DEVICE
      dev.style.opacity = mine ? 1 : Math.min(1, p / 0.25)
      dev.querySelector(".frame").style.opacity = mine ? own : 1
      dev.querySelector(".scr").style.boxShadow = mine ? shadow(1 - own) : "none"
    }
  }
  document.getElementById("synced").style.opacity = s.pull === null ? 0 : Math.max(0, Math.min(1, (s.pull - 0.75) / 0.25))
  const [c0, c1] = [document.getElementById("c0"), document.getElementById("c1")]
  c0.innerHTML = capHtml(s.caption && s.caption.lines)
  c0.style.opacity = s.caption ? s.caption.k : 0
  c0.style.transform = "translateY(" + (1 - (s.caption ? s.caption.k : 1)) * 26 + "px)"
  c1.innerHTML = capHtml(s.prev && s.prev.lines)
  c1.style.opacity = s.prev ? s.prev.o : 0
  c1.style.transform = "translateY(" + -(s.prev ? 1 - s.prev.o : 0) * 18 + "px)"
  document.getElementById("taps").innerHTML = s.taps.map((t) => '<div class="tap" style="left:' + t.x + "px;top:" + t.y + "px;opacity:" + t.o + ";transform:scale(" + t.k + ')"></div>').join("")
  const cur = document.getElementById("cursor"), rip = document.getElementById("ripple")
  cur.style.display = s.cursor ? "block" : "none"
  rip.style.display = s.cursor && s.cursor.ripple !== null ? "block" : "none"
  if (s.cursor) {
    cur.style.left = s.cursor.x - 3 + "px"; cur.style.top = s.cursor.y - 2 + "px"; cur.style.opacity = s.cursor.o
    if (s.cursor.ripple !== null) { rip.style.left = s.cursor.x + "px"; rip.style.top = s.cursor.y + "px"; rip.style.opacity = 1 - s.cursor.ripple; rip.style.transform = "scale(" + (0.4 + 0.8 * s.cursor.ripple) + ")" }
  }
  const keys = document.getElementById("keys")
  keys.style.display = s.keys ? "flex" : "none"
  if (s.keys) { keys.innerHTML = s.keys.text.split(" ").map((k) => "<b>" + k + "</b>").join(""); keys.style.opacity = s.keys.o }
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

// Taps and the pointer: CSS px inside the recorded page → stage px.
const toStage = (x, y) => ({ x: SCREEN_LEFT + x * S.css * K, y: SCREEN_TOP + (S.top + y * S.css) * K })

// FRAME=<seconds> renders that one frame to <TMP>/frame.png instead of the video (for checking a shot).
const only = process.env.FRAME
const times = only ? [Number(only)] : Array.from({ length: Math.round(TOTAL * FPS) }, (_, n) => n / FPS)
for (const [n, t] of times.entries()) {
  const s = state(t)
  s.taps = s.taps.map((p) => ({ ...p, ...toStage(p.x, p.y) }))
  if (s.cursor) s.cursor = { ...s.cursor, ...toStage(s.cursor.x, s.cursor.y) }
  await page.evaluate((st) => window.setState(st), s)
  await page.screenshot({ path: only ? join(TMP, "frame.png") : join(TMP, "frames", `${String(n).padStart(5, "0")}.png`) })
  if (n % 150 === 0 && !only) console.log(`frame ${n}/${times.length}`)
}
await browser.close()
if (only) { console.log(`frame at ${only} s → ${join(TMP, "frame.png")} (total ${TOTAL.toFixed(2)} s)`); process.exit(0) }

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
