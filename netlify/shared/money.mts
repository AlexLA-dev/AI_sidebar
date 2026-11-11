// Prices in the person's currency. A shop abroad shows its own currency (dollars, to someone who pays in euros or
// yen), so "cheaper than 249 EUR" could never be settled. Their country's currency, and the
// European Central Bank's reference rates of the day (free, public, no key: one small XML a day, kept in memory).

/** The currency people pay in, by country (two letters); "" when we don't know it. */
const EURO = "AD AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MC ME MT NL PT SI SK SM VA XK".split(" ")
const OTHERS: Record<string, string> = {
  US: "USD", PR: "USD", EC: "USD", SV: "USD", PA: "USD", GB: "GBP", IM: "GBP", JE: "GBP", GG: "GBP", CH: "CHF", LI: "CHF",
  NO: "NOK", SE: "SEK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", TR: "TRY", IL: "ILS",
  JP: "JPY", CN: "CNY", HK: "HKD", SG: "SGD", KR: "KRW", IN: "INR", ID: "IDR", MY: "MYR", PH: "PHP", TH: "THB",
  AU: "AUD", NZ: "NZD", CA: "CAD", MX: "MXN", BR: "BRL", ZA: "ZAR", AE: "AED", SA: "SAR",
  RU: "RUB", UA: "UAH", BY: "BYN", KZ: "KZT", GE: "GEL", AM: "AMD", AZ: "AZN", UZ: "UZS", MD: "MDL", RS: "RSD",
  BA: "BAM", MK: "MKD", AL: "ALL", VN: "VND", TW: "TWD", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR",
  AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU", EG: "EGP", MA: "MAD", TN: "TND", DZ: "DZD",
  NG: "NGN", KE: "KES", GH: "GHS", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR", JO: "JOD"
}

export function currencyOf(country: string | undefined): string {
  const c = (country ?? "").toUpperCase()
  if (EURO.includes(c)) return "EUR"
  return OTHERS[c] ?? ""
}

/** Units of each currency for one euro. */
export type Rates = Record<string, number>

// Currencies pegged to the dollar that the ECB doesn't list: their fixed rate to the dollar.
const PEGGED: Record<string, number> = { AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845, JOD: 0.709 }

const ECB = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
const KEEP_MS = 6 * 3_600_000
let kept: { at: number; rates: Rates } | null = null

/** The ECB's daily XML read into rates per euro (EUR itself is 1); null when it isn't that XML. */
export function parseEcb(xml: string): Rates | null {
  const rates: Rates = { EUR: 1 }
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const r = Number(m[2])
    if (Number.isFinite(r) && r > 0) rates[m[1]] = r
  }
  if (!rates.USD) return null
  for (const [code, perUsd] of Object.entries(PEGGED)) rates[code] = rates.USD * perUsd
  return rates
}

/** Today's rates (kept for a few hours in this instance); null when the ECB can't be reached in time. */
export async function eurRates(timeoutMs = 2_500, signal?: AbortSignal): Promise<Rates | null> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.rates
  try {
    const res = await fetch(ECB, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return kept?.rates ?? null
    const rates = parseEcb(await res.text())
    if (rates) kept = { at: Date.now(), rates }
    return rates ?? kept?.rates ?? null
  } catch {
    return kept?.rates ?? null
  }
}

/** Tests: rates as if fetched now (null forgets them). */
export function useRates(rates: Rates | null): void {
  kept = rates ? { at: Date.now(), rates } : null
}

/** An amount in another currency at the day's rate; null when either currency isn't known. */
export function convert(amount: number, from: string, to: string, rates: Rates | null): number | null {
  if (!from || !to) return null
  if (from === to) return amount
  const a = rates?.[from]
  const b = rates?.[to]
  if (!a || !b) return null
  return (amount / a) * b
}

/** A converted amount as people read it: whole units from 10 up, cents below ("114 EUR", "7.45 EUR"). */
export function roughAmount(amount: number, currency: string): string {
  const n = amount >= 10 ? String(Math.round(amount)) : amount.toFixed(2)
  return `${n} ${currency}`
}
