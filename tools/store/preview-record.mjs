// Records real ContextFlow UI on iPhone, iPad or Mac for the App Store app preview videos.
// The build needs CF_OPEN_SHADOW=1: these scripts read inside the panel's shadow root (production closes it).
// Needs: tools/preview/server.mts on :8787 (STREAM_DELAY_MS=22 gives a readable streaming pace)
// and an extension build pointing at it (see capture.mjs).
//   node tools/store/preview-record.mjs <extensionDir> <outDir> [lang] [iphone|ipad|mac]
// Output: <outDir>/<take>/NNNNN.jpg + <outDir>/<take>.json { frames: [{ f, t }], events: [{ t, type, ... }] }
// Times are seconds from the start of the take. preview-render.mjs turns the takes into the video.
import { chromium } from "playwright"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [extDir, outDir, lang = "en", device = "iphone"] = process.argv.slice(2)
// Same layouts as the screenshots (capture.mjs). `scale` maps CSS px onto the screen the renderer draws;
// `rec` is the resolution actually recorded: enough for the size on the video frame, and low enough
// for the screencast to keep a smooth frame rate (the full iPad / Mac resolution drops it to ~2 fps).
const DEVICES = {
  // 6.9" iPhone at @3x: the renderer draws the status bar and Safari bar around the 1290 × 2400 page.
  iphone: { viewport: { width: 430, height: 800 }, scale: 3, rec: 3, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" },
  // 11"-class layout on the 13" canvas (2064 px wide), so the side panel stays readable.
  ipad: { viewport: { width: 826, height: 1032 }, scale: 2064 / 826, rec: 1.3, touch: true, largeText: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" },
  mac: { viewport: { width: 1180, height: 760 }, scale: 2, rec: 1.15, touch: false, largeText: true,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15" }
}
const D = DEVICES[device]
if (!D) throw new Error(`unknown device ${device}`)
// CF_STAND=http://localhost:8799 records against a stand on another port (the build must point at it).
const BASE = process.env.CF_STAND ?? "http://localhost:8787"
const ARTICLE = lang === "ru" ? `${BASE}/article-ru` : `${BASE}/article`
const ARTICLE_2 = lang === "ru" ? `${BASE}/article-2-ru` : `${BASE}/article-2`
// "Translate" always targets the UI language, so it is shown on a page in the other language.
const FOREIGN = lang === "ru" ? `${BASE}/article` : `${BASE}/article-ru`
// The 2.5 sites under names of their own (Chromium maps them to the stand), as on the screenshots.
const site = (host, path) => `${BASE.replace("localhost", host)}/${lang === "ru" ? `${path}-ru` : path}`
const INBOX = site(lang === "ru" ? "mail.sevveter.studio" : "mail.northwind.studio", "inbox")
const SHOP = site(lang === "ru" ? "zvukodom.store" : "soundhouse.store", "product")
// TAKES=main,watch,copies,fill,notes records only those (the fill take runs on the Pro stand: no "N fills left").
const TAKES = process.env.TAKES?.split(",")
const want = (name) => !TAKES || TAKES.includes(name)
const L = lang === "ru"
  ? { summarize: "Кратко", key: "Главное", explain: "Объясн", translate: "Перевести", question: "Стоит ли пробовать это стартапу из 10 человек?", note: "Обсудить с командой пилот с короткой пятницей",
      selQuestion: "Подойдёт стартапу?", compare: "Как это сравнить с прошлой статьёй?" }
  : { summarize: "Summarize", key: "Key takeaways", explain: "Explain", translate: "Translate", question: "Is this worth trying for a 10-person startup?", note: "Pitch a short-Friday pilot to the team",
      selQuestion: "Good idea for a startup?", compare: "How does this compare with the previous article?" }

const LINUX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
// macOS Chromium ignores --lang, so chrome.i18n would follow the system language. A copy of the
// build that ships only the wanted locale (as default_locale) shows the UI in that language anyway.
function localizedExtension() {
  if (process.platform !== "darwin" || lang === "en") return extDir
  const dir = join(tmpdir(), `cf-ext-${lang}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(extDir, dir, { recursive: true })
  for (const l of readdirSync(join(dir, "_locales"))) if (l !== lang) rmSync(join(dir, "_locales", l), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, default_locale: lang }, null, 2))
  return dir
}
const ext = localizedExtension()
const ctx = await chromium.launchPersistentContext("", {
  headless: true,
  // Full Chromium (new headless): the default headless shell cannot load extensions.
  ...(existsSync(LINUX_CHROME) ? { executablePath: LINUX_CHROME } : { channel: "chromium" }),
  // The screencast sends CSS-pixel frames (430 × 800) unless the compositor itself renders at @3x.
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${lang}`, `--force-device-scale-factor=${D.rec}`, "--host-resolver-rules=MAP *.studio 127.0.0.1, MAP *.store 127.0.0.1"],
  locale: lang === "ru" ? "ru-RU" : "en-US",
  userAgent: D.ua, viewport: D.viewport, deviceScaleFactor: D.rec, hasTouch: D.touch
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent("serviceworker")
await new Promise((r) => setTimeout(r, 300))
for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
// No consent card, first-session tour or first-time hints over the panel.
await sw.evaluate(() => chrome.storage.local.set({ "cf:consent": 3, "cf:tourSeen": true, "cf:noteHint": -1, "cf:selHint": -1, "cf:hintsSeen": ["chats", "video", "pdf"],
  // 2.5's first-time tips (the eye and the bell, the button by a field) and organizing's Free cards stay out.
  "cf:watchTips": { eye: true, later: true }, "cf:selIconsTip": true, "cf:insertTipSeen": true, "cf:orgCards": { thirdTag: true, mess: { chats: [], at: 0, closed: true } } }))
// Chromium has no app behind the extension: its answers stand in (notifications allowed).
const native = () => sw.evaluate(() => { globalThis.browser = { runtime: { sendNativeMessage: async (_id, msg) => msg?.command === "watch_permission" || msg?.command === "remind" ? { success: true, data: { outcome: msg.command === "remind" ? "scheduled" : "ok" } } : { success: false } } } })
await native()
// Larger text (a user setting) keeps the panel readable on the smaller iPad and Mac frames.
if (D.largeText) await sw.evaluate(() => chrome.storage.local.set({ "cf:settings": { textSize: "large", fab: "on" }, "cf:settingsUpdatedAt": Date.now() }))
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)

const shadow = (js) => `(() => { const r = document.querySelector("contextflow-root")?.shadowRoot; return (${js})(r) })()`
const wait = (ms) => page.waitForTimeout(ms)

let take = null
function mark(type, data = {}) {
  take.events.push({ t: Date.now() / 1000 - take.start, type, ...data })
}

cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
  if (!take) return
  const f = `${String(take.frames.length).padStart(5, "0")}.jpg`
  writeFileSync(join(outDir, take.name, f), Buffer.from(data, "base64"))
  take.frames.push({ f, t: metadata.timestamp - take.start })
})

// `prep` runs before the screencast starts (a state to begin from, not shown).
async function begin(name, url, prep) {
  await fetch(`${BASE}/reset`)
  await sw.evaluate(() => chrome.storage.local.remove(["cf:chats", "cf:threads", "cf:activeThread", "cf:pageTexts"]))
  await page.emulateMedia({ colorScheme: "light" })
  await go(url)
  if (prep) await prep()
  mkdirSync(join(outDir, name), { recursive: true })
  take = { name, start: Date.now() / 1000, frames: [], events: [] }
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(D.viewport.width * D.rec), maxHeight: Math.round(D.viewport.height * D.rec), everyNthFrame: 1 })
  // A scroll nudge forces a first frame even if nothing animates yet.
  await page.evaluate(() => window.scrollBy(0, 1))
}

