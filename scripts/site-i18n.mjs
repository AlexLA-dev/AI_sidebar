#!/usr/bin/env node
// The site in every app language (2.6, the owner: «на сайт все языки для лучшей индексации»).
//
// English pages in site/ are the source. Their text is cut into segments (a paragraph, a heading, a list item, a link,
// the title, the meta description, the JSON-LD texts); each language's translations live in site-i18n/<lang>.json as
// { key: translated segment }, the key a hash of the English segment. The build writes site/<path>/<page>.html for
// every language from the English page with the segments swapped, links pointed at the same language, and the head
// set up for search engines (lang, dir, canonical, hreflang alternates with x-default, og:locale). The English pages
// get the same alternates, and the sitemap lists every page in every language with its alternates.
//
//   node scripts/site-i18n.mjs extract   → site-i18n/source.json: every segment with its English and where it's from
//   node scripts/site-i18n.mjs build     → the language pages, the English pages' alternates, site/sitemap.xml
//   node scripts/site-i18n.mjs check [lang] → translations whose tags or links differ from the English, keys missing
//   node scripts/site-i18n.mjs status    → per language: how many segments are translated
//
// A segment with no translation yet stays English on that language's page, and the build says which ones.
// Privacy and terms stay English only: they're the binding texts.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseHTML } from "linkedom"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SITE = join(root, "site")
const I18N = join(root, "site-i18n")
export const ORIGIN = "https://context-flow.app"

/** The app's languages: the site's path, hreflang, html lang, og:locale, the name in the switcher, direction. */
export const LANGUAGES = [
  { path: "", hreflang: "en", lang: "en", og: "en_US", name: "English" },
  { path: "de", hreflang: "de", lang: "de", og: "de_DE", name: "Deutsch" },
  { path: "es", hreflang: "es", lang: "es", og: "es_ES", name: "Español" },
  { path: "fr", hreflang: "fr", lang: "fr", og: "fr_FR", name: "Français" },
  { path: "it", hreflang: "it", lang: "it", og: "it_IT", name: "Italiano" },
  { path: "pt-br", hreflang: "pt-BR", lang: "pt-BR", og: "pt_BR", name: "Português (Brasil)" },
  { path: "ru", hreflang: "ru", lang: "ru", og: "ru_RU", name: "Русский" },
  { path: "uk", hreflang: "uk", lang: "uk", og: "uk_UA", name: "Українська" },
  { path: "vi", hreflang: "vi", lang: "vi", og: "vi_VN", name: "Tiếng Việt" },
  { path: "ar", hreflang: "ar", lang: "ar", og: "ar_AR", name: "العربية", rtl: true },
  { path: "ja", hreflang: "ja", lang: "ja", og: "ja_JP", name: "日本語" },
  { path: "ko", hreflang: "ko", lang: "ko", og: "ko_KR", name: "한국어" },
  { path: "zh-hans", hreflang: "zh-Hans", lang: "zh-Hans", og: "zh_CN", name: "简体中文", also: ["zh-CN", "zh-SG"] },
  { path: "zh-hant", hreflang: "zh-Hant", lang: "zh-Hant", og: "zh_TW", name: "繁體中文", also: ["zh-TW", "zh-HK", "zh-MO"] }
]
const ENGLISH = LANGUAGES[0]
export const TRANSLATED = LANGUAGES.slice(1)

/** The pages that come in every language (site/ paths), in the sitemap's order. */
export const PAGES = [
  "index.html", "features.html", "cases.html", "cases/replies-and-forms.html", "cases/studying.html", "cases/shopping.html",
  "cases/planning.html", "safari-ai-extension-iphone.html", "notes-while-reading-safari.html", "safari-summary-vs-chatgpt.html",
  "support.html"
]
/** English only, still in the sitemap. */
export const ENGLISH_ONLY = ["privacy.html", "terms.html"]

/** A page's URL path in a language: "/", "/features", "/ru/", "/ru/cases/planning". */
export function urlPath(file, language = ENGLISH) {
  const page = file === "index.html" ? "" : file.replace(/\.html$/, "")
  const prefix = language.path ? `/${language.path}/` : "/"
  return prefix + page
}
export const pageUrl = (file, language = ENGLISH) => ORIGIN + urlPath(file, language)

