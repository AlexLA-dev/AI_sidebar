import assert from "node:assert/strict"
import { test } from "node:test"

import { addCopied, COPIED_SLOTS, COPIED_TTL_MS, liveCopied, siteExcluded } from "../src/shared/copied.ts"
import {
  applyTemplates,
  blanks,
  cleanTemplate,
  editTemplate,
  fillBlanks,
  makeTemplate,
  markBlanks,
  newer,
  noteUse,
  pendingTemplates,
  searchTemplates,
  textParts,
  titleFrom,
  tombstone,
  type Template
} from "../src/shared/templates.ts"

const NOW = 1_800_000_000_000

test("blanks: labels once, in order; parts; filling", () => {
  const text = "Здравствуйте, {Имя}! Встреча в {день}, {дата}. До встречи, {Имя}."
  assert.deepEqual(blanks(text), ["Имя", "день", "дата"])
  assert.deepEqual(textParts("Hi {Name}!"), [{ text: "Hi " }, { blank: "Name" }, { text: "!" }])
  assert.equal(fillBlanks(text, { Имя: "Анна", день: "пятницу" }), "Здравствуйте, Анна! Встреча в пятницу, . До встречи, Анна.")
  assert.deepEqual(blanks("no blanks {} or {\n}"), [])
})

test("markBlanks keeps the text exactly and marks every occurrence", () => {
  const text = "Здравствуйте, Анна! Напоминаю о встрече в четверг, 14 ноября, в 15:00. Анна, ссылка прежняя."
  const marked = markBlanks(text, [
    { label: "Имя", value: "Анна" },
    { label: "дата", value: "14 ноября" },
    { label: "время", value: "15:00" },
    { label: "missing", value: "не в тексте" }
  ])
  assert.equal(marked, "Здравствуйте, {Имя}! Напоминаю о встрече в четверг, {дата}, в {время}. {Имя}, ссылка прежняя.")
  assert.equal(fillBlanks(marked, { Имя: "Анна", дата: "14 ноября", время: "15:00" }), text)
  // A shorter value inside a longer one already marked stays inside it.
  assert.equal(markBlanks("Order 4471 shipped to 4471 Main St", [{ label: "street", value: "4471 Main St" }, { label: "order", value: "4471" }]), "Order {order} shipped to {street}")
})

test("titles from the first words", () => {
  assert.equal(titleFrom("Здравствуйте, {Имя}! Напоминаю о встрече в четверг"), "Здравствуйте, Имя! Напоминаю о встрече")
  assert.equal(titleFrom("   "), "…")
})

const tpl = (id: string, title: string, text: string, extra: Partial<Template> = {}): Template => ({ ...makeTemplate({ text, title }, NOW - 1000, id), ...extra })

test("search: every word starts a word; title over keywords over text; site first", () => {
  const list = [
    tpl("a", "Перенос встречи", "Можно перенести на {день}?", { keywords: ["созвон"] }),
    tpl("b", "Wi-Fi", "Сеть Loft_5G, пароль на холодильнике"),
    tpl("c", "Как заселиться", "Здравствуйте, {Имя}! Заселение с 15:00", { site: "airbnb.ru" }),
    tpl("d", "Удалённый", "встреча", { deleted: true })
  ]
  const ctx = { host: "airbnb.ru", use: {}, now: NOW }
  assert.deepEqual(searchTemplates(list, "перен встр", ctx).map((t) => t.id), ["a"])
  assert.deepEqual(searchTemplates(list, "созв", ctx).map((t) => t.id), ["a"])
  assert.deepEqual(searchTemplates(list, "пароль", ctx).map((t) => t.id), ["b"])
  assert.deepEqual(searchTemplates(list, "встреч", ctx).map((t) => t.id), ["a"])
  assert.deepEqual(searchTemplates(list, "ёлка", ctx), [])
  // Nothing typed: the site's own template first, then what was used here.
  const use = noteUse(noteUse({}, "b", "airbnb.ru", NOW), "b", "airbnb.ru", NOW)
  assert.deepEqual(searchTemplates(list, "", { ...ctx, use }).map((t) => t.id), ["c", "b", "a"])
  assert.equal(searchTemplates(list, "wi fi", ctx)[0]?.id, "b")
})

