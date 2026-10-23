// Captures real ContextFlow UI states for App Store screenshots.
// Needs: tools/preview/server.mts running on :8787 and an extension build pointing at it.
//   node tools/store/capture.mjs <extensionDir> <outDir> [lang]
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"

const [extDir, outDir, lang = "en"] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const BASE = "http://localhost:8787"
const ARTICLE = lang === "ru" ? `${BASE}/article-ru` : `${BASE}/article`
// "Translate" always targets the UI language, so it is shown on a page in the other language.
const FOREIGN = lang === "ru" ? `${BASE}/article` : `${BASE}/article-ru`

const DEVICES = {
  iphone: {
    viewport: { width: 430, height: 800 }, scale: 3, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
  },
  ipad: {
    // 11"-class layout scaled to the 13" canvas (2064 px wide): the side panel stays readable.
    viewport: { width: 826, height: 1032 }, scale: 2064 / 826, touch: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
  },
  mac: {
    viewport: { width: 1180, height: 760 }, scale: 2, touch: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
  }
}

const L = lang === "ru"
  ? { summarize: "Кратко", key: "Главное", explain: "Объясн", translate: "Перевести", question: "Стоит ли пробовать это стартапу из 10 человек?", settings: "Настройки" }
  : { summarize: "Summarize", key: "Key takeaways", explain: "Explain", translate: "Translate", question: "Is this worth trying for a 10-person startup?", settings: "Settings" }

const shadow = (js) => `(() => { const r = document.querySelector("contextflow-root")?.shadowRoot; return (${js})(r) })()`

