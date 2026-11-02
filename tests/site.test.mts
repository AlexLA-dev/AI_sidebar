import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"

const dir = new URL("../site/", import.meta.url)
const read = (name: string) => readFileSync(new URL(name, dir), "utf8")
const ORIGIN = "https://context-flow.app"
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"))
const indexable = pages.filter((f) => !/<meta name="robots" content="noindex/.test(read(f)))
const urlOf = (file: string) => `${ORIGIN}/${file === "index.html" ? "" : file.replace(/\.html$/, "")}`
const sitemap = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const answerPages = ["safari-ai-extension-iphone.html", "notes-while-reading-safari.html", "safari-summary-vs-chatgpt.html"]

test("every App Store button is a campaign link with its own short label", () => {
  const campaign = /^https:\/\/apps\.apple\.com\/app\/apple-store\/id6759115793\?pt=119037986&amp;ct=([a-z0-9_]{1,30})&amp;mt=8$/
  const labels = new Set<string>()
  for (const file of pages) {
    for (const [, href] of read(file).matchAll(/href="(https:\/\/apps\.apple\.com[^"]*)"/g)) {
      const m = href.match(campaign)
      assert.ok(m, `${file}: ${href} is not a campaign link`)
      labels.add(m[1])
    }
  }
  assert.deepEqual([...labels].sort(), ["page_compare", "page_notes", "page_safari_ai", "site_footer", "site_hero", "site_pricing"])
})

test("the Smart App Banner carries the campaign and provider tokens on every indexable page", () => {
  for (const file of indexable) {
    assert.match(read(file), /<meta name="apple-itunes-app" content="app-id=6759115793, affiliate-data=ct=site_banner&amp;pt=119037986" \/>/, file)
  }
})

test("the sitemap lists exactly the indexable pages, and each page names itself canonical", () => {
  assert.deepEqual([...sitemap].sort(), indexable.map(urlOf).sort())
  for (const file of indexable) {
    const canonical = read(file).match(/<link rel="canonical" href="([^"]+)" \/>/)?.[1]
    assert.equal(canonical, urlOf(file), file)
    assert.ok(read(file).includes(`<meta property="og:url" content="${urlOf(file)}" />`), `${file}: og:url`)
  }
})

test("robots.txt lets search and AI crawlers in and points to the sitemap", () => {
  const robots = read("robots.txt")
  for (const agent of ["*", "bingbot", "OAI-SearchBot", "ChatGPT-User"]) assert.ok(robots.includes(`User-agent: ${agent}\n`), agent)
  assert.match(robots, /^Allow: \/$/m)
  assert.doesNotMatch(robots, /^Disallow: \/$/m)
  assert.match(robots, new RegExp(`^Sitemap: ${ORIGIN}/sitemap.xml$`, "m"))
})

test("JSON-LD parses, and the landing page describes the app", () => {
  for (const file of pages) {
    for (const [, json] of read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(json)
  }
  const app = JSON.parse(read("index.html").match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1])
  assert.equal(app["@type"], "SoftwareApplication")
  assert.equal(app.downloadUrl, "https://apps.apple.com/app/id6759115793")
})

test("the IndexNow key file holds its own name", () => {
  const key = readdirSync(dir).find((f) => /^[0-9a-f]{32}\.txt$/.test(f))
  assert.ok(key)
  assert.equal(read(key), key.replace(/\.txt$/, ""))
})

test("links between pages lead to files that exist", () => {
  for (const file of pages) {
    for (const [, path] of read(file).matchAll(/href="\/([a-z0-9-]*)(?:#[a-z]+)?"/g)) {
      assert.ok(existsSync(new URL(path ? `${path}.html` : "index.html", dir)), `${file} → /${path}`)
    }
  }
})

test("the old host sends every page to the domain and never touches the API", () => {
  const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8")
  const rules = toml.split("[[redirects]]").slice(1).map((block) => Object.fromEntries([...block.matchAll(/^\s*(\w+) = "?([^"\n]*)"?$/gm)].map((m) => [m[1], m[2]])))
  const OLD = "https://aisidebar.netlify.app"
  const moved = rules.filter((r) => r.from.startsWith(OLD))
  for (const r of moved) {
    const path = r.from.slice(OLD.length)
    assert.doesNotMatch(path, /^\/(api|\.netlify|confirm|email-confirmed)\b|\*/, r.from)
    assert.equal(r.to, `${ORIGIN}${path.replace(/(index)?\.html$/, "")}`, r.from)
    assert.equal(r.status, "301", r.from)
    assert.equal(r.force, "true", r.from)
  }
  const paths = new Set(moved.map((r) => r.from.slice(OLD.length)))
  for (const file of pages) {
    const path = file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`
    assert.ok(paths.has(path) && paths.has(`/${file}`), `${file} isn't redirected from the old host`)
  }
})

test("the answer pages promise nothing that isn't shipped or free", () => {
  // Search over chats isn't shipped, videos and PDFs are Pro-only, and answer counts aren't promised.
  const banned = /search (your|across|over) chats|ask your chats|video|pdf|\d+ (free )?answers|answers (a|every|per) (day|week)/i
  for (const file of answerPages) {
    const text = read(file).replace(/<[^>]+>/g, " ")
    assert.doesNotMatch(text, banned, file)
  }
})
