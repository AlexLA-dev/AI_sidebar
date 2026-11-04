import assert from "node:assert/strict"
import { test } from "node:test"

import { detectWatchable } from "../src/shared/watch/detect.ts"

const all = (what: string, list: string[]) => {
  for (const s of list) assert.equal(detectWatchable(s), what, s)
}

test("prices in the shops' own formats", () => {
  all("price", [
    "$129.00", "$ 39", "US$ 1,299.99", "Now $89.00", "€ 249,00", "209,95 €", "49.99€", "£12", "¥34,500", "34,500 円",
    "69,800円", "199元", "¥199", "29,000원", "₩29,000", "1 299 ₽", "1299 руб.", "799 грн", "R$ 1.299,90", "CHF 49.90",
    "120 EUR", "USD 15", "от 29 990 ₽", "à partir de 19,99 €", "ab 120 €"
  ])
})

test("stock in 11 languages", () => {
  all("stock", [
    "In stock", "Out of stock", "Sold out", "Only 3 left", "Coming soon",
    "В наличии", "Нет в наличии", "Осталось 2",
    "В наявності", "Немає в наявності",
    "Auf Lager", "Ausverkauft", "Derzeit nicht verfügbar", "Nur noch 1",
    "En stock", "Rupture de stock", "Épuisé",
    "Agotado", "Sin stock", "Quedan 4",
    "Disponibile", "Esaurito",
    "Em estoque", "Esgotado",
    "在庫あり", "在庫切れ", "売り切れ",
    "품절", "재고 있음",
    "有货", "缺货", "售罄"
  ])
})

test("dates in 11 languages", () => {
  all("date", [
    "2026-11-04", "04.11.2026", "4/11/26", "12 March", "March 12, 2026", "Dec 3",
    "4 ноября", "15 янв.", "4 листопада", "12. März", "3 décembre", "12 de marzo", "5 maggio", "20 de janeiro",
    "2026年11月", "11月4日", "11월 4일", "04.11", "4/11"
  ])
})

test("statuses, a few words at most", () => {
  all("status", [
    "Approved", "Case Was Received", "Shipped", "Registration open", "Tickets on sale",
    "На рассмотрении", "Отправлено", "Регистрация открыта",
    "Схвалено", "In Bearbeitung", "Zugestellt", "En attente", "Expédiée", "Pendiente", "Inscripciones abiertas",
    "In lavorazione", "Em trânsito", "発送済み", "배송 중", "已发货"
  ])
})

test("ordinary text keeps the bubble as it was", () => {
  for (const s of [
    "the quick brown fox", "Привет, как дела?", "This is a long sentence about something that is not a value at all",
    "19.99", "12.50", "42", "1/2", "Hello world", "ContextFlow", "Mayday", "Openness",
    "We are open to new ideas and the status quo is changing quickly in this market",
    "x".repeat(81)
  ]) {
    assert.equal(detectWatchable(s), null, s)
  }
})

test("a price wins over the words around it", () => {
  assert.equal(detectWatchable("In stock · $129"), "price")
  assert.equal(detectWatchable("Sold out — 49,99 €"), "price")
})

import { eyeFor } from "../src/shared/watch/detect.ts"

test("the eye on a date only with an event by it; on a status only by what it's the status of (the audit, 27)", () => {
  // A news page: the article's date, "shipped" in a story.
  assert.equal(eyeFor("3 November 2026", "By Anna Lee · 3 November 2026 · 4 min read"), null)
  assert.equal(eyeFor("12 December", "The meeting happened on 12 December at 10:00."), null)
  assert.equal(eyeFor("shipped", "The company shipped its first phone in 2007."), null)
  // Things worth watching.
  assert.equal(eyeFor("12 December", "Tickets go on sale 12 December at 10:00"), "date")
  assert.equal(eyeFor("15 января", "Регистрация открывается 15 января"), "date")
  assert.equal(eyeFor("04.11", "Запись до 04.11"), "date")
  assert.equal(eyeFor("12. März", "Anmeldung bis 12. März"), "date")
  assert.equal(eyeFor("3 November 2026", "", true), "date", "an Event in the page's markup")
  assert.equal(eyeFor("Shipped", "Order #1234 · Shipped"), "status")
  assert.equal(eyeFor("На рассмотрении", "Статус заявления: На рассмотрении"), "status")
  assert.equal(eyeFor("配送中", "注文番号 123 配送中"), "status")
  // Prices and stock as before.
  assert.equal(eyeFor("$1,299", "A story about a $1,299 laptop"), "price")
  assert.equal(eyeFor("Sold out", ""), "stock")
  assert.equal(eyeFor("the quick brown fox", "the quick brown fox jumps"), null)
})
