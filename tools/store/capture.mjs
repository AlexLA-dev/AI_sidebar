// Captures real ContextFlow UI states for App Store screenshots.
// The build needs CF_OPEN_SHADOW=1: these scripts read inside the panel's shadow root (production closes it).
// Needs: tools/preview/server.mts running on :8787 and an extension build pointing at it.
//   node tools/store/capture.mjs <extensionDir> <outDir> [lang]
// CF_STAND=http://localhost:8797 uses a stand on another port (the build must point at it).
// SET=pro: the Pro shots (a video and a PDF on the page) from a stand with PREVIEW_PLAN=pro and a build pointing at it.
// The 2.5 product page: the default run (summary, quick insert, page watch, reminders, selection, pins and highlights,
// notes) on the free stand, then SET=pro25 (organizing suggestions, the lecture video) on the Pro stand.
import { chromium } from "playwright"
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [extArg, outDir, lang = "en"] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const BASE = process.env.CF_STAND ?? "http://localhost:8787"
// macOS Chromium ignores --lang: a copy of the build with only the wanted locale shows the UI in it.
function localizedExtension() {
  if (process.platform !== "darwin" || lang === "en") return extArg
  const dir = join(tmpdir(), `cf-capture-${lang}-${new URL(BASE).port}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(extArg, dir, { recursive: true })
  for (const l of readdirSync(join(dir, "_locales"))) if (l !== lang) rmSync(join(dir, "_locales", l), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, default_locale: lang }, null, 2))
  return dir
}
const extDir = localizedExtension()
const ARTICLE = lang === "ru" ? `${BASE}/article-ru` : `${BASE}/article`
// A second article in the same language: the conversation continues there.
const ARTICLE_2 = lang === "ru" ? `${BASE}/article-2-ru` : `${BASE}/article-2`
// "Translate" always targets the UI language, so it is shown on a page in the other language.
const FOREIGN = lang === "ru" ? `${BASE}/article` : `${BASE}/article-ru`
// Custom product pages: a product with reviews (shopping) and an investor page with an embedded PDF report (Pro).
const PRODUCT = lang === "ru" ? `${BASE}/product-ru` : `${BASE}/product`
const REPORT = lang === "ru" ? `${BASE}/report-ru` : `${BASE}/report`
// The 2.5 sites under names of their own (*.example resolves to the stand), so Copied names a site, not localhost.
const site = (host, path) => `${BASE.replace("localhost", host)}/${lang === "ru" ? `${path}-ru` : path}`
// The hosts the composed address bar shows too (the panel names the site in Copied and its settings).
const INBOX = site(lang === "ru" ? "mail.sevveter.studio" : "mail.northwind.studio", "inbox")
const SHOP = site(lang === "ru" ? "zvukodom.store" : "soundhouse.store", "product")
// The build's own words (menu items the 2.5 scenes look for), in the capture's language.
const messages = JSON.parse(readFileSync(join(extArg, "_locales", lang === "ru" ? "ru" : "en", "messages.json"), "utf8"))
const msg = (key, ...args) => args.reduce((text, a, i) => text.replace(`{${i}}`, a), messages[key].message)

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
      recall: "Сведи мои заметки с обеими статьями", other: "Подборка статей про удалёнку", research: "Исследование: четырёхдневка",
      selQuestion: "Подойдёт ли нам?", search: "четырёх", lecture: "Какой свет поглощает хлорофилл?", pdf: "Какие главные выводы отчёта?",
      shopAsk: "Стоит ли брать? В чём подвох?", shopReviews: "Что на самом деле пишут в отзывах?", shopSel: "Зачем это нужно?",
      callTpl: "Подтвердить созвон", orderTpl: "Спасибо за заказ", marks: [["61 компания", ","], ["Выручка не изменилась", "."]] }
  : { summarize: "Summarize", key: "Key takeaways", explain: "Explain", translate: "Translate", google: "Google", question: "Is this worth trying for a 10-person startup?", compare: "How does this compare with the previous article?", settings: "Settings",
      notes: ["Revenue +1.4% — check against our quarter", "Ask HR about a short-Friday pilot", "Compare with the Japan article"],
      recall: "Pull my notes together with both articles", other: "Remote work reading list", research: "Research: four-day week",
      selQuestion: "Worth it for a team of 10?", search: "four", lecture: "What light does chlorophyll absorb?", pdf: "What are the report's main findings?",
      shopAsk: "Worth buying? What's the catch?", shopReviews: "What do the reviews really say?", shopSel: "Why does this matter?",
      callTpl: "Confirm the call", orderTpl: "Thanks for the order", marks: [["61 companies", ","], ["Revenue held steady", "."]] }

const shadow = (js) => `(() => { const r = document.querySelector("contextflow-root")?.shadowRoot; return (${js})(r) })()`

async function session(name) {
  const d = DEVICES[name]
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    // Full Chromium: the default headless shell can't load extensions.
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--lang=${lang}`, "--host-resolver-rules=MAP *.example 127.0.0.1, MAP *.studio 127.0.0.1, MAP *.store 127.0.0.1"],
    locale: lang === "ru" ? "ru-RU" : "en-US",
    userAgent: d.ua, viewport: d.viewport, deviceScaleFactor: d.scale, hasTouch: d.touch
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent("serviceworker")
  await new Promise((r) => setTimeout(r, 300))
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
  const page = await ctx.newPage()
  return { ctx, sw, page, d }
}

