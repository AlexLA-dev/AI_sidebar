// The cookie closer (2.7.1): label matching in our languages, «only Accept → do nothing», each consent platform's
// markup and site-made banners in ten languages (tests/fixtures/cookies/pages.mjs), the counts and the settings.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { parseHTML } from "linkedom"

import { aboutCookies, chooseButton, labelKind } from "../src/shared/cookies/labels.ts"
import { closesOn, counted, readState, rollDay, tell, TOLD_TIMES, withSite } from "../src/shared/cookies/state.ts"
import { closeOnce, forgetBanners, safeControl, type Env } from "../src/content/cookies/closer.ts"
import { consentFrame } from "../src/content/cookies/frameMatch.ts"
import { FRAME_RULES } from "../src/content/cookies/rules.ts"
import { FEATURES, useFields } from "../src/shared/usage.ts"
// @ts-expect-error: plain JavaScript fixtures
import { GENERIC_PAGES, PAGE_SCRIPT, PAGES, PLATFORM_PAGES } from "./fixtures/cookies/pages.mjs"

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

test("reject labels in our 15 languages are rejects", () => {
  const rejects = [
    "Reject all", "Reject All Cookies", "Decline", "Only necessary", "Use necessary cookies only", "Continue without accepting",
    "Do not consent", "Necessary cookies only", "Required Only", "Disagree to all",
    "Отклонить все", "Только необходимые", "Принять только необходимые", "Відхилити все", "Лише необхідні",
    "Alle ablehnen", "Nur notwendige Cookies", "Nur essenzielle Cookies akzeptieren", "Tout refuser", "Continuer sans accepter →",
    "Rechazar todas", "Solo necesarias", "Rifiuta tutti", "Solo necessari", "Rejeitar todos", "Apenas necessários",
    "Tümünü reddet", "Yalnızca gerekli çerezler", "رفض الكل", "الضرورية فقط", "すべて拒否", "必須のみ", "모두 거부", "필수 쿠키만 허용",
    "全部拒绝", "仅必要", "全部拒絕", "僅必要", "Từ chối tất cả", "Chỉ cần thiết", "Alles weigeren", "Odrzuć wszystkie"
  ]
  for (const label of rejects) assert.equal(labelKind(label), "reject", label)
})

test("accept labels are accepts, and never pressed", () => {
  const accepts = [
    "Accept all", "Accept All Cookies", "Allow all", "OK", "Got it!", "I agree", "Agree and close", "Yes, I'm happy",
    "Принять все", "Согласен", "Прийняти все", "Alle akzeptieren", "Zustimmen", "Tout accepter", "J'accepte", "Aceptar todas",
    "Accetta tutti", "Aceitar todos", "Tümünü kabul et", "قبول الكل", "すべて同意する", "모두 동의", "全部接受", "接受所有",
    "Chấp nhận tất cả", "Alles accepteren"
  ]
  for (const label of accepts) {
    assert.equal(labelKind(label), "accept", label)
    assert.deepEqual(chooseButton([label]), { leave: "only_accept" }, label)
  }
})

test("reject beats the accept words it holds; settings that mention reject are settings", () => {
  assert.equal(labelKind("Accept only necessary"), "reject")
  assert.equal(labelKind("Continue without accepting"), "reject")
  assert.equal(labelKind("I do not accept"), "reject")
  assert.equal(labelKind("Nur notwendige akzeptieren"), "reject")
  assert.equal(labelKind("Manage or reject cookies"), "settings")
  assert.equal(labelKind("Cookie settings"), "settings")
  assert.equal(labelKind("Настройки"), "settings")
  // A banner's sentence is no button.
  assert.equal(labelKind("We use cookies. You can reject them in your browser settings at any time if you want to."), null)
})

test("only Accept → nothing pressed; Accept and settings → nothing pressed; a reject among them is chosen", () => {
  assert.deepEqual(chooseButton(["Accept all"]), { leave: "only_accept" })
  assert.deepEqual(chooseButton(["Accept all", "Cookie settings"]), { leave: "only_accept" })
  assert.deepEqual(chooseButton(["Принять", "Настроить"]), { leave: "only_accept" })
  assert.deepEqual(chooseButton(["Yes, I'm happy", "Manage or reject cookies"]), { leave: "only_accept" })
  assert.deepEqual(chooseButton(["Learn more", "Privacy policy"]), { leave: "none" })
  assert.deepEqual(chooseButton([]), { leave: "none" })
  assert.deepEqual(chooseButton(["Settings", "Reject all", "Accept all"]), { press: 1, label: "Reject all" })
  // The whole label one of ours beats a label that only holds one.
  assert.deepEqual(chooseButton(["No thanks, take me back", "Reject all", "Accept"]), { press: 1, label: "Reject all" })
})

