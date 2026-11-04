// Records real ContextFlow UI on iPhone for the clips in the app's Tips tab (one take per tip).
// Needs: tools/preview/server.mts on :8787 (STREAM_DELAY_MS=22 gives a readable streaming pace)
// and a Safari build pointing at it: CF_API_BASE=http://localhost:8787 CF_OPEN_SHADOW=1 node scripts/build-extension.mjs --out=<dir>
//   node tools/store/tips-record.mjs <extensionDir> <outDir> [lang] [takes]
// The Pro takes (aisearch, history, pdf) need the stand with PREVIEW_PLAN=pro and a build pointing at it:
//   CF_STAND=http://localhost:8788 node tools/store/tips-record.mjs <proBuild> <outDir> en aisearch,history,pdf
// Output like preview-record.mjs: <outDir>/<take>/NNNNN.jpg + <outDir>/<take>.json { frames, events }.
// tips-render.mjs turns the takes into the looping clips.
import { chromium } from "playwright"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [extDir, outDir, lang = "en", only = ""] = process.argv.slice(2)
const BASE = process.env.CF_STAND ?? "http://localhost:8787"
const ru = lang === "ru"
const PAGE_1 = `${BASE}/${ru ? "article-ru" : "article"}`
const PAGE_2 = `${BASE}/${ru ? "article-2-ru" : "article-2"}`
const L = ru
  ? {
      summarize: "Кратко", key: "Главное", explain: "Объясн",
      google: "Сколько компаний в Японии уже перешли на четырёхдневку?",
      note: "Проверить цифры по выгоранию в отчёте",
      compare: "А если сравнить с первой статьёй?",
      about: "Я продакт-менеджер. Люблю короткие ответы с цифрами.",
      lecture: "Какой свет поглощает хлорофилл?",
      search: "пилот",
      tag: "Идеи", tagButton: "Тег",
      find: "исследование про выгорание",
      selq: "Сколько компаний вернулись к пятидневке?",
      pdf: "Что в отчёте про выручку?"
    }
  : {
      summarize: "Summarize", key: "Key takeaways", explain: "Explain",
      google: "How many companies in Japan have moved to a four-day week?",
      note: "Check the burnout numbers in the report",
      compare: "How does this compare with the first article?",
      about: "I'm a product manager. I like short answers with numbers.",
      lecture: "What light does chlorophyll absorb?",
      search: "pilot",
      tag: "Ideas", tagButton: "Tag",
      find: "that study where burnout dropped",
      selq: "How many companies went back to five days?",
      pdf: "What does the report say about revenue?"
    }

// macOS Chromium ignores --lang: a copy of the build with only the wanted locale shows the UI in it.
function localizedExtension() {
  if (process.platform !== "darwin" || lang === "en") return extDir
  const dir = join(tmpdir(), `cf-tips-${lang}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(extDir, dir, { recursive: true })
  for (const l of readdirSync(join(dir, "_locales"))) if (l !== lang) rmSync(join(dir, "_locales", l), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, default_locale: lang }, null, 2))
  return dir
}
const LINUX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const ext = localizedExtension()
const ctx = await chromium.launchPersistentContext("", {
  headless: true,
  ...(existsSync(LINUX_CHROME) ? { executablePath: LINUX_CHROME } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${lang}`, "--force-device-scale-factor=3"],
  locale: ru ? "ru-RU" : "en-US",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  viewport: { width: 430, height: 800 }, deviceScaleFactor: 3, hasTouch: true
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent("serviceworker")
await new Promise((r) => setTimeout(r, 300))
for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)

const shadow = (js) => `(() => { const r = document.querySelector("contextflow-root")?.shadowRoot; return (${js})(r) })()`
const wait = (ms) => page.waitForTimeout(ms)

let take = null
function mark(type, data = {}) {
  take?.events.push({ t: Date.now() / 1000 - take.start, type, ...data })
}
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
  if (!take) return
  const f = `${String(take.frames.length).padStart(5, "0")}.jpg`
  writeFileSync(join(outDir, take.name, f), Buffer.from(data, "base64"))
  take.frames.push({ f, t: metadata.timestamp - take.start })
})

