// The iOS 27 creative assets for 2.6.1: a product page header (21:9, 3840 × 1646) and a search results asset
// (3:2, 3840 × 2560) for the main page and each custom product page, in the real 2.6 UI on iPhone.
// One benefit per asset: the caption says what you get, the phone shows the feature, and a magnified card of the
// part that proves it sits beside the phone, with the same part ringed on the screen, so the eye goes caption →
// card → phone. Pro and Ultra get a chip over the caption. Apple's rules for these assets: no prices, web
// addresses or "free" (the scenes with them are shot again with BANNER=1, see capture.mjs), and the Safari
// address field is drawn empty.
//   CF_ROOT=<repo> node creative26.mjs <raw> <bannerRaw> <outRoot> <en|ru> [page,…]
// raw: capture.mjs SET=v26 (iPhone); bannerRaw: the same with BANNER=1 (similar, similarpick, copied5, copied5done).
// Output: <outRoot>/<page>/<en-US|ru>/{header,search}.png
import { chromium } from "playwright"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.CF_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [rawArg, bannerArg, outArg, lang = "en", only] = process.argv.slice(2)
const RAWS = { raw: resolve(rawArg), banner: resolve(bannerArg) }
const OUT = resolve(outArg)
const LOC = lang === "ru" ? "ru" : "en-US"
const ru = lang === "ru"
const file = (p) => pathToFileURL(p).href
const APP_ICON = file(join(root, "ContextFlow/Shared (App)/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png"))

const T = (en, r) => (ru ? r : en)
const C = {
  summary: T(["Summarize any", "page in Safari"], ["Пересказ страницы", "прямо в Safari"]),
  similar: T(["Cheaper options,", "every link checked"], ["Найдёт дешевле", "и проверит ссылки"]),
  pick: T(["Cheaper, newer,", "in stock: you pick"], ["Дешевле, новее,", "в наличии — на выбор"]),
  askchats: T(["Ask all your chats", "at once"], ["Спросите сразу", "все свои чаты"]),
  organize: T(["Chats that keep", "themselves in order"], ["Чаты сами", "наводят порядок"]),
  templates: T(["Templates fill in", "names and dates"], ["Шаблон сам впишет", "имя и дату"]),
  copies: T(["Your last 5 copies", "in any Safari field"], ["Последние 5 копий", "в любом поле Safari"]),
  listen: T(["Listen to any page", "or answer"], ["Слушайте страницу", "или ответ"]),
  locked: T(["Keep listening with", "the screen locked"], ["Слушайте даже", "с выключенным экраном"]),
  foreign: T(["Read any language", "in yours"], ["Любой язык —", "по-русски"]),
  translate: T(["Translate just", "the part you need"], ["Переведёт только", "нужный кусок"]),
  // 2.7: the page for people moving to Safari (English only).
  arcAsk: ["AI on the page,", "right in Safari"],
  arcKeys: ["The key points", "of any page"],
  // Under the main header's caption: what 2.6 adds, quieter than the caption.
  newLabel: T("New", "Новое"),
  news: T([["Find similar", "Ultra"], ["Listen", "Ultra"], ["Chats in order", "Pro"]], [["Найти похожее", "Ultra"], ["Слушать", "Ultra"], ["Порядок в чатах", "Pro"]]),
  // The lock screen (drawn: iOS draws it, Chromium can't). Title and artist as Listen.swift's updateNowPlaying
  // sets them: the page's title and "ContextFlow", the app's icon as the artwork.
  lockDate: T("Tuesday 9 June", "Вторник, 9 июня"),
  lockTitle: T("Why the four-day week works — and when it doesn't", "Почему четырёхдневка работает — и когда нет")
}