async function go(url) {
  await page.goto(url)
  await page.waitForSelector("contextflow-root", { state: "attached" })
  await wait(400)
  // The free-answers count under the field names the daily number, which the store page doesn't.
  // Nor "Get Pro" (the 2.6 page test labels Pro on the screens that show Pro features, not on every one).
  await page.evaluate(shadow(`(r) => { const st = document.createElement("style"); st.textContent = ".cf-usage-text, .cf-usage .cf-link { visibility: hidden }"; r.appendChild(st) }`))
}

async function toggle() {
  await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url)
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" })
  }, page.url())
}

async function end() {
  await wait(200)
  await cdp.send("Page.stopScreencast")
  mark("end")
  writeFileSync(join(outDir, `${take.name}.json`), JSON.stringify({ frames: take.frames, events: take.events }, null, 1))
  console.log(`${take.name}: ${take.frames.length} frames, ${take.events.at(-1).t.toFixed(1)} s`)
  take = null
}

// Tap = visible touch marker (drawn by the renderer) shortly before the click lands.
async function tap(locator) {
  const b = await locator.boundingBox()
  mark("tap", { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  await wait(220)
  await locator.click()
}

async function waitAnswer(count) {
  await page.waitForFunction(shadow(`(r) => r && r.querySelectorAll(".cf-msg.ai .md").length >= ${count} && !r.querySelector(".cf-send.stop")`), null, { timeout: 30000 })
}

const fab = () => page.locator(".cf-fab")
const chip = (label) => page.locator(".cf-chip", { hasText: label }).first()

// On the Mac the panel opens with Control-Shift-E (the renderer shows the keys), elsewhere with the button.
async function openPanel() {
  if (D.touch) await tap(fab())
  else {
    mark("keys", { text: "⌃ ⇧ E" })
    await wait(350)
    await toggle()
  }
  await page.locator(".cf-panel.in").waitFor()
  await wait(650)
}

// Note mode: a swipe up on the send button by touch, a scroll over it with a mouse.
async function noteMode() {
  const b = await page.locator(".cf-send-wrap").boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  if (!D.touch) {
    mark("point", { x, y })
    await page.mouse.move(x, y)
    await wait(300)
    await page.mouse.wheel(0, 60)
    await page.locator(".cf-send.note").waitFor()
    return
  }
  mark("swipe", { x, y, dy: -46 })
  await wait(120)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let i = 1; i <= 6; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 8 }] }); await wait(25) }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