// A clean first session: no chats; no consent card, tour or first-time hints (they would cover the panel);
// larger text (a user setting) keeps the panel readable at App Store thumbnail sizes. `threads` seeds earlier chats.
async function fresh(s, { dark = false, url = ARTICLE, threads = null, extra = {} } = {}) {
  await s.page.goto("about:blank")
  await fetch(`${BASE}/reset`)
  await s.sw.evaluate(async ({ threads, extra }) => {
    // Chromium has no app behind the extension: its answers stand in (a reminder is scheduled, notifications allowed).
    globalThis.browser = { runtime: { sendNativeMessage: async (_id, msg) => {
      if (msg?.command === "remind") return { success: true, data: { outcome: "scheduled" } }
      if (msg?.command === "watch_permission") return { success: true, data: { outcome: "ok" } }
      return { success: false }
    } } }
    await chrome.storage.local.clear()
    const { "cf:settings": settings = {}, ...rest } = extra
    await chrome.storage.local.set({ "cf:consent": 3, "cf:tourSeen": true, "cf:noteHint": -1, "cf:selHint": -1, "cf:hintsSeen": ["chats", "video", "pdf"],
      // 2.5's first-time tips (the eye and the bell, the button by a field) and organizing's Free cards stay out of the shots.
      "cf:watchTips": { eye: true, later: true }, "cf:selIconsTip": true, "cf:insertTipSeen": true,
      "cf:orgCards": { thirdTag: true, mess: { chats: [], at: 0, closed: true } },
      "cf:settings": { textSize: "large", fab: "on", ...settings }, "cf:settingsUpdatedAt": Date.now(), ...rest })
    if (threads) await chrome.storage.local.set({ "cf:threads": threads, "cf:activeThread": { id: Object.keys(threads)[0], at: Date.now() } })
  }, { threads, extra })
  await s.page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
  await go(s, url)
}

async function go(s, url) {
  await s.page.goto(url)
  await s.page.waitForSelector("contextflow-root", { state: "attached" })
  await s.page.waitForTimeout(300)
  // The free-answers count under the field names the daily number, which the store page doesn't.
  if (process.env.KEEP_USAGE !== "1") await s.page.evaluate(shadow(`(r) => { const st = document.createElement("style"); st.textContent = ".cf-usage-text { visibility: hidden }"; r.appendChild(st) }`))
}

async function open(s) {
  if (s.d.touch) await s.page.locator(".cf-fab").click()
  else await s.sw.evaluate(async (url) => {
    // The tab by its address: the 2.5 sites sit on hosts of their own, not on the stand's.
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url)
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" })
  }, s.page.url())
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
  await go(s, ARTICLE_2)
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
  await go(s, ARTICLE_2)
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