// ---------------------------------------------------------------- segments

const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "VIDEO", "AUDIO", "TEMPLATE", "NOSCRIPT", "IFRAME", "CANVAS", "IMG", "BR", "HR", "SOURCE", "PICTURE"])
const INLINE = new Set(["A", "STRONG", "EM", "B", "I", "CODE", "SPAN", "SMALL", "SUP", "SUB", "KBD", "MARK", "ABBR", "S", "U", "Q", "TIME", "BR"])
// Text that is the same in every language: never a segment of its own.
const SAME = new Set(["ContextFlow", "App Store", "Mac App Store", "Pro", "X", "Threads", "Google", "Safari", "ChatGPT", "© 2026 ContextFlow", "PDF", "→", "›", "·", "✦"])
const META = [['meta[name="description"]', "content"], ['meta[property="og:title"]', "content"], ['meta[property="og:description"]', "content"]]
const ATTRS = ["alt", "aria-label", "title", "placeholder"]
const LD_KEYS = new Set(["name", "description", "headline", "text", "alternateName"])

const norm = (s) => s.replace(/\s+/g, " ").trim()
export const keyOf = (en) => createHash("sha1").update(norm(en)).digest("hex").slice(0, 12)
const meaningful = (text) => {
  const t = norm(text)
  return t !== "" && !SAME.has(t) && /\p{L}/u.test(t) && !/^[\w.+-]+@[\w.-]+$/.test(t)
}

/** An element whose whole content is text and inline markup (no media, no blocks): it can sit inside a segment. */
function inlineOnly(el) {
  if (!INLINE.has(el.tagName)) return false
  for (const child of el.children) if (!inlineOnly(child)) return false
  // A span holding a small label and a brand ("<small>Download on the</small>App Store") is split, not kept whole.
  for (const node of el.childNodes) if (node.nodeType === 3 && SAME.has(norm(node.textContent)) && el.children.length) return false
  return true
}
const htmlOf = (node) => (node.nodeType === 3 ? escapeText(node.textContent) : node.outerHTML)
const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;")

/**
 * Walks an element's content in document order and calls `visit(segment)` for each piece of text to translate.
 * A segment: { kind: "html", nodes } (a run of text and inline elements with text between them), { kind: "attr",
 * el, name }. A run that is only elements (a row of links) gives one segment per element, its inner HTML.
 */
function walk(parent, visit) {
  let run = []
  const flush = () => {
    if (!run.length) return
    const nodes = run
    run = []
    while (nodes.length && nodes[0].nodeType === 3 && !nodes[0].textContent.trim()) nodes.shift()
    while (nodes.length && nodes[nodes.length - 1].nodeType === 3 && !nodes[nodes.length - 1].textContent.trim()) nodes.pop()
    if (!nodes.length) return
    const texts = nodes.filter((n) => n.nodeType === 3 && n.textContent.trim())
    if (!texts.length) {
      // Only elements: each its own segment (its content, the tag and its link stay in the page).
      for (const n of nodes) if (n.nodeType === 1) { attrs(n, visit); if (meaningful(n.textContent)) visit({ kind: "inner", el: n }) }
      return
    }
    if (!meaningful(nodes.map((n) => n.textContent).join(""))) return
    for (const n of nodes) if (n.nodeType === 1) attrsDeep(n, visit)
    visit({ kind: "html", nodes })
  }
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) {
      if (SAME.has(norm(node.textContent))) { flush(); continue }
      run.push(node)
    } else if (node.nodeType === 1 && node.hasAttribute("data-i18n-generated")) {
      flush()
    } else if (node.nodeType === 1 && inlineOnly(node)) {
      run.push(node)
    } else {
      flush()
      if (node.nodeType === 1) {
        attrs(node, visit)
        if (!SKIP.has(node.tagName)) walk(node, visit)
      }
    }
  }
  flush()
}
function attrs(el, visit) {
  for (const name of ATTRS) if (el.hasAttribute(name) && meaningful(el.getAttribute(name))) visit({ kind: "attr", el, name })
}
function attrsDeep(el, visit) {
  attrs(el, visit)
  for (const child of el.children) attrsDeep(child, visit)
}
const segmentHtml = (s) => (s.kind === "html" ? s.nodes.map(htmlOf).join("") : s.kind === "inner" ? s.el.innerHTML : s.el.getAttribute(s.name))

