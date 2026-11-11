// Records real ContextFlow UI on iPhone for the clips in the app's Tips tab (one take per tip).
// Needs: tools/preview/server.mts on :8787 (STREAM_DELAY_MS=22 gives a readable streaming pace)
// and a Safari build pointing at it: CF_API_BASE=http://localhost:8787 CF_OPEN_SHADOW=1 node scripts/build-extension.mjs --out=<dir>
//   node tools/store/tips-record.mjs <extensionDir> <outDir> [lang] [takes]
// The Pro takes (aisearch, history, pdf, organize, suggested-tags) need the stand with PREVIEW_PLAN=pro and a build
// pointing at it:
//   CF_STAND=http://localhost:8788 node tools/store/tips-record.mjs <proBuild> <outDir> en aisearch,history,pdf,organize,suggested-tags
// The 2.6 takes: similar, listen and chips need the stand with PREVIEW_PLAN=ultra (Find similar's fixed list, a tone
// for Listen); yearly needs it without a plan (Free: Listen opens the plans sheet), the build pointing at that stand.
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
// The 2.5 sites under names of their own (*.example resolves to the stand), so Copied and the list's footer show a
// site rather than localhost.
const site = (host, path) => `${BASE.replace("localhost", host)}/${ru ? `${path}-ru` : path}`
const INBOX = site("mail.example", "inbox")
const ORDER = site("parcelly.example", "order")
const PRODUCT = site("soundhouse.example", "product")
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
      pdf: "Что в отчёте про выручку?",
      settings: "Настройки", morning: "Завтра утром", fill: "Заполнить со страницы", insert: "Вставить", open: "Открыть",
      remindNote: "Попробовать фокус-блоки в команде",
      watchNote: "Купить до поездки, если подешевеют"
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
      pdf: "What does the report say about revenue?",
      settings: "Settings", morning: "Tomorrow morning", fill: "Fill from the page", insert: "Insert", open: "Open",
      remindNote: "Try focus blocks with the team",
      watchNote: "Buy before the trip if they drop"
    }

// macOS Chromium ignores --lang: a copy of the build with only the wanted locale shows the UI in it (English too: a
// Chromium whose AppleLanguages another script set to Russian would show the Russian panel).
function localizedExtension() {
  if (process.platform !== "darwin") return extDir
  const dir = join(tmpdir(), `cf-tips-${lang}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(extDir, dir, { recursive: true })
  for (const l of readdirSync(join(dir, "_locales"))) if (l !== lang) rmSync(join(dir, "_locales", l), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, default_locale: lang }, null, 2))
  return dir
}
// The build's own words (aria labels the takes look for), in the take's language.
const messages = JSON.parse(readFileSync(join(extDir, "_locales", ru ? "ru" : "en", "messages.json"), "utf8"))
const msg = (key) => messages[key].message
const LINUX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const ext = localizedExtension()
const ctx = await chromium.launchPersistentContext("", {
  headless: true,
  ...(existsSync(LINUX_CHROME) ? { executablePath: LINUX_CHROME } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${lang}`, "--force-device-scale-factor=3", "--host-resolver-rules=MAP *.example 127.0.0.1"],
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

/** A fresh first session on `url` (nothing recorded yet): no chats, tour and hints seen, consent (2.4's) given.
 * `extra` adds storage (templates, Copied, settings…); `entitlement`: the app's answer about the plan and its prices. */
async function fresh(url, threads = null, extra = {}, entitlement = null) {
  // The previous take's panel must not see (and write back over) the reset storage.
  await page.goto("about:blank")
  await fetch(`${BASE}/reset`)
  await sw.evaluate(async ({ threads, extra, entitlement }) => {
    // Chromium has no Safari app behind the extension: its answers stand in (a reminder is scheduled,
    // notifications are allowed, the PDF is read by PdfText.swift).
    globalThis.browser = { runtime: { sendNativeMessage: async (_id, msg) => {
      if (msg.command === "remind") return { success: true, data: { outcome: "scheduled" } }
      if (msg.command === "watch_permission") return { success: true, data: { outcome: "ok" } }
      if (msg.command === "notifStatus") return { success: true, data: { status: "authorized" } }
      if (msg.command === "pdfText") return { success: true, data: { ok: true, pages: 3, title: "Q3 report", text: "Northwind Q3 report. Revenue rose 12% to $48.2M; subscriptions $31.5M (+18%), services $16.7M." } }
      if (msg.command === "getEntitlement" && entitlement) return { success: true, data: entitlement }
      return { success: false }
    } } }
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      // The one AI consent (2.5 (78): version 3) given.
      "cf:consent": 3, "cf:tourSeen": true, "cf:noteHint": -1, "cf:selHint": -1, "cf:hintsSeen": ["chats", "video", "pdf"],
      // 2.5's first-time tips (the eye, the bell, the button by a field) are for real first times, not the clips.
      "cf:watchTips": { eye: true, later: true }, "cf:selIconsTip": true, "cf:insertTipSeen": true,
      // Organizing's cards for Free ("Everything in one chat?", after the third tag) have their own clips.
      "cf:orgCards": { thirdTag: true, mess: { chats: [], at: 0, closed: true } },
      ...extra
    })
    if (threads) await chrome.storage.local.set({ "cf:threads": threads, "cf:activeThread": { id: Object.keys(threads)[0], at: Date.now() } })
  }, { threads, extra, entitlement })
  await go(url)
}