/** A fresh first session on `url` (nothing recorded yet): no chats, tour and hints seen, consent (2.4's) given. */
async function fresh(url, threads = null) {
  // The previous take's panel must not see (and write back over) the reset storage.
  await page.goto("about:blank")
  await fetch(`${BASE}/reset`)
  await sw.evaluate(async (threads) => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ "cf:consent": 2, "cf:tourSeen": true, "cf:noteHint": -1, "cf:selHint": -1, "cf:hintsSeen": ["chats", "video", "pdf"] })
    if (threads) await chrome.storage.local.set({ "cf:threads": threads, "cf:activeThread": { id: Object.keys(threads)[0], at: Date.now() } })
  }, threads)
  await go(url)
}

/** A few earlier chats, for the search, tags and Pro takes. */
function history() {
  const now = Date.now()
  const page = (url, title) => ({ url, title })
  const q = (content, p, extra = {}) => ({ role: "user", content, page: p, ...extra })
  const a = (content, extra = {}) => ({ role: "assistant", content, ...extra })
  const p1 = page(PAGE_1, ru ? "Почему четырёхдневка работает — и когда нет" : "Why the four-day week works — and when it doesn't")
  const t = (id, ago, m, extra = {}) => ({ id, u: now - ago, a: now - ago, m, ...extra })
  return ru
    ? {
        a1: t("a1", 6e5, [q("Кратко", p1, { label: "Кратко" }), a("**Коротко:** 61 компания сократила неделю на 20%; выгорание упало, выручка не изменилась."), q("Стоит ли пробовать в стартапе?", p1), a("Для команды из 10 человек — да: чередуйте выходной и запустите **пилот на 3 месяца**.")], { title: "Исследование четырёхдневки", tags: ["Работа"] }),
        a2: t("a2", 9e6, [q("Кофе после 16:00 мешает сну?", page("https://health.example/coffee", "Кофе и сон")), a("Период полувыведения кофеина — около 5 часов, так что кофе в 16:00 может сдвинуть сон.")], { tags: ["Здоровье"] }),
        a3: t("a3", 2e7, [q("Рецепт быстрого ужина?", page("https://food.example/pasta", "Паста за 15 минут")), a("Сварите пасту, добавьте чеснок, масло и перец чили.")]),
        a4: t("a4", 9e7, [q("Что такое пилотный проект?", page("https://pm.example/pilot", "Пилоты в продукте")), a("Небольшой запуск на ограниченной группе, чтобы проверить гипотезу до полного запуска.")], { tags: ["Работа"] })
      }
    : {
        a1: t("a1", 6e5, [q("Summarize", p1, { label: "Summarize" }), a("**In short:** 61 companies cut hours by 20%; burnout fell and revenue held."), q("Is this worth trying for a startup?", p1), a("For a 10-person team, yes: rotate the day off and run a **3-month pilot**.")], { title: "Four-day week research", tags: ["Work"] }),
        a2: t("a2", 9e6, [q("Does coffee after 4 pm hurt sleep?", page("https://health.example/coffee", "Coffee and sleep")), a("Caffeine has a half-life of about 5 hours, so a 4 pm coffee can delay sleep.")], { tags: ["Health"] }),
        a3: t("a3", 2e7, [q("Recipe for a quick dinner?", page("https://food.example/pasta", "Pasta in 15 minutes")), a("Boil pasta, add garlic, olive oil and chili.")]),
        a4: t("a4", 9e7, [q("What is a pilot project?", page("https://pm.example/pilot", "Pilots in product work")), a("A small launch with a limited group, to test an idea before the full rollout.")], { tags: ["Work"] })
      }
}
async function go(url) {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(url)
  await page.waitForSelector("contextflow-root", { state: "attached" })
  await wait(400)
}
async function record(name) {
  mkdirSync(join(outDir, name), { recursive: true })
  take = { name, start: Date.now() / 1000, frames: [], events: [] }
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1290, maxHeight: 2400, everyNthFrame: 1 })
  await page.evaluate(() => window.scrollBy(0, 1)) // forces a first frame
  await wait(500)
}
async function end() {
  await wait(200)
  await cdp.send("Page.stopScreencast")
  mark("end")
  writeFileSync(join(outDir, `${take.name}.json`), JSON.stringify({ frames: take.frames, events: take.events }, null, 1))
  console.log(`${take.name}: ${take.frames.length} frames, ${take.events.at(-1).t.toFixed(1)} s`)
  take = null
}