test("sync: newest copy wins per template, a tombstone wins a tie, pending until confirmed", () => {
  const a1 = tpl("a", "A", "one", { updatedAt: NOW - 50 })
  const a2 = editTemplate(a1, { text: "two" }, NOW - 10)
  assert.equal(newer(a1, a2), a2)
  const dead = { ...tombstone(a1, NOW - 50), updatedAt: a1.updatedAt }
  assert.equal(newer(a1, dead), dead)

  const local = { a: a2, b: tpl("b", "B", "bee") }
  const synced = { a: a1.updatedAt }
  assert.deepEqual(pendingTemplates(local, synced).map((t) => t.id).sort(), ["a", "b"])
  // The app returns the merged set: another device deleted b later; a is ours.
  const remote = [a2, { ...tombstone(local.b, NOW), updatedAt: NOW }, { id: "bad" }]
  const res = applyTemplates(local, synced, remote, NOW)
  assert.equal(res.changed, true)
  assert.equal(res.templates.b.deleted, true)
  assert.equal(res.templates.a.text, "two")
  assert.deepEqual(pendingTemplates(res.templates, res.synced), [])
  // An older remote copy doesn't replace a newer local one.
  const older = applyTemplates({ a: a2 }, {}, [a1], NOW)
  assert.equal(older.templates.a.text, "two")
  assert.equal(older.changed, false)
})

test("cleanTemplate rejects what isn't a template", () => {
  assert.equal(cleanTemplate(null), null)
  assert.equal(cleanTemplate({ id: "x y", updatedAt: 1, text: "a" }), null)
  assert.equal(cleanTemplate({ id: "x", updatedAt: 1, text: "  " }), null)
  assert.deepEqual(cleanTemplate({ id: "x", updatedAt: 5, deleted: true, text: "secret" }), { id: "x", title: "", text: "", keywords: [], createdAt: 5, updatedAt: 5, deleted: true })
  const t = cleanTemplate({ id: "x", updatedAt: 5, text: "Hi {Name}", keywords: ["a", "A", 3, "b"] })
  assert.equal(t?.title, "Hi Name")
  assert.deepEqual(t?.keywords, ["a", "b"])
})

test("copied: five slots, a day, the same text moves up, exclusions by site", () => {
  let list = addCopied([], { text: "one", host: "a.com", at: NOW - COPIED_TTL_MS - 1, from: "page" }, NOW - COPIED_TTL_MS - 1)
  list = addCopied(list, { text: "two", host: "a.com", at: NOW - 10, from: "page" }, NOW)
  assert.deepEqual(liveCopied(list, NOW).map((c) => c.text), ["two"])
  for (const t of ["3", "4", "5", "6", "7"]) list = addCopied(list, { text: t, host: "a.com", at: NOW, from: "page" }, NOW)
  assert.equal(list.length, COPIED_SLOTS)
  list = addCopied(list, { text: " 4 ", host: "b.com", at: NOW + 1, from: "page" }, NOW + 1)
  assert.equal(list[0].text, "4")
  assert.equal(list.filter((c) => c.text === "4").length, 1)
  assert.equal(siteExcluded("www.mail.bank.com", ["bank.com"]), true)
  assert.equal(siteExcluded("notbank.com", ["bank.com"]), false)
})

test("one-time codes are never kept in Copied (the audit, 20)", async () => {
  const { oneTimeCode } = await import("../src/shared/copied.ts")
  for (const s of ["482913", "4829", "48291374", "482 913", "482-913", " 1234 "]) assert.equal(oneTimeCode(s), true, s)
  for (const s of ["123", "123456789", "Order 482913", "+7 495 123-45-67", "12.50", "2026-11-04"]) assert.equal(oneTimeCode(s), false, s)
})
