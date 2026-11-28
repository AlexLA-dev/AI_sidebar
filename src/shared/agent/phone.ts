// Decision 15 (round 142, the director's; S2 proved it): a phone field beside a country or dial-code control takes the
// national part, with the control set to the number's calling code. A whole «+44 7700 900123» typed into such a field
// is read by the page's own parser, which picks the first country with that code (Guernsey for +44, Canada for +1)
// and refuses the number. Pure functions here; the runner does the presses.
import type { MapItem, PageMap } from "./types.ts"

// A control that names a country or a dial code (the classifier's own words), and a calling code in a label.
const DIAL_WORDS = /\+\d|country|code|código|codice|indicatif|vorwahl|код|kod|国番号|국가|区号|區號|mã|رمز|pays|país|paese|land|страна|країна|ülke|国|나라|quốc gia|البلد|الدولة/i
const CODE_IN = /\+\s?(\d{1,4})(?![\d])/g
// The main territory of calling codes several countries share (the director's table), by ISO region.
export const MAIN_REGION: Record<string, string> = { "1": "US", "44": "GB", "7": "RU", "39": "IT", "47": "NO", "358": "FI", "61": "AU", "212": "MA", "262": "RE", "590": "GP", "599": "CW" }

/** The calling codes an option or a label names: «United Kingdom (+44)» → ["44"], «+1-684» → ["1"]. */
export function codesIn(text: string): string[] {
  return [...new Set([...text.matchAll(CODE_IN)].map((m) => m[1]))]
}

/** A number written with its calling code: its digits after «+» (the code still in them). */
export function internationalDigits(value: string): string | null {
  const v = value.trim()
  if (!/^\+\s?\d/.test(v)) return null
  const digits = v.replace(/\D/g, "")
  return digits.length >= 7 ? digits : null
}

/** The national part of an international number, as written after its code («+44 7700 900123», "44" → «7700 900123»;
 *  no trunk zero added). */
export function nationalPart(value: string, code: string): string {
  let rest = value.trim().replace(/^\+\s?/, "")
  for (const d of code) rest = rest.replace(new RegExp(`^[\\s().-]*${d}`), "")
  // («+44 (0) 7700 900123»: the written trunk zero isn't part of the national number after a code.)
  return rest.replace(/^[\s.-]*\(0\)/, "").replace(/^[\s().-]+/, "").trim()
}

const CONTROL_ROLES = new Set(["select", "combobox", "listbox", "button"])

/** The field's country or dial-code control: a select, combobox, listbox or button of its form (or its place on the page
 *  when it has none) whose options or label carry a calling code or a dial-code word, nearest to the field first. */
export function dialControl(map: PageMap, field: MapItem): MapItem | null {
  const at = map.items.findIndex((i) => i.id === field.id)
  const same = (i: MapItem) => (field.form !== undefined ? i.form === field.form : i.where === field.where)
  const cands = map.items
    .map((i, n) => ({ i, n }))
    .filter(({ i }) => i.id !== field.id && CONTROL_ROLES.has(i.role) && same(i) && !i.lock?.includes("secret"))
    .filter(({ i }) => (i.options ?? []).some((o) => codesIn(o).length) || codesIn(i.label).length > 0 || codesIn(i.value ?? "").length > 0 || (i.role !== "button" && DIAL_WORDS.test(i.label)))
    .sort((a, b) => Math.abs(a.n - at) - Math.abs(b.n - at))
  // (Only a control right beside the field: within three items of it in the page's order.)
  return cands.find(({ n }) => Math.abs(n - at) <= 3)?.i ?? null
}

/** The region's name as an option would write it, in the page's language and in English. */
function regionNames(region: string, lang: string): string[] {
  const out: string[] = []
  for (const l of [lang, "en"]) {
    try {
      const n = new Intl.DisplayNames([l || "en"], { type: "region" }).of(region)
      if (n && n !== region) out.push(n.toLocaleLowerCase())
    } catch {
      // an unknown language or region: the English name only
    }
  }
  return out
}
const namesRegion = (option: string, region: string, lang: string) => {
  const o = option.toLocaleLowerCase()
  return regionNames(region, lang).some((n) => o.includes(n)) || new RegExp(`(^|[^A-Za-z])${region}([^A-Za-z]|$)`).test(option)
}

export interface DialPick {
  option: string
  code: string
  national: string
  // The other options with the same code, in order: tried once when the page still marks the field invalid.
  others: string[]
}

/** The option to choose for an international number: the longest calling code the options carry that starts the number;
 *  among options with that code, the selected one, else the device region's country, else the code's main territory
 *  (MAIN_REGION), else the first. Null when no option carries a code that starts it. */
export function pickDialOption(options: string[], value: string, opts: { selected?: string; region?: string; lang?: string } = {}): DialPick | null {
  const digits = internationalDigits(value)
  if (!digits) return null
  const codes = [...new Set(options.flatMap(codesIn))].filter((c) => digits.startsWith(c)).sort((a, b) => b.length - a.length)
  const code = codes[0]
  if (!code) return null
  const withCode = options.filter((o) => codesIn(o).includes(code))
  const lang = opts.lang ?? "en"
  const pick =
    (opts.selected && withCode.find((o) => o === opts.selected)) ||
    (opts.region && withCode.find((o) => namesRegion(o, opts.region!, lang))) ||
    (MAIN_REGION[code] && withCode.find((o) => namesRegion(o, MAIN_REGION[code], lang))) ||
    withCode[0]
  return { option: pick, code, national: nationalPart(value, code), others: withCode.filter((o) => o !== pick) }
}

/** A fixed code shown as the field's prefix (its label or hint carries «+82» and no control sets it): the code, else null. */
export function fixedPrefix(field: MapItem): string | null {
  const codes = [...codesIn(field.label), ...codesIn(field.hint ?? "")]
  return codes.length === 1 ? codes[0] : null
}

/** The device's region (its locale's), for a code several countries share. */
export function deviceRegion(): string {
  try {
    const loc = typeof navigator !== "undefined" ? navigator.language : Intl.DateTimeFormat().resolvedOptions().locale
    return new Intl.Locale(loc).maximize().region ?? ""
  } catch {
    return ""
  }
}