// Each asset: caption, plan chip, the iPhone capture, the card (a crop of the capture in CSS px, [x0, y0, x1, y1],
// or the captured elements' rects), and the ring on the screen (the card's own area unless `ring` names another).
const R = (sel) => ({ select: sel })
const PAGES = {
  main: {
    header: { caption: C.summary, shot: "iphone-summary", card: [6, 388, 424, 682], news: true },
    search: { caption: C.similar, plan: "Ultra", raw: "banner", shot: "iphone-similar", card: ru ? [8, 320, 422, 606] : [8, 320, 422, 668] }
  },
  "cpp-shop": {
    header: { caption: C.similar, plan: "Ultra", raw: "banner", shot: "iphone-similar", card: ru ? [8, 504, 422, 604] : [8, 458, 422, 668] },
    search: { caption: C.pick, plan: "Ultra", raw: "banner", shot: "iphone-similarpick", card: R([".cf-similar-pick"]), pad: 4 }
  },
  "cpp-study": {
    header: { caption: C.askchats, plan: "Pro", shot: "iphone-askchats", card: ru ? [6, 314, 424, 628] : [6, 314, 424, 606] },
    // ru: the Suggested bar sits over the question in this capture, so the card starts at the answer.
    search: { caption: C.organize, plan: "Pro", shot: "iphone-organize", card: ru ? [6, 396, 424, 586] : R([".cf-sugbar-main", ".cf-org"]), pad: 8 }
  },
  "cpp-work": {
    header: { caption: C.templates, shot: "iphone-fill", card: R([".cf-qi-fill-text", ".cf-qi-fill-row"]), pad: 12, cardTitle: true },
    search: { caption: C.copies, raw: "banner", shot: "iphone-copied5done", from: "iphone-copied5", card: R(["all:.cf-qi-row"]), pad: 6, ring: "@#reply" }
  },
  "cpp-listen": {
    header: { caption: C.listen, plan: "Ultra", shot: "iphone-listenbtn", card: R(["[data-cf=listen-row]"]), top: 290, pad: 8, inner: "[data-cf-btn]" },
    search: { caption: C.locked, plan: "Ultra", lock: true }
  },
  // English only (render with the page filter: en cpp-arc). The search asset is the summary's key points, so it
  // doesn't repeat the first screenshot (a question asked about the page).
  "cpp-arc": {
    header: { caption: C.arcAsk, shot: "iphone-askpage", card: [6, 328, 424, 602] },
    search: { caption: C.arcKeys, shot: "iphone-keypoints", card: [6, 380, 424, 600] }
  },
  "cpp-lang": {
    header: { caption: C.foreign, shot: "iphone-foreign", card: ru ? [6, 230, 424, 548] : [6, 230, 424, 498] },
    search: { caption: C.translate, shot: "iphone-translatesel", card: ru ? [6, 230, 424, 466] : [6, 230, 424, 445] }
  }
}

// The crop of a capture in CSS px, from fixed numbers or the captured elements.
function crop(spec) {
  const meta = JSON.parse(readFileSync(join(RAWS[spec.raw ?? "raw"], (spec.from ?? spec.shot) + ".json"), "utf8"))
  let box
  if (Array.isArray(spec.card)) box = spec.card
  else {
    const rects = spec.card.select.map((s) => meta[s]).filter(Boolean)
    if (!rects.length) throw new Error(`${spec.shot}: none of ${spec.card.select} captured`)
    const p = spec.pad ?? 8
    box = [Math.min(...rects.map((r) => r.x)) - p, Math.min(...rects.map((r) => r.y)) - p, Math.max(...rects.map((r) => r.x + r.width)) + p, Math.max(...rects.map((r) => r.y + r.height)) + p]
    if (spec.top !== undefined) box[1] = spec.top
    // Templates: the card from the pop-up's title down, so the filled text reads as a template.
    if (spec.cardTitle && meta[".cf-qi"]) box[1] = meta[".cf-qi"].y + 2
  }
  const inner = spec.inner && meta[spec.inner]
  let ringBox = box
  if (spec.ring) {
    const m = JSON.parse(readFileSync(join(RAWS[spec.raw ?? "raw"], spec.shot + ".json"), "utf8"))[spec.ring]
    ringBox = [m.x - 6, m.y - 6, m.x + m.width + 6, m.y + m.height + 6]
  }
  return { box, inner, ringBox, scale: meta.scale }
}