// Tap = touch marker (drawn by the renderer) shortly before the click lands.
async function tap(locator) {
  const b = await locator.boundingBox()
  mark("tap", { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  await wait(220)
  await locator.click()
}
async function type(text) {
  await page.keyboard.type(text, { delay: 26 })
  await wait(250)
}
async function answers(count) {
  await page.waitForFunction(shadow(`(r) => r && r.querySelectorAll(".cf-msg.ai .md").length >= ${count} && !r.querySelector(".cf-send.stop")`), null, { timeout: 30000 })
}
const chip = (label) => page.locator(".cf-chip", { hasText: label }).first()
async function openPanel(recorded = true) {
  if (recorded) await tap(page.locator(".cf-fab"))
  else await page.locator(".cf-fab").click()
  await page.locator(".cf-panel.in").waitFor()
  await wait(650)
}
/** A swipe up on the send button (the renderer draws the finger moving). */
async function swipeUp(locator) {
  const b = await locator.boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  mark("swipe", { x, y, dy: -46 })
  await wait(160)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 8 }] })
    await wait(25)
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

/** Selects a phrase of the n-th paragraph: from the first match of `from` to the next `until` (not included). */
async function selectText(n, from, until, scroll = true) {
  if (scroll) {
    await page.evaluate((n) => document.querySelectorAll("main p")[n].scrollIntoView({ block: "center" }), n)
    await wait(400)
  }
  await page.evaluate(({ n, from, until }) => {
    const text = document.querySelectorAll("main p")[n].firstChild
    const start = text.data.search(new RegExp(from))
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, text.data.indexOf(until, start))
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  }, { n, from, until })
}
/** On iPhone the tap that reaches the selection buttons also clears the page's selection. */
const tapClears = () => page.evaluate(() => document.addEventListener("pointerdown", () => getSelection().removeAllRanges(), { capture: true, once: true }))