// A few earlier chats (two of them tagged), for the chat list with search and tags.
function history() {
  const now = Date.now()
  const ru = lang === "ru"
  const page = (url, title) => ({ url, title })
  const q = (content, p, extra = {}) => ({ role: "user", content, page: p, ...extra })
  const a = (content) => ({ role: "assistant", content })
  const t = (id, ago, m, extra = {}) => ({ id, u: now - ago, a: now - ago, m, ...extra })
  const p1 = page(ru ? "https://delovoyobzor.ru/four-day-week" : "https://weeklyreview.com/four-day-week", ru ? "Почему четырёхдневка работает — и когда нет" : "Why the four-day week works — and when it doesn't")
  const p2 = page(ru ? "https://tehrynok.ru/four-day-week" : "https://techledger.com/four-day-week", ru ? "Японские компании тестируют четырёхдневку" : "Japan's tech firms test the four-day week")
  return ru
    ? {
        a1: t("a1", 6e5, [q("Кратко", p1, { label: "Кратко" }), a("**Коротко:** 61 компания сократила неделю на 20%; выгорание упало, выручка не изменилась."), q("Как это сравнить с японским пилотом?", p2), a("В обоих случаях вывод один: сначала меньше встреч, потом короче неделя.")], { title: "Исследование: четырёхдневка", tags: ["Работа"], pin: 0 }),
        a2: t("a2", 9e6, [q("Кофе после 16:00 мешает сну?", page("https://health.example/coffee", "Кофе и сон")), a("Период полувыведения кофеина — около 5 часов, так что кофе в 16:00 может сдвинуть сон.")], { tags: ["Здоровье"] }),
        a3: t("a3", 2e7, [q("Какой свет поглощает хлорофилл?", page("https://edu.example/lecture-3", "Лекция 3: как растения получают пищу")), a("Красный и синий, а зелёный отражает — поэтому листья зелёные.")], { tags: ["Учёба"] }),
        a4: t("a4", 9e7, [q("Что такое пилотный проект?", page("https://pm.example/pilot", "Пилоты в продукте")), a("Небольшой запуск на ограниченной группе, чтобы проверить гипотезу до полного запуска.")], { tags: ["Работа"] }),
        a5: t("a5", 2e8, [q("Рецепт быстрого ужина?", page("https://food.example/pasta", "Паста за 15 минут")), a("Сварите пасту, добавьте чеснок, масло и перец чили.")])
      }
    : {
        a1: t("a1", 6e5, [q("Summarize", p1, { label: "Summarize" }), a("**In short:** 61 companies cut hours by 20%; burnout fell and revenue held."), q("How does this compare with the Japan pilot?", p2), a("Both point the same way: fewer meetings first, then a shorter week.")], { title: "Research: four-day week", tags: ["Work"], pin: 0 }),
        a2: t("a2", 9e6, [q("Does coffee after 4 pm hurt sleep?", page("https://health.example/coffee", "Coffee and sleep")), a("Caffeine has a half-life of about 5 hours, so a 4 pm coffee can delay sleep.")], { tags: ["Health"] }),
        a3: t("a3", 2e7, [q("What light does chlorophyll absorb?", page("https://edu.example/lecture-3", "Lecture 3: How plants make food")), a("Red and blue; it reflects green, which is why leaves look green.")], { tags: ["Study"] }),
        a4: t("a4", 9e7, [q("What is a pilot project?", page("https://pm.example/pilot", "Pilots in product work")), a("A small launch with a limited group, to test an idea before the full rollout.")], { tags: ["Work"] }),
        a5: t("a5", 2e8, [q("Recipe for a quick dinner?", page("https://food.example/pasta", "Pasta in 15 minutes")), a("Boil pasta, add garlic, olive oil and chili.")])
      }
}

// Selects a sentence (touch) or the quote (mouse) and types a question into the field under the buttons.
// The value is set without focusing the field, so the selection stays highlighted as it is while typing starts.
async function selAsk(s) {
  await fresh(s)
  if (s.d.touch) await touchSelect(s)
  else {
    await s.page.evaluate(() => { document.querySelector("blockquote").scrollIntoView({ block: "start" }); window.scrollBy(0, -260) })
    const box = await s.page.locator("blockquote").boundingBox()
    await s.page.mouse.move(box.x + 4, box.y + 6); await s.page.mouse.down()
    await s.page.mouse.move(box.x + box.width - 6, box.y + box.height - 10, { steps: 10 }); await s.page.mouse.up()
    await s.page.locator(".cf-bubble").waitFor(); await s.page.waitForTimeout(300)
  }
  await s.page.evaluate(shadow(`(r) => { const i = r.querySelector(".cf-bubble-ask input"); i.value = ${JSON.stringify(L.selQuestion)}; i.dispatchEvent(new Event("input", { bubbles: true })) }`))
  await s.page.waitForTimeout(400)
}

// The chat list: search field, tag folders, earlier chats.
async function chatList(s, query = "") {
  await fresh(s, { threads: history() }); await open(s)
  await s.page.locator(".cf-chats-button").click()
  await s.page.waitForTimeout(600)
  if (query) {
    await s.page.locator(".cf-search input").fill(query)
    await s.page.waitForTimeout(900)
  }
}

// Pro: a question about the lecture video on the page, answered from its transcript.
async function video(s) {
  await fresh(s, { url: `${BASE}/${lang === "ru" ? "lecture-ru" : "lecture"}` })
  // The video at the top of what the panel leaves in view.
  if (s.d.touch && s.d.viewport.width < 600) await s.page.evaluate(() => { document.body.style.paddingBottom = "900px"; document.querySelector("figure").scrollIntoView({ block: "start" }); window.scrollBy(0, -16) })
  await open(s)
  await s.page.waitForTimeout(800)
  await s.page.locator(".cf-input textarea").fill(L.lecture)
  if (s.d.touch) await s.page.locator(".cf-send").click(); else await s.page.keyboard.press("Enter")
  await waitAnswer(s)
}