test("a banner is about cookies by the word in any script; consent words count only with a platform's sign", () => {
  assert.ok(aboutCookies("我们使用Cookie来改善您的体验"))
  assert.ok(aboutCookies("当サイトではクッキーを使用しています"))
  assert.ok(aboutCookies("Мы используем файлы cookie"))
  assert.ok(aboutCookies("Bu sitede çerezler kullanılır"))
  assert.ok(aboutCookies("نستخدم ملفات تعريف الارتباط"))
  assert.ok(!aboutCookies("We value your privacy"))
  assert.ok(aboutCookies("We value your privacy", true))
  assert.ok(!aboutCookies("Subscribe to our newsletter for 10% off"))
})

// ------------------------------------------------------------------------------------------------- the pages

function hiddenUp(el: Element | null): boolean {
  for (let e: Element | null = el; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot)?.host ?? null)) {
    if (e.hasAttribute("hidden") || (e as HTMLElement).style?.display === "none") return true
  }
  return false
}

function floatsUp(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot)?.host ?? null)) {
    const pos = (e as HTMLElement).style?.position
    if (pos === "fixed" || pos === "sticky" || e.matches("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]")) return true
  }
  return false
}

interface Page {
  name: string
  html: string
  shadow?: { host: string; html: string }
  expect: { status: string; via?: string; why?: string }
}

