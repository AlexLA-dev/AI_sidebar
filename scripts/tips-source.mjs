// The app's Tips, for the extension's Tips sheet (2.5 (78), the owner's note: the same Tips in the extension).
// One source: the blocks, their order, the cards and the Pro and Ultra badges come from TipGroup in ContentView.swift, the
// translations from Localizable.xcstrings. The extension build reads both, so the sheet can't drift from the app:
//   tipsData(root)            → { heading, intro, clipLang, lead, groups } in English, each text with its message key
//   tipsMessages(root, data, lang) → { key: text } in an extension language (src/locales/<lang>.json's name)
//   tipClips(data)            → the clips the cards show (TipClips/<en|ru>/<name>.mp4 in the app)
// A text or a clip that differs on a Mac (#if os(iOS) … #else … #endif in a helper, iOSClip("…")) comes in both;
// the sheet picks one.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SWIFT = "ContextFlow/Shared (App)/ContentView.swift"
const CATALOG = "ContextFlow/Shared (App)/Localizable.xcstrings"
// The extension's languages (src/locales/<file>.json) and the app catalog's names for them.
export const CATALOG_LANG = { ar: "ar", de: "de", es: "es", fr: "fr", it: "it", ja: "ja", ko: "ko", pt_BR: "pt-BR", ru: "ru", uk: "uk", vi: "vi", zh_CN: "zh-Hans", zh_TW: "zh-Hant" }
// The screen's own words, outside TipGroup.
const HEADING = "Tips"
const INTRO = "Quick answers to “how do I…?”"
// The panel's language for the clips: the extension language's own code ("de", "pt_BR"); the app picks the folder
// (its clips in that language, else the person's next language that has them, else English: TipClipShare.language).
const CLIP_LANG = "tip_clips"

/** A message key for a text: the same English text, the same key (chrome.i18n allows [A-Za-z0-9_]). */
export const tipKey = (en) => "tip_" + createHash("sha1").update(en).digest("hex").slice(0, 10)
const text = (en) => ({ key: tipKey(en), en })

// ---------------------------------------------------------------- reading Swift

// The source without its comments, line and block (a quote or a bracket in a comment would mislead the reading).
function stripComments(src) {
  let out = ""
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "\"") {
      const start = i
      for (i++; src[i] !== "\""; i++) if (src[i] === "\\") i++
      out += src.slice(start, i + 1)
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1
    } else out += c
  }
  return out
}

/** Index just past the bracket matching the one at `open` ( "(" or "[" or "{" ), string literals skipped. */
function matching(src, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }
  const stack = [pairs[src[open]]]
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]
    if (c === "\"") {
      for (i++; src[i] !== "\""; i++) if (src[i] === "\\") i++
    } else if (pairs[c]) stack.push(pairs[c])
    else if (c === stack[stack.length - 1]) {
      stack.pop()
      if (!stack.length) return i + 1
    }
  }
  throw new Error("tips: unbalanced brackets in ContentView.swift")
}

/** Splits `a: 1, b: f(x, y), c` at its top-level commas. */
function topLevel(src) {
  const parts = []
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "\"") for (i++; src[i] !== "\""; i++) { if (src[i] === "\\") i++ }
    else if (c === "(" || c === "[" || c === "{") i = matching(src, i) - 1
    else if (c === ",") { parts.push(src.slice(start, i).trim()); start = i + 1 }
  }
  if (src.slice(start).trim()) parts.push(src.slice(start).trim())
  return parts
}

function literal(value, where) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(value)
  if (!m) throw new Error(`tips: ${where} isn't a plain string literal: ${value.slice(0, 60)}`)
  if (m[1].includes("\\(")) throw new Error(`tips: ${where} has an interpolation`)
  return m[1].replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t" })[c] ?? c)
}

/** A Tip's clip on iOS and on a Mac: `clip: "x"` both, `clip: iOSClip("x")` iOS only, none without. */
function clipArg(value) {
  if (value === undefined) return { ios: null, mac: null }
  const only = /^iOSClip\("([\w-]+)"\)$/.exec(value)
  if (only) return { ios: only[1], mac: null }
  const name = literal(value, "a Tip's clip")
  return { ios: name, mac: name }
}

/** `Tip(symbol: …, title: "…", text: "…", clip: …, pro: true)` → { title, text, clip: { ios, mac }, pro, ultra }. */
function tipCall(src) {
  const open = src.indexOf("Tip(")
  if (open < 0) throw new Error(`tips: no Tip(…) in ${src.slice(0, 60)}`)
  const args = Object.fromEntries(topLevel(src.slice(open + 4, matching(src, open + 3) - 1)).map((a) => {
    const at = a.indexOf(":")
    return [a.slice(0, at).trim(), a.slice(at + 1).trim()]
  }))
  return { title: literal(args.title, "a Tip's title"), text: literal(args.text, "a Tip's text"), clip: clipArg(args.clip), pro: args.pro === "true", ultra: args.ultra === "true" }
}

