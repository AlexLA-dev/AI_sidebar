// Records real ContextFlow UI on iPhone for the App Store app preview video.
// Needs: tools/preview/server.mts on :8787 (STREAM_DELAY_MS=22 gives a readable streaming pace)
// and an extension build pointing at it (see capture.mjs).
//   node tools/store/preview-record.mjs <extensionDir> <outDir> [lang]
// Output: <outDir>/<take>/NNNNN.jpg + <outDir>/<take>.json { frames: [{ f, t }], events: [{ t, type, ... }] }
// Times are seconds from the start of the take. preview-render.mjs turns the takes into the video.
import { chromium } from "playwright"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [extDir, outDir, lang = "en"] = process.argv.slice(2)
const BASE = "http://localhost:8787"
const ARTICLE = lang === "ru" ? `${BASE}/article-ru` : `${BASE}/article`
// "Translate" always targets the UI language, so it is shown on a page in the other language.
const FOREIGN = lang === "ru" ? `${BASE}/article` : `${BASE}/article-ru`
const L = lang === "ru"
  ? { summarize: "Кратко", key: "Главное", explain: "Объясн", translate: "Перевести", question: "Стоит ли пробовать это стартапу из 10 человек?", note: "Обсудить с командой пилот с короткой пятницей" }
  : { summarize: "Summarize", key: "Key takeaways", explain: "Explain", translate: "Translate", question: "Is this worth trying for a 10-person startup?", note: "Pitch a short-Friday pilot to the team" }

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
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${lang}`, "--force-device-scale-factor=3"],
  locale: lang === "ru" ? "ru-RU" : "en-US",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  viewport: { width: 430, height: 800 }, deviceScaleFactor: 3, hasTouch: true
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent("serviceworker")
await new Promise((r) => setTimeout(r, 300))
for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
// No first-session tour or notes hint over the panel.
await sw.evaluate(() => chrome.storage.local.set({ "cf:consent": true, "cf:tourSeen": true, "cf:noteHint": -1 }))
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
  await page.goto(url)
  await page.waitForSelector("contextflow-root", { state: "attached" })
  await wait(400)
  if (prep) await prep()
  mkdirSync(join(outDir, name), { recursive: true })
  take = { name, start: Date.now() / 1000, frames: [], events: [] }
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1290, maxHeight: 2400, everyNthFrame: 1 })
  // A scroll nudge forces a first frame even if nothing animates yet.
  await page.evaluate(() => window.scrollBy(0, 1))
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

async function openPanel() {
  await tap(fab())
  await page.locator(".cf-panel.in").waitFor()
  await wait(650)
}

// ------------------------------------------------ take 1: summarize → key takeaways → ask
await begin("main", ARTICLE)
mark("caption", { key: "summary" })
await wait(900)
await openPanel()
await tap(chip(L.summarize)); await waitAnswer(1); await wait(1300)
mark("caption", { key: "keys" })
await tap(chip(L.key)); await waitAnswer(2); await wait(1600)
mark("caption", { key: "ask" })
await tap(page.locator(".cf-input textarea"))
await page.keyboard.type(L.question, { delay: 28 })
await wait(250)
await tap(page.locator(".cf-send")); await waitAnswer(3); await wait(1500)
await end()

// ------------------------------------------------ take 2: explain selected text
await begin("selection", ARTICLE)
mark("caption", { key: "selection" })
await page.evaluate(() => { const q = document.querySelector("blockquote"); q.scrollIntoView({ block: "start" }); window.scrollBy(0, -150) })
await wait(700)
await page.evaluate(() => {
  const range = document.createRange()
  range.selectNodeContents(document.querySelector("blockquote"))
  document.getSelection().removeAllRanges()
  document.getSelection().addRange(range)
})
await wait(700)
await openPanel()
await tap(chip(L.explain)); await waitAnswer(1); await wait(1300)
await end()

// ------------------------------------------------ take 3: a note under the summary (swipe the send button)
await begin("notes", ARTICLE, async () => {
  await fab().click(); await page.locator(".cf-panel.in").waitFor(); await wait(500)
  await chip(L.summarize).click(); await waitAnswer(1); await wait(300)
})
mark("caption", { key: "notes" })
await wait(500)
await tap(page.locator(".cf-input textarea"))
await page.keyboard.type(L.note, { delay: 28 })
await wait(300)
{
  const b = await page.locator(".cf-send-wrap").boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  mark("swipe", { x, y, dy: -46 })
  await wait(120)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let i = 1; i <= 6; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 8 }] }); await wait(25) }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}
await wait(800)
await tap(page.locator(".cf-send")); await wait(1700)
await end()

// ------------------------------------------------ take 4: translate a foreign page (screenshots only)
await begin("translate", FOREIGN)
mark("caption", { key: "translate" })
await wait(800)
await openPanel()
await tap(chip(L.translate)); await waitAnswer(1); await wait(1300)
await end()

await ctx.close()
