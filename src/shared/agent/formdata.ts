// «Мои данные» (2.7.1): what the agent fills into forms on sites from what the person saved, on the device only.
// - The model sees only the keys ("email", "address.city", "fact:Размер обуви"), never the values: it calls
//   fill(id, key), and the extension puts the value in after the person's «Заполнить?» (the values show only there).
// - Refused before they're kept: passwords, cards, bank and document numbers, codes, health data (by the label and by
//   the value: a card number, an IBAN, a social security number).
// - A value is shaped for the field it goes into: a birth date as one date field or three lists, a phone with or
//   without its country code, a country by its name or code in a list.
// Plain data, so the tests, the panel and the app's rules (FormData.swift) share it.

import { hasSecretNumber } from "./classify.ts"
import { fieldLock } from "./fields.ts"

export const FORM_KEYS = [
  "name.full", "name.given", "name.family", "name.latin", "name.phonetic", "email", "phone",
  "address.line", "address.apartment", "address.city", "address.region", "address.postal", "address.country",
  "company", "jobTitle", "website", "birthDate"
] as const

export type FormKey = (typeof FORM_KEYS)[number] | "fact"

export interface FormEntry {
  id: string
  key: FormKey
  // The person's own name for a fact («Размер обуви»); the standard keys' names come from the locales.
  label: string
  value: string
  updatedAt: number
  deleted?: boolean
}

/** The key as the model sees it: the standard key, or "fact:<the person's label>". */
export function modelKey(e: FormEntry): string {
  return e.key === "fact" ? `fact:${e.label.trim().slice(0, 60)}` : e.key
}

export function liveEntries(entries: FormEntry[]): FormEntry[] {
  return entries.filter((e) => !e.deleted && e.value.trim())
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/

/** Why an entry can't be kept, or null: a secret label (password, card, document, code, health) or value. */
export function refusedEntry(label: string, value: string): "label" | "value" | null {
  if (label.trim() && fieldLock({ tag: "input", label }) === "secret") return "label"
  if (hasSecretNumber(value) || SSN.test(value)) return "value"
  return null
}

// What the page's autocomplete token asks for, as one of the keys (and a part of it).
const AUTO: Record<string, { key: FormKey; part?: "day" | "month" | "year" | "national" | "code" }> = {
  name: { key: "name.full" }, "given-name": { key: "name.given" }, "family-name": { key: "name.family" },
  email: { key: "email" }, tel: { key: "phone" }, "tel-national": { key: "phone", part: "national" },
  "tel-country-code": { key: "phone", part: "code" }, "street-address": { key: "address.line" },
  "address-line1": { key: "address.line" }, "address-line2": { key: "address.apartment" },
  "address-level2": { key: "address.city" }, "address-level1": { key: "address.region" },
  "postal-code": { key: "address.postal" }, country: { key: "address.country" }, "country-name": { key: "address.country" },
  organization: { key: "company" }, "organization-title": { key: "jobTitle" }, url: { key: "website" },
  bday: { key: "birthDate" }, "bday-day": { key: "birthDate", part: "day" }, "bday-month": { key: "birthDate", part: "month" },
  "bday-year": { key: "birthDate", part: "year" }
}

/** The key a field's autocomplete token names (the extension fills those without the model), or null. */
export function keyOfAutocomplete(auto: string | undefined): { key: FormKey; part?: string } | null {
  const tokens = (auto ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  for (const t of tokens.reverse()) if (AUTO[t]) return AUTO[t]
  return null
}

export interface FieldShape {
  // input type, autocomplete, the page's language, and a list's options when it's a list.
  type?: string
  auto?: string
  lang?: string
  options?: string[]
  label?: string
}

function monthNames(lang: string, style: "long" | "short"): string[] {
  try {
    const f = new Intl.DateTimeFormat(lang || "en", { month: style, timeZone: "UTC" })
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2000, i, 15))).toLowerCase())
  } catch {
    return []
  }
}

/** A birth date part as a list wants it: its option by number, by name in the page's language, or as is. */
function pickOption(options: string[] | undefined, candidates: string[]): string | null {
  if (!options?.length) return null
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  for (const c of candidates) {
    const hit = options.find((o) => norm(o) === norm(c))
    if (hit) return hit
  }
  for (const c of candidates) {
    if (c.length < 3) continue
    const hit = options.find((o) => norm(o).startsWith(norm(c)))
    if (hit) return hit
  }
  return null
}

// Words in a label (letters of any script around them don't count as a boundary).
const DAY_LABEL = new RegExp("(?<![\\p{L}])(day|день|tag|jour|día|dia|giorno|gün|ngày)(?![\\p{L}])|日|일", "iu")
const MONTH_LABEL = new RegExp("(?<![\\p{L}])(month|месяц|місяць|monat|mois|mes|mês|mese|ay|tháng)(?![\\p{L}])|月|월", "iu")
const YEAR_LABEL = new RegExp("(?<![\\p{L}])(year|год|рік|jahr|année|año|ano|anno|yıl|năm)(?![\\p{L}])|年|년", "iu")

/**
 * The value an entry takes in a field: shaped for the field's type, autocomplete part and list. Null when it can't go
 * there (a list without a matching option).
 */
export function shapeValue(e: FormEntry, field: FieldShape): string | null {
  const auto = keyOfAutocomplete(field.auto)
  const value = e.value.trim()
  if (e.key === "birthDate") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!m) return value
    const [, y, mo, d] = m
    const label = field.label ?? ""
    // A label naming one part (Tag, Месяц, 年) is that part; one naming them all («生年月日», «Day / Month / Year») is the date.
    const named = [DAY_LABEL.test(label) && "day", MONTH_LABEL.test(label) && "month", YEAR_LABEL.test(label) && "year"].filter(Boolean) as string[]
    const part = auto?.part ?? (named.length === 1 ? named[0] : undefined)
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    if (part === "day") return pickOption(field.options, [String(Number(d)), d]) ?? (field.options?.length ? null : d)
    if (part === "year") return pickOption(field.options, [y]) ?? (field.options?.length ? null : y)
    if (part === "month") {
      const i = Number(mo) - 1
      const names = [monthNames(field.lang ?? "en", "long")[i], monthNames(field.lang ?? "en", "short")[i]].filter(Boolean) as string[]
      return pickOption(field.options, [String(i + 1), mo, ...names]) ?? (field.options?.length ? null : mo)
    }
    if ((field.type ?? "") === "date") return `${y}-${mo}-${d}`
    try {
      return new Intl.DateTimeFormat(field.lang || "en", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(date)
    } catch {
      return value
    }
  }
  if (e.key === "phone") {
    const code = /^\+(\d{1,3})[\s-]?(.*)$/.exec(value)
    if (auto?.part === "code") return code ? `+${code[1]}` : null
    if (auto?.part === "national" && code) return code[2].trim()
    return value
  }
  if (field.options?.length) return pickOption(field.options, [value])
  return value
}