/** Free, with the App Store's prices as the app shares them (2.6: the list prices in USD, the ones in
 * ContextFlow.storekit and the Ultra migration; perMonth, save and percent as StoreKitManager.deal works them out). */
const FREE_WITH_PRICES = {
  active: false, productId: null, expiresAt: null, jws: null,
  prices: {
    "com.contextflow.byok.monthly": "$1.99", "com.contextflow.byok.yearly": "$16.99",
    "com.contextflow.byok.yearly#perMonth": "$1.42", "com.contextflow.byok.yearly#save": "$6.89", "com.contextflow.byok.yearly#percent": "29",
    "com.contextflow.pro.monthly": "$6.99", "com.contextflow.pro.yearly": "$59.99",
    "com.contextflow.pro.yearly#perMonth": "$5.00", "com.contextflow.pro.yearly#save": "$23.89", "com.contextflow.pro.yearly#percent": "28",
    "com.contextflow.ultra.monthly": "$12.99", "com.contextflow.ultra.yearly": "$119.99",
    "com.contextflow.ultra.yearly#perMonth": "$10.00", "com.contextflow.ultra.yearly#save": "$35.89", "com.contextflow.ultra.yearly#percent": "23"
  }
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
/** One chat on the first article: a long answer to highlight, a note, a few more turns (`pins`: which to pin). */
// `url`: the page's address in the chat (the share take's text shows it: a site's, not the stand's).
function chat({ pins = [], url = PAGE_1 } = {}) {
  const now = Date.now()
  const p1 = { url, title: ru ? "Почему четырёхдневка работает — и когда нет" : "Why the four-day week works — and when it doesn't" }
  const m = ru
    ? [
        { role: "user", content: "Кратко", label: "Кратко", page: p1 },
        { role: "assistant", content: "**Коротко:** 61 компания сократила неделю на 20%, и через год 56 из них остались на четырёх днях.\n\nВыручка не изменилась, а выгорание снизилось на 71%. Помогли три привычки: меньше встреч, защищённые блоки для работы и ясные приоритеты на неделю.\n\nХуже всего пришлось командам с поддержкой клиентов: им пришлось чередовать выходные." },
        { role: "user", content: "Проверить цифры по выгоранию в отчёте", note: true, page: p1 },
        { role: "user", content: "Что помогло командам больше всего?", page: p1 },
        { role: "assistant", content: "Сокращение встреч: команды, которые урезали их вдвое в первый месяц, выиграли больше всех." },
        { role: "user", content: "А что с клиентами?", page: p1 },
        { role: "assistant", content: "Жалоб не прибавилось: компании держали дежурного в пятницу и отвечали в тот же день." },
        { role: "user", content: "Стоит ли пробовать в стартапе?", page: p1 },
        { role: "assistant", content: "Для команды из 10 человек — да: чередуйте выходной и запустите **пилот на 3 месяца**." }
      ]
    : [
        { role: "user", content: "Summarize", label: "Summarize", page: p1 },
        { role: "assistant", content: "**In short:** 61 companies cut the week by 20%, and a year later 56 of them stayed on four days.\n\nRevenue held steady while burnout fell by 71%. Three habits made it work: fewer meetings, protected focus blocks and clear priorities for the week.\n\nCustomer support teams had it hardest: they had to rotate the day off." },
        { role: "user", content: "Check the burnout numbers in the report", note: true, page: p1 },
        { role: "user", content: "What helped the teams most?", page: p1 },
        { role: "assistant", content: "Cutting meetings: the teams that halved them in the first month gained the most." },
        { role: "user", content: "What about customers?", page: p1 },
        { role: "assistant", content: "Complaints didn't go up: firms kept someone on call on Fridays and answered the same day." },
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

/** Organizing (Pro): two chats; the shown one ends with a block that belongs in the other. The stand's vectors come from
 * shared words, so the block and the trip's chat share theirs (build 98's move needs a 75% match), and the trip's chat
 * has two pages (a chat of one page block needs 0.65, more than word vectors give). */
function organizeChats() {
  const now = Date.now()
  const H = 3_600_000
  const turn = (role, content, url, title, at, extra = {}) => ({ role, content, id: Math.random().toString(36).slice(2, 14), t: at, ...(url ? { page: { url, title, at } } : {}), ...extra })
  const japan = ru ? "Поездка в Японию" : "Trip to Japan"
  const bread = ru ? "Банановый хлеб" : "Banana bread"
  const A = { id: "chat-japan", u: now - 30 * H, a: now - 30 * H, title: japan, m: ru
    ? [turn("user", "Храмы Киото для поездки в Японию в марте: какие посмотреть?", "https://travel.example/kyoto", "Киото за два дня", now - 50 * H), turn("assistant", "Для поездки в Японию в марте: Кинкаку-дзи и Фусими Инари в Киото, с утра — в сезон сакуры людей больше.", null, null, now - 50 * H + 5000),
       turn("user", "JR Pass для поездки в Японию в марте: окупится из Токио?", "https://rail.example/jr-pass", "JR Pass в 2026", now - 30 * H), turn("assistant", "Для поездки в Японию в марте, Токио — Киото и обратно, да: окупится, если добавить ещё одну поездку.", null, null, now - 30 * H + 5000)]
    : [turn("user", "Kyoto temples for the Japan trip in March: which to see?", "https://travel.example/kyoto", "Kyoto in two days", now - 50 * H), turn("assistant", "For the Japan trip in March, see Kinkaku-ji and Fushimi Inari in Kyoto early: crowds climb in cherry blossom season.", null, null, now - 50 * H + 5000),
       turn("user", "JR Pass for the Japan trip in March: worth it from Tokyo?", "https://rail.example/jr-pass", "JR Pass in 2026", now - 30 * H), turn("assistant", "For the Japan trip in March, Tokyo to Kyoto and back, yes: it pays off with one more ride.", null, null, now - 30 * H + 5000)] }
  const B = { id: "chat-bread", u: now - 60e3, a: now - 60e3, title: bread, m: ru
    ? [turn("user", "Сколько бананов на одну форму хлеба?", `${BASE}/article-ru`, "Банановый хлеб", now - 3 * H), turn("assistant", "Три очень спелых банана на форму 22 см.", null, null, now - 3 * H + 5000),
       turn("user", "Перелёты в Токио для поездки в Японию в марте: когда покупать?", `${BASE}/article-2-ru`, "Перелёты в Токио", now - 2 * 60e3), turn("assistant", "Для поездки в Японию в марте билеты в Токио лучше брать за 2–3 месяца: в сезон сакуры цены растут.", null, null, now - 2 * 60e3 + 5000)]
    : [turn("user", "How many bananas for one loaf of banana bread?", `${BASE}/article`, "Banana bread", now - 3 * H), turn("assistant", "Three very ripe bananas for a 9-inch loaf pan.", null, null, now - 3 * H + 5000),
       turn("user", "Flights to Tokyo for the Japan trip in March: when to book?", `${BASE}/article-2`, "Flights to Tokyo", now - 2 * 60e3), turn("assistant", "For the Japan trip in March, book Tokyo flights 2–3 months ahead: prices climb in cherry blossom season.", null, null, now - 2 * 60e3 + 5000)] }
  return { [B.id]: B, [A.id]: A }
}
/** Suggested tags (Pro): two chats you tagged Work, and the shown one about the same kind of thing, untagged. */
function tagChats() {
  const now = Date.now()
  const H = 3_600_000
  const turn = (role, content, at, extra = {}) => ({ role, content, id: Math.random().toString(36).slice(2, 14), t: at, ...(role === "user" ? { page: { url: `${BASE}/article-2${ru ? "-ru" : ""}`, title: ru ? "Спринт без авралов" : "Sprints without crunch", at } } : {}), ...extra })
  const work = ru ? "Работа" : "Work"
  const w = { tags: [work] }
  const chats = ru
    ? [
        { id: "chat-release", u: now - 60e3, a: now - 60e3, title: "План релиза", m: [
          turn("user", "Обзор спринта в четверг: перенести релиз на пятницу?", now - 2 * 60e3), turn("assistant", "Да, перенесите релиз на пятницу: обзор спринта в четверг, а тестированию нужен день.", now - 2 * 60e3 + 5000)] },
        { id: "chat-standup", u: now - 20 * H, a: now - 20 * H, title: "Стендапы", tags: [work], m: [
          turn("user", "Кто на стендапе перед релизом рассказывает про тестирование?", now - 20 * H), turn("assistant", "На стендапе перед релизом ведущий тестирования говорит, что осталось до обзора спринта.", now - 20 * H + 5000, w)] },
        { id: "chat-retro", u: now - 40 * H, a: now - 40 * H, title: "Ретро спринта", tags: [work], m: [
          turn("user", "Что исправить, если релиз съехал на пятницу?", now - 40 * H), turn("assistant", "Начинайте тестирование раньше в спринте, чтобы релиз не переносили после обзора спринта.", now - 40 * H + 5000, w)] },
        { id: "chat-bread", u: now - 60 * H, a: now - 60 * H, title: "Банановый хлеб", m: [
          turn("user", "Сколько бананов на одну форму хлеба?", now - 60 * H), turn("assistant", "Три очень спелых банана на форму 22 см.", now - 60 * H + 5000)] }
      ]
    : [
        { id: "chat-release", u: now - 60e3, a: now - 60e3, title: "Release plan", m: [
          turn("user", "Sprint review is Thursday: move the release to Friday?", now - 2 * 60e3), turn("assistant", "Yes, move the release to Friday: the sprint review is on Thursday and testing needs a day.", now - 2 * 60e3 + 5000)] },
        { id: "chat-standup", u: now - 20 * H, a: now - 20 * H, title: "Standups", tags: [work], m: [
          turn("user", "Who reports on testing at the standup before the release?", now - 20 * H), turn("assistant", "At the standup before the release, the testing lead says what is left for the sprint review.", now - 20 * H + 5000, w)] },
        { id: "chat-retro", u: now - 40 * H, a: now - 40 * H, title: "Sprint retro", tags: [work], m: [
          turn("user", "What to fix when the release slipped to Friday?", now - 40 * H), turn("assistant", "Start testing earlier in the sprint, so the release isn't moved after the sprint review.", now - 40 * H + 5000, w)] },
        { id: "chat-bread", u: now - 60 * H, a: now - 60 * H, title: "Banana bread", m: [
          turn("user", "How many bananas for one loaf of banana bread?", now - 60 * H), turn("assistant", "Three very ripe bananas for a 9-inch loaf pan.", now - 60 * H + 5000)] }
      ]
  return Object.fromEntries(chats.map((c) => [c.id, c]))
}
const ORGANIZE_ON = { "cf:settings": { organize: true }, "cf:orgCards": { consent: "accepted", thirdTag: true, mess: { chats: [], at: 0, closed: true }, firstWin: true } }

/** Quick insert's lists: two templates (one with blanks the page fills), two things copied, ContextFlow's answer. */
function insertData(copied = true) {
  const now = Date.now()
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
    ? [{ id: "k1", text: "Москва, ул. Лесная, 12, кв. 4", host: "maps.example", at: now - 6e5, from: "page" }, { id: "k2", text: "Северный ветер, ИНН 7701234567", host: "docs.example", at: now - 2e6, from: "page" }]
    : [{ id: "k1", text: "12 Linden Street, Apt 4, Boston, MA 02118", host: "maps.example", at: now - 6e5, from: "page" }, { id: "k2", text: "Northwind Studio, VAT GB 123 4567 89", host: "docs.example", at: now - 2e6, from: "page" }]
  return { "cf:templates": templates, ...(copied ? { "cf:copied": items } : {}) }
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
// The same with a finger (pointer events of type touch), where the panel tells taps from clicks.
async function touch(locator) {
  const b = await locator.boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  mark("tap", { x, y })
  await wait(220)
  await page.touchscreen.tap(x, y)
}
/** A sideways swipe on a message (dx > 0 to the right), slow enough to read. */
async function swipeX(locator, dx) {
  const b = await locator.boundingBox()
  const x = dx > 0 ? b.x + 48 : b.x + b.width - 48
  const y = b.y + Math.min(b.height / 2, 28)
  mark("swipe", { x, y, dx, dy: 0 })
  await wait(160)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  const steps = 14
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y }] })
    await wait(24)
  }
  await wait(60)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}