// A question about a page, typed and sent, answered.
async function askAbout(s, url, question) {
  await fresh(s, { url }); await open(s)
  await s.page.locator(".cf-input textarea").fill(question)
  if (s.d.touch) await s.page.locator(".cf-send").click(); else await s.page.keyboard.press("Enter")
  await waitAnswer(s)
}

// Shopping: a spec sentence selected on the product page, a question typed under the selection buttons.
async function shopSelect(s) {
  await fresh(s, { url: PRODUCT })
  await touchSelect(s, 1)
  await s.page.evaluate(shadow(`(r) => { const i = r.querySelector(".cf-bubble-ask input"); i.value = ${JSON.stringify(L.shopSel)}; i.dispatchEvent(new Event("input", { bubbles: true })) }`))
  await s.page.waitForTimeout(400)
}

// Pro: a question about the report embedded in an investor page. Safari's panel gets a PDF's text from the
// app (PdfText.swift); Chromium has no app, so the service worker answers that one native call itself.
const REPORT_TEXT = {
  en: { title: "Q3 report", text: "Northwind. Q3 report. Third quarter, results for shareholders. Revenue $48.2M, +12% year over year. Subscribers 1.9M, +18% year over year. Gross margin 61%, +2 points. Monthly churn 2.1%, down from 2.6%. Highlights: revenue grew 12% on subscription growth in Europe and North America; monthly churn fell to 2.1% after the new onboarding; full-year revenue guidance raised to $186–190M. Customers: subscribers reached 1.9M, up 18%; churn fell from 2.6% to 2.1%; gross margin rose 2 points to 61%. Outlook and risks: guidance raised to $186–190M; cloud costs rose 9%, faster than revenue; hiring stays flat until margins pass 62%." },
  ru: { title: "Отчёт за III квартал", text: "Норвинд. Отчёт за III квартал. Третий квартал, результаты для акционеров. Выручка 3,9 млрд ₽, +12% к прошлому году. Подписчики 1,9 млн, +18%. Валовая маржа 61%, +2 п. п. Отток в месяц 2,1%, было 2,6%. Главное: выручка выросла на 12% за счёт подписок; отток снизился до 2,1% после нового онбординга; прогноз выручки на год повышен до 15–15,4 млрд ₽. Клиенты: подписчиков 1,9 млн; отток снизился с 2,6% до 2,1%; маржа выросла до 61%. Прогноз и риски: прогноз повышен до 15–15,4 млрд ₽; расходы на облако выросли на 9%, быстрее выручки; найм не растёт, пока маржа не превысит 62%." }
}
async function pdf(s) {
  await fresh(s, { url: REPORT })
  // The report's first page at the top of what the panel leaves in view.
  if (s.d.touch && s.d.viewport.width < 600) await s.page.evaluate(() => { document.body.style.paddingBottom = "900px"; document.querySelector(".doc").scrollIntoView({ block: "start" }); window.scrollBy(0, -16) })
  await open(s)
  await s.sw.evaluate((doc) => {
    globalThis.browser = { runtime: { sendNativeMessage: async (_id, msg) => msg?.command === "pdfText" ? { success: true, data: { ok: true, text: doc.text, pages: 3, title: doc.title } } : null } }
  }, REPORT_TEXT[lang === "ru" ? "ru" : "en"])
  await s.page.locator(".cf-input textarea").fill(L.pdf)
  if (s.d.touch) await s.page.locator(".cf-send").click(); else await s.page.keyboard.press("Enter")
  await waitAnswer(s)
}

// ------------------------------------------------------------------ 2.5

// A finger on iPhone and iPad (the panel tells taps from clicks), the mouse on a Mac.
async function press(s, locator) {
  if (!s.d.touch) return locator.click()
  const b = await locator.boundingBox()
  await s.page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
}

/** Quick insert's lists: two templates (one with blanks the page fills) and, with `copied`, two things copied elsewhere. */
function insertData(copied) {
  const now = Date.now()
  const ru = lang === "ru"
  const templates = ru
    ? {
        t1: { id: "t1", title: "Подтвердить созвон", keywords: ["созвон"], text: "Здравствуйте, {имя}! {дата} в {время} мне подходит, созвонимся.", createdAt: now - 9e6, updatedAt: now - 9e6 },
        t2: { id: "t2", title: "Спасибо за заказ", keywords: ["заказ"], text: "Спасибо за заказ! Отправим в течение двух дней, трек-номер придёт на почту.", createdAt: now - 8e6, updatedAt: now - 8e6 }
      }
    : {
        t1: { id: "t1", title: "Confirm the call", keywords: ["call"], text: "Hi {name}, {date} at {time} works for me. Talk then!", createdAt: now - 9e6, updatedAt: now - 9e6 },
        t2: { id: "t2", title: "Thanks for the order", keywords: ["order"], text: "Thanks for your order! It ships within 2 days, and the tracking number comes by email.", createdAt: now - 8e6, updatedAt: now - 8e6 }
      }
  const items = ru
    ? [{ id: "k1", text: "Трек-номер PX-7741-2093", host: "parcelly.studio", at: now - 6e5, from: "page" }, { id: "k2", text: "Москва, ул. Лесная, 12, кв. 4", host: "contacts.sevveter.studio", at: now - 2e6, from: "page" }]
    : [{ id: "k1", text: "Tracking number PX-7741-2093", host: "parcelly.studio", at: now - 6e5, from: "page" }, { id: "k2", text: "12 Linden Street, Apt 4, Boston, MA 02118", host: "contacts.northwind.studio", at: now - 2e6, from: "page" }]
  return { "cf:templates": templates, ...(copied ? { "cf:copied": items } : {}) }
}