/** Every segment of a page: [{ key, en, kind, apply(translation) }], in document order (head first). */
function segments(document) {
  const out = []
  const add = (kind, en, apply) => out.push({ key: keyOf(en), en: norm(en), kind, apply })
  const title = document.querySelector("title")
  if (title) add("title", title.textContent, (t) => { title.textContent = t })
  for (const [selector, name] of META) {
    const el = document.querySelector(selector)
    if (el && meaningful(el.getAttribute(name))) add("meta", el.getAttribute(name), (t) => el.setAttribute(name, t))
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const data = JSON.parse(script.textContent)
    const texts = []
    const each = (v, key) => {
      if (Array.isArray(v)) v.forEach((x) => each(x, key))
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) each(x, k)
      else if (typeof v === "string" && LD_KEYS.has(key) && meaningful(v)) texts.push(v)
    }
    each(data)
    for (const en of texts) add("ld", en, () => {})
    // JSON-LD is rewritten as a whole: see ldTranslate.
  }
  walk(document.body, (s) => {
    const en = segmentHtml(s)
    if (s.kind === "attr") add("attr", en, (t) => s.el.setAttribute(s.name, t))
    else if (s.kind === "inner") add("html", en, (t) => { s.el.innerHTML = t })
    else add("html", en, (t) => replaceNodes(document, s.nodes, t))
  })
  return out
}
function replaceNodes(document, nodes, html) {
  const box = document.createElement("div")
  box.innerHTML = html
  const first = nodes[0]
  for (const child of [...box.childNodes]) first.parentNode.insertBefore(child, first)
  for (const n of nodes) n.parentNode.removeChild(n)
}

// ---------------------------------------------------------------- pages

const read = (file) => readFileSync(join(SITE, file), "utf8")
const parse = (html) => parseHTML(html).document

/** The English page without what the build adds (alternates, og:locale, the language links), parsed. */
function sourceDocument(file) {
  return parse(strip(read(file)))
}

export function extract() {
  const seen = new Map()
  for (const file of PAGES) {
    for (const s of segments(sourceDocument(file))) {
      const known = seen.get(s.key)
      if (known) known.pages.includes(file) || known.pages.push(file)
      else seen.set(s.key, { key: s.key, kind: s.kind, en: s.en, pages: [file] })
    }
  }
  return [...seen.values()]
}