// A finger on a touch screen (quick insert tells taps from clicks); the marker as for any tap.
async function touchTap(locator) {
  const b = await locator.boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  mark("tap", { x, y })
  await wait(220)
  if (D.touch) await page.touchscreen.tap(x, y); else await locator.click()
}

// ------------------------------------------------ take 1: summarize the page
if (want("main")) {
await begin("main", ARTICLE)
mark("caption", { key: "summary" })
await wait(800)
await openPanel()
await tap(chip(L.summarize)); await waitAnswer(1); await wait(1300)
await end()
}

// ------------------------------------------------ take 2: own question about a selection (typed in the field under its buttons)
if (want("select")) {
await begin("select", ARTICLE, async () => {
  await page.evaluate(() => { const q = document.querySelector("blockquote"); q.scrollIntoView({ block: "center" }) })
  await wait(300)
})
mark("caption", { key: "select" })
await wait(400)
if (D.touch) {
  await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector("blockquote"))
    document.getSelection().removeAllRanges()
    document.getSelection().addRange(range)
  })
} else {
  const box = await page.locator("blockquote").boundingBox()
  mark("point", { x: box.x + 4, y: box.y + 6 })
  await page.mouse.move(box.x + 4, box.y + 6); await wait(250); await page.mouse.down()
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 10, { steps: 14 }); await page.mouse.up()
}
await page.locator(".cf-bubble").waitFor(); await wait(700)
await tap(page.locator(".cf-bubble-ask input"))
await page.keyboard.type(L.selQuestion, { delay: 30 })
await wait(300)
await tap(page.locator(".cf-bubble-send"))
await page.locator(".cf-panel.in").waitFor()
await waitAnswer(1); await wait(1300)
await end()
}

