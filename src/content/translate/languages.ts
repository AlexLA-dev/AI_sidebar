// Which language a page is translated into (2.7, build 107, the owner: «А что если я хочу не на язык системы
// перевести, а на другой?»). One tap still translates into the person's own language; a small control on the pill
// picks another, and the site remembers it.

import { languageName } from "../translateTarget"
import { targetCode } from "../../shared/translate"

const KEY = "cf:trLang"
const SITES_KEPT = 500

/** Languages offered besides the person's own: the panel's, then the most read on the web, each as a target code. */
const COMMON = [
  "en", "de", "fr", "es", "it", "pt", "ru", "uk", "tr", "ja", "ko", "zh-Hans", "zh-Hant", "vi", "ar",
  "pl", "nl", "sv", "da", "nb", "fi", "cs", "sk", "ro", "hu", "el", "he", "fa", "ur", "hi", "bn", "id", "ms", "th",
  "ca", "hr", "sr", "bg", "lt", "lv", "et", "sl", "sw", "tl"
]

export interface LanguageChoice {
  code: string
  name: string
}

const capital = (s: string, ui: string) => s.charAt(0).toLocaleUpperCase(ui) + s.slice(1)

/** A target's name in the interface's language; Chinese with its script («Chinese (Traditional)»). */
export function targetName(code: string, ui: string): string {
  return capital(languageName(code, ui), ui)
}

/**
 * The languages to pick from: the person's own first, then the others they read (Safari's list), then the rest by
 * name; never the page's own language.
 */
export function languageChoices(own: string, preferred: readonly string[], ui: string, except: string | null): LanguageChoice[] {
  const first = [own, ...preferred.map(targetCode)]
  const seen = new Set<string>()
  const out: LanguageChoice[] = []
  const push = (code: string) => {
    if (!code || seen.has(code) || (except && code.split("-")[0] === except.split("-")[0] && !code.startsWith("zh"))) return
    seen.add(code)
    out.push({ code, name: targetName(code, ui) })
  }
  for (const code of first) push(code)
  const lead = out.length
  for (const code of COMMON) push(code)
  const rest = out.splice(lead).sort((a, b) => a.name.localeCompare(b.name, ui))
  return [...out, ...rest]
}

/** The short mark on the pill's control: «RU», «ZH» (Traditional: «繁»). */
export function shortMark(code: string): string {
  if (code === "zh-Hant") return "繁"
  return code.split("-")[0].toUpperCase()
}

const site = () => location.hostname.replace(/^www\./, "")

/** The language picked on this site before, if any. */
export async function keptLanguage(): Promise<string | null> {
  try {
    const all = (await chrome.storage.local.get(KEY))[KEY] as Record<string, string> | undefined
    return all?.[site()] ?? null
  } catch {
    return null
  }
}

/** Remembers the language picked on this site (the person's own clears it). */
export async function keepLanguage(code: string, own: string): Promise<void> {
  try {
    const all = { ...(((await chrome.storage.local.get(KEY))[KEY] as Record<string, string> | undefined) ?? {}) }
    delete all[site()]
    const kept = Object.entries(all).slice(-(SITES_KEPT - 1))
    await chrome.storage.local.set({ [KEY]: Object.fromEntries(code === own ? kept : [...kept, [site(), code]]) })
  } catch {
    // storage unavailable: the pick lasts for this page
  }
}
