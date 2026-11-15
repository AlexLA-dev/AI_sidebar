// The language the quick actions answer in (2.7, the director, from the site session: «одинаково хорошо для всех»).
// The panel speaks 14 languages; on a device in any other (Polish, Dutch, Indonesian, Thai, Hebrew…) its strings fall
// back to English, and so did the answers: a quick action is an instruction in the panel's language, and the model
// answers in the language of the instruction. The person's own language is the first of their preferred languages
// (Safari's, which are the device's); when the panel doesn't speak it, the quick actions ask for it by name, and
// Translate goes into it. A question the person types is answered in its own language, as before.

import { baseLanguage, languageName } from "./translateTarget"

/** The languages the person reads, most preferred first: Safari's list, else its one language, else the device's. */
export function preferredLanguages(nav: { languages?: readonly string[]; language?: string }, device = ""): string[] {
  const list = (nav.languages ?? []).filter((l) => typeof l === "string" && l.trim())
  if (list.length) return [...list]
  return [nav.language ?? "", device].filter((l) => l.trim())
}

/**
 * The language to answer the quick actions in when it isn't the panel's own: the person's first preferred language
 * ("pl-PL"), or null when the panel speaks it (nothing changes) or nothing is known.
 */
export function answerLanguage(ui: string, preferred: readonly string[]): string | null {
  const first = preferred.find((l) => l.trim())?.trim()
  if (!first || !/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(first)) return null
  return baseLanguage(first) === baseLanguage(ui) ? null : first
}

/** Actions whose answer isn't in the reader's language by nature: Translate names its target itself, Improve keeps the
 *  text's own language, Find similar has its own (the shops' country and the person's words). */
const OWN_TARGET = new Set(["translate", "sel_translate", "sel_improve", "similar", "sel_similar"])

/** "Polish (polski)": the name in English, which every model reads, and in the language itself (no region: the
 *  device's "pl-PL" is Polish, not "Polish (Poland)"). */
function names(reader: string): string {
  const lang = baseLanguage(reader)
  const english = languageName(lang, "en")
  const own = languageName(lang, lang)
  return own && own.toLowerCase() !== english.toLowerCase() ? `${english} (${own})` : english
}

/** A quick action's instruction, with the answer's language asked for by name when it isn't the panel's. */
export function withAnswerLanguage(actionId: string, prompt: string, reader: string | null): string {
  if (!reader || OWN_TARGET.has(actionId)) return prompt
  return `${prompt} Write your answer in ${names(reader)}.`
}

/** The language Translate goes into when it goes "into the person's": its name in the panel's language. */
export function readerLanguageName(reader: string | null, ui: string, panelOwn: string): string {
  return reader ? languageName(baseLanguage(reader), ui) : panelOwn
}