// The reply box of the mail page, the button by it, its list open.
async function insertMenu(s, copied) {
  await fresh(s, { url: INBOX, extra: insertData(copied) })
  await s.page.evaluate((top) => {
    document.body.style.paddingBottom = "900px"
    const r = document.getElementById("reply")
    // Copied on iPhone: the box at the top with a little room above it (the store page's plaques sit there, not
    // over the letter). Elsewhere the box in the middle, the letter above it in view.
    r.scrollIntoView({ block: top ? "start" : "center" })
    window.scrollBy(0, top ? -12 : 60)
  }, copied && s.d.touch && s.d.viewport.width < 600)
  await s.page.waitForTimeout(300)
  await press(s, s.page.locator("#reply"))
  if (s.d.touch) {
    await s.page.locator(".cf-qi-btn").waitFor()
    await s.page.waitForTimeout(400)
    await press(s, s.page.locator(".cf-qi-btn"))
  } else {
    // A Mac has no button by the field: ⌃⇧V (the manifest's quick_insert command) opens the list at the caret.
    // Headless Chromium doesn't fire extension shortcuts, so the background's own message for it is sent.
    await s.page.waitForTimeout(300)
    await s.sw.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url)
      await chrome.tabs.sendMessage(tab.id, { type: "quickInsert" })
    }, s.page.url())
  }
  await s.page.locator(".cf-qi-row").first().waitFor()
  await s.page.waitForTimeout(600)
}

// Templates that fill themselves: "Confirm the call", Fill from the page: the name and the date from the open
// conversation, marked yellow, and "Rewrite for this chat" under them.
async function fill(s) {
  await insertMenu(s, false)
  await press(s, s.page.locator(".cf-qi-row", { hasText: L.callTpl }).first())
  const button = s.page.locator(".cf-qi-fill button", { hasText: msg("qiFillFromPage") })
  await button.waitFor()
  await s.page.waitForTimeout(400)
  await press(s, button)
  await s.page.locator(".cf-qi-blank.filled").first().waitFor({ timeout: 15000 })
  // The first blank keeps the focus on a Mac (an outline instead of its yellow): every value shows as filled.
  await s.page.evaluate(shadow(`(r) => r.activeElement?.blur()`))
  await s.page.waitForTimeout(700)
}

// Page watch: the price selected, the eye, Watch; then the check that found the new price, as the background
// records it (the stand's page doesn't change on its own), the page showing it, and the panel's Watching list.
async function watch(s) {
  await fresh(s, { url: SHOP })
  await s.page.evaluate(() => document.getElementById("price").scrollIntoView({ block: "center" }))
  await s.page.waitForTimeout(300)
  if (s.d.touch) await s.page.evaluate(() => getSelection().selectAllChildren(document.getElementById("price")))
  else {
    const b = await s.page.locator("#price").boundingBox()
    await s.page.mouse.move(b.x + 1, b.y + b.height / 2); await s.page.mouse.down()
    await s.page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 }); await s.page.mouse.up()
  }
  const eye = s.page.locator(".cf-sel-watch").first()
  await eye.waitFor()
  await s.page.waitForTimeout(300)
  await press(s, eye)
  const start = s.page.locator(".cf-watch .cf-sheet-actions .cf-primary")
  await start.waitFor()
  await s.page.waitForTimeout(500)
  await press(s, start)
  await s.page.locator(".cf-watch-ok").waitFor({ timeout: 20000 })
  await s.page.waitForTimeout(400)
  // The stand's scripted AI names what's watched in English; the real one answers in the person's language.
  await s.sw.evaluate(async ([now, label]) => {
    const list = (await chrome.storage.local.get("cf:watches"))["cf:watches"]
    const w = list[list.length - 1]
    const before = Date.now() - 12 * 60e3
    Object.assign(w, { label, createdAt: before - 3 * 864e5, checkedAt: Date.now() - 4 * 60e3, checks: 31, metAt: Date.now() - 4 * 60e3, metValue: now })
    await chrome.storage.local.set({ "cf:watches": list })
  }, [lang === "ru" ? "10 990 ₽" : "$99", msg("watchLabelPrice")])
  await go(s, SHOP)
  // The page as the check found it: the new price, the old one struck through.
  await s.page.evaluate(([now, was]) => {
    document.getElementById("price").textContent = now
    document.querySelector(".old").textContent = was
  }, lang === "ru" ? ["10 990 ₽", "12 990 ₽"] : ["$99", "$129"])
  await open(s)
  await openMenuItem(s, msg("uxWatchingN", "1"))
  await s.page.locator(".cf-later-row").first().waitFor()
  await s.page.waitForTimeout(600)
}