const svg = {
  signal: (c) => `<svg viewBox="0 0 18 12" width="54" height="36"><g fill="${c}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>`,
  wifi: (c) => `<svg viewBox="0 0 16 12" width="48" height="36"><path fill="${c}" d="M8 2.2c2.4 0 4.6.9 6.3 2.4l1.2-1.3C13.4 1.4 10.8.3 8 .3S2.6 1.4.5 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.3-1.3A7.2 7.2 0 0 0 8 4c-1.9 0-3.7.7-5 1.9l1.3 1.3c1-.9 2.3-1.4 3.7-1.4zM8 9.4c-.7 0-1.3.3-1.8.7L8 12l1.8-1.9c-.5-.4-1.1-.7-1.8-.7z"/></svg>`,
  battery: (c) => `<svg viewBox="0 0 27 13" width="81" height="39"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="${c}" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="${c}"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="${c}" opacity=".45"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M15 5l-7 7 7 7" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: `<svg viewBox="0 0 24 24" width="100%" height="100%"><g fill="#000"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>`,
  // Now Playing controls (SF Symbols' gobackward.15 / pause.fill / goforward.15, drawn).
  back15: `<svg viewBox="0 0 48 48" width="100%" height="100%"><path d="M24 8a16 16 0 1 1-15.3 11.3" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M24 2l-7 6 7 6z" fill="#fff"/><text x="24" y="30.5" text-anchor="middle" font-family="Inter" font-weight="700" font-size="12.5" fill="#fff">15</text></svg>`,
  fwd15: `<svg viewBox="0 0 48 48" width="100%" height="100%"><path d="M24 8a16 16 0 1 0 15.3 11.3" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M24 2l7 6-7 6z" fill="#fff"/><text x="24" y="30.5" text-anchor="middle" font-family="Inter" font-weight="700" font-size="12.5" fill="#fff">15</text></svg>`,
  pause: `<svg viewBox="0 0 48 48" width="100%" height="100%"><rect x="12" y="8" width="8.5" height="32" rx="2.5" fill="#fff"/><rect x="27.5" y="8" width="8.5" height="32" rx="2.5" fill="#fff"/></svg>`,
  airplay: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M5 17H3.5A1.5 1.5 0 0 1 2 15.5v-10A1.5 1.5 0 0 1 3.5 4h17A1.5 1.5 0 0 1 22 5.5v10a1.5 1.5 0 0 1-1.5 1.5H19" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M12 14l5 6H7z" fill="#fff"/></svg>`,
  torch: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M8 2h8v4l-2 4v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V10L8 6z" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="#fff" stroke-width="1.7"/></svg>`
}

// The iPhone screen, 1290 × 2796 @3x (status 162 + web 2400 + Safari bar 234) in a thin dark bezel, scaled by k.
// The address field stays empty: these assets may not show web addresses.
function phone(k, left, top, src) {
  const bz = 34
  return `
  <div class="bezel" style="left:${left - bz * k}px;top:${top - bz * k}px;width:${(1290 + bz * 2) * k}px;height:${(2796 + bz * 2) * k}px;border-radius:${224 * k}px"></div>
  <div class="screen" style="left:${left}px;top:${top}px;transform:scale(${k})">
    <div class="ios-status"><div class="t">9:41</div><div class="ic">${svg.signal("#000")}${svg.wifi("#000")}${svg.battery("#000")}</div></div>
    <img class="web" src="${src}">
    <div class="ios-bar"><div class="btn">${svg.back}</div><div class="url"><span class="aa">aA</span></div><div class="btn">${svg.more}</div></div>
    <div class="home"></div><div class="island"></div>
  </div>`
}