const takes = {
  async open() {
    await fresh(PAGE_1)
    await record("open")
    await wait(500)
    await openPanel()
    await wait(1400)
  },
  async gist() {
    await fresh(PAGE_1)
    await openPanel(false)
    await record("gist")
    await tap(chip(L.summarize)); await answers(1); await wait(1600)
  },
  async part() {
    await fresh(PAGE_1)
    await page.evaluate(() => { const q = document.querySelector("blockquote"); q.scrollIntoView({ block: "center" }) })
    await wait(300)
    await record("part")
    await page.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector("blockquote"))
      document.getSelection().removeAllRanges()
      document.getSelection().addRange(range)
    })
    await wait(900)
    await openPanel()
    await tap(chip(L.explain)); await answers(1); await wait(1500)
  },
  async google() {
    await fresh(PAGE_1)
    await openPanel(false)
    await record("google")
    await tap(page.locator(".cf-mode"))
    await tap(page.locator(".cf-input textarea")); await type(L.google)
    await tap(page.locator(".cf-send")); await answers(1); await wait(1800)
  },
  async follows() {
    await fresh(PAGE_1)
    await openPanel(false)
    await chip(L.summarize).click(); await answers(1)
    await go(PAGE_2)
    await openPanel(false)
    await record("follows")
    await wait(600)
    await tap(chip(L.key)); await answers(2); await wait(1600)
  },
  async chats() {
    await fresh(PAGE_1)
    await openPanel(false)
    await chip(L.summarize).click(); await answers(1)
    await go(PAGE_2)
    await openPanel(false)
    await page.locator(`header .cf-icon:has(path[d="M12 5v14M5 12h14"])`).click() // + new chat
    await wait(300)
    await chip(L.key).click(); await answers(1)
    await record("chats")
    await tap(page.locator(".cf-chats-button"))
    await wait(900)
    await tap(page.locator(".cf-thread:not(.current) .cf-thread-main").first())
    await wait(1600)
  },
  async notes() {
    await fresh(PAGE_1)
    await openPanel(false)
    await chip(L.summarize).click(); await answers(1)
    await record("notes")
    await tap(page.locator(".cf-input textarea")); await type(L.note)
    await swipeUp(page.locator(".cf-send-wrap"))
    await wait(700)
    await tap(page.locator(".cf-send")); await wait(1600)
  },
  async select() {
    await fresh(PAGE_1)
    await page.evaluate(() => document.querySelectorAll("main p")[0].scrollIntoView({ block: "center" }))
    await wait(400)
    await record("select")
    const bubble = page.locator(".cf-bubble")
    await selectText(0, "\\d", ",", false)
    await bubble.waitFor()
    await wait(700)
    await tapClears()
    await tap(bubble.locator(".cf-bubble-ask input")); await type(L.selq)
    await tap(bubble.locator(".cf-bubble-send"))
    await page.locator(".cf-panel.in").waitFor()
    await answers(1); await wait(1500)
    await page.locator(".cf-backdrop").click({ position: { x: 20, y: 20 } })
    await wait(500)
    await selectText(4, "^", ",")
    await bubble.waitFor()
    await wait(700)
    await tapClears()
    await tap(bubble.locator(".cf-sel-note"))
    await bubble.locator(".cf-bubble-saved").waitFor()
    await wait(900)
    await tap(bubble.locator(".cf-bubble-saved button"))
    await page.locator(".cf-panel.in").waitFor()
    await wait(1700)
  },
  async pdf() {
    // Chromium has no Safari app extension to read the PDF (PdfText.swift): its answer stands in.
    await sw.evaluate(() => {
      globalThis.browser = { runtime: { sendNativeMessage: async (_id, msg) => msg.command === "pdfText"
        ? { success: true, data: { ok: true, pages: 3, title: "Q3 report", text: "Northwind Q3 report. Revenue rose 12% to $48.2M; subscriptions $31.5M (+18%), services $16.7M." } }
        : { success: false } } }
    })
    await fresh(`${BASE}/pdf-embed`)
    await record("pdf")
    await openPanel()
    await wait(800)
    await tap(page.locator(".cf-input textarea")); await type(L.pdf)
    await tap(page.locator(".cf-send")); await answers(1); await wait(2000)
  },
  async whole() {
    await fresh(PAGE_1)
    await openPanel(false)
    await chip(L.summarize).click(); await answers(1)
    await go(PAGE_2)
    await openPanel(false)
    await record("whole")
    await tap(page.locator(".cf-whole"))
    await wait(300)
    await tap(page.locator(".cf-input textarea")); await type(L.compare)
    await tap(page.locator(".cf-send")); await answers(2); await wait(1700)
  },
  async video() {
    await fresh(`${BASE}/${ru ? "lecture-ru" : "lecture"}`)
    await record("video")
    await openPanel()
    await wait(1100)
    await tap(page.locator(".cf-input textarea")); await type(L.lecture)
    await tap(page.locator(".cf-send")); await answers(1); await wait(1800)
  },
  async search() {
    await fresh(PAGE_1, history())
    await openPanel(false)
    await record("search")
    await tap(page.locator(".cf-chats-button"))
    await wait(700)
    await tap(page.locator(".cf-search input")); await type(L.search)
    await wait(1000)
    await tap(page.locator(".cf-search-hit").first())
    await wait(1700)
  },
  async tags() {
    await fresh(PAGE_1, history())
    await openPanel(false)
    await record("tags")
    await tap(page.locator(".cf-msg.ai .cf-msg-tools button", { hasText: L.tagButton }).last())
    await wait(400)
    await type(L.tag)
    await page.keyboard.press("Enter")
    await wait(500)
    await tap(page.locator(".cf-tag-editor .cf-tag-done"))
    await wait(500)
    await tap(page.locator(".cf-chats-button"))
    await wait(700)
    await tap(page.locator(".cf-tag-group"))
    await wait(1800)
  },
  async aisearch() {
    await fresh(PAGE_1, history())
    await openPanel(false)
    await record("aisearch")
    await tap(page.locator(".cf-chats-button"))
    await wait(600)
    await tap(page.locator(".cf-search-ai"))
    await wait(300)
    await tap(page.locator(".cf-search input")); await type(L.find)
    await page.keyboard.press("Enter")
    await page.locator(".cf-find-why").first().waitFor({ timeout: 15000 })
    await wait(1900)
  },
  async history() {
    await fresh(PAGE_1, history())
    await openPanel(false)
    await record("history")
    await tap(page.locator(".cf-chats-button"))
    await wait(600)
    await tap(page.locator(".cf-ask-history .cf-thread-main"))
    await wait(700)
    await tap(page.locator(".cf-empty .cf-chip").first()); await answers(1); await wait(1900)
  },
  async about() {
    await fresh(PAGE_1)
    await openPanel(false)
    await record("about")
    await tap(page.locator(".cf-settings-button"))
    await wait(500)
    const field = page.locator(".cf-settings textarea").first()
    await field.scrollIntoViewIfNeeded()
    await wait(400)
    await tap(field); await type(L.about)
    await wait(1200)
  }
}

for (const [name, run] of Object.entries(takes)) {
  if (only && !only.split(",").includes(name)) continue
  try { await run() } catch (e) { await page.screenshot({ path: join(outDir, `${name}-fail.png`) }); throw e }
  await end()
}
await ctx.close()