// The page's own "…" menu in the panel's header, then one of its items.
async function openMenuItem(s, text) {
  await press(s, s.page.locator(".cf-page-more").first())
  const item = s.page.locator(".cf-page-menu button", { hasText: text }).first()
  await item.waitFor()
  await s.page.waitForTimeout(300)
  await press(s, item)
}

// Remind me about this page: … → the times to pick from.
async function remind(s) {
  await fresh(s, { threads: chat25() })
  await open(s)
  await openMenuItem(s, msg("uxLater"))
  await s.page.locator(".cf-sheet .cf-sheet-row", { hasText: msg("uxRemindMorning") }).first().waitFor()
  await s.page.waitForTimeout(600)
}

/** One chat on the first article: a long answer, a note, a few more turns; `pins`: the messages pinned. */
function chat25({ pins = [] } = {}) {
  const now = Date.now()
  const ru = lang === "ru"
  const p1 = { url: ARTICLE, title: ru ? "Почему четырёхдневка работает — и когда нет" : "Why the four-day week works — and when it doesn't" }
  const m = ru
    ? [
        { role: "user", content: "Кратко", label: "Кратко", page: p1 },
        { role: "assistant", content: "**Коротко:** 61 компания сократила неделю на 20%, и через год 56 из них остались на четырёх днях.\n\nВыручка не изменилась, а выгорание снизилось на 71%. Помогли три привычки: меньше встреч, защищённые блоки для работы и ясные приоритеты на неделю.\n\nХуже всего пришлось командам с поддержкой клиентов: им пришлось чередовать выходные." },
        { role: "user", content: "Проверить цифры по выгоранию в отчёте", note: true, page: p1 },
        { role: "user", content: "Что помогло командам больше всего?", page: p1 },
        { role: "assistant", content: "Сокращение встреч: команды, которые урезали их вдвое в первый месяц, выиграли больше всех." },
        { role: "user", content: "Стоит ли пробовать в стартапе?", page: p1 },
        { role: "assistant", content: "Для команды из 10 человек — да: чередуйте выходной и запустите **пилот на 3 месяца**." }
      ]
    : [
        { role: "user", content: "Summarize", label: "Summarize", page: p1 },
        { role: "assistant", content: "**In short:** 61 companies cut the week by 20%, and a year later 56 of them stayed on four days.\n\nRevenue held steady while burnout fell by 71%. Three habits made it work: fewer meetings, protected focus blocks and clear priorities for the week.\n\nCustomer support teams had it hardest: they had to rotate the day off." },
        { role: "user", content: "Check the burnout numbers in the report", note: true, page: p1 },
        { role: "user", content: "What helped the teams most?", page: p1 },
        { role: "assistant", content: "Cutting meetings: the teams that halved them in the first month gained the most." },
        { role: "user", content: "Is this worth trying for a startup?", page: p1 },
        { role: "assistant", content: "For a 10-person team, yes: rotate the day off and run a **3-month pilot**." }
      ]
  const at = now - 20 * 60e3
  m.forEach((e, i) => {
    e.id = `c${i}`
    e.t = at + i * 60e3
    if (pins.includes(i)) e.pinned = at + i * 60e3 + 1000
  })
  return { c1: { id: "c1", u: now - 60e3, a: now - 60e3, m, title: ru ? "Исследование четырёхдневки" : "Four-day week research" } }
}