const translations = (language) => {
  const file = join(I18N, `${language.path}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
}

/** Internal links point at the same language; privacy and terms stay English; the rest stays as it is. */
function localLink(href, language) {
  const m = /^\/([a-z0-9/-]*)(#[\w-]+)?$/.exec(href)
  if (!m) return href
  const file = m[1] === "" ? "index.html" : `${m[1].replace(/\/$/, "")}.html`
  if (!PAGES.includes(file)) return href
  return urlPath(file, language) + (m[2] ?? "")
}

/** The canonical URL, og:url, lang and dir in the DOM (translated pages). */
function setHead(document, file, language) {
  const url = pageUrl(file, language)
  document.documentElement.setAttribute("lang", language.lang)
  if (language.rtl) document.documentElement.setAttribute("dir", "rtl")
  document.head.querySelector('link[rel="canonical"]')?.setAttribute("href", url)
  document.head.querySelector('meta[property="og:url"]')?.setAttribute("content", url)
}

/** What the build adds to a page, as text (the English pages stay byte for byte what their authors wrote). */
const GENERATED = [/^<link rel="alternate" hreflang="[^"]+" href="[^"]+" \/>\n/gm, /^<meta property="og:locale" content="[^"]+" \/>\n/gm, /<nav class="langs"[^>]*data-i18n-generated[^>]*>[\s\S]*?<\/nav>/g]
const strip = (html) => GENERATED.reduce((h, re) => h.replace(re, ""), html)

function addGenerated(html, file, language) {
  if (PAGES.includes(file)) {
    const alternates = LANGUAGES.flatMap((l) => [l.hreflang, ...(l.also ?? [])].map((code) => `<link rel="alternate" hreflang="${code}" href="${pageUrl(file, l)}" />\n`))
    alternates.push(`<link rel="alternate" hreflang="x-default" href="${pageUrl(file)}" />\n`)
    html = html.replace(/(<link rel="canonical" href="[^"]+" \/>\n)/, `$1${alternates.join("")}`)
    html = html.replace(/(<meta property="og:url" content="[^"]+" \/>\n)/, `$1<meta property="og:locale" content="${language.og}" />\n`)
  }
  // The language links at the end of the footer: the same page in every language (crawlable, no redirect).
  const target = PAGES.includes(file) ? file : "index.html"
  const links = LANGUAGES.map((l) =>
    l === language && PAGES.includes(file)
      ? `<span lang="${l.lang}" aria-current="page">${l.name}</span>`
      : `<a href="${urlPath(target, l)}" hreflang="${l.hreflang}" lang="${l.lang}">${l.name}</a>`
  ).join("")
  return html.replace(/<\/footer>/, `<nav class="langs" aria-label="Language" data-i18n-generated>${links}</nav></footer>`)
}

// linkedom writes void elements as <meta …>; the site writes them as <meta … />.
const voids = (html) => html.replace(/<(meta|link|img|br|hr|input|source)\b([^>]*?)\s*\/?>/g, (_, tag, rest) => `<${tag}${rest} />`)

/** JSON-LD with its texts translated, the page's own URL and inLanguage set, in the author's layout; the app's @id
 * stays one entity across languages. */
function ldTranslate(document, file, language, dict) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let text = script.textContent
    const pairs = new Map()
    const each = (v, key) => {
      if (Array.isArray(v)) v.forEach((x) => each(x, key))
      else if (v && typeof v === "object") {
        if (["WebPage", "Article", "FAQPage", "HowTo"].includes(v["@type"]) && typeof v.url === "string") pairs.set(`"url": ${JSON.stringify(v.url)}`, `"url": ${JSON.stringify(pageUrl(file, language))}`)
        for (const [k, x] of Object.entries(v)) each(x, k)
      } else if (typeof v === "string" && LD_KEYS.has(key) && meaningful(v) && dict[keyOf(v)] !== undefined) {
        pairs.set(JSON.stringify(v), JSON.stringify(dict[keyOf(v)]))
      }
    }
    each(JSON.parse(text))
    pairs.set(`"inLanguage": "en"`, `"inLanguage": ${JSON.stringify(language.lang)}`)
    for (const [from, to] of pairs) text = text.split(from).join(to)
    JSON.parse(text)
    script.textContent = text
  }
}

// linkedom leaves "&" bare in attribute values; the site writes "&amp;" (the App Store links' "&amp;ct=").
function escapeAttrs(html) {
  return html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/).map((part, i) =>
    i % 2 ? part : part.replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(/="([^"]*)"/g, (_, v) => `="${v.replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;")}"`))
  ).join("")
}

/** The page in a language: { html, missing: [keys] }. English: the source with alternates and the switcher. */
export function render(file, language) {
  const source = strip(read(file))
  if (language === ENGLISH) return { html: addGenerated(source, file, language), missing: [] }
  const document = parse(source)
  const dict = translations(language)
  const missing = []
  for (const s of segments(document)) {
    const t = dict[s.key]
    if (t === undefined) { missing.push(s.key); continue }
    s.apply(t)
  }
  ldTranslate(document, file, language, dict)
  for (const a of document.querySelectorAll("a[href]")) a.setAttribute("href", localLink(a.getAttribute("href"), language))
  setHead(document, file, language)
  const html = "<!doctype html>\n" + escapeAttrs(voids(document.documentElement.outerHTML)) + "\n"
  return { html: addGenerated(html, file, language), missing }
}

