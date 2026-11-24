// 2.8 (В7.2, В7.1, В1.5): one-tap purchase from the panel, back to Safari after the App Store's sheet; «Remind me when my
// answers are back» at the free limit; every purchase with its source.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { before, test } from "node:test"

import { build } from "esbuild"

import { appLink } from "../src/shared/plan.ts"
import { FEATURES } from "../src/shared/usage.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let purchase: Record<string, (...args: any[]) => any>
before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-purchase-")), "purchase.mjs")
  await build({ entryPoints: [join(root, "src/content/purchase.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" })
  purchase = await import(pathToFileURL(out).href)
})

test("the link to buy names the plan, period, where it started and the page to come back to (no fragment, http only)", () => {
  const link = appLink("subscribe", undefined, "pro", "monthly", { via: "sheet", back: "https://example.com/a?b=1#top" })
  assert.equal(link, `contextflow://subscribe?plan=pro&period=monthly&via=sheet&back=${encodeURIComponent("https://example.com/a?b=1")}`)
  // Without a period (the plans, not a purchase) there's nothing to come back from; a page that isn't http isn't sent.
  assert.equal(appLink("subscribe", undefined, "ultra", undefined, { back: "https://example.com" }), "contextflow://subscribe?plan=ultra")
  assert.equal(appLink("subscribe", undefined, "pro", "yearly", { back: "file:///etc/passwd" }), "contextflow://subscribe?plan=pro&period=yearly")
  // Older links are unchanged.
  assert.equal(appLink("subscribe", "listen", "ultra", "yearly"), "contextflow://subscribe?plan=ultra&period=yearly&feature=listen")
})

test("coming back: the app's mark, and whether the plan bought is on", () => {
  assert.deepEqual(purchase.boughtMark("#cf-bought=pro"), { word: "pro", rest: "" })
  assert.equal(purchase.boughtMark("#cf-bought=<x>"), null)
  assert.equal(purchase.boughtMark("#section"), null)
  const buying = { plan: "pro", period: "monthly", was: "free", at: Date.now() }
  assert.equal(purchase.boughtNow(buying, "pro"), "pro")
  assert.equal(purchase.boughtNow(buying, "free"), null)
  assert.equal(purchase.boughtNow({ ...buying, plan: "ultra", was: "pro" }, "ultra"), "ultra")
  // A move that starts at the renewal (Ultra → Pro, or yearly): nothing new now.
  assert.equal(purchase.boughtNow({ ...buying, was: "ultra" }, "ultra"), null)
  assert.equal(purchase.boughtNow(null, "pro"), null)
})

