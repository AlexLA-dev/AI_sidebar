// Captures real ContextFlow UI states for App Store screenshots.
// Needs: tools/preview/server.mts running on :8787 and an extension build pointing at it.
//   node tools/store/capture.mjs <extensionDir> <outDir> [lang]
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"

const [extDir, outDir, lang = "en"] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const BASE = "http://localhost:8787"
const ARTICLE = lang === "ru" ? `${BASE}/article-ru` : `${BASE}/article`
// A second article in the same language: the conversation continues there.
const ARTICLE_2 = lang === "ru" ? `${BASE}/article-2-ru` : `${BASE}/article-2`
// "Translate" always targets the UI language, so it is shown on a page in the other language.
const FOREIGN = lang === "ru" ? `${BASE}/article` : `${BASE}/article-ru`

const DEVICES = {
  iphone: {
    // 6.9" iPhone at @3x; the compositor draws the status bar (162) and Safari bar (234) around the 2400 px page.
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
  ? { summarize: "Кратко", key: "Главное", explain: "Объясн", translate: "Перевести", google: "Google", question: "Стоит ли пробовать это стартапу из 10 человек?", compare: "Как это сравнить с прошлой статьёй?", settings: "Настройки",
      notes: ["Выручка +1,4% — сверить с нашими цифрами за квартал", "Спросить HR про пилот с короткой пятницей", "Сравнить со статьёй про Японию"],
      recall: "Сведи мои заметки с обеими статьями", other: "Подборка статей про удалёнку", research: "Исследование: четырёхдневка" }
  : { summarize: "Summarize", key: "Key takeaways", explain: "Explain", translate: "Translate", google: "Google", question: "Is this worth trying for a 10-person startup?", compare: "How does this compare with the previous article?", settings: "Settings",
      notes: ["Revenue +1.4% — check against our quarter", "Ask HR about a short-Friday pilot", "Compare with the Japan article"],
      recall: "Pull my notes together with both articles", other: "Remote work reading list", research: "Research: four-day week" }

const shadow = (js) => `(() => { const r = document.querySelector("contextflow-root")?.shadowRoot; return (${js})(r) })()`

async function session(name) {
  const d = DEVICES[name]
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    // Full Chromium: the default headless shell can't load extensions.
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--lang=${lang}`],
    locale: lang === "ru" ? "ru-RU" : "en-US",
    userAgent: d.ua, viewport: d.viewport, deviceScaleFactor: d.scale, hasTouch: d.touch
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent("serviceworker")
  await new Promise((r) => setTimeout(r, 300))
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
  // Skip the one-time consent card in captures (it is shown in a dedicated shot).
  // Nor the first-session tour and the hint about notes: they would cover the panel.
  await sw.evaluate(() => chrome.storage.local.set({ "cf:consent": true, "cf:tourSeen": true, "cf:noteHint": -1 }))
  // Larger text (a user setting) keeps the panel readable at App Store thumbnail sizes.
  await sw.evaluate(() => chrome.storage.local.set({ "cf:settings": { textSize: "large", fab: "on" }, "cf:settingsUpdatedAt": Date.now() }))
  const page = await ctx.newPage()
  return { ctx, sw, page, d }
}

async function fresh(s, { dark = false, url = ARTICLE } = {}) {
  await fetch(`${BASE}/reset`)
  await s.sw.evaluate(() => chrome.storage.local.remove(["cf:chats", "cf:conversation", "cf:threads", "cf:activeThread", "cf:pageTexts"]))
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

const shot = (s, file) => s.page.screenshot({ path: `${outDir}/${file}.png` })

// Saves the CSS-pixel rectangles of elements (the last match of each, inside the panel) for zoomed call-outs.
async function rect(s, file, selectors) {
  const rects = await s.page.evaluate((sels) => {
    const root = document.querySelector("contextflow-root").shadowRoot
    return Object.fromEntries(sels.map((sel) => {
      const els = root.querySelectorAll(sel)
      const b = els[els.length - 1]?.getBoundingClientRect()
      return [sel, b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null]
    }))
  }, selectors)
  writeFileSync(`${outDir}/${file}.json`, JSON.stringify({ ...rects, scale: s.d.scale }))
}


// Selects a sentence of the article by touch (iPhone / iPad) and waits for the selection button.
async function touchSelect(s, nth = 2) {
  await s.page.evaluate((n) => {
    const p = document.querySelectorAll("main p")[n]
    p.scrollIntoView({ block: "center" })
    const text = p.firstChild
    const end = text.textContent.indexOf(".") + 1
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, end > 0 ? end : text.textContent.length)
    document.getSelection().removeAllRanges()
    document.getSelection().addRange(range)
  }, nth)
  await s.page.locator(".cf-bubble.touch").waitFor({ timeout: 5000 })
  await s.page.waitForTimeout(300)
}

async function waitSources(s) {
  await s.page.waitForFunction(shadow(`(r) => r && r.querySelector(".cf-msg.ai .cf-sources") && !r.querySelector(".cf-send.stop")`), null, { timeout: 20000 })
  await s.page.waitForTimeout(300)
}

// Scrolls the message list so `selector` (the last match) sits near the top of the list,
// but never so far up that `keep` (the last match) falls below the bottom edge.
async function scrollTo(s, selector, offset = 12, keep) {
  await s.page.evaluate(shadow(`(r) => {
    const list = r.querySelector(".cf-messages")
    const last = (sel) => { const els = r.querySelectorAll(sel); return els[els.length - 1] }
    const el = last(${JSON.stringify(selector)})
    if (!el) return
    let top = el.offsetTop - list.offsetTop - ${offset}
    const k = ${JSON.stringify(keep ?? null)} && last(${JSON.stringify(keep ?? "")})
    if (k) top = Math.max(top, k.offsetTop - list.offsetTop + k.offsetHeight + 8 - list.clientHeight)
    list.scrollTop = top
  }`))
  await s.page.waitForTimeout(250)
}

// Summarize on one article, then continue the same chat on a second one, with "Whole chat" on.
async function conversation(s) {
  await fresh(s, { dark: true }); await open(s); await chip(s, L.summarize); await waitAnswer(s)
  await s.page.goto(ARTICLE_2); await s.page.waitForSelector("contextflow-root", { state: "attached" }); await s.page.waitForTimeout(300)
  await open(s)
  if (!(await s.page.locator(".cf-whole input").isChecked())) await s.page.locator(".cf-whole").click()
  await s.page.locator(".cf-input textarea").fill(L.compare)
  if (s.d.touch) await s.page.locator(".cf-send").click(); else await s.page.keyboard.press("Enter")
  await waitAnswer(s, 2)
  await scrollTo(s, ".cf-divider", 0)
}

// The user's own question about the page, answered (the hook of the "ask" test page).
async function ask(s) {
  await fresh(s); await open(s)
  await s.page.locator(".cf-input textarea").fill(L.question)
  if (s.d.touch) await s.page.locator(".cf-send").click(); else await s.page.keyboard.press("Enter")
  await waitAnswer(s)
}

// A summary, two notes kept under it and a third being written: the send button switched to a note.
async function notes(s) {
  await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s)
  const send = s.page.locator(".cf-send-wrap")
  for (const [i, text] of L.notes.entries()) {
    await s.page.locator(".cf-input textarea").fill(text)
    await s.page.waitForTimeout(600) // the button flips once per scroll gesture
    const b = await send.boundingBox()
    await s.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await s.page.mouse.wheel(0, 60)
    await s.page.locator(".cf-send.note").waitFor()
    if (i < L.notes.length - 1) {
      await s.page.locator(".cf-send").click()
      await s.page.waitForTimeout(300)
    }
  }
  await s.page.evaluate(shadow(`(r) => { const l = r.querySelector(".cf-messages"); l.scrollTop = l.scrollHeight }`))
  await s.page.waitForTimeout(300)
}

// The custom product page for people who take notes while they read (SET=notes): a research chat over
// two articles with notes, the answer from the whole chat, picking messages to share, the chat list.
async function writeNote(s, text) {
  await s.page.locator(".cf-input textarea").fill(text)
  await s.page.waitForTimeout(600)
  const b = await s.page.locator(".cf-send-wrap").boundingBox()
  await s.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await s.page.mouse.wheel(0, 60)
  await s.page.locator(".cf-send.note").click()
  await s.page.waitForTimeout(300)
}
async function research(s, k) {
  await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s)
  await writeNote(s, L.notes[0]); await writeNote(s, L.notes[1])
  await s.page.goto(ARTICLE_2); await s.page.waitForSelector("contextflow-root", { state: "attached" }); await s.page.waitForTimeout(300)
  await open(s)
  await writeNote(s, L.notes[2])
  if (!(await s.page.locator(".cf-whole input").isChecked())) await s.page.locator(".cf-whole").click()
  await s.page.locator(".cf-input textarea").fill(L.recall)
  if (s.d.touch) await s.page.locator(".cf-send").click(); else await s.page.keyboard.press("Enter")
  await waitAnswer(s, 2)
  await scrollTo(s, ".cf-msg.user.note", 0)
  await shot(s, `${k}-recall`); await rect(s, `${k}-recall`, [".cf-panel", ".cf-whole"])
  // Pick: the notes and the last answer go, the summary and the question stay out.
  await s.page.locator("header .cf-icon:has(path[d^='M4 12v8'])").click()
  await s.page.waitForTimeout(300)
  for (const i of [0, 1]) await s.page.locator(".cf-msg.pickable").nth(i).click()
  await s.page.locator(".cf-msg.pickable").nth(5).click()
  await scrollTo(s, ".cf-msg.user.note", 0)
  await s.page.waitForTimeout(300)
  await shot(s, `${k}-pick`); await rect(s, `${k}-pick`, [".cf-panel", ".cf-pickbar"])
  await s.page.locator(".cf-pickbar .cf-icon").first().click()
  // The chat list: this research chat (named and pinned) with its pages, under another chat.
  await s.sw.evaluate(async ({ research, other }) => {
    const store = await chrome.storage.local.get(["cf:threads", "cf:activeThread"])
    const threads = store["cf:threads"]
    const active = threads[store["cf:activeThread"].id]
    active.title = research; active.pin = 0; active.u = Date.now()
    // The made-up sites the screenshots show in the address bar, not localhost.
    const hosts = { "/article": "weeklyreview.com", "/article-2": "techledger.com", "/article-ru": "delovoyobzor.ru", "/article-2-ru": "tehrynok.ru" }
    for (const e of active.m) if (e.page) e.page = { ...e.page, url: `https://${hosts[new URL(e.page.url).pathname]}/four-day-week` }
    const now = Date.now()
    threads.other = { id: "other", u: now - 7200_000, a: now - 7200_000, title: other,
      m: [{ role: "user", content: other, page: { url: "https://www.theverge.com/remote", title: "Remote" } }, { role: "assistant", content: "…" }] }
    await chrome.storage.local.set({ "cf:threads": threads })
  }, { research: L.research, other: L.other })
  await s.page.waitForTimeout(400)
  await s.page.locator(".cf-chats-button").click()
  await s.page.waitForTimeout(400)
  await s.page.locator(".cf-pages-chip").first().click()
  await s.page.waitForTimeout(300)
  await shot(s, `${k}-chats`); await rect(s, `${k}-chats`, [".cf-panel", ".cf-pages-pop", ".cf-thread"])
}