// The Now Playing card as iOS shows it on the lock screen (w: its width in px; everything scales with it).
function nowPlaying(w, look = "") {
  const u = w / 1170
  return `<div class="np" style="${look}width:${w}px;padding:${54 * u}px ${58 * u}px ${46 * u}px;border-radius:${84 * u}px">
    <div class="np-top" style="gap:${36 * u}px">
      <img src="${APP_ICON}" style="width:${168 * u}px;height:${168 * u}px;border-radius:${38 * u}px">
      <div class="np-t"><b style="font-size:${50 * u}px">${C.lockTitle}</b><span style="font-size:${46 * u}px">ContextFlow</span></div>
      <i style="width:${64 * u}px;height:${64 * u}px">${svg.airplay}</i>
    </div>
    <div class="np-bar" style="margin-top:${52 * u}px;height:${14 * u}px;border-radius:${7 * u}px"><div style="width:31%"></div></div>
    <div class="np-times" style="font-size:${34 * u}px;margin-top:${14 * u}px"><span>1:52</span><span>−4:09</span></div>
    <div class="np-ctl" style="margin-top:${24 * u}px;gap:${170 * u}px"><i style="width:${108 * u}px;height:${108 * u}px">${svg.back15}</i><i style="width:${124 * u}px;height:${124 * u}px">${svg.pause}</i><i style="width:${108 * u}px;height:${108 * u}px">${svg.fwd15}</i></div>
  </div>`
}

// The iPhone lock screen with the Now Playing card (Listen keeps playing with the screen locked).
function lockPhone(k, left, top) {
  const bz = 34
  return `
  <div class="bezel" style="left:${left - bz * k}px;top:${top - bz * k}px;width:${(1290 + bz * 2) * k}px;height:${(2796 + bz * 2) * k}px;border-radius:${224 * k}px"></div>
  <div class="screen lock" style="left:${left}px;top:${top}px;transform:scale(${k})">
    <div class="ios-status on-dark"><div class="t"></div><div class="ic">${svg.signal("#fff")}${svg.wifi("#fff")}${svg.battery("#fff")}</div></div>
    <div class="lk-date">${C.lockDate}</div><div class="lk-time">9:41</div>
    <div class="lk-np">${nowPlaying(1170)}</div>
    <div class="lk-btn" style="left:120px"><i>${svg.torch}</i></div><div class="lk-btn" style="right:120px"><i>${svg.camera}</i></div>
    <div class="home on-dark"></div><div class="island"></div>
  </div>`
}

// The magnified card: the crop of the capture at width w (or height-capped), with the ringed element inside.
function card(src, c, left, top, w, dark) {
  const [x0, y0, x1, y1] = c.box
  const f = w / (x1 - x0)
  const h = (y1 - y0) * f
  const ms = c.scale
  let inner = ""
  if (c.inner) {
    const p = 4
    inner = `<div class="ring in" style="left:${(c.inner.x - x0 - p) * f}px;top:${(c.inner.y - y0 - p) * f}px;width:${(c.inner.width + p * 2) * f}px;height:${(c.inner.height + p * 2) * f}px;border-radius:${12 * f}px"></div>`
  }
  return `<div class="card ${dark ? "on-dark" : ""}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;border-radius:${Math.min(16 * f, 64)}px">
    <div style="width:100%;height:100%;background:url('${src}') ${-x0 * f}px ${-y0 * f}px / ${430 * f}px auto no-repeat"></div>${inner}
  </div>`
}

// The same area ringed on the phone's screen (k: the phone's scale; CSS px × 3 = screen px, + the 162 px status bar).
function ring(c, k, left, top) {
  const [x0, y0, x1, y1] = c.ringBox ?? c.box
  return `<div class="ring" style="left:${left + x0 * 3 * k}px;top:${top + (162 + y0 * 3) * k}px;width:${(x1 - x0) * 3 * k}px;height:${(y1 - y0) * 3 * k}px;border-radius:${30 * k}px"></div>`
}