/** A finger along the selection field's chips (dx < 0 pulls the next ones in), as the carousel scrolls under it. */
async function swipeChips(field, dx) {
  const b = await field.boundingBox()
  const x = dx < 0 ? b.x + b.width - 30 : b.x + 30
  const y = b.y + b.height / 2
  mark("swipe", { x, y, dx, dy: 0 })
  await wait(160)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  const steps = 16
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y }] })
    await wait(22)
  }
  await wait(40)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}
/** A finger up a sheet (dy < 0), slow enough to read: it scrolls under the finger. */
async function swipeSheet(locator, dy) {
  const b = await locator.boundingBox()
  const x = b.x + b.width / 2
  const y = Math.min(b.y + b.height / 2, 700)
  mark("swipe", { x, y, dx: 0, dy })
  await wait(160)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  const steps = 18
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] })
    await wait(24)
  }
  await wait(120)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}
/** Swipes the field's chips until `chip` is wholly in sight at its end (at least `least` px, so it reads as a swipe). */
async function bringChip(field, chip, least = 0) {
  const box = await field.boundingBox()
  const c = await chip.boundingBox()
  const over = c.x + c.width - (box.x + box.width - 6)
  if (over <= 0 && !least) return
  await swipeChips(field, -Math.max(least, over + 24))
  await wait(900)
}
const inRoot = (js) => page.evaluate(shadow(js))
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
    // 2.5: the selection's bubble, "Ask AI" in it (it can cover ✦).
    const ask = page.locator(".cf-bubble .cf-bubble-row button.primary")
    await ask.waitFor()
    await wait(700)
    await tapClears()
    await touch(ask)
    await page.locator(".cf-panel.in").waitFor()
    await wait(650)
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
    await tap(page.locator(".cf-thread:not(.current):not(.cf-ask-history) .cf-thread-main").first())
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
    // Chromium has no Safari app extension to read the PDF (PdfText.swift): fresh() stands in for its answer.
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
    await tap(page.locator(`.cf-msg.ai .cf-msg-tools button[aria-label="${L.tagButton}"]`).last())
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
    await tap(page.locator(".cf-page-more"))
    await wait(450)
    await tap(page.locator(".cf-page-menu button", { hasText: L.settings }))
    await wait(500)
    const field = page.locator(".cf-settings textarea").first()
    await field.scrollIntoViewIfNeeded()
    await wait(400)
    await tap(field); await type(L.about)
    await wait(1200)
  },

  // Share what you found (2.5 (81), the owner: no clip yet): the chat's share button picks every message, the note
  // is left out, Copy; in a mail reply the text comes as it is, with the page's link and ContextFlow's.
  async share() {
    await fresh(PAGE_1, chat({ url: ru ? "https://delovoy-obzor.example/chetyrekhdnevka" : "https://weekly-review.example/four-day-week" }), { "cf:settings": { insertButton: false } })
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE })
    await openPanel(false)
    await record("share")
    await wait(600)
    await touch(page.locator(`.cf-icon[aria-label="${msg("shareChat")}"]`))
    await page.locator(".cf-pickbar").waitFor()
    await wait(1000)
    await touch(page.locator(".cf-msg.note.picked").first())
    await wait(800)
    await touch(page.locator(".cf-pickbar .cf-secondary"))
    await wait(900)
    const text = await page.evaluate(() => navigator.clipboard.readText())
    await go(INBOX)
    await page.evaluate(() => document.getElementById("reply").scrollIntoView({ block: "center" }))
    await wait(500)
    await touch(page.locator("#reply"))
    await wait(400)
    await page.evaluate((t) => document.execCommand("insertText", false, t), text)
    await page.evaluate(() => { const r = document.getElementById("reply"); r.style.height = "250px"; r.scrollTop = 0 })
    await wait(1300)
    // Down to its end: the pages it was about, with their links, and ContextFlow's.
    for (let i = 1; i <= 14; i++) {
      await page.evaluate((f) => { const r = document.getElementById("reply"); r.scrollTop = (r.scrollHeight - r.clientHeight) * f }, i / 14)
      await wait(70)
    }
    await wait(2000)
  },
  // The ✦ button, your way (2.5 (81), the owner: "the round button can be moved up and down if it covers something"):
  // the site's own chat pill sits under ✦; a drag up uncovers it, and ✦ stays where it was left.
  async button() {
    await fresh(PAGE_1)
    const fab = page.locator(".cf-fab")
    const b = await fab.boundingBox()
    // A site's corner widget where ✦ sits (a help chat, as on many shops): ✦ covers its end.
    await page.evaluate(({ y, label }) => {
      const pill = document.createElement("a")
      pill.href = "#"
      pill.textContent = label
      pill.setAttribute("style", `position:fixed;right:12px;top:${y - 22}px;height:44px;padding:0 18px;display:flex;align-items:center;gap:8px;border-radius:22px;background:#111827;color:#fff;font:600 15px -apple-system,system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000`)
      document.body.appendChild(pill)
    }, { y: b.y + b.height / 2, label: ru ? "💬 Чат с поддержкой" : "💬 Chat with support" })
    await record("button")
    await wait(1300)
    const x = b.x + b.width / 2, y = b.y + b.height / 2, dy = -230
    mark("swipe", { x, y, dx: 0, dy })
    await wait(160)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    const steps = 22
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] })
      await wait(30)
    }
    await wait(80)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await wait(2000)
  },

  // ------------------------------------------------------------------ 2.5

  // Insert into any field: a tap on the reply field, the button by it, a template from the list.
  async insert() {
    await fresh(INBOX, null, insertData())
    await page.evaluate(() => document.getElementById("reply").scrollIntoView({ block: "center" }))
    await wait(300)
    await record("insert")
    await touch(page.locator("#reply"))
    const button = page.locator(".cf-qi-btn")
    await button.waitFor()
    await wait(500)
    await touch(button)
    await page.locator(".cf-qi-row").first().waitFor()
    await wait(1100)
    await touch(page.locator(".cf-qi-row", { hasText: ru ? "Спасибо за заказ" : "Thanks for the order" }).first())
    await wait(1500)
  },
  // Templates that fill themselves: the template with blanks, Fill from the page, the yellow values, Insert.
  async fill() {
    await fresh(INBOX, null, insertData(false))
    await page.evaluate(() => document.getElementById("reply").scrollIntoView({ block: "center" }))
    await wait(300)
    await page.locator("#reply").tap()
    await page.locator(".cf-qi-btn").waitFor()
    await wait(300)
    await record("fill")
    await touch(page.locator(".cf-qi-btn"))
    await page.locator(".cf-qi-row").first().waitFor()
    await wait(600)
    await touch(page.locator(".cf-qi-row", { hasText: ru ? "Подтвердить созвон" : "Confirm the call" }).first())
    const fill = page.locator(".cf-qi-fill button", { hasText: L.fill })
    await fill.waitFor()
    await wait(600)
    await touch(fill)
    await page.locator(".cf-qi-blank.filled").first().waitFor({ timeout: 15000 })
    await wait(1200)
    await touch(page.locator(".cf-qi-fill button", { hasText: new RegExp(`^${L.insert}$`) }).first())
    await wait(1400)
  },
  // Copied, kept for a day: Copy on an order page, then the number waits in the list on another site.
  async copied() {
    await fresh(ORDER, null, insertData(false))
    await record("copied")
    await wait(200)
    await touch(page.locator("#copy"))
    await wait(900)
    await page.goto(INBOX)
    await page.waitForSelector("contextflow-root", { state: "attached" })
    await page.evaluate(() => document.getElementById("reply").scrollIntoView({ block: "center" }))
    await wait(500)
    await touch(page.locator("#reply"))
    await page.locator(".cf-qi-btn").waitFor()
    await wait(300)
    await touch(page.locator(".cf-qi-btn"))
    const row = page.locator(".cf-qi-row", { hasText: "PX-7741-2093" }).first()
    await row.waitFor()
    await wait(900)
    await touch(row)
    await wait(1400)
  },
  // Page watch: the price selected, the eye, its window with the condition and a note of your own (2.6 (97): shown with
  // the watch and in its notification), Watch.
  async watch() {
    await fresh(PRODUCT)
    await page.locator("#price").scrollIntoViewIfNeeded()
    await wait(300)
    await record("watch")
    await page.evaluate(() => getSelection().selectAllChildren(document.getElementById("price")))
    const eye = page.locator(".cf-sel-watch")
    await eye.waitFor()
    await wait(800)
    await tapClears()
    await touch(eye)
    const go = page.locator(".cf-watch .cf-sheet-actions .cf-primary")
    await go.waitFor()
    await wait(900)
    await tap(page.locator(".cf-watch .cf-note-words")); await type(L.watchNote)
    await wait(500)
    await touch(go)
    await page.locator(".cf-watch-ok").waitFor({ timeout: 20000 })
    await wait(1500)
  },
  // Remind me (2.6 (97)): a line selected, the bell, the window with the line as a quote and a note of your own,
  // Tomorrow morning; ✦ shows the note in the chat, under its quote, with the reminder's time.
  async later() {
    await fresh(PAGE_1)
    await page.evaluate(() => document.querySelectorAll("main p")[4].scrollIntoView({ block: "center" }))
    await wait(400)
    await record("later")
    const bubble = page.locator(".cf-bubble")
    await selectText(4, "^", ":", false)
    const bell = bubble.locator(".cf-sel-remind")
    await bell.waitFor()
    await wait(800)
    await tapClears()
    await touch(bell)
    const words = page.locator(".cf-sheet .cf-note-words")
    await words.waitFor()
    await wait(700)
    await tap(words); await type(L.remindNote)
    await wait(400)
    const row = page.locator(".cf-sheet .cf-sheet-row", { hasText: L.morning }).first()
    await touch(row)
    await page.locator(".cf-sheet").waitFor({ state: "detached", timeout: 8000 }).catch(() => undefined)
    await wait(900)
    await openPanel()
    await inRoot(`(r) => { const l = r.querySelector(".cf-messages"); if (l) l.scrollTop = l.scrollHeight }`)
    await wait(1900)
  },
  // Highlights: a line of an answer selected, Highlight, a yellow mark.
  async highlight() {
    await fresh(PAGE_1, chat())
    await openPanel(false)
    // The long answer in view.
    await inRoot(`(r) => r.querySelectorAll(".cf-msg.ai")[0].scrollIntoView({ block: "start" })`)
    await wait(400)
    await record("highlight")
    for (const [from, until] of ru ? [["Выручка", ","]] : [["Revenue held", " while"]]) {
      // Selected by a drag, as a finger would: a selection set by script inside the panel's root reads as the
      // page's own in Chromium.
      const at = await inRoot(`(r) => {
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
      }`)
      await page.mouse.move(at.x1, at.y1)
      await page.mouse.down()
      await page.mouse.move(at.x2, at.y2, { steps: 12 })
      await page.mouse.up()
      const mark = page.locator(".cf-float button")
      await mark.waitFor()
      await wait(700)
      await touch(mark)
      await wait(900)
    }
    await wait(700)
  },
  // Pinned: the bar at the top; a tap goes to the pinned answer, another to the one before.
  async pinned() {
    await fresh(PAGE_1, chat({ pins: [1, 4] }))
    await openPanel(false)
    await inRoot(`(r) => { const l = r.querySelector(".cf-messages"); l.scrollTop = l.scrollHeight }`)
    await wait(500)
    await record("pinned")
    await wait(500)
    await touch(page.locator(".cf-pinbar-main"))
    await wait(1300)
    await touch(page.locator(".cf-pinbar-main"))
    await wait(1600)
  },
  // Swipes: an answer to the right (pinned), a note to the left (deleted), Undo.
  async swipes() {
    await fresh(PAGE_1, chat())
    await openPanel(false)
    await inRoot(`(r) => r.querySelectorAll(".cf-msg")[2].scrollIntoView({ block: "center" })`)
    await wait(400)
    await record("swipes")
    const answer = page.locator(".cf-msg.ai .cf-swipe").nth(1)
    await swipeX(answer, 300)
    await wait(1200)
    const note = page.locator(".cf-msg.note .cf-swipe").first()
    await swipeX(note, -320)
    const undo = page.locator(".cf-undo-bar button").first()
    await undo.waitFor()
    await wait(900)
    await touch(undo)
    await wait(1400)
  },
  // Organizing (Pro): the Suggestions bar at the top of the chat (2.6 (97)); a tap on it brings the suggestion under the
  // answer it's about, a tap there moves the block, Open shows it in its chat.
  async organize() {
    await fresh(PAGE_2, organizeChats(), ORGANIZE_ON)
    await openPanel(false)
    const move = page.locator(".cf-org-chip.move .cf-org-take")
    await move.waitFor({ timeout: 15000 })
    // From the top of the chat, where the bar is (the suggestion is under the last answer, out of sight).
    await inRoot(`(r) => { const l = r.querySelector(".cf-messages"); if (l) l.scrollTop = 0 }`)
    await wait(500)
    await record("organize")
    const bar = page.locator(".cf-sugbar-main")
    await bar.waitFor({ timeout: 15000 })
    await wait(1200)
    await touch(bar)
    await wait(1300)
    await touch(move)
    const open = page.locator(".cf-undo-bar button", { hasText: L.open })
    await open.waitFor()
    await wait(900)
    await touch(open)
    await wait(1800)
  },
  // Suggested tags (Pro): your own tag offered under a new answer; a tap makes it a tag.
  async "suggested-tags"() {
    await fresh(PAGE_2, tagChats(), ORGANIZE_ON)
    // The first pass (vectors, the tag check) takes a while; the clip opens the panel on the next one.
    await openPanel(false)
    const tag = page.locator(".cf-org-chip:not(.move) .cf-org-take").last()
    await tag.waitFor({ timeout: 40000 })
    await go(PAGE_2)
    await openPanel(false)
    await record("suggested-tags")
    await tag.waitFor({ timeout: 15000 })
    await wait(1100)
    await touch(tag)
    await wait(1000)
    await touch(page.locator(".cf-chats-button"))
    await wait(1700)
  },

  // ------------------------------------------------------------------ 2.6

  // Quick actions in the selection's field (iPhone and iPad): a phrase selected, the chips after "Your question…"
  // (they nudge in by themselves), a swipe pulls the rest in, a tap on Explain simply answers about the selection.
  async chips() {
    await fresh(PAGE_1)
    await page.evaluate(() => document.querySelectorAll("main p")[3].scrollIntoView({ block: "center" }))
    await wait(400)
    await record("chips")
    const bubble = page.locator(".cf-bubble")
    await selectText(3, "^", ":", false)
    await bubble.waitFor()
    const field = bubble.locator(".cf-ask-field.chips")
    await field.waitFor()
    await wait(1900) // the chips' own nudge
    const explain = bubble.locator(".cf-sel-chip", { hasText: msg("actExplain") }).first()
    await bringChip(field, explain, 150)
    await bringChip(field, explain)
    await tapClears()
    await touch(explain)
    await page.locator(".cf-panel.in").waitFor()
    await answers(1); await wait(1600)
  },
  // Find similar (Ultra) from a selection: the product's name selected, Find similar in the field's chips, the card
  // with its conditions, Cheaper, Find; the checked list streams in (the stand's fixed one for the Aero 2).
  async similar() {
    await fresh(PRODUCT)
    await page.evaluate(() => document.querySelector("h1").scrollIntoView({ block: "center" }))
    await wait(300)
    await record("similar")
    await wait(200)
    await page.evaluate(() => getSelection().selectAllChildren(document.querySelector("h1")))
    const bubble = page.locator(".cf-bubble")
    await bubble.waitFor()
    const field = bubble.locator(".cf-ask-field.chips")
    await field.waitFor()
    await wait(1600) // past the chips' nudge
    const chip = bubble.locator(".cf-sel-chip.ultra")
    // In sight at the field's end, as a swipe would bring it.
    await bringChip(field, chip)
    await bringChip(field, chip)
    await tapClears()
    await touch(chip)
    const card = page.locator(".cf-similar-pick")
    await card.waitFor()
    await wait(900)
    await touch(card.locator(".cf-chip", { hasText: msg("similarCheaper") }).first())
    await wait(600)
    await touch(card.locator(".cf-primary"))
    await page.locator(".cf-similar-item").first().waitFor({ timeout: 15000 })
    await page.waitForFunction(shadow(`(r) => r && !r.querySelector(".cf-send.stop") && r.querySelectorAll(".cf-similar-item").length >= 4`), null, { timeout: 20000 })
    // The list from its top: the checked, cheaper ones first.
    await inRoot(`(r) => {
      const list = r.querySelector(".cf-messages")
      const asked = [...r.querySelectorAll(".cf-msg.user")].at(-1)
      list.scrollTo({ top: list.scrollTop + asked.getBoundingClientRect().top - list.getBoundingClientRect().top - 8, behavior: "smooth" })
    }`)
    await wait(2200)
  },
  // Listen (Ultra): Listen under an answer, the player over the question field, its speed tapped to 1.2× and 1.5×;
  // heard to its end, Listen gets its tick (2.6 (94–98): already voiced, hearing it again costs no minutes). On iPhone
  // and iPad it plays in the panel when notifications are on (they are here: the app's answer), as on a Mac.
  async listen() {
    await fresh(PAGE_1, chat(), { "cf:notifyOn": true })
    await openPanel(false)
    // A short answer, heard to its end within the clip.
    await inRoot(`(r) => r.querySelectorAll(".cf-msg.ai")[1].scrollIntoView({ block: "center" })`)
    await wait(400)
    await record("listen")
    await wait(500)
    const listen = page.locator(".cf-msg.ai .cf-listen-btn").nth(1)
    await touch(listen)
    await page.locator(".cf-listen .cf-listen-time").waitFor({ timeout: 15000 })
    await wait(1200)
    const speed = page.locator(".cf-listen-speed")
    await touch(speed)
    await wait(800)
    await touch(speed)
    await listen.locator(".cf-voiced").waitFor({ timeout: 20000 })
    await wait(2200)
  },
  // Monthly or yearly (any plan; recorded on Free): Listen without Ultra opens the plans, Yearly first with what
  // each plan saves; Monthly, then Yearly again.
  async yearly() {
    await fresh(PAGE_1, chat(), {}, FREE_WITH_PRICES)
    await openPanel(false)
    await inRoot(`(r) => r.querySelectorAll(".cf-msg.ai")[0].scrollIntoView({ block: "start" })`)
    await wait(400)
    await record("yearly")
    await wait(400)
    await touch(page.locator(".cf-msg.ai .cf-listen-btn").first())
    const sheet = page.locator(".cf-plans")
    await sheet.waitFor()
    await page.locator(".cf-plans .cf-plan-save").first().waitFor()
    await wait(1500)
    const [monthly, yearly] = [0, 1].map((i) => page.locator(".cf-plans-period button").nth(i))
    await touch(monthly)
    await wait(1500)
    await touch(yearly)
    await wait(1300)
    // Up the sheet to Pro and Ultra, the plans the card is about (Ultra comes last, under Own key and Pro).
    const ultra = await page.locator(".cf-plan-card.ultra").boundingBox()
    await swipeSheet(page.locator(".cf-plans .cf-plan-card.pro"), -Math.max(120, Math.min(360, ultra.y + ultra.height - 780)))
    await wait(2200)
  }
}

for (const [name, run] of Object.entries(takes)) {
  if (only && !only.split(",").includes(name)) continue
  try { await run() } catch (e) { await page.screenshot({ path: join(outDir, `${name}-fail.png`) }); throw e }
  await end()
}
await ctx.close()
