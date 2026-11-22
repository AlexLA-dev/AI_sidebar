// Amounts of money as pages write them (2.7.1): the plan's price check and the step classes (a button with an amount on
// it pays). No imports, so classify.ts and taskplan.ts both use it.

const CUR = "[€$£¥₽₴₺₹₫₩₪]|руб\\.?|грн\\.?|zł|kr|chf|eur|usd|gbp|rub|uah|try|jpy|aed|sar|inr|vnd|r\\$|円|元|đ|درهم|ريال|ر\\.س|د\\.إ"
const NUM = "\\d{1,3}(?:[ \\u00a0\\u202f.,']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?"
const MONEY = new RegExp(`(?:(?:${CUR})\\s?(${NUM}))|(?:(${NUM})\\s?(?:${CUR}))`, "giu")

/** An amount's value: "1 299,90" and "1,299.90" are 1299.9; "129" is 129. */
export function amountOf(raw: string): number | null {
  const t = raw.replace(/[\s  ']/g, "")
  const m = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(t)
  if (!m) return null
  const whole = m[1].replace(/[.,]/g, "")
  if (!/^\d+$/.test(whole)) return null
  return Number(whole) + (m[2] ? Number(m[2].padEnd(2, "0")) / 100 : 0)
}

/** The money amounts written in a text. A plain space may group thousands («1 299 ₽») or end a name («Air 2 129.00 €»):
 *  both readings count. */
export function amounts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(MONEY)) {
    const raw = m[1] ?? m[2] ?? ""
    for (const r of / /.test(raw) ? [raw, raw.slice(raw.indexOf(" ") + 1)] : [raw]) {
      const v = amountOf(r)
      if (v !== null && v > 0 && !out.includes(v)) out.push(v)
    }
  }
  return out
}

