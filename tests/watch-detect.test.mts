import assert from "node:assert/strict"
import { test } from "node:test"

import { detectWatchable, eyeFor, firstValue, lastValue, priceAround } from "../src/shared/watch/detect.ts"

const all = (what: string, list: string[]) => {
  for (const s of list) assert.equal(detectWatchable(s), what, s)
}

test("prices in the shops' own formats", () => {
  all("price", [
    "$129.00", "$ 39", "US$ 1,299.99", "Now $89.00", "€ 249,00", "209,95 €", "49.99€", "£12", "¥34,500", "34,500 円",
    "69,800円", "199元", "¥199", "29,000원", "₩29,000", "1 299 ₽", "1299 руб.", "799 грн", "R$ 1.299,90", "CHF 49.90",
    "120 EUR", "USD 15", "от 29 990 ₽", "à partir de 19,99 €", "ab 120 €",
    // Taiwan, Vietnam, the Gulf and Egypt (2.6)
    "NT$1,299", "1,299 元", "299.000₫", "299.000đ", "1.299.000 VNĐ", "99 ر.س", "ر.س 99", "149 درهم", "SAR 99", "12.500 د.ك", "350 ج.م"
  ])
})

test("stock in 14 languages", () => {
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
    "有货", "缺货", "售罄",
    "有貨", "缺貨", "已售完", "現貨",
    "متوفر", "غير متوفر", "نفدت الكمية",
    "Còn hàng", "Hết hàng", "Chỉ còn 3"
  ])
})

test("dates in 14 languages", () => {
  all("date", [
    "2026-11-04", "04.11.2026", "4/11/26", "12 March", "March 12, 2026", "Dec 3",
    "4 ноября", "15 янв.", "4 листопада", "12. März", "3 décembre", "12 de marzo", "5 maggio", "20 de janeiro",
    "2026年11月", "11月4日", "11월 4일", "04.11", "4/11",
    "12 مارس", "4 نوفمبر 2026", "5 أيار", "4 tháng 11 năm 2026", "ngày 4 tháng 11", "12 tháng 3"
  ])
})

test("statuses, a few words at most", () => {
  all("status", [
    "Approved", "Case Was Received", "Shipped", "Registration open", "Tickets on sale",
    "На рассмотрении", "Отправлено", "Регистрация открыта",
    "Схвалено", "In Bearbeitung", "Zugestellt", "En attente", "Expédiée", "Pendiente", "Inscripciones abiertas",
    "In lavorazione", "Em trânsito", "発送済み", "배송 중", "已发货",
    "已出貨", "審核中", "تم الشحن", "قيد المراجعة", "Đã giao hàng", "Đang vận chuyển"
  ])
})

test("ordinary text keeps the bubble as it was", () => {
  for (const s of [
    "the quick brown fox", "Привет, как дела?", "This is a long sentence about something that is not a value at all",
    "19.99", "12.50", "42", "1/2", "Hello world", "ContextFlow", "Mayday", "Openness",
    "Tôi đi học", "đi chợ 5 lần", "مرحبا بك في موقعنا", "這是一篇文章",
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

test("prices with a currency code, before or after the number (the owner, build 75)", () => {
  all("price", [
    "USD 40", "40 EUR", "1 299 RUB", "CHF 12.50", "CHF 12.–", "EUR 1.299,00", "GBP 9.99", "JPY 3,000", "40 usd", "40,00 EUR",
    "RUB 1 299,50", "CZK 250", "250 Kč", "MXN 120", "AED 50", "SGD 18.90", "PLN 99", "HUF 4 990", "KZT 15 000",
    "199 kr", "1 299 RUB", "USD 40", "Price: USD 40", "40 EUR/month"
  ])
})

test("codes that are words, models and units are not prices", () => {
  for (const s of ["all 40 items", "Try 3 times", "top 10", "TOP 10", "ALL 40 ITEMS", "RTX 4090", "6 ft", "iPhone 15", "USB 3.0", "ISO 9001", "chapter 12", "3 krona"]) {
    assert.equal(detectWatchable(s), null, s)
  }
})

test("a number selected next to its code: the eye shows and watches the whole price", () => {
  // On iPhone a tap on "40" in "USD 40" selects the number only; "$40" comes whole.
  assert.equal(eyeFor("40", "Price: USD 40 per month"), "price")
  assert.equal(priceAround("40", "Price: USD 40 per month"), "USD 40")
  assert.equal(priceAround("1 299", "Итого 1 299 RUB"), "1 299 RUB")
  assert.equal(priceAround("12.50", "CHF 12.50 / Stk."), "CHF 12.50")
  // The same digits elsewhere, or no currency by them: no eye.
  assert.equal(priceAround("40", "We have 40 items and USD 99"), null)
  assert.equal(eyeFor("40", "We have 40 items"), null)
  assert.equal(firstValue("price", "Was USD 55, now USD 40"), "USD 55")
  assert.equal(lastValue("price", "Was USD 55, now USD 40"), "USD 40")
})