// Pins and highlights: two answers pinned (the bar at the top), two lines of the long answer highlighted by hand.
async function pins(s) {
  await fresh(s, { threads: chat25({ pins: [1, 6] }) })
  await open(s)
  await s.page.evaluate(shadow(`(r) => { const l = r.querySelector(".cf-messages"); l.scrollTop = 0 }`))
  await s.page.waitForTimeout(400)
  for (const [from, until] of L.marks) {
    const at = await s.page.evaluate(shadow(`(r) => {
      const md = r.querySelectorAll(".cf-msg.ai .md")[0]
      const walk = document.createTreeWalker(md, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walk.nextNode()) && !node.data.includes(${JSON.stringify(from)}));
      const s = node.data.indexOf(${JSON.stringify(from)})
      const range = document.createRange()
      range.setStart(node, s)
      range.setEnd(node, node.data.indexOf(${JSON.stringify(until)}, s))
      const rects = [...range.getClientRects()]
      const a = rects[0], b = rects[rects.length - 1]
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }
    }`))
    await s.page.mouse.move(at.x1, at.y1)
    await s.page.mouse.down()
    await s.page.mouse.move(at.x2, at.y2, { steps: 12 })
    await s.page.mouse.up()
    const mark = s.page.locator(".cf-float button").first()
    await mark.waitFor()
    await s.page.waitForTimeout(300)
    await mark.click()
    await s.page.waitForTimeout(500)
  }
  await s.page.evaluate(() => getSelection().removeAllRanges())
  // The long answer at the top, both highlights in view, the pinned bar above it.
  await s.page.evaluate(shadow(`(r) => { const l = r.querySelector(".cf-messages"); const a = r.querySelectorAll(".cf-msg.ai")[0]; l.scrollTop = a.offsetTop - l.offsetTop - 70 }`))
  await s.page.waitForTimeout(700)
}

// Organizing (Pro): two chats; the shown one ends with a block that belongs in the other: the suggestion under it.
function organizeChats() {
  const now = Date.now()
  const H = 3_600_000
  const ru = lang === "ru"
  const turn = (role, content, url, title, at, extra = {}) => ({ role, content, id: Math.random().toString(36).slice(2, 14), t: at, ...(url ? { page: { url, title, at } } : {}), ...extra })
  const japan = ru ? "Поездка в Японию" : "Trip to Japan"
  const bread = ru ? "Банановый хлеб" : "Banana bread"
  const A = { id: "chat-japan", u: now - 30 * H, a: now - 30 * H, title: japan, m: ru
    ? [turn("user", "Какие храмы в Киото посмотреть в Токио-поездке?", ARTICLE_2, "Киото за два дня", now - 50 * H), turn("assistant", "Кинкаку-дзи, Фусими Инари и Киёмидзу-дэра — по утрам, пока мало людей.", null, null, now - 50 * H + 5000),
       turn("user", "Окупится ли JR Pass для поездки Токио — Киото?", ARTICLE_2, "JR Pass в 2026", now - 30 * H), turn("assistant", "Для поездки Токио — Киото туда и обратно — да, если добавить хотя бы одну поездку.", null, null, now - 30 * H + 5000)]
    : [turn("user", "Which Kyoto temples to see on the Tokyo trip?", ARTICLE_2, "Kyoto in two days", now - 50 * H), turn("assistant", "Kinkaku-ji, Fushimi Inari and Kiyomizu-dera, early in the morning before the crowds.", null, null, now - 50 * H + 5000),
       turn("user", "Is the JR Pass worth it for a Tokyo to Kyoto trip?", ARTICLE_2, "JR Pass in 2026", now - 30 * H), turn("assistant", "For a Tokyo to Kyoto round trip, yes, if you add at least one more ride.", null, null, now - 30 * H + 5000)] }
  const B = { id: "chat-bread", u: now - 60e3, a: now - 60e3, title: bread, m: ru
    ? [turn("user", "Сколько бананов на одну форму хлеба?", ARTICLE, "Банановый хлеб", now - 3 * H), turn("assistant", "Три очень спелых банана на форму 22 см.", null, null, now - 3 * H + 5000),
       turn("user", "Перелёты в Токио в марте: когда покупать билеты для поездки?", ARTICLE_2, "Перелёты в Токио", now - 2 * 60e3), turn("assistant", "Для поездки в Токио в марте билеты лучше брать за 2–3 месяца: в сезон сакуры цены растут.", null, null, now - 2 * 60e3 + 5000)]
    : [turn("user", "How many bananas for one loaf of banana bread?", ARTICLE, "Banana bread", now - 3 * H), turn("assistant", "Three very ripe bananas for a 9-inch loaf pan.", null, null, now - 3 * H + 5000),
       turn("user", "Flights to Tokyo in March: when to book for the trip?", ARTICLE_2, "Flights to Tokyo", now - 2 * 60e3), turn("assistant", "For a Tokyo trip in March, book 2–3 months ahead: prices climb in cherry blossom season.", null, null, now - 2 * 60e3 + 5000)] }
  return { [B.id]: B, [A.id]: A }
}
const ORGANIZE_ON = { "cf:settings": { organize: true }, "cf:orgCards": { consent: "accepted", thirdTag: true, mess: { chats: [], at: 0, closed: true }, firstWin: true } }