/** A tip on iOS and on a Mac: one Tip(…), or `#if os(iOS) Tip(…) #else Tip(…) #endif`. */
function tipBody(body) {
  const m = /#if os\(iOS\)([\s\S]*?)#else([\s\S]*?)#endif/.exec(body)
  if (!m) {
    const t = tipCall(body)
    return { ios: { ...t, clip: t.clip.ios }, mac: { ...t, clip: t.clip.mac } }
  }
  const ios = tipCall(m[1])
  const mac = tipCall(m[2])
  return { ios: { ...ios, clip: ios.clip.ios }, mac: { ...mac, clip: mac.clip.mac } }
}

function entry({ ios, mac }) {
  const e = { title: text(ios.title), text: text(ios.text) }
  if (ios.clip) e.clip = ios.clip
  if (ios.title !== mac.title || ios.text !== mac.text || ios.clip !== mac.clip) {
    e.mac = { title: text(mac.title), text: text(mac.text) }
    if (mac.clip) e.mac.clip = mac.clip
  }
  if (ios.pro || mac.pro) e.pro = true
  // 2.6: Ultra's own features (Find similar, Listen) carry the Ultra badge.
  if (ios.ultra || mac.ultra) e.ultra = true
  return e
}

export function tipsData(root) {
  const swift = stripComments(readFileSync(join(root, SWIFT), "utf8"))
  const at = swift.indexOf("struct TipGroup {")
  if (at < 0) throw new Error("tips: no struct TipGroup in ContentView.swift")
  const group = swift.slice(at, matching(swift, swift.indexOf("{", at)))
  for (const words of [HEADING, INTRO]) if (!swift.includes(`"${words}"`)) throw new Error(`tips: "${words}" is gone from TipsView`)

  // Helpers: `private static var openTip: Tip { … }`.
  const helpers = {}
  for (const m of group.matchAll(/static var (\w+): Tip \{/g)) {
    const brace = m.index + m[0].length - 1
    helpers[m[1]] = tipBody(group.slice(brace + 1, matching(group, brace) - 1))
  }
  const leadAt = group.search(/static let lead = Tip\(/)
  if (leadAt < 0) throw new Error("tips: no TipGroup.lead")
  const leadOpen = group.indexOf("(", leadAt)
  const lead = tipBody(group.slice(leadAt, matching(group, leadOpen)))

  const allAt = group.indexOf("static let all: [TipGroup] = [")
  if (allAt < 0) throw new Error("tips: no TipGroup.all")
  const allOpen = group.indexOf("[", group.indexOf("=", allAt))
  const groups = topLevel(group.slice(allOpen + 1, matching(group, allOpen) - 1)).map((g) => {
    const open = g.indexOf("(")
    const args = topLevel(g.slice(open + 1, matching(g, open) - 1))
    const arg = (name) => args.find((a) => a.startsWith(`${name}:`))?.slice(name.length + 1).trim()
    const tips = arg("tips")
    const items = topLevel(tips.slice(1, -1)).map((item) => {
      if (/^\w+$/.test(item)) {
        if (!helpers[item]) throw new Error(`tips: no helper ${item}`)
        return entry(helpers[item])
      }
      return entry(tipBody(item))
    })
    if (!items.length) throw new Error("tips: an empty block")
    return { id: literal(arg("id"), "a block's id"), title: text(literal(arg("title"), "a block's title")), tips: items }
  })
  return { heading: text(HEADING), intro: text(INTRO), clipLang: { key: CLIP_LANG, en: "en" }, lead: entry(lead), groups }
}

/** Every clip a card shows, on iOS or on a Mac, once. */
export function tipClips(data) {
  const names = new Set()
  const add = (e) => {
    if (e.clip) names.add(e.clip)
    if (e.mac?.clip) names.add(e.mac.clip)
  }
  add(data.lead)
  for (const g of data.groups) g.tips.forEach(add)
  return [...names].sort()
}

// ---------------------------------------------------------------- translations

/** Every text in the data, once. */
export function tipTexts(data) {
  const out = [data.heading, data.intro]
  const add = (e) => {
    out.push(e.title, e.text)
    if (e.mac) out.push(e.mac.title, e.mac.text)
  }
  add(data.lead)
  for (const g of data.groups) {
    out.push(g.title)
    g.tips.forEach(add)
  }
  return [...new Map(out.map((t) => [t.key, t])).values()]
}

/** The texts in an extension language, from the app's catalog (English where the catalog has none). */
export function tipsMessages(root, data, lang) {
  const catalog = JSON.parse(readFileSync(join(root, CATALOG), "utf8")).strings
  const code = CATALOG_LANG[lang]
  const texts = Object.fromEntries(tipTexts(data).map((t) => {
    const unit = catalog[t.en]?.localizations?.[code ?? "en"]?.stringUnit
    return [t.key, unit?.state === "translated" && unit.value ? unit.value : t.en]
  }))
  // The clips' folder for this language, chosen through chrome.i18n like every text (so the two never disagree).
  return { ...texts, [CLIP_LANG]: lang }
}
