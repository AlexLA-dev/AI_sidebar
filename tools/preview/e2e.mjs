// End-to-end check of the extension in Chromium against tools/preview/server.mts.
// Usage: node tools/preview/e2e.mjs <extensionDir> <outDir>   (needs `playwright`)
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"

const [extDir, outDir = "/tmp/cf-e2e"] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const BASE = "http://localhost:8787"
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1"
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

const results = []
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`) }

async function launch(ua, viewport, extra = {}) {
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    executablePath: process.env.CHROMIUM ?? undefined,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    userAgent: ua,
    viewport,
    deviceScaleFactor: 2,
    ...extra
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent("serviceworker")
  return { ctx, sw }
}

await fetch(`${BASE}/reset`)

// ---------------------------------------------------------------- iPhone
{
  const { ctx, sw } = await launch(IPHONE_UA, { width: 430, height: 932 }, { hasTouch: true })
  // close the welcome tab opened on install
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
  const page = await ctx.newPage()
  await page.goto(`${BASE}/article`)
  const fab = page.locator(".cf-fab")
  await fab.waitFor({ timeout: 8000 })
  check("FAB visible on iPhone", await fab.isVisible())
  await page.screenshot({ path: `${outDir}/iphone-1-page.png` })

  await fab.click()
  await page.locator(".cf-panel.in").waitFor()
  await page.waitForTimeout(400)
  check("panel opens as bottom sheet", (await page.locator(".cf[data-layout=sheet]").count()) === 1)
  const chips = await page.locator(".cf-empty .cf-chip").allInnerTexts()
  check("quick actions shown", chips.length === 4, chips.join(", "))
  await page.screenshot({ path: `${outDir}/iphone-2-empty.png` })

  await page.locator(".cf-chip", { hasText: "Summarize" }).click()
  const consent = page.locator(".cf-card.consent")
  await consent.waitFor()
  check("consent requested before first request", await consent.isVisible())
  await page.screenshot({ path: `${outDir}/iphone-3-consent.png` })
  await page.locator(".cf-card.consent .cf-primary").click()
  await page.locator(".cf-msg.ai .md").first().waitFor({ timeout: 10000 })
  await page.waitForFunction(() => !document.querySelector("contextflow-root")?.shadowRoot?.querySelector(".cf-send.stop"), null, { timeout: 15000 })
  const answer = await page.locator(".cf-msg.ai .md").first().innerText()
  check("answer streamed and rendered", answer.includes("56 still work four days"), answer.slice(0, 60))
  check("user bubble shows short label", (await page.locator(".cf-bubble-user").first().innerText()) === "Summarize")
  const usage = await page.locator(".cf-usage").innerText()
  check("usage line updated", /4 of 5/.test(usage), usage)
  await page.screenshot({ path: `${outDir}/iphone-4-answer.png` })

  // exhaust the free allowance
  for (let i = 0; i < 4; i++) {
    await page.locator(".cf-input textarea").fill(`Question ${i}: is this worth trying for a startup?`)
    await page.locator(".cf-send").click()
    await page.waitForFunction(() => !document.querySelector("contextflow-root")?.shadowRoot?.querySelector(".cf-send.stop"), null, { timeout: 15000 })
  }
  await page.locator(".cf-input textarea").fill("One more question")
  await page.locator(".cf-send").click()
  await page.locator(".cf-card.limit").waitFor({ timeout: 8000 })
  check("limit card after 5 free answers", await page.locator(".cf-card.limit").isVisible(), await page.locator(".cf-card.limit strong").innerText())
  await page.screenshot({ path: `${outDir}/iphone-5-limit.png` })

  await page.locator(".cf-header button[aria-label=Settings]").click()
  await page.locator(".cf-settings").waitFor()
  await page.screenshot({ path: `${outDir}/iphone-6-settings.png` })
  check("settings view renders", (await page.locator(".cf-settings .cf-group").count()) >= 5)

  // chats persist per page
  await page.reload()
  await page.locator(".cf-fab").click()
  await page.locator(".cf-msg.ai").first().waitFor({ timeout: 5000 })
  check("chat restored after reload", (await page.locator(".cf-msg").count()) >= 2)

  // dark mode
  await page.emulateMedia({ colorScheme: "dark" })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${outDir}/iphone-7-dark.png` })
  await ctx.close()
}

// ---------------------------------------------------------------- Mac
{
  await fetch(`${BASE}/reset`)
  const { ctx, sw } = await launch(MAC_UA, { width: 1440, height: 900 })
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close()
  const page = await ctx.newPage()
  await page.goto(`${BASE}/article`)
  await page.waitForSelector("contextflow-root", { state: "attached" })
  check("no FAB on Mac by default", (await page.locator(".cf-fab").count()) === 0)

  // toolbar click = background sends "toggle"
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "http://localhost:8787/*" })
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" })
  })
  await page.locator(".cf-panel.in").waitFor()
  check("toolbar toggle opens side panel", (await page.locator(".cf[data-layout=side]").count()) === 1)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${outDir}/mac-1-panel.png` })

  // consent then ask a typed question
  await page.locator(".cf-input textarea").fill("Is this worth trying for a 10-person startup?")
  await page.keyboard.press("Enter")
  await page.locator(".cf-card.consent .cf-primary").click()
  await page.waitForFunction(() => !document.querySelector("contextflow-root")?.shadowRoot?.querySelector(".cf-send.stop") && document.querySelector("contextflow-root")?.shadowRoot?.querySelector(".cf-msg.ai .md"), null, { timeout: 15000 })
  check("typed question answered", (await page.locator(".cf-msg.ai .md ol li").count()) === 3)
  await page.screenshot({ path: `${outDir}/mac-2-answer.png` })

  // Esc closes, selection bubble appears after selecting text
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  check("Esc closes the panel", (await page.locator(".cf-panel").count()) === 0)
  const quote = page.locator("blockquote")
  const box = await quote.boundingBox()
  await page.mouse.move(box.x + 5, box.y + 8)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 8, { steps: 8 })
  await page.mouse.up()
  await page.locator(".cf-bubble").waitFor({ timeout: 3000 })
  check("selection bubble on Mac", await page.locator(".cf-bubble").isVisible())
  await page.screenshot({ path: `${outDir}/mac-3-bubble.png` })
  await page.locator(".cf-bubble button", { hasText: "Explain" }).click()
  await page.waitForFunction(() => document.querySelector("contextflow-root")?.shadowRoot?.querySelectorAll(".cf-msg.ai .md").length >= 2 && !document.querySelector("contextflow-root")?.shadowRoot?.querySelector(".cf-send.stop"), null, { timeout: 15000 })
  const chip = await page.locator(".cf-ctx").innerText()
  check("selection context used", /Selection/.test(chip), chip)
  await page.screenshot({ path: `${outDir}/mac-4-selection-answer.png` })
  await ctx.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