async function organize(s) {
  await fresh(s, { url: ARTICLE_2, threads: organizeChats(), extra: ORGANIZE_ON })
  await open(s)
  await s.page.locator(".cf-org-chip.move .cf-org-take").first().waitFor({ timeout: 20000 })
  await s.page.evaluate(shadow(`(r) => { const l = r.querySelector(".cf-messages"); l.scrollTop = l.scrollHeight }`))
  await s.page.waitForTimeout(700)
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
  if (process.env.SET === "pro") {
    try { await video(s) } catch (e) { await shot(s, `${k}-video-fail`); throw e }
    await shot(s, `${k}-video`); await rect(s, `${k}-video`, [".cf-panel", ".cf-used"])
    await s.ctx.close()
    continue
  }
  // Custom product page «Shopping»: is it worth buying, what the reviews say, a spec selected (stand on the free plan).
  if (process.env.SET === "shop") {
    await askAbout(s, PRODUCT, L.shopAsk); await shot(s, `${k}-shop-ask`); await rect(s, `${k}-shop-ask`, [".cf-panel"])
    await askAbout(s, PRODUCT, L.shopReviews); await shot(s, `${k}-shop-reviews`); await rect(s, `${k}-shop-reviews`, [".cf-panel", ".md-table"])
    if (s.d.touch) { await shopSelect(s); await shot(s, `${k}-shop-select`); await rect(s, `${k}-shop-select`, [".cf-bubble"]) }
    await s.ctx.close()
    continue
  }
  // Custom product page «Videos and PDFs»: the PDF shot (stand with PREVIEW_PLAN=pro).
  if (process.env.SET === "pdf") {
    try { await pdf(s) } catch (e) { await shot(s, `${k}-pdf-fail`); throw e }
    await shot(s, `${k}-pdf`); await rect(s, `${k}-pdf`, [".cf-panel", ".cf-used"])
    await s.ctx.close()
    continue
  }
  if (process.env.SET === "selask") {
    await selAsk(s); await shot(s, `${k}-selask`); await rect(s, `${k}-selask`, [".cf-bubble"])
    await s.ctx.close()
    continue
  }
  if (process.env.SET === "explore") {
    await selAsk(s); await shot(s, `${k}-selask`); await rect(s, `${k}-selask`, [".cf-bubble"])
    await chatList(s); await shot(s, `${k}-list`); await rect(s, `${k}-list`, [".cf-panel"])
    await chatList(s, L.search); await shot(s, `${k}-search`); await rect(s, `${k}-search`, [".cf-panel"])
    await s.ctx.close()
    continue
  }
  // Only the own-question state (the product page tests reuse every other capture).
  if (process.env.SET === "ask") {
    await ask(s); await shot(s, `${k}-ask`); await rect(s, `${k}-ask`, [".cf-panel"])
    await s.ctx.close()
    continue
  }
  // The 2.5 Pro shots (stand with PREVIEW_PLAN=pro): organizing's suggestion, the lecture video.
  if (process.env.SET === "pro25") {
    for (const [name, run, sels] of [["organize", organize, [".cf-panel", ".cf-org"]], ["video", video, [".cf-panel", ".cf-used"]],
      // Fill on the Pro stand: a free fill adds "N fills left today", and the store page names no limits.
      ["fill", fill, [".cf-qi", ".cf-qi-fill-text", ".cf-qi-fill-row"]]]) {
      try { await run(s) } catch (e) { await shot(s, `${k}-${name}-fail`); throw e }
      await shot(s, `${k}-${name}`); await rect(s, `${k}-${name}`, sels)
    }
    await s.ctx.close()
    continue
  }
  // The 2.5 product page (free stand). Each scene: its capture and the rectangles of what the call-outs magnify.
  const scenes = [
    ["summary", async () => { await fresh(s); await open(s); await chip(s, L.summarize); await waitAnswer(s) }, [".cf-panel"]],
    ["watch", () => watch(s), [".cf-panel", ".cf-later-list", ".cf-later-text"]],
    ["copied", () => insertMenu(s, true), [".cf-qi", ".cf-qi-btn"]],
    ["remind", () => remind(s), [".cf-panel", ".cf-sheet"]],
    ["selask", () => selAsk(s), [".cf-bubble"]],
    ["pins", () => pins(s), [".cf-panel", ".cf-pinbar", ".cf-msg.ai"]],
    ["notes", () => notes(s), [".cf-panel", ".cf-bubble-note", ".cf-input"]]
  ]
  for (const [name, run, sels] of scenes) {
    if (process.env.SCENES && !process.env.SCENES.split(",").includes(name)) continue
    try { await run() } catch (e) { await shot(s, `${k}-${name}-fail`); throw e }
    await shot(s, `${k}-${name}`); await rect(s, `${k}-${name}`, sels)
  }
  await s.ctx.close()
}
console.log("captured →", outDir)
