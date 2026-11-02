// Tells Bing (and the other IndexNow engines) that the site's pages changed, so they recrawl them
// without waiting. Reads the URLs from site/sitemap.xml; the key file is site/<key>.txt.
// Run after a deploy of main has gone live:
//   node tools/site/indexnow.mjs            → submits every URL in the sitemap
//   node tools/site/indexnow.mjs --dry-run  → prints what it would send
import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "../../site")
const HOST = "aisidebar.netlify.app"

const keyFile = readdirSync(SITE).find((f) => /^[0-9a-f]{32}\.txt$/.test(f))
if (!keyFile) throw new Error("No IndexNow key file (site/<32 hex>.txt)")
const key = readFileSync(resolve(SITE, keyFile), "utf8").trim()
const urlList = [...readFileSync(resolve(SITE, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const body = { host: HOST, key, keyLocation: `https://${HOST}/${keyFile}`, urlList }

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(body, null, 2))
} else {
  const live = await fetch(body.keyLocation).then((r) => (r.ok ? r.text() : ""))
  if (live.trim() !== key) throw new Error(`${body.keyLocation} doesn't serve the key yet: deploy first`)
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  })
  // 200 and 202 both mean accepted; 403 = key not valid, 422 = URLs don't belong to the host.
  console.log(`IndexNow: ${res.status} ${res.statusText} for ${urlList.length} URLs`)
  if (res.status >= 300) process.exitCode = 1
}