// ------------------------------------------------ take 3: the chat follows to the next page
if (want("follows")) {
await begin("follows", ARTICLE, async () => {
  if (D.touch) await fab().click(); else await toggle()
  await page.locator(".cf-panel.in").waitFor(); await wait(500)
  await chip(L.summarize).click(); await waitAnswer(1); await wait(300)
  await go(ARTICLE_2)
})
mark("caption", { key: "follows" })
await wait(500)
await openPanel()
await wait(500)
await tap(page.locator(".cf-input textarea"))
await page.keyboard.type(L.compare, { delay: 24 })
await wait(250)
await tap(page.locator(".cf-send")); await waitAnswer(2); await wait(1400)
await end()
}

// ------------------------------------------------ take 4: a note under the summary (swipe or scroll on the send button)
// Its last frame is the chat the closing "all your devices" shot shows on every device.
if (want("notes")) {
await begin("notes", ARTICLE, async () => {
  if (D.touch) await fab().click(); else await toggle()
  await page.locator(".cf-panel.in").waitFor(); await wait(500)
  await chip(L.summarize).click(); await waitAnswer(1); await wait(300)
})
mark("caption", { key: "notes" })
await wait(400)
await tap(page.locator(".cf-input textarea"))
await page.keyboard.type(L.note, { delay: 28 })
await wait(300)
await noteMode()
await wait(800)
await tap(page.locator(".cf-send")); await wait(1600)
await end()
}

// ------------------------------------------------ 2.6 page test takes (iPhone and iPad)
const now = Date.now()
const ru = lang === "ru"

// The price watched, then the check that finds it lower: the page shows the new price and the notification comes
// (the renderer draws it from the "banner" event, with the app's own text).
if (want("watch")) {
await begin("watch", SHOP, async () => {
  await sw.evaluate(() => chrome.storage.local.remove(["cf:watches"]))
  await native()
  await page.evaluate(() => document.getElementById("price").scrollIntoView({ block: "center" }))
  await wait(300)
})
mark("caption", { key: "price" })
await wait(400)
await page.evaluate(() => getSelection().selectAllChildren(document.getElementById("price")))
await page.locator(".cf-sel-watch").first().waitFor(); await wait(500)
await touchTap(page.locator(".cf-sel-watch").first())
const watchGo = page.locator(".cf-watch .cf-sheet-actions .cf-primary")
await watchGo.waitFor(); await wait(600)
await touchTap(watchGo)
await page.locator(".cf-watch-ok").waitFor({ timeout: 20000 }); await wait(700)
await page.keyboard.press("Escape").catch(() => undefined)
await page.evaluate(([n, w]) => { document.getElementById("price").textContent = n; document.querySelector(".old").textContent = w }, ru ? ["10 990 ₽", "12 990 ₽"] : ["$99", "$129"])
mark("banner")
await wait(1900)
await end()
}

