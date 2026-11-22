#!/usr/bin/env node
// The cookie closer's test pages for real browsers (2.7.1): every consent platform's markup and the site-made banners
// of tests/fixtures/cookies/pages.mjs, one page each, with the pages' own behaviour (a press hides the banner, the
// settings open). Each page says what the closer pressed («pressed: …») and what it was meant to do.
//
//   node tools/cookies/stand.mjs [port]        (default 8940)  →  http://localhost:8940/
import { createServer } from "node:http"

import { PAGE_SCRIPT, PAGES } from "../../tests/fixtures/cookies/pages.mjs"

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8940)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

function page(p) {
  const want = p.expect.status === "done" ? `answered by ${p.expect.via}` : p.expect.status === "left" ? `left alone (${p.expect.why})` : "not a banner: nothing pressed"
  const shadow = p.shadow
    ? `<script>(function(){var h=document.getElementById(${JSON.stringify(p.shadow.host)});var r=h.attachShadow({mode:"open"});r.innerHTML=${JSON.stringify(p.shadow.html)};})();</script>`
    : ""
  return `<!doctype html><html lang="${esc(p.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name)}</title><style>body{font:16px system-ui;margin:20px;line-height:1.45}main{max-width:640px}#pressed{font-weight:600;color:#0a6}</style></head>
<body><main><h1>${esc(p.name)}</h1><p>Expected: ${esc(want)}.</p><p id="pressed">pressed: nothing</p><p>${"Some page text to read. ".repeat(30)}</p><p><a href="/">All pages</a></p></main>
${p.html}${shadow}<script>${PAGE_SCRIPT}</script></body></html>`
}

function index() {
  const rows = PAGES.map((p) => `<li><a href="/p/${encodeURIComponent(p.name)}">${esc(p.name)}</a> — ${esc(p.expect.status)}${p.expect.why ? ` (${esc(p.expect.why)})` : ""}</li>`).join("")
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cookie closer pages</title><body style="font:16px system-ui;margin:20px"><h1>Cookie closer pages</h1><ol>${rows}</ol></body>`
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  const m = /^\/p\/(.+)$/.exec(url.pathname)
  const p = m ? PAGES.find((x) => x.name === decodeURIComponent(m[1])) : null
  if (m && !p) return res.writeHead(404).end("no such page")
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
  res.end(p ? page(p) : index())
}).listen(PORT, () => console.log(`cookie pages on http://localhost:${PORT}/`))