const chip = (plan, size) => (plan ? `<div class="plan ${plan === "Ultra" ? "u" : ""}" style="font-size:${size}px">${plan}</div>` : "")
const caption = (cap) => `<span>${cap[0]}</span><br><span class="l2">${cap[1]}</span>`

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { overflow: hidden; }
body { position: relative; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
.ribbon { position: absolute; inset: 0; }
.bezel { position: absolute; background: #0d0f14; box-shadow: inset 0 0 0 2px rgba(255,255,255,.10); }
.screen { position: absolute; width: 1290px; height: 2796px; transform-origin: 0 0; border-radius: 190px; overflow: hidden; background: #fff; }
.web { position: absolute; left: 0; top: 162px; width: 1290px; height: 2400px; }
.ios-status { position: absolute; top: 0; left: 0; right: 0; height: 162px; display: flex; align-items: center; justify-content: space-between; padding: 22px 96px 0 150px; font: 600 52px Inter, sans-serif; color: #000; }
.ios-status .ic { display: flex; align-items: center; gap: 18px; margin-left: auto; }
.island { position: absolute; top: 33px; left: 50%; width: 375px; height: 111px; margin-left: -187px; border-radius: 60px; background: #000; }
.ios-bar { position: absolute; left: 0; right: 0; top: 2562px; height: 234px; display: flex; align-items: flex-start; gap: 24px; padding: 30px 40px 0; }
.ios-bar .btn { flex: none; width: 138px; height: 138px; border-radius: 50%; padding: 36px; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10); }
.ios-bar .url { flex: 1; height: 138px; border-radius: 69px; display: flex; align-items: center; justify-content: center; font: 500 46px Inter, sans-serif; color: #000; background: rgba(242,242,247,.96); box-shadow: 0 6px 24px rgba(0,0,0,.10); position: relative; }
.ios-bar .url .aa { position: absolute; left: 44px; font-weight: 600; font-size: 40px; }
.home { position: absolute; bottom: 24px; left: 50%; width: 420px; height: 15px; margin-left: -210px; border-radius: 8px; background: #000; }
.home.on-dark { background: #fff; }
.lock { background: radial-gradient(90% 55% at 30% 18%, #6D8BFF 0%, transparent 70%), radial-gradient(80% 60% at 85% 80%, #8B5CF6 0%, transparent 70%), linear-gradient(180deg, #1E3A8A 0%, #312E81 55%, #1E1B4B 100%); }
.lk-date { position: absolute; top: 300px; left: 0; right: 0; text-align: center; font: 600 64px Inter, sans-serif; color: rgba(255,255,255,.92); }
.lk-time { position: absolute; top: 360px; left: 0; right: 0; text-align: center; font: 700 330px/1 Inter, sans-serif; letter-spacing: -0.02em; color: rgba(255,255,255,.95); }
.lk-np { position: absolute; left: 60px; top: 1640px; }
.lk-btn { position: absolute; bottom: 150px; width: 150px; height: 150px; border-radius: 50%; background: rgba(255,255,255,.18); display: grid; place-items: center; }
.lk-btn i { width: 70px; height: 70px; }
.np { color: #fff; background: rgba(20, 22, 48, .55); backdrop-filter: blur(30px); box-shadow: inset 0 0 0 2px rgba(255,255,255,.12); }
.np-top { display: flex; align-items: center; }
.np-top img { flex: none; }
.np-top .np-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.np-t b { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-t span { color: rgba(255,255,255,.62); font-weight: 500; }
.np-top i { flex: none; align-self: flex-start; opacity: .8; }
.np-bar { background: rgba(255,255,255,.25); overflow: hidden; }
.np-bar div { height: 100%; background: #fff; }
.np-times { display: flex; justify-content: space-between; color: rgba(255,255,255,.62); font-weight: 600; font-variant-numeric: tabular-nums; }
.np-ctl { display: flex; justify-content: center; align-items: center; }
.np-ctl i { display: block; }
h1 { position: absolute; font-weight: 800; line-height: 1.05; letter-spacing: -0.03em; white-space: nowrap; color: #0B1530; }
.l2 { background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); -webkit-background-clip: text; background-clip: text; color: transparent; }
.dark h1 { color: #fff; }
.dark .l2 { background: linear-gradient(90deg, #7DD3FC, #93C5FD 55%, #A5B4FC); -webkit-background-clip: text; background-clip: text; }
.plan { display: inline-block; padding: .22em .62em; border-radius: 999px; font-weight: 800; line-height: 1; letter-spacing: .02em; color: #fff; background: linear-gradient(90deg, #0EA5E9, #2563EB 70%, #4F46E5); box-shadow: 0 16px 40px rgba(37,99,235,.32); }
.plan.u { background: linear-gradient(90deg, #A78BFA, #7C3AED 70%, #4F46E5); box-shadow: 0 16px 40px rgba(124,58,237,.34); }
.head { position: absolute; display: flex; flex-direction: column; align-items: flex-start; }
.head h1 { position: static; }
.card { position: absolute; z-index: 4; overflow: hidden; background: #fff; box-shadow: 0 0 0 5px rgba(37,99,235,.55), 0 50px 110px rgba(20,45,110,.34), 0 10px 30px rgba(20,45,110,.16); }
.card.on-dark { box-shadow: 0 0 0 5px rgba(147,197,253,.75), 0 50px 120px rgba(0,0,0,.6), 0 0 120px rgba(59,130,246,.45); }
.card.np-card { background: none; overflow: visible; }
.ring { position: absolute; z-index: 3; border: 5px solid rgba(37,99,235,.9); box-shadow: 0 0 0 6px rgba(37,99,235,.18), 0 0 40px rgba(37,99,235,.35); }
.dark .ring { border-color: rgba(147,197,253,.95); box-shadow: 0 0 0 6px rgba(147,197,253,.18), 0 0 50px rgba(96,165,250,.55); }
.ring.in { border-width: 6px; border-color: #7C3AED; box-shadow: 0 0 0 8px rgba(124,58,237,.2); }
.news { display: flex; flex-wrap: wrap; align-items: center; gap: 22px; }
.news .lbl { font: 700 40px/1 Inter, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: rgba(191,219,254,.75); margin-right: 6px; }
.news .n { display: flex; align-items: center; gap: 18px; padding: 16px 18px 16px 30px; border-radius: 999px; background: rgba(255,255,255,.09); border: 2px solid rgba(147,197,253,.28); color: #fff; font: 600 44px/1 Inter, sans-serif; white-space: nowrap; }
.news .n .plan { box-shadow: none; }
`

const page = (W, H, body, cls = "") => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=block" rel="stylesheet">
<style>html,body{width:${W}px;height:${H}px}${CSS}</style></head><body class="${cls}">${body}
<script>
const img = document.querySelector("img.web")
// Status bar and Safari bar take the colour of the page right under them.
const paint = () => {
  if (!img) return
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight
  const g = c.getContext("2d"); g.drawImage(img, 0, 0)
  const at = (y) => { const [r, gg, b] = g.getImageData(10, y, 1, 1).data; return "rgb(" + r + "," + gg + "," + b + ")" }
  document.querySelector(".ios-status").style.background = at(2)
  document.querySelector(".ios-bar").style.background = at(img.naturalHeight - 2)
}
// Captions shrink until they fit their column (longer languages must not reach the phone).
const fit = () => {
  for (const h of document.querySelectorAll("h1[data-max]")) {
    let size = parseFloat(getComputedStyle(h).fontSize)
    while (h.getBoundingClientRect().width > Number(h.dataset.max) && size > 60) h.style.fontSize = (size -= 4) + "px"
  }
}
;(async () => {
  await document.fonts.ready
  fit()
  if (img && !img.complete) await new Promise((r) => img.addEventListener("load", r))
  paint()
  document.body.dataset.ready = "1"
})()
</script></body></html>`

const ribbon = (W, H, opacity) => `
  <svg class="ribbon" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="rib" x1="0" x2="${W}" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7DD3FC"/><stop offset=".5" stop-color="#3B82F6"/><stop offset="1" stop-color="#818CF8"/></linearGradient>
    <filter id="soft" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${W * 3}" height="${H * 3}"><feGaussianBlur stdDeviation="${Math.round(H * 0.06)}"/></filter></defs>
    <path d="M-300,${H * 0.72} C${W * 0.3},${H * 0.45} ${W * 0.62},${H * 0.95} ${W + 300},${H * 0.5}" fill="none" stroke="url(#rib)" stroke-width="${Math.round(H * 0.2)}" opacity="${opacity}" filter="url(#soft)"/>
  </svg>`

// ---------------------------------------------------------------- header 21:9
// Safe area (checked in App Store Connect's preview for 2.5): the top ~22% sits under iPhone's status bar and
// buttons, iPad shows only the middle band, so everything stays in y 540–1400 and x 440–3400.
// Caption column on the left, the phone, then the card overlapping the phone's right edge at the height of the
// part it magnifies.
function header(spec) {
  const W = 3840, H = 1646, top = 540, ph = 860, k = ph / 2796, pw = 1290 * k
  const px = 1640
  let body = `
  <div style="position:absolute;inset:0;background:radial-gradient(110% 120% at 50% 60%, #1B3A86 0%, #0B1633 55%, #070D1F 100%)"></div>
  ${ribbon(W, H, 0.5)}
  <div style="position:absolute;left:${px - 30}px;top:${top - 30}px;width:${pw + 60}px;height:${ph + 60}px;border-radius:110px;box-shadow:0 0 200px rgba(59,130,246,.5)"></div>`
  const colW = px - 120 - 440
  let headInner = `${chip(spec.plan, 60)}<h1 data-max="${colW}" style="font-size:140px;margin-top:${spec.plan ? 34 : 0}px">${caption(spec.caption)}</h1>`
  if (spec.news) headInner += `<div class="news" style="margin-top:64px;max-width:${colW}px"><span class="lbl">${C.newLabel}</span>${C.news.map(([t, p]) => `<span class="n">${t}${chip(p, 30)}</span>`).join("")}</div>`
  const mid = top + ph / 2
  body += `<div class="head" style="left:440px;top:${mid}px;transform:translateY(-50%)">${headInner}</div>`
  if (spec.lock) {
    body += lockPhone(k, px, top)
  } else {
    const src = file(join(RAWS[spec.raw ?? "raw"], spec.shot + ".png"))
    body += phone(k, px, top, src)
    const c = crop(spec)
    const [x0, y0, x1, y1] = c.box
    const cardSrc = file(join(RAWS[spec.raw ?? "raw"], (spec.from ?? spec.shot) + ".png"))
    // Card: from just inside the phone's right edge to x 3400, at most the safe band's height.
    const left = px + pw - 70
    let w = Math.min(3400 - left, 1300)
    let h = (y1 - y0) * (w / (x1 - x0))
    if (h > ph) { w *= ph / h; h = ph }
    const elemMid = top + (162 + ((y0 + y1) / 2) * 3) * k
    const ctop = Math.max(top, Math.min(top + ph - h, elemMid - h / 2))
    body += ring(c, k, px, top) + card(cardSrc, c, left, ctop, w, true)
  }
  return { W, H, html: page(W, H, body, "dark") }
}

// ------------------------------------------------------------ search 3:2
// Caption top left, the phone on the right, the card under the caption reaching over the phone's left edge at
// the height of the part it magnifies.
function search(spec) {
  const W = 3840, H = 2560, top = 115, ph = 2330, k = ph / 2796, pw = 1290 * k
  const px = W - pw - 300
  let body = `
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,#F4F9FF 0%,#E7F0FF 55%,#E3EEFF 100%)"></div>
  ${ribbon(W, H, 0.45)}
  <div style="position:absolute;left:${px}px;top:${top}px;width:${pw}px;height:${ph}px;border-radius:190px;box-shadow:0 90px 200px rgba(16,38,96,.28),0 30px 70px rgba(16,38,96,.16)"></div>`
  const capTop = spec.plan ? 330 : 300
  body += `<div class="head" style="left:300px;top:${spec.plan ? 190 : 300}px">${chip(spec.plan, 84)}<h1 data-max="${px - 160 - 300}" style="font-size:210px;margin-top:${spec.plan ? 44 : 0}px">${caption(spec.caption)}</h1></div>`
  const capBottom = capTop + 2 * 220 + 150
  if (spec.lock) {
    body += lockPhone(k, px, top)
    // The Now Playing card, magnified, reaching over the phone at its own height.
    const w = 1900
    const npTop = top + 1640 * k
    const left = px + 330 - w
    body += `<div class="ring" style="left:${px + 60 * k}px;top:${npTop - 4}px;width:${1170 * k}px;height:${560 * k}px;border-radius:${84 * k}px"></div>`
    body += `<div class="card np-card" style="left:${Math.max(300, left)}px;top:${Math.max(capBottom, npTop - 260)}px;box-shadow:none">${nowPlaying(w, "background:rgba(30,35,80,.94);box-shadow:0 0 0 5px rgba(124,58,237,.6),0 50px 110px rgba(20,45,110,.42);")}</div>`
    return { W, H, html: page(W, H, body) }
  }
  const src = file(join(RAWS[spec.raw ?? "raw"], spec.shot + ".png"))
  body += phone(k, px, top, src)
  const c = crop(spec)
  const [x0, y0, x1, y1] = c.box
  const cardSrc = file(join(RAWS[spec.raw ?? "raw"], (spec.from ?? spec.shot) + ".png"))
  const right = px + 260
  const maxH = H - 140 - capBottom
  let w = Math.min(right - 300, 2150)
  let h = (y1 - y0) * (w / (x1 - x0))
  if (h > maxH) { w *= maxH / h; h = maxH }
  const elemMid = top + (162 + ((y0 + y1) / 2) * 3) * k
  const ctop = Math.max(capBottom, Math.min(H - 140 - h, elemMid - h / 2))
  body += ring(c, k, px, top) + card(cardSrc, c, right - w, ctop, w, false)
  return { W, H, html: page(W, H, body) }
}

const LINUX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const browser = await chromium.launch({
  ...(existsSync(LINUX_CHROME) ? { executablePath: LINUX_CHROME } : {}),
  args: ["--allow-file-access-from-files", "--font-render-hinting=none"]
})
for (const [name, spec] of Object.entries(PAGES)) {
  if (only && !only.split(",").includes(name)) continue
  const dir = join(OUT, name, LOC)
  mkdirSync(dir, { recursive: true })
  for (const [kind, build] of [["header", header], ["search", search]]) {
    const s = build(spec[kind])
    const htmlFile = join(dir, `.${kind}.html`)
    writeFileSync(htmlFile, s.html)
    const p = await browser.newPage({ viewport: { width: s.W, height: s.H }, deviceScaleFactor: 1 })
    await p.goto(file(htmlFile))
    await p.waitForFunction(() => document.body.dataset.ready === "1")
    await p.waitForTimeout(300)
    const out = join(dir, `${kind}.png`)
    await p.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: s.W, height: s.H } })
    await p.close()
    console.log(`${name}/${LOC}/${kind}: ${s.W}×${s.H}`)
  }
}
await browser.close()