// Copied: the reply begun by hand, the button by the field, the last five copies, one tapped into the reply.
if (want("copies")) {
await begin("copies", INBOX, async () => {
  const items = (ru
    ? [["PX-7741-2093", "parcelly.studio", 4], ["Москва, ул. Лесная, 12, кв. 4", "contacts.sevveter.studio", 18], ["Заказ 48213", "shop.sevveter.studio", 35], ["maria.lopez@sevveter.studio", "mail.sevveter.studio", 52], ["+7 495 555-01-42", "contacts.sevveter.studio", 80]]
    : [["PX-7741-2093", "parcelly.studio", 4], ["12 Linden Street, Apt 4, Boston, MA 02118", "contacts.northwind.studio", 18], ["Order 48213", "shop.northwind.studio", 35], ["maria.lopez@northwind.studio", "mail.northwind.studio", 52], ["+1 617 555 0142", "contacts.northwind.studio", 80]])
    .map(([text, host, min], i) => ({ id: `k${i}`, text, host, at: now - min * 60e3, from: "page" }))
  await sw.evaluate((items) => chrome.storage.local.set({ "cf:templates": {}, "cf:copied": items }), items)
  await go(INBOX)
  await page.evaluate((v) => { document.body.style.paddingBottom = "900px"; const r = document.getElementById("reply"); r.value = v; r.scrollIntoView({ block: "start" }); window.scrollBy(0, -12) }, ru ? "Мария, заказ уже в пути. Трек-номер: " : "Hi Maria, your order is on its way. Tracking number: ")
  await wait(300)
})
mark("caption", { key: "copies" })
await wait(300)
await touchTap(page.locator("#reply"))
await page.evaluate(() => { const r = document.getElementById("reply"); r.setSelectionRange(r.value.length, r.value.length) })
await page.locator(".cf-qi-btn").waitFor(); await wait(500)
await touchTap(page.locator(".cf-qi-btn"))
await page.locator(".cf-qi-row").first().waitFor(); await wait(1200)
await touchTap(page.locator(".cf-qi-row", { hasText: "PX-7741-2093" }).first())
await wait(1400)
await end()
}

// Templates: "Confirm the call", Fill from the page (the name, the date and the time from the letter), Insert.
if (want("fill")) {
await begin("fill", INBOX, async () => {
  const templates = ru
    ? { t1: { id: "t1", title: "Подтвердить созвон", keywords: ["созвон"], text: "Здравствуйте, {имя}! {дата} в {время} мне подходит, созвонимся.", createdAt: now - 9e6, updatedAt: now - 9e6 },
        t2: { id: "t2", title: "Спасибо за заказ", keywords: ["заказ"], text: "Спасибо за заказ! Отправим в течение двух дней, трек-номер придёт на почту.", createdAt: now - 8e6, updatedAt: now - 8e6 } }
    : { t1: { id: "t1", title: "Confirm the call", keywords: ["call"], text: "Hi {name}, {date} at {time} works for me. Talk then!", createdAt: now - 9e6, updatedAt: now - 9e6 },
        t2: { id: "t2", title: "Thanks for the order", keywords: ["order"], text: "Thanks for your order! It ships within 2 days, and the tracking number comes by email.", createdAt: now - 8e6, updatedAt: now - 8e6 } }
  await sw.evaluate((templates) => chrome.storage.local.set({ "cf:templates": templates, "cf:copied": [] }), templates)
  await go(INBOX)
  await page.evaluate(() => { document.body.style.paddingBottom = "900px"; const r = document.getElementById("reply"); r.scrollIntoView({ block: "center" }); window.scrollBy(0, 60) })
  await wait(300)
})
mark("caption", { key: "fill" })
await wait(250)
await touchTap(page.locator("#reply"))
await page.locator(".cf-qi-btn").waitFor(); await wait(400)
await touchTap(page.locator(".cf-qi-btn"))
await page.locator(".cf-qi-row").first().waitFor(); await wait(700)
await touchTap(page.locator(".cf-qi-row", { hasText: ru ? "Подтвердить созвон" : "Confirm the call" }).first())
const fillButton = page.locator(".cf-qi-fill button", { hasText: ru ? "Заполнить со страницы" : "Fill from the page" })
await fillButton.waitFor(); await wait(500)
await touchTap(fillButton)
await page.locator(".cf-qi-blank.filled").first().waitFor({ timeout: 15000 }); await wait(1300)
await touchTap(page.locator(".cf-qi-fill button", { hasText: new RegExp(`^${ru ? "Вставить" : "Insert"}$`) }).first())
await wait(1100)
await end()
}

await ctx.close()
