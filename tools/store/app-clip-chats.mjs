// Demo chats for the "Your chats in the app" clip: the app's chats.json (App Group Chats/), the same chats as
// the panel's Tips takes (tools/store/tips-record.mjs history()), with page texts so a question in the app has
// something to answer about.
//   node tools/store/app-clip-chats.mjs <en|ru> <out.json>
import { writeFileSync } from "node:fs"

const [lang, out] = process.argv.slice(2)
const ru = lang === "ru"
const now = Date.now()
const BASE = "http://localhost:8787"
const article = ru
  ? "Через год после того, как 61 компания сократила рабочую неделю до четырёх дней, результаты известны: выручка не изменилась, выгорание заметно снизилось, а большинство компаний не вернулись к пятидневке. Руководители называют три привычки: меньше встреч, защищённые блоки для работы и ясные приоритеты на неделю."
  : "A year after 61 companies cut the working week to four days, the results are in: revenue held steady, burnout fell sharply, and most firms never went back. Managers credit three habits: fewer meetings, protected focus blocks and clear priorities for the week."
const page = (url, title, at, text) => ({ url, title, hash: String(at), at, ...(text ? { text } : {}) })
const q = (content, p, extra = {}) => ({ role: "user", content, page: p, ...extra })
const a = (content, extra = {}) => ({ role: "assistant", content, ...extra })
const t = (ago, m, extra = {}) => ({ m, a: now - ago, ...extra })

const p1 = page(`${BASE}/${ru ? "article-ru" : "article"}`, ru ? "Почему четырёхдневка работает — и когда нет" : "Why the four-day week works — and when it doesn't", now - 2 * 3600e3, article)
const chats = ru
  ? {
      a1: t(2 * 3600e3, [q("Кратко", p1, { label: "Кратко" }), a("**Коротко:** 61 компания сократила неделю на 20%; выгорание упало, выручка не изменилась.", { tags: ["Работа"] }), q("Что помогло командам?", { ...p1, text: undefined }), a("Три привычки: **меньше встреч**, защищённые блоки для работы и ясные приоритеты на неделю.")], { title: "Исследование четырёхдневки" }),
      a2: t(9e6 * 3, [q("Кофе после 16:00 мешает сну?", page("https://health.example/coffee", "Кофе и сон", now - 27e6)), a("Период полувыведения кофеина — около 5 часов, так что кофе в 16:00 может сдвинуть сон.", { tags: ["Здоровье"] })]),
      a3: t(9e7, [q("Рецепт быстрого ужина?", page("https://food.example/pasta", "Паста за 15 минут", now - 9e7)), a("Сварите пасту, добавьте чеснок, масло и перец чили.")]),
      a4: t(2e8, [q("Что такое пилотный проект?", page("https://pm.example/pilot", "Пилоты в продукте", now - 2e8)), a("Небольшой запуск на ограниченной группе, чтобы проверить гипотезу до полного запуска.", { tags: ["Работа"] })])
    }
  : {
      a1: t(2 * 3600e3, [q("Summarize", p1, { label: "Summarize" }), a("**In short:** 61 companies cut hours by 20%; burnout fell and revenue held.", { tags: ["Work"] }), q("What helped the teams?", { ...p1, text: undefined }), a("Three habits: **fewer meetings**, protected focus blocks and clear priorities for the week.")], { title: "Four-day week research" }),
      a2: t(9e6 * 3, [q("Does coffee after 4 pm hurt sleep?", page("https://health.example/coffee", "Coffee and sleep", now - 27e6)), a("Caffeine has a half-life of about 5 hours, so a 4 pm coffee can delay sleep.", { tags: ["Health"] })]),
      a3: t(9e7, [q("Recipe for a quick dinner?", page("https://food.example/pasta", "Pasta in 15 minutes", now - 9e7)), a("Boil pasta, add garlic, olive oil and chili.")]),
      a4: t(2e8, [q("What is a pilot project?", page("https://pm.example/pilot", "Pilots in product work", now - 2e8)), a("A small launch with a limited group, to test an idea before the full rollout.", { tags: ["Work"] })])
    }
const file = {}
for (const [id, c] of Object.entries(chats)) {
  const m = c.m.map((e) => (e.page && e.page.text === undefined ? { ...e, page: Object.fromEntries(Object.entries(e.page).filter(([k]) => k !== "text")) } : e))
  file[id] = { updatedAt: Math.round(c.a), data: JSON.stringify({ m, a: Math.round(c.a), ...(c.title ? { title: c.title } : {}) }) }
}
writeFileSync(out, JSON.stringify(file))
console.log(`${Object.keys(file).length} chats (${lang}) → ${out}`)