function sitemap() {
  const today = (file) => read(file).match(/"dateModified": "([\d-]+)"/)?.[1]
  const old = read("sitemap.xml")
  const lastmod = (file) => old.match(new RegExp(`<loc>${pageUrl(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc><lastmod>([\\d-]+)</lastmod>`))?.[1] ?? today(file) ?? "2026-11-07"
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">']
  for (const file of PAGES) {
    const alternates = LANGUAGES.flatMap((l) => [l.hreflang, ...(l.also ?? [])].map((code) => `<xhtml:link rel="alternate" hreflang="${code}" href="${pageUrl(file, l)}" />`))
    alternates.push(`<xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(file)}" />`)
    for (const l of LANGUAGES) lines.push(`  <url><loc>${pageUrl(file, l)}</loc><lastmod>${lastmod(file)}</lastmod>${alternates.join("")}</url>`)
  }
  for (const file of ENGLISH_ONLY) lines.push(`  <url><loc>${pageUrl(file)}</loc><lastmod>${lastmod(file)}</lastmod></url>`)
  lines.push("</urlset>", "")
  return lines.join("\n")
}

/** What the build writes: { path under site/: content }. */
export function outputs() {
  const files = {}
  const missing = {}
  for (const file of [...PAGES, ...ENGLISH_ONLY]) files[file] = render(file, ENGLISH).html
  for (const language of TRANSLATED) {
    for (const file of PAGES) {
      const page = render(file, language)
      files[`${language.path}/${file}`] = page.html
      if (page.missing.length) (missing[language.path] ??= new Set()) && page.missing.forEach((k) => missing[language.path].add(k))
    }
  }
  files["sitemap.xml"] = sitemap()
  return { files, missing }
}

// ---------------------------------------------------------------- checks

const tagsOf = (html) => [...html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)].map((m) => `${m[0].startsWith("</") ? "/" : ""}${m[1].toLowerCase()}${(m[2].match(/\s(href|class|id|data-[\w-]+)="[^"]*"/g) ?? []).sort().join("")}`).sort()

/** Translations whose markup differs from the English one, keys no page has, keys a page has but no translation. */
export function problems(language, source = extract()) {
  const dict = translations(language)
  const byKey = new Map(source.map((s) => [s.key, s]))
  const out = []
  for (const [key, t] of Object.entries(dict)) {
    const s = byKey.get(key)
    if (!s) { out.push(`${key}: no such segment (English changed?)`); continue }
    if (typeof t !== "string" || !t.trim()) { out.push(`${key}: empty`); continue }
    if (s.kind === "html" && tagsOf(s.en).join() !== tagsOf(t).join()) out.push(`${key}: markup differs\n  en: ${s.en}\n  ${language.path}: ${t}`)
    if (s.kind !== "html" && /<[a-z]/i.test(t)) out.push(`${key}: markup in a plain text`)
    if (/✦/.test(s.en) !== /✦/.test(t)) out.push(`${key}: ✦ ${/✦/.test(s.en) ? "lost" : "added"}`)
  }
  const missing = source.filter((s) => !(s.key in dict)).map((s) => s.key)
  return { problems: out, missing }
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === "extract") {
    mkdirSync(I18N, { recursive: true })
    const source = extract()
    writeFileSync(join(I18N, "source.json"), JSON.stringify(source, null, 1) + "\n")
    console.log(`${source.length} segments, ${source.reduce((n, s) => n + s.en.length, 0)} characters → site-i18n/source.json`)
  } else if (command === "build") {
    const { files, missing } = outputs()
    for (const l of TRANSLATED) rmSync(join(SITE, l.path), { recursive: true, force: true })
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(SITE, path)), { recursive: true })
      writeFileSync(join(SITE, path), content)
    }
    console.log(`${Object.keys(files).length} files written`)
    for (const [lang, keys] of Object.entries(missing)) console.log(`${lang}: ${keys.size} segments still English`)
  } else if (command === "check" || command === "status") {
    const source = extract()
    const only = process.argv[3]
    let bad = 0
    for (const l of TRANSLATED.filter((x) => !only || x.path === only)) {
      const { problems: p, missing } = problems(l, source)
      console.log(`${l.path}: ${source.length - missing.length}/${source.length} translated${p.length ? `, ${p.length} problems` : ""}`)
      if (command === "check") for (const line of p) console.log("  " + line)
      bad += p.length
    }
    process.exit(command === "check" && bad ? 1 : 0)
  } else {
    console.log("usage: node scripts/site-i18n.mjs extract|build|check|status")
    process.exit(2)
  }
}