async function session(name) {
  const d = DEVICES[name]
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--lang=${lang}`],
    locale: lang === "ru" ? "ru-RU" : "en-US",
    userAgent: d.ua, viewport: d.viewport, deviceScaleFactor: d.scale, hasTouch: d.touch
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent("serviceworker")
  await new Promise((r) => setTimeout(r, 300))
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
  // Skip the one-time consent card in captures (it is shown in a dedicated shot).
  await sw.evaluate(() => chrome.storage.local.set({ "cf:consent": true }))
  // Larger text (a user setting) keeps the side panel readable at App Store thumbnail sizes.
  if (name !== "iphone") await sw.evaluate(() => chrome.storage.local.set({ "cf:settings": { textSize: "large" } }))
  const page = await ctx.newPage()
  return { ctx, sw, page, d }
}

async function fresh(s, { dark = false, url = ARTICLE } = {}) {
  await fetch(`${BASE}/reset`)
  await s.sw.evaluate(() => chrome.storage.local.remove("cf:chats"))
  await s.page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
  await s.page.goto(url)
  await s.page.waitForSelector("contextflow-root", { state: "attached" })
  await s.page.waitForTimeout(300)
}

async function open(s) {
  if (s.d.touch) await s.page.locator(".cf-fab").click()
  else await s.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "http://localhost:8787/*" })
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" })
  })
  await s.page.locator(".cf-panel.in").waitFor()
  await s.page.waitForTimeout(350)
}

async function waitAnswer(s, count = 1) {
  await s.page.waitForFunction(shadow(`(r) => r && r.querySelectorAll(".cf-msg.ai .md").length >= ${count} && !r.querySelector(".cf-send.stop")`), null, { timeout: 20000 })
  await s.page.evaluate(shadow(`(r) => { const l = r.querySelector(".cf-messages"); l.scrollTop = 0 }`))
  await s.page.waitForTimeout(250)
}

async function chip(s, label) {
  await s.page.locator(".cf-chip", { hasText: label }).first().click()
}

async function selectQuote(s, top = 0) {
  await s.page.evaluate((top) => {
    const q = document.querySelector("blockquote")
    q.scrollIntoView({ block: top ? "start" : "center" })
    if (top) window.scrollBy(0, -top)
    const range = document.createRange()
    range.selectNodeContents(q)
    const sel = document.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }, top)
  await s.page.waitForTimeout(500)
}

const shot = (s, file) => s.page.screenshot({ path: `${outDir}/${file}.png` })

// Saves the CSS-pixel rectangle of an element (inside the panel or on the page) for zoomed call-outs.
async function rect(s, file, selector, inShadow = true) {
  const r = await s.page.evaluate(([sel, sh]) => {
    const root = sh ? document.querySelector("contextflow-root").shadowRoot : document
    const b = root.querySelector(sel)?.getBoundingClientRect()
    return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
  }, [selector, inShadow])
  writeFileSync(`${outDir}/${file}.json`, JSON.stringify({ [selector]: r, scale: s.d.scale }))
}

const ONLY = process.env.ONLY?.split(",")
const want = (d) => !ONLY || ONLY.includes(d)

// ------------------------------------------------------------ iPhone
if (want("iphone")) {
  const s = await session("iphone")
  await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s); await shot(s, "iphone-summary")
  await fresh(s); await open(s); await chip(s, L.key); await waitAnswer(s); await shot(s, "iphone-keys"); await rect(s, "iphone-keys", ".md table")
  // Keep the highlighted quote visible above the bottom sheet.
  await fresh(s); await selectQuote(s, 150); await open(s); await chip(s, L.explain); await waitAnswer(s); await shot(s, "iphone-selection")
  await fresh(s, { url: FOREIGN }); await open(s); await chip(s, L.translate); await waitAnswer(s); await shot(s, "iphone-translate")
  await fresh(s, { dark: true }); await open(s)
  await s.page.locator(".cf-input textarea").fill(L.question); await s.page.locator(".cf-send").click(); await waitAnswer(s); await shot(s, "iphone-ask-dark")
  await s.ctx.close()
}

// ------------------------------------------------------------ iPad
if (want("ipad")) {
  const s = await session("ipad")
  await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s); await shot(s, "ipad-summary")
  await fresh(s); await selectQuote(s, 300); await open(s); await chip(s, L.explain); await waitAnswer(s); await shot(s, "ipad-selection")
  await fresh(s, { url: FOREIGN }); await open(s); await chip(s, L.translate); await waitAnswer(s); await shot(s, "ipad-translate")
  await fresh(s, { dark: true }); await open(s)
  await s.page.locator(".cf-input textarea").fill(L.question); await s.page.locator(".cf-send").click(); await waitAnswer(s); await shot(s, "ipad-ask-dark")
  await s.ctx.close()
}

// ------------------------------------------------------------ Mac
if (want("mac")) {
  const s = await session("mac")
  await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s); await shot(s, "mac-summary")
  await fresh(s)
  await s.page.evaluate(() => { document.querySelector("blockquote").scrollIntoView({ block: "start" }); window.scrollBy(0, -260) })
  const box = await s.page.locator("blockquote").boundingBox()
  await s.page.mouse.move(box.x + 4, box.y + 6); await s.page.mouse.down()
  await s.page.mouse.move(box.x + box.width - 6, box.y + box.height - 10, { steps: 10 }); await s.page.mouse.up()
  await s.page.locator(".cf-bubble").waitFor(); await s.page.waitForTimeout(250); await shot(s, "mac-bubble"); await rect(s, "mac-bubble", ".cf-bubble")
  await s.page.locator(".cf-bubble button", { hasText: L.explain }).click(); await waitAnswer(s)
  // Clicking the bubble moves focus into the panel; restore the highlight so the shot shows what was asked about.
  await s.page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector("blockquote"))
    document.getSelection().removeAllRanges()
    document.getSelection().addRange(range)
  })
  await s.page.waitForTimeout(400); await shot(s, "mac-selection")
  await fresh(s, { url: FOREIGN }); await open(s); await chip(s, L.translate); await waitAnswer(s); await shot(s, "mac-translate")
  await fresh(s, { dark: true }); await open(s)
  await s.page.locator(".cf-input textarea").fill(L.question); await s.page.keyboard.press("Enter"); await waitAnswer(s); await shot(s, "mac-ask-dark")
  await s.ctx.close()
}
console.log("captured →", outDir)