const ONLY = process.env.ONLY?.split(",")
const want = (d) => !ONLY || ONLY.includes(d)

for (const name of ["iphone", "ipad", "mac"]) {
  if (!want(name)) continue
  const s = await session(name)
  const k = name
  if (process.env.SET === "notes") {
    if (name !== "mac") await research(s, k)
    await s.ctx.close()
    continue
  }
  // Only the own-question state (the product page tests reuse every other capture).
  if (process.env.SET === "ask") {
    await ask(s); await shot(s, `${k}-ask`); await rect(s, `${k}-ask`, [".cf-panel"])
    await s.ctx.close()
    continue
  }
  // 1. Summary of the page (hero)
  await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s); await shot(s, `${k}-summary`); await rect(s, `${k}-summary`, [".cf-panel"])
  if (k === "iphone") {
    // Same state without the free-answers line and "Get Pro": the header / search
    // creative assets may not mention prices or "free".
    await s.page.evaluate(shadow(`(r) => { const st = document.createElement("style"); st.textContent = ".cf-usage { visibility: hidden }"; r.appendChild(st) }`))
    await shot(s, `${k}-summary-clean`)
  }
  // 2. Selection button
  if (s.d.touch) {
    await fresh(s); await touchSelect(s); await shot(s, `${k}-select`); await rect(s, `${k}-select`, [".cf-bubble"])
  } else {
    await fresh(s)
    await s.page.evaluate(() => { document.querySelector("blockquote").scrollIntoView({ block: "start" }); window.scrollBy(0, -260) })
    const box = await s.page.locator("blockquote").boundingBox()
    await s.page.mouse.move(box.x + 4, box.y + 6); await s.page.mouse.down()
    await s.page.mouse.move(box.x + box.width - 6, box.y + box.height - 10, { steps: 10 }); await s.page.mouse.up()
    await s.page.locator(".cf-bubble").waitFor(); await s.page.waitForTimeout(300)
    await shot(s, `${k}-select`); await rect(s, `${k}-select`, [".cf-bubble"])
  }
  // 3. Google answer with sources
  await fresh(s); await open(s); await chip(s, L.google); await waitSources(s)
  await scrollTo(s, ".cf-msg.ai .cf-grounded", 140, ".cf-msg.ai .cf-source-list")
  await shot(s, `${k}-google`); await rect(s, `${k}-google`, [".cf-panel", ".cf-sources-title", ".cf-source-list"])
  // 4. Notes in the chat
  await notes(s); await shot(s, `${k}-notes`); await rect(s, `${k}-notes`, [".cf-panel", ".cf-bubble-note", ".cf-input"])
  // 5. Translate a page in another language
  await fresh(s, { url: FOREIGN }); await open(s); await chip(s, L.translate); await waitAnswer(s); await shot(s, `${k}-translate`); await rect(s, `${k}-translate`, [".cf-panel"])
  // 6. One chat across sites (dark, for rhythm)
  await conversation(s); await shot(s, `${k}-chat`); await rect(s, `${k}-chat`, [".cf-panel", ".md-table"])
  // 7. Own question about the page
  await ask(s); await shot(s, `${k}-ask`); await rect(s, `${k}-ask`, [".cf-panel"])
  await s.ctx.close()
}
console.log("captured →", outDir)