function load(page: Page): { env: Env; doc: Document; window: Window } {
  forgetBanners()
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body><main><h1>Page</h1><p>Its own words.</p></main>${page.html}<p id="pressed"></p></body></html>`)
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: (window as any).ShadowRoot })
  ;(window as any).__pressed = []
  // linkedom keeps a box's state in its attribute: `checked` and a click on a box, as a browser has them.
  Object.defineProperty((window as any).HTMLInputElement.prototype, "checked", {
    configurable: true,
    get(this: Element) { return this.hasAttribute("checked") },
    set(this: Element, on: boolean) { if (on) this.setAttribute("checked", ""); else this.removeAttribute("checked") }
  })
  document.addEventListener("click", (e: Event) => {
    const box = e.target as HTMLInputElement
    if (box?.tagName === "INPUT" && box.getAttribute("type") === "checkbox") box.checked = !box.checked
  }, true)
  new Function("window", "document", PAGE_SCRIPT)(window, document)
  if (page.shadow) {
    const host = document.getElementById(page.shadow.host)!
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML = page.shadow.html
    // In the stand the page's script hears it through the shadow root; here it's told directly.
    root.addEventListener("click", (e: Event) => {
      const b = (e.target as Element).closest("[data-act]")
      if (!b) return
      ;((window as any).__pressed ??= []).push(b.textContent!.trim())
      if (b.getAttribute("data-act") === "hide") (b.closest("[data-banner]") as HTMLElement).hidden = true
    })
  }
  const env: Env = {
    doc: document as unknown as Document,
    visible: (el) => el.isConnected && !hiddenUp(el),
    floats: floatsUp,
    until: async (_root, _ms, ready) => ready(),
    sign: !!document.querySelector("iframe[name=__tcfapiLocator]")
  }
  return { env, doc: document as unknown as Document, window: window as unknown as Window }
}

function pressedOk(doc: Document, page: Page): void {
  const expected = [...doc.querySelectorAll("[data-expect]"), ...(page.shadow ? doc.getElementById(page.shadow.host)!.shadowRoot!.querySelectorAll("[data-expect]") : [])]
  const pressed = ((globalThis as any).window.__pressed ?? []) as string[]
  if (page.expect.status === "done") {
    assert.ok(expected.length, `${page.name}: the fixture marks the button to press`)
    // Every press is the platform's way: the expected button last (settings opened first, if they had to be).
    assert.equal(pressed.at(-1), expected.at(-1)!.textContent!.trim(), `${page.name}: pressed ${JSON.stringify(pressed)}`)
    for (const p of pressed) assert.notEqual(labelKind(p), "accept", `${page.name}: never «${p}»`)
  } else {
    assert.deepEqual(pressed, [], `${page.name}: nothing pressed`)
  }
}

for (const page of PAGES as Page[]) {
  test(`page ${page.name}: ${page.expect.status}${page.expect.why ? ` (${page.expect.why})` : ""}`, async () => {
    const { env, doc } = load(page)
    const result = await closeOnce(env)
    assert.equal(result.status, page.expect.status, `${page.name}: ${JSON.stringify(result)}`)
    if ("via" in result && page.expect.via) assert.equal(result.via, page.expect.via)
    if (result.status === "left") assert.equal(result.why, page.expect.why)
    pressedOk(doc, page)
    // Answered banners are gone; left ones are all still there (nothing hidden).
    const banners = [...doc.querySelectorAll("[data-banner]")]
    if (page.expect.status === "left") assert.ok(banners.every((b) => !b.hasAttribute("hidden")), `${page.name}: nothing hidden`)
    // The optional switches were turned off before saving.
    for (const box of doc.querySelectorAll("[data-off-expect]")) assert.equal((box as HTMLInputElement).checked, false, `${page.name}: switch off`)
    // A second look presses nothing more.
    const pressed = ((globalThis as any).window.__pressed ?? []).length
    const again = await closeOnce(env)
    assert.ok(again.status !== "done", `${page.name}: once`)
    assert.equal(((globalThis as any).window.__pressed ?? []).length, pressed)
  })
}

test("the page set covers every platform of the list and generic banners in ten languages", () => {
  const ids = new Set((PLATFORM_PAGES as Page[]).map((p) => p.expect.via))
  for (const id of ["onetrust", "cookiebot", "didomi", "quantcast", "trustarc", "usercentrics", "cookieyes", "complianz", "iubenda", "osano", "termly", "klaro", "consentmanager", "axeptio", "funding_choices", "tcf"]) {
    assert.ok(ids.has(id), id)
  }
  const langs = new Set((GENERIC_PAGES as Array<Page & { lang: string }>).filter((p) => p.expect.status === "done").map((p) => p.lang))
  for (const lang of ["en", "ru", "de", "fr", "es", "it", "tr", "ar", "ja", "zh"]) assert.ok(langs.has(lang), lang)
})

test("Sourcepoint answers in its own frame: its message and, only when we opened it, its privacy manager", () => {
  assert.equal(consentFrame("https://cdn.privacy-mgmt.com/index.html?hasCsp=true&message_id=123456&consentUUID=x&preload_message=true"), "sourcepoint")
  assert.equal(consentFrame("https://sourcepoint.theguardian.com/index.html?message_id=8&consentUUID=x"), "sourcepoint")
  assert.equal(consentFrame("https://cdn.privacy-mgmt.com/privacy-manager/index.html?message_id=55"), "sourcepoint_pm")
  assert.equal(consentFrame("https://consent-pref.trustarc.com/?type=x"), "trustarc")
  assert.equal(consentFrame("https://googleads.g.doubleclick.net/pagead/ads?x=1"), null)
  assert.ok(FRAME_RULES.sourcepoint_pm.ours)
  assert.ok(FRAME_RULES.sourcepoint.settings?.length)
  // frame.js stays small: it only asks for the closer, which the background injects into that frame alone.
  const frame = read("src/content/frame.ts")
  assert.match(frame, /import \{ consentFrame \} from "\.\/cookies\/frameMatch"/)
  assert.doesNotMatch(frame, /cookies\/closer|cookies\/rules|cookies\/inframe/)
  assert.match(read("src/background/index.ts"), /frameIds: \[_sender\.frameId\] \}, files: \["dist\/cookieframe\.js"\]/)
})

test("never a link that leaves the page, a form's submit, or a field near a password", () => {
  const { document } = parseHTML(`<body>
    <a id="away" href="https://example.org/reject">Reject</a><a id="hash" href="#">Reject</a><a id="new" href="#" target="_blank">Reject</a>
    <form id="f"><input type="text"><button id="sub">Decline</button><button id="typed" type="button">Decline</button></form>
    <form><input type="password"><button id="pw" type="button">Decline</button></form>
    <form><button id="own">Reject all</button></form><button id="off" disabled>Reject</button></body>`)
  const $ = (id: string) => document.getElementById(id) as unknown as Element
  assert.equal(safeControl($("away")), false)
  assert.equal(safeControl($("hash")), true)
  assert.equal(safeControl($("new")), false)
  assert.equal(safeControl($("sub")), false)
  assert.equal(safeControl($("typed")), true)
  assert.equal(safeControl($("pw")), false)
  assert.equal(safeControl($("own")), true)
  assert.equal(safeControl($("off")), false)
})

test("counts per day, no site: yesterday's reported once; the confirmation the first few times", () => {
  const day1 = Date.UTC(2026, 10, 22, 10)
  const day2 = Date.UTC(2026, 10, 23, 9)
  let s = counted({}, day1, { via: "onetrust" })
  s = counted(s, day1, { via: "onetrust" })
  s = counted(s, day1, { via: "generic" })
  s = counted(s, day1, { left: "only_accept" })
  assert.deepEqual(s.done, { onetrust: 2, generic: 1 })
  assert.deepEqual(s.left, { only_accept: 1 })
  assert.doesNotMatch(JSON.stringify(s), /\./, "no host or address in the counts")
  assert.equal(rollDay(s, day1).report, null)
  const rolled = rollDay(s, day2)
  assert.deepEqual(rolled.report, { day: "2026-11-22", done: { onetrust: 2, generic: 1 }, left: { only_accept: 1 } })
  assert.equal(rolled.state.done, undefined)
  assert.equal(rollDay(rolled.state, day2).report, null)
  let told = {}
  for (let i = 0; i < TOLD_TIMES; i++) {
    const r = tell(told)
    assert.ok(r.show)
    told = r.state
  }
  assert.equal(tell(told).show, false)
})

test("the switch is on by default, for new and existing users; the site exception", () => {
  assert.ok(closesOn(readState(undefined), "www.fresha.com"))
  assert.ok(closesOn(readState({ told: 2 }), "fresha.com"))
  assert.ok(!closesOn(readState({ off: true }), "fresha.com"))
  const off = withSite({}, "www.fresha.com", false)
  assert.deepEqual(off.sites, ["fresha.com"])
  assert.ok(!closesOn(off, "fresha.com"))
  assert.ok(closesOn(off, "bbc.co.uk"))
  assert.ok(closesOn(withSite(off, "fresha.com", true), "fresha.com"))
})

test("the use event: counts by platform and reason, never a site", () => {
  assert.ok(FEATURES.cookies)
  assert.deepEqual(useFields({ f: "cookies", a: "closed", what: "onetrust", count: 3, site: "fresha.com", url: "https://x" }), { f: "cookies", a: "closed", what: "onetrust", count: 3 })
  assert.deepEqual(useFields({ f: "cookies", a: "left", why: "only_accept", count: "2" }), { f: "cookies", a: "left", why: "only_accept", count: 2 })
  assert.equal(useFields({ f: "cookies", a: "visited" }), null)
  const rules = read("src/content/cookies/rules.ts")
  for (const id of new Set([...rules.matchAll(/id: "([a-z_]+)"/g)].map((m) => m[1]))) {
    assert.ok((FEATURES.cookies.fields!.what as readonly string[]).includes(id), `${id} is a counted platform`)
  }
})

test("the agent answers a page's banner before reading it; Settings has the switch and the exception", () => {
  const index = read("src/content/index.tsx")
  assert.match(index, /closeForAgent\(\)\.catch\(\(\) => null\)\.then\(\(\) => sendResponse\(buildMap\(document, \{ money \}\)\)\)/)
  assert.match(index, /startCookieCloser\(announceClosed, announceLeft\)/)
  assert.match(read("src/content/Settings.tsx"), /<CookieGroup site=\{site\} \/>/)
  const ru = JSON.parse(read("src/locales/ru.json"))
  assert.equal(ru.setCookies, "Закрывать окна cookie")
  assert.equal(ru.setCookiesHint, "Выбирает «только необходимые».")
  assert.equal(ru.cookiesOffOnSite, "Не закрывать на этом сайте")
  assert.equal(ru.cookieClosedLine, "Закрыл окно cookie: только необходимые")
  const en = JSON.parse(read("src/locales/en.json"))
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const l = JSON.parse(read(`src/locales/${lang}.json`))
    for (const key of ["setCookies", "setCookiesHint", "cookiesOffOnSite", "cookiesOnOnSite", "cookieClosedLine"]) {
      assert.ok(typeof l[key] === "string" && l[key].length > 2, `${lang}.${key}`)
      if (lang !== "en") assert.notEqual(l[key], en[key], `${lang}.${key} translated`)
    }
  }
})