test("the panel: every plan choice goes through one-tap buy; the return takes the mark, refreshes, says it's on", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /const choosePlan = \(choice: OfferChoice\) => buyPlan\(choice\.plan, choice\.period, "chat"\)/)
  assert.match(app, /buyPlan\(chosen, period, "sheet"\)/)
  assert.match(app, /buyPlan\(chosen, "yearly", "yearly"\)/)
  assert.match(app, /via, back: source\.href\(\) \}\)/)
  assert.match(app, /const mark = takeBoughtMark\(\)[\s\S]{0,900}const next = await refreshStatus\(true\)\s*const now = boughtNow\(buying, next\?\.plan\)/)
  assert.match(app, /window\.addEventListener\("focus", onEvent\)/)
  // Counted once: the purchase on record is cleared before the guard lets the next look in; the line is scrolled into view.
  assert.match(app, /if \(!mark && \(touch \|\| !document\.hasFocus\(\)\)\) return/)
  assert.match(app, /busy = true\s*\/\/[^\n]*\n\s*if \(buying\) await clearBuying\(\)\s*try \{/)
  assert.match(app, /setBought\(now\)[\s\S]{0,500}listRef\.current\?\.scrollTo\(\{ top: listRef\.current\.scrollHeight/)
  // The address goes only into the app's link, never to our server: the background passes it to appLink and nowhere else.
  const bg = read("src/background/index.ts")
  assert.equal((bg.match(/message\.back/g) ?? []).length, 1)
})

test("the app: one-tap purchase without the Pro tab, back to Safari with the mark (iPhone, iPad) or Safari's window (Mac)", () => {
  const swift = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(swift, /&& QuickBuy\.wants\(url\):[\s\S]{0,200}QuickBuy\.run\(url, store: store\) \{ tab = \.pro \}/)
  assert.match(swift, /parts\?\.fragment = "cf-bought=\\\(word\)"/)
  // Back by the address itself, never x-safari- (it always opens a new tab: the director's acceptance 2).
  const back = swift.slice(swift.indexOf("static func backToSafari"), swift.indexOf("static func backToSafari") + 1600)
  assert.match(back, /UIApplication\.shared\.open\(target\)/)
  assert.doesNotMatch(back, /x-safari-\\\(/)
  assert.match(swift, /#else\s*\/\/ Safari's own window, as it was \(the tab and its panel\): no new tab\.\s*PlanTour\.openSafari\(\)/)
  for (const a of ["plan", "buy_ok", "buy_cancel", "buy_pending", "buy_fail"]) assert.ok(swift.includes(`"paywall", "${a}"`) || swift.includes(`"buy_ok" : outcome`), a)
})

test("events: the purchase's source, plan, period and offer are registered; the panel's plans say bought and the feature", () => {
  const paywall = FEATURES.paywall
  for (const via of ["panel_sheet", "panel_chat", "panel_yearly", "tab", "deeplink"]) assert.ok(paywall.via?.includes(via), via)
  assert.deepEqual([paywall.fields?.plan, paywall.fields?.period, paywall.fields?.offer], [["pro", "ultra", "byok"], ["monthly", "yearly"], ["none", "promo", "intro", "code"]])
  assert.ok(FEATURES.plans.actions.includes("bought"))
  assert.deepEqual(FEATURES.plans.fields?.feature, ["listen", "similar"])
  for (const a of ["remind", "remind_set", "remind_off"]) assert.ok(FEATURES.chat_plans.actions.includes(a), a)
})

test("«Remind me when my answers are back»: at the free limit only, at the moment they're back, through the reminder path", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /!hasPro\(plan\) && TARGET === "safari" && resetsAt && \(\s*<AnswersBack resetsAt=\{Date\.parse\(resetsAt\)\} count=\{back\}/)
  const card = read("src/content/ux/AnswersBack.tsx")
  assert.match(card, /type: "remind", \.\.\.ANSWERS_BACK, at,/)
  assert.match(card, /send\(\{ \.\.\.message, ask \}/)
  // Notifications not on: the app's own ask (setup-28's entry point), back to this page, then set again here.
  assert.match(card, /followLink\(notifyLink\(url\)\)/)
  assert.match(card, /contextflow:\/\/notifications\?why=answers_back/)
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const d = JSON.parse(read(`src/locales/${lang}.json`))
    for (const key of ["answersBackAsk", "answersBackSet", "answersBackOff", "answersBackFailed", "answersBackBody", "boughtPro", "boughtUltra", "boughtByok"]) {
      assert.ok(d[key]?.includes("{0}") || !/\{0\}/.test(JSON.parse(read("src/locales/en.json"))[key]), `${lang} ${key}`)
    }
  }
})

test("the director's acceptance (shot 15): nothing is presented over the App Store's sheet; the flag is set before launch sheets can", () => {
  const swift = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(swift, /@Published var purchasing = false/)
  assert.match(swift, /QuickBuy\.wants\(url\):\s*\/\/[^\n]*\n\s*Paywall\.shared\.purchasing = true\s*QuickBuy\.run/)
  assert.match(swift, /guard hasChats,[^\n]*!Paywall\.shared\.purchasing,[^\n]*!UserDefaults/)
  assert.match(swift, /\.onReceive\(Paywall\.shared\.\$purchasing\) \{ purchaseStarted\(\$0\) \}/)
  assert.match(swift, /var busy = [^\n]*Paywall\.shared\.purchasing/)
  // Both purchase paths set it and always clear it.
  assert.match(swift, /Paywall\.shared\.purchasing = true\s*Task \{ @MainActor in\s*defer \{\s*running = false\s*Paywall\.shared\.purchasing = false/)
  assert.match(swift, /paywall\.purchasing = true\s*Task \{\s*defer \{ paywall\.purchasing = false \}/)
})

test("acceptance 2: the limit card shows no made-up time and no live Retry before the server's reset time; the memory card waits on day 1", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /const backFree = resetsAt \? freeAnswersBack\(back, clockTime\(resetsAt\), timeUntil\(resetsAt\)\) : ""/)
  assert.match(app, /retryAt=\{resetsAt \? Date\.parse\(resetsAt\) : "unknown"\}/)
  const offer = read("src/content/ux/PlanOffer.tsx")
  assert.match(offer, /const canRetry = Boolean\(onRetry\) && retryAt !== "unknown"/)
  assert.match(app, /if \(firstDay \|\| done\.includes\(chat\) \|\| threadRef\.current !== chat\) return/)
})

test("back from the app: the mark leaves the address and the tab's history as they were (acceptance 3, D2)", () => {
  const page = (hash: string, loadedWith: string) => {
    const calls: string[] = []
    const at = { hash, href: `https://example.com/a?b=1${hash}`, pathname: "/a", search: "?b=1" }
    return { calls, at, where: { location: at, loadedWith, history: { state: null, back: () => calls.push("back"), replaceState: (_s: unknown, _t: string, url: string) => calls.push(`replace ${url}`) } } }
  }
  // Came by a jump within the page (the tab that had it): that step is taken back, once, however often it's looked at.
  const jump = page("#cf-bought=no", "")
  assert.equal(purchase.takeBoughtMark(jump.where), "no")
  assert.equal(purchase.takeBoughtMark(jump.where), null)
  assert.deepEqual(jump.calls, ["back"])
  // Back on the step before: no mark, nothing to do; a later return is taken again.
  const before = page("", "")
  assert.equal(purchase.takeBoughtMark(before.where), null)
  const again = page("#cf-bought=pro", "")
  assert.equal(purchase.takeBoughtMark(again.where), "pro")
  assert.deepEqual(again.calls, ["back"])
  purchase.takeBoughtMark(page("", "").where)
  // Loaded with it (a fresh tab): only the address is replaced, nothing is stepped back.
  const fresh = page("#cf-bought=pro", "#cf-bought=pro")
  assert.equal(purchase.takeBoughtMark(fresh.where), "pro")
  assert.deepEqual(fresh.calls, ["replace /a?b=1"])
  // No mark: nothing touched.
  const plain = page("#section", "")
  assert.equal(purchase.takeBoughtMark(plain.where), null)
  assert.deepEqual(plain.calls, [])
})
