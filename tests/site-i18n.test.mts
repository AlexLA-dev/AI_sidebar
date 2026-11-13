import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"

// The site in every app language (2.6): scripts/site-i18n.mjs writes site/<language>/… from the English pages and
// site-i18n/<language>.json. These checks read what's committed.
// @ts-expect-error: a plain .mjs module
import { ENGLISH_ONLY, LANGUAGES, PAGES, TRANSLATED, extract, outputs, pageUrl, problems, urlPath } from "../scripts/site-i18n.mjs"

const dir = new URL("../site/", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, dir), "utf8")
const fileOf = (language: any, page: string) => (language.path ? `${language.path}/${page}` : page)

test("the language pages, the English pages' alternates and the sitemap are what the build writes", () => {
  const { files } = outputs()
  for (const [path, content] of Object.entries(files) as Array<[string, string]>) {
    assert.ok(existsSync(new URL(path, dir)), `${path} is missing: run node scripts/site-i18n.mjs build`)
    assert.equal(read(path), content, `${path} is out of date: run node scripts/site-i18n.mjs build`)
  }
})

test("every page names itself canonical and every language version, x-default English, both ways", () => {
  for (const page of PAGES) {
    for (const language of LANGUAGES) {
      const html = read(fileOf(language, page))
      const own = pageUrl(page, language)
      assert.ok(html.includes(`<link rel="canonical" href="${own}" />`), `${fileOf(language, page)}: canonical`)
      assert.ok(html.includes(`<meta property="og:url" content="${own}" />`), `${fileOf(language, page)}: og:url`)
      assert.ok(html.includes(`<meta property="og:locale" content="${language.og}" />`), `${fileOf(language, page)}: og:locale`)
      for (const other of LANGUAGES) {
        assert.ok(html.includes(`<link rel="alternate" hreflang="${other.hreflang}" href="${pageUrl(page, other)}" />`), `${fileOf(language, page)} → ${other.hreflang}`)
      }
      assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${pageUrl(page)}" />`), `${fileOf(language, page)}: x-default`)
    }
  }
  // Traditional Chinese answers for Taiwan, Hong Kong and Macao; Simplified for China and Singapore.
  const home = read("index.html")
  for (const code of ["zh-TW", "zh-HK", "zh-MO"]) assert.ok(home.includes(`hreflang="${code}" href="https://context-flow.app/zh-hant/"`), code)
  for (const code of ["zh-CN", "zh-SG"]) assert.ok(home.includes(`hreflang="${code}" href="https://context-flow.app/zh-hans/"`), code)
})

test("each language page says its language and direction, keeps the counter, and links within its language", () => {
  for (const language of TRANSLATED) {
    for (const page of PAGES) {
      const file = fileOf(language, page)
      const html = read(file)
      const tag = html.match(/<html[^>]*>/)![0]
      assert.ok(tag.includes(` lang="${language.lang}"`), `${file}: ${tag}`)
      assert.equal(tag.includes(' dir="rtl"'), !!language.rtl, `${file}: ${tag}`)
      assert.ok(html.includes('<script src="/visit.js" defer></script>'), `${file}: visit.js`)
      // Internal links stay in the language; privacy, terms and the alternative pages are English only; the language
      // links go anywhere.
      const body = html.replace(/<nav class="langs"[\s\S]*?<\/nav>/, "")
      for (const [, href] of body.matchAll(/href="(\/[^"]*)"/g)) {
        if (/^\/(icon|style|cases\.css|clips)/.test(href)) continue
        if (ENGLISH_ONLY.some((page: string) => href === urlPath(page))) continue
        assert.ok(href.startsWith(`/${language.path}/`), `${file}: ${href} leaves the language`)
      }
      // Never an /api or /.netlify link, never a redirect script.
      assert.doesNotMatch(html, /href="\/(api|\.netlify)/, file)
      assert.doesNotMatch(html, /location\.(href|replace|assign)\s*=|navigator\.language/, file)
    }
  }
})

test("the language links list every language, the current one unlinked", () => {
  for (const language of LANGUAGES) {
    const html = read(fileOf(language, "features.html"))
    const nav = html.match(/<nav class="langs"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? ""
    for (const other of LANGUAGES) {
      if (other === language) assert.ok(nav.includes(`<span lang="${other.lang}" aria-current="page">${other.name}</span>`), `${language.hreflang}: current`)
      else assert.ok(nav.includes(`<a href="${urlPath("features.html", other)}" hreflang="${other.hreflang}" lang="${other.lang}">${other.name}</a>`), `${language.hreflang} → ${other.hreflang}`)
    }
  }
  for (const page of ENGLISH_ONLY) assert.match(read(page), /<nav class="langs"/, page)
})

test("titles and descriptions are translated in every language, with the English markup kept", () => {
  // The search result's headline and text: never left English ("Support — ContextFlow" may read the same in German).
  const source = extract()
  const head = source.filter((s: any) => s.kind === "title" || s.kind === "meta").map((s: any) => s.key)
  for (const language of TRANSLATED) {
    const { problems: bad, missing } = problems(language, source)
    assert.deepEqual(bad, [], language.path)
    assert.deepEqual(head.filter((key: string) => missing.includes(key)), [], `${language.path}: titles or descriptions still English`)
    for (const page of PAGES) {
      const html = read(fileOf(language, page))
      assert.notEqual(html.match(/<meta name="description" content="([^"]*)"/)![1], read(page).match(/<meta name="description" content="([^"]*)"/)![1], `${fileOf(language, page)}: description`)
      for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(json)
    }
  }
})

test("the sitemap lists every page in every language with its alternates, privacy and terms in English", () => {
  const sitemap = read("sitemap.xml")
  for (const page of PAGES) {
    for (const language of LANGUAGES) assert.ok(sitemap.includes(`<loc>${pageUrl(page, language)}</loc>`), pageUrl(page, language))
  }
  for (const page of ENGLISH_ONLY) assert.ok(sitemap.includes(`<loc>${pageUrl(page)}</loc>`), page)
  assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/)
  assert.equal([...sitemap.matchAll(/<loc>/g)].length, PAGES.length * LANGUAGES.length + ENGLISH_ONLY.length)
})
