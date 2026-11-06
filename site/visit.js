// Site counter: which source brought this visit, and which App Store button was tapped. Sends two values
// from fixed lists (src/shared/site.ts) to /api/v2/site. No cookie, nothing stored on the device, and not
// the address of the page the visitor came from: only its source's name.
(() => {
  // On a Mac the App Store buttons open the Mac App Store and say so (the owner, 2.5: on a Mac the site offered the
  // iPhone and iPad app). An iPad's Safari says "Macintosh" too, but it has touch.
  if (/Macintosh/.test(navigator.userAgent || "") && !(navigator.maxTouchPoints > 1)) {
    for (const link of document.querySelectorAll('a[href^="https://apps.apple.com/"]')) {
      link.href = link.href.replace(/([?&])mt=8(?=&|$)/, "$1mt=12")
      const name = link.querySelector("span") || link
      for (const node of name.childNodes) if (node.nodeType === 3 && node.textContent.trim() === "App Store") node.textContent = "Mac App Store"
    }
  }

  const PAGES = {
    "/": "home",
    "/features": "features",
    "/safari-ai-extension-iphone": "safari_ai",
    "/notes-while-reading-safari": "notes",
    "/safari-summary-vs-chatgpt": "compare",
    "/support": "support",
    "/privacy": "privacy",
    "/terms": "terms",
    "/cases": "cases",
    "/cases/replies-and-forms": "case_fill",
    "/cases/studying": "case_study",
    "/cases/shopping": "case_shop",
    "/cases/planning": "case_plan"
  }
  const OWN = /(^|\.)(context-flow\.app|aisidebar\.netlify\.app)$/
  // A referrer's host or a utm_source value → the source; the first match wins (Gemini before Google).
  const SOURCES = [
    ["chatgpt", /(^|\.)(chatgpt\.com|openai\.com)$|^(chatgpt|openai)/],
    ["perplexity", /(^|\.)perplexity\.ai$|^perplexity/],
    ["copilot", /(^|\.)copilot\.microsoft\.com$|^copilot/],
    ["gemini", /(^|\.)gemini\.google\.com$|^gemini/],
    ["claude", /(^|\.)claude\.ai$|^claude/],
    ["bing", /(^|\.)bing\.com$|^bing/],
    ["google", /(^|\.)google(\.[a-z]{2,3}){1,2}$|^google/],
    ["duckduckgo", /(^|\.)duckduckgo\.com$|^duckduckgo/]
  ]

  const path = location.pathname.replace(/\.html$/, "").replace(/^\/index$/, "/").replace(/(.)\/$/, "$1")
  const page = PAGES[path]
  if (!page) return
  const src = source()
  send({ kind: "site_visit", src, page })

  document.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href^="https://apps.apple.com/"]') : null
    const label = link ? new URL(link.href).searchParams.get("ct") : null
    if (label) send({ kind: "site_click", src, label })
  }, true)

  function source() {
    const utm = (new URLSearchParams(location.search).get("utm_source") || "").trim().toLowerCase()
    if (utm) return named(utm) || "other"
    let host = ""
    try { host = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : "" } catch { host = "" }
    if (!host) return "direct"
    if (OWN.test(host)) return "site"
    return named(host) || "other"
  }

  function named(value) {
    const hit = SOURCES.find(([, test]) => test.test(value))
    return hit ? hit[0] : null
  }

  function send(body) {
    const data = JSON.stringify(body)
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/api/v2/site", data)) return
    } catch { /* fall through to fetch */ }
    fetch("/api/v2/site", { method: "POST", body: data, keepalive: true }).catch(() => {})
  }
})()
