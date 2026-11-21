// «Мои данные» (2.7.1): what's refused before it's kept, how a value is shaped for a field, and the fill tool whose
// value the model never sees.
import assert from "node:assert/strict"
import { test } from "node:test"

import { checkCall } from "../src/shared/agent/call.ts"
import { classify } from "../src/shared/agent/classify.ts"
import { keyOfAutocomplete, modelKey, refusedEntry, shapeValue, type FormEntry } from "../src/shared/agent/formdata.ts"
import type { PageMap } from "../src/shared/agent/types.ts"

const entry = (key: FormEntry["key"], value: string, label = ""): FormEntry => ({ id: "x", key, label, value, updatedAt: 1 })

test("passwords, cards, documents, codes and health are refused in any language, by label and by value", () => {
  for (const label of ["Пароль от почты", "Номер паспорта", "Card number", "CVV", "IBAN", "Codice fiscale", "Аллергии", "暗証番号", "Kimlik numarası"]) {
    assert.equal(refusedEntry(label, "x"), "label", label)
  }
  assert.equal(refusedEntry("Карта лояльности", "4111 1111 1111 1111"), "value")
  assert.equal(refusedEntry("Note", "DE89 3704 0044 0532 0130 00"), "value")
  assert.equal(refusedEntry("Note", "123-45-6789"), "value")
  for (const [label, value] of [["Размер обуви", "43"], ["Номер читательского билета", "1234"], ["Удобное время звонка", "после 18:00"], ["Shoe size", "10.5"]]) {
    assert.equal(refusedEntry(label, value), null, label)
  }
})

test("the model's key: a standard key or the person's fact by its name", () => {
  assert.equal(modelKey(entry("email", "a@b.c")), "email")
  assert.equal(modelKey(entry("fact", "43", "Размер обуви")), "fact:Размер обуви")
})

test("a birth date goes into one date field or three lists, month by number or name in the page's language", () => {
  const bday = entry("birthDate", "1990-03-07")
  assert.equal(shapeValue(bday, { type: "date" }), "1990-03-07")
  assert.equal(shapeValue(bday, { auto: "bday-day", options: ["1", "2", "7", "8"] }), "7")
  assert.equal(shapeValue(bday, { auto: "bday-year", options: ["1989", "1990"] }), "1990")
  assert.equal(shapeValue(bday, { auto: "bday-month", lang: "ru", options: ["январь", "февраль", "март", "апрель"] }), "март")
  assert.equal(shapeValue(bday, { auto: "bday-month", lang: "de", options: ["Januar", "Februar", "März"] }), "März")
  assert.equal(shapeValue(bday, { label: "Месяц", lang: "ru", options: ["01", "02", "03"] }), "03")
  assert.equal(shapeValue(bday, { label: "Jahr" }), "1990")
  assert.equal(shapeValue(bday, { type: "text", lang: "de" }), "07.03.1990")
  assert.equal(shapeValue(bday, { type: "text", lang: "en-US" }), "03/07/1990")
})

test("a phone with or without its country code; a country picked from a list", () => {
  const phone = entry("phone", "+7 900 123-45-67")
  assert.equal(shapeValue(phone, { auto: "tel" }), "+7 900 123-45-67")
  assert.equal(shapeValue(phone, { auto: "tel-national" }), "900 123-45-67")
  assert.equal(shapeValue(phone, { auto: "tel-country-code" }), "+7")
  assert.equal(shapeValue(entry("address.country", "Germany"), { options: ["France", "Germany", "Italy"] }), "Germany")
  assert.equal(shapeValue(entry("address.country", "Atlantis"), { options: ["France", "Germany"] }), null)
  assert.deepEqual(keyOfAutocomplete("shipping postal-code"), { key: "address.postal" })
})

test("fill: only a saved key, into a field; it always asks first and the value is nowhere in the call", () => {
  const map: PageMap = {
    url: "https://shop.example.com/", title: "", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "",
    items: [{ id: "1", role: "textbox", label: "E-mail", lock: "personal" }, { id: "2", role: "button", label: "Go" }, { id: "3", role: "textbox", label: "Password", lock: "secret" }]
  }
  const keys = ["email", "fact:Размер обуви"]
  const ok = checkCall({ tool: "fill", id: "1", key: "email", why: "" }, map, keys)
  assert.ok(ok.ok)
  assert.equal(checkCall({ tool: "fill", id: "1", key: "phone", why: "" }, map, keys).ok, false)
  assert.equal(checkCall({ tool: "fill", id: "2", key: "email", why: "" }, map, keys).ok, false)
  const ctx = { map, startHost: "shop.example.com", request: "", confirmedHere: true, policy: { amazon: true } }
  assert.equal(classify({ tool: "fill", id: "1", key: "email" }, ctx).cls, "confirm")
  assert.equal(classify({ tool: "fill", id: "3", key: "email" }, ctx).cls, "blocked")
})

test("a label that names the whole date gets the whole date", () => {
  const bday = { id: "x", key: "birthDate" as const, label: "", value: "1990-03-07", updatedAt: 1 }
  assert.equal(shapeValue(bday, { label: "生年月日", lang: "ja" }), "1990/03/07")
  assert.equal(shapeValue(bday, { label: "Дата рождения (день, месяц, год)", lang: "ru" }), "07.03.1990")
})
