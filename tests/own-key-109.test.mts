// Own key (109). A refused key says why in the person's language (no credit, the account's rate limit) and the
// counters keep the provider's error type; a rate limit tries the next OpenAI model, an account without credit
// doesn't; each refusal of an Own key subscriber reaches the counters; on the purchase screens Own key is under the
// link «I have my own API key», in the app, the panel's plans sheet and the site, in all 15 languages.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { before, test } from "node:test"

import { build } from "esbuild"

import { cleanErrorTag, ownKeyPlace, ownKeyProblem, providerErrorTag, tryNextModel } from "../src/shared/ownKeyError.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

// ---------------------------------------------------------------- what the provider said

test("OpenAI: no credit and the rate limit are told apart by its code, not by the status", () => {
  assert.equal(ownKeyProblem("openai", { status: 429, type: "insufficient_quota", code: "insufficient_quota" }), "credit")
  assert.equal(ownKeyProblem("openai", { status: 429, type: "tokens", code: "rate_limit_exceeded" }), "rate")
  assert.equal(ownKeyProblem("openai", { status: 429 }), "rate")
  assert.equal(ownKeyProblem("openai", { status: 400, code: "billing_hard_limit_reached" }), "credit")
  assert.equal(ownKeyProblem("openai", { status: 404, code: "model_not_found" }), null)
  assert.equal(ownKeyProblem("openai", { status: 500 }), null)
})

test("Anthropic: 402, a credit or spend-limit 400, and 429", () => {
  assert.equal(ownKeyProblem("anthropic", { status: 402, type: "billing_error" }), "credit")
  assert.equal(ownKeyProblem("anthropic", { status: 400, type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." }), "credit")
  assert.equal(ownKeyProblem("anthropic", { status: 400, type: "invalid_request_error", message: "messages: text content blocks must be non-empty" }), null)
  assert.equal(ownKeyProblem("anthropic", { status: 429, type: "rate_limit_error" }), "rate")
  assert.equal(ownKeyProblem("anthropic", { status: 529, type: "overloaded_error" }), null)
})

test("the counters get the status and the provider's word for the error, never its sentence", () => {
  assert.equal(providerErrorTag({ status: 429, type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" }), "429:insufficient_quota")
  assert.equal(providerErrorTag({ status: 429, type: "tokens", code: "rate_limit_exceeded" }), "429:rate_limit_exceeded")
  assert.equal(providerErrorTag({ status: 402, type: "billing_error" }), "402:billing_error")
  assert.equal(providerErrorTag({ status: 500 }), "500")
  // A "code" that is a sentence, or anything with spaces or capitals, is left out.
  assert.equal(providerErrorTag({ status: 400, code: "Your key sk-abc is wrong", type: "Some Text" }), "400")
  assert.equal(cleanErrorTag("429:insufficient_quota"), "429:insufficient_quota")
  assert.equal(cleanErrorTag("500"), "500")
  for (const bad of ["429:You exceeded your quota", "sk-abc", "429:" + "a".repeat(60), 429, null, "999:x", "429:rate limit"]) assert.equal(cleanErrorTag(bad), null, String(bad))
})

test("another model is tried after a model this key can't use and after OpenAI's rate limit, not without credit", () => {
  assert.equal(tryNextModel("openai", { status: 404 }), true)
  assert.equal(tryNextModel("openai", { status: 429, code: "rate_limit_exceeded" }), true)
  assert.equal(tryNextModel("openai", { status: 429, code: "insufficient_quota" }), false)
  assert.equal(tryNextModel("openai", { status: 401 }), false)
  assert.equal(tryNextModel("anthropic", { status: 404 }), true)
  assert.equal(tryNextModel("anthropic", { status: 429, type: "rate_limit_error" }), false)
})

test("where to mend it: the provider's own pages", () => {
  for (const provider of ["openai", "anthropic"] as const) for (const problem of ["credit", "rate"] as const) {
    const place = ownKeyPlace(provider, problem)
    assert.match(place.url, provider === "openai" ? /^https:\/\/platform\.openai\.com\// : /^https:\/\/platform\.claude\.com\//)
    assert.ok(place.label.startsWith(new URL(place.url).host), place.label)
  }
})

// ---------------------------------------------------------------- the own-key request, with the providers stood in

type Seen = { url: string; model?: string }
let ask: (key: string, payload: unknown, profile: string, locale: string, tier: "smart" | "fast", emit: (e: any) => void, signal: AbortSignal) => Promise<any>
let seen: Seen[] = []
let answer: (model: string) => Response = () => new Response("{}", { status: 500 })

const openaiError = (status: number, code: string, type: string, message: string) => () =>
  new Response(JSON.stringify({ error: { message, type, code, param: null } }), { status, headers: { "content-type": "application/json" } })
const openaiStream = () =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
const claudeError = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type, message }, request_id: "req_1" }), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } })

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-own-key-"))
  const out = join(dir, "chat.mjs")
  await build({
    entryPoints: [join(root, "src/background/chat.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    define: { __API_BASE__: '"http://stand.test"', __VERSION__: '"0"', __TARGET__: '"safari"', __SHADOW_MODE__: '"closed"', __TIPS__: "{}", __WATCH_EVERY_S__: "900" }
  })
  ;(globalThis as any).chrome = { storage: { local: { get: async () => ({}), set: async () => undefined } } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith("/v1/models") || url.includes("/v1/models?")) {
      seen.push({ url })
      return new Response(JSON.stringify(url.includes("anthropic") ? { data: [], has_more: false, first_id: null, last_id: null } : { data: [{ id: "gpt-5.5" }, { id: "gpt-5" }] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}")))
    seen.push({ url, model: body.model })
    return answer(body.model)
  }) as typeof fetch
  ask = (await import(pathToFileURL(out).href)).askWithOwnKey
})

async function run(key: string): Promise<{ events: any[]; usage: any; models: string[] }> {
  seen = []
  const events: any[] = []
  const usage = await ask(key, { messages: [{ role: "user", content: "hi" }], page: null }, "", "en", "smart", (e) => events.push(e), new AbortController().signal)
  return { events, usage, models: seen.filter((s) => s.model).map((s) => s.model!) }
}

test("OpenAI, an account without credit: one request, the cause and OpenAI's sentence to the panel, its code to the counters", async () => {
  answer = openaiError(429, "insufficient_quota", "insufficient_quota", "You exceeded your current quota, please check your plan and billing details.")
  const { events, usage, models } = await run("sk-test")
  assert.equal(models.length, 1, "no other model is asked: the account is refused whatever the model")
  assert.deepEqual(events, [{ type: "error", code: "BUSY", message: "You exceeded your current quota, please check your plan and billing details.", ownKey: { provider: "openai", problem: "credit" } }])
  assert.equal(usage.ok, false)
  assert.equal(usage.error, "BUSY")
  assert.equal(usage.errorType, "429:insufficient_quota")
})

test("OpenAI, the rate limit on the newest model: the next model answers", async () => {
  answer = (model) => (model === "gpt-5.5" ? openaiError(429, "rate_limit_exceeded", "tokens", "Request too large for gpt-5.5 on tokens per min (TPM): Limit 30000, Requested 41000.")() : openaiStream())
  const { events, usage, models } = await run("sk-test")
  assert.deepEqual(models.slice(0, 2), ["gpt-5.5", "gpt-5"])
  assert.ok(events.some((e) => e.type === "delta" && e.text === "Hello"))
  assert.ok(!events.some((e) => e.type === "error"))
  assert.equal(usage.ok, true)
  assert.equal(usage.model, "gpt-5")
  assert.equal(usage.errorType, undefined)
})

test("OpenAI, the rate limit on every model: said as the account's limit", async () => {
  answer = openaiError(429, "rate_limit_exceeded", "requests", "Rate limit reached for requests.")
  const { events, usage, models } = await run("sk-test")
  assert.ok(models.length >= 2, "the other models were tried")
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].ownKey, { provider: "openai", problem: "rate" })
  assert.equal(events[0].code, "BUSY")
  assert.equal(usage.errorType, "429:rate_limit_exceeded")
})

test("OpenAI, a model the key can't use (404) still falls through to the next one; a bad key is a bad key", async () => {
  answer = (model) => (model === "gpt-5.5" ? openaiError(404, "model_not_found", "invalid_request_error", "The model does not exist")() : openaiStream())
  assert.equal((await run("sk-test")).usage.model, "gpt-5")
  answer = openaiError(401, "invalid_api_key", "invalid_request_error", "Incorrect API key provided: sk-test.")
  const { events, usage } = await run("sk-test")
  assert.deepEqual(events, [{ type: "error", code: "BAD_KEY" }], "the provider's sentence (it repeats part of the key) isn't shown")
  assert.equal(usage.errorType, "401:invalid_api_key")
})

test("Anthropic, no credit (402, and the 400 about the credit balance) and the rate limit", async () => {
  answer = () => claudeError(402, "billing_error", "Your credit balance is too low to access the Anthropic API.")
  let got = await run("sk-ant-test")
  assert.deepEqual(got.events.at(-1), { type: "error", code: "UPSTREAM", message: "Your credit balance is too low to access the Anthropic API.", ownKey: { provider: "anthropic", problem: "credit" } })
  assert.equal(got.usage.errorType, "402:billing_error")

  answer = () => claudeError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")
  got = await run("sk-ant-test")
  assert.deepEqual(got.events.at(-1).ownKey, { provider: "anthropic", problem: "credit" })
  assert.equal(got.usage.errorType, "400:invalid_request_error")

  answer = () => claudeError(429, "rate_limit_error", "This request would exceed your organization's rate limit of 30,000 input tokens per minute.")
  got = await run("sk-ant-test")
  assert.deepEqual(got.events.at(-1).ownKey, { provider: "anthropic", problem: "rate" })
  assert.equal(got.events.at(-1).code, "BUSY")
  assert.equal(got.usage.errorType, "429:rate_limit_error")
})

// ---------------------------------------------------------------- the panel, the counters, the purchase screens

test("the panel says the cause in its own words first, then the provider's sentence, and names the place", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /if \(error\.ownKey\) \{[\s\S]{0,400}t\(problem === "credit" \? "errKeyCredit" : "errKeyRate", providerName\(provider\), ownKeyPlace\(provider, problem\)\.label\)[\s\S]{0,120}t\("errProvider", error\.message\)/)
  assert.match(app, /error\.ownKey && \([\s\S]{0,260}sendBackground\(\{ type: "openUrl", url: ownKeyPlace\(provider, problem\)\.url \}\)/)
  assert.match(app, /\.\.\.\(event\.ownKey \? \{ ownKey: event\.ownKey \} : \{\}\)/)
})

test("the card at the limit, once a key is added: the same question again with the key", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /\{status\?\.hasOwnKey && lastIsUser && \(\n\s+<button type="button" class="cf-secondary" onClick=\{\(\) => retry\(true\)\}>\n\s+<Icon\.Retry \/> \{messages\[messages\.length - 1\]\?\.mode === "google" \? t\("askWithoutGoogle"\) : t\("retry"\)\}/)
})

test("the key's field is not a password field: Safari doesn't offer to save the key as a password", () => {
  const settings = read("src/content/Settings.tsx")
  const field = settings.slice(settings.indexOf('class="cf-text cf-secret"'), settings.indexOf("onInput={(e) => setKeyDraft"))
  assert.match(field, /type="text"/)
  assert.match(field, /autoComplete="off"/)
  assert.doesNotMatch(settings, /type="password"/)
  assert.match(read("src/content/styles.css"), /\.cf-secret:not\(:placeholder-shown\) \{ -webkit-text-security: disc; \}/)
})

test("each refusal of an Own key subscriber goes to the counters, with whether a key is added", () => {
  const background = read("src/background/index.ts")
  const fn = background.slice(background.indexOf("async function reportUpsell"), background.indexOf("async function reportRenewal"))
  assert.doesNotMatch(fn, /if \(action === "refused"\) \{[\s\S]*?return\n\s*\}\n\s*if \(action === "shown"/, "a refusal no longer returns before the request")
  assert.match(fn, /action === "refused" \? \{ has_key: Boolean\(key\) \} : \{\}/)
  const event = read("netlify/functions/v2-event.mts")
  assert.match(event, /UPSELL_ACTIONS = new Set\(\["refused", "shown", "tap"\]\)/)
  assert.match(event, /typeof body\.has_key === "boolean" \? \{ has_key: body\.has_key \} : \{\}/)
  assert.match(read("netlify/functions/v2-usage.mts"), /error_type: cleanErrorTag\(usage\.errorType\)/)
})

const LOCALES = readdirSync(join(root, "src/locales")).filter((f) => f.endsWith(".json"))
const KEYS = ["errKeyCredit", "errKeyRate", "plansOwnKeyLink", "plansOwnKeyNeeds"]

test("the new strings are in all 15 languages, with their two places kept in the error lines", () => {
  assert.equal(LOCALES.length, 15)
  const en = JSON.parse(read("src/locales/en.json")) as Record<string, string>
  for (const file of LOCALES) {
    const strings = JSON.parse(read(`src/locales/${file}`)) as Record<string, string>
    for (const key of KEYS) {
      assert.ok(strings[key]?.trim(), `${file}: ${key}`)
      if (file !== "en.json") assert.notEqual(strings[key], en[key], `${file}: ${key} is still English`)
    }
    for (const key of ["errKeyCredit", "errKeyRate"]) for (const mark of ["{0}", "{1}"]) assert.ok(strings[key].includes(mark), `${file}: ${key} ${mark}`)
    assert.match(strings.plansOwnKeyNeeds, /OpenAI/)
    assert.match(strings.plansOwnKeyNeeds, /Claude/)
  }
  assert.equal(en.plansOwnKeyLink, "I have my own API key")
  assert.equal(JSON.parse(read("src/locales/ru.json")).plansOwnKeyLink, "У меня есть свой API-ключ")
})

test("the panel's plans sheet: Pro and Ultra in the row, Own key under its link; its subscriber sees it as before", () => {
  const sheet = read("src/content/Plans.tsx")
  assert.match(sheet, /export function plansShown\(current: string, ownOpen: boolean\): PaidPlan\[\] \{\n  if \(current === "byok"\) return ORDER\n  return ownOpen \? \["pro", "ultra", "byok"\] : \["pro", "ultra"\]\n\}/)
  assert.match(sheet, /useState\(focus === "byok"\)/, "the sheet opened for Own key shows its card at once")
  assert.match(sheet, /currentPlan !== "byok" && !ownOpen && \([\s\S]{0,200}t\("plansOwnKeyLink"\)/)
  assert.match(sheet, /plan === "byok" && currentPlan !== "byok" && <p class="cf-plan-needs">\{t\("plansOwnKeyNeeds"\)\}<\/p>/)
  assert.match(sheet, /\{shown\.map\(\(plan\) => \{/)
})

test("the app's purchase screen: the same row, the link, the sentence, and the saving named from the plans shown", () => {
  const view = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(view, /static func tiersShown\(current: StoreKitManager\.Tier\?, ownKeyOpen: Bool\) -> \[StoreKitManager\.Tier\] \{\n\s+if current == \.byok \{ return StoreKitManager\.Tier\.allCases \}\n\s+return ownKeyOpen \? \[\.pro, \.ultra, \.byok\] : \[\.pro, \.ultra\]/)
  assert.match(view, /private var ownKeyShown: Bool \{ ownKeyOpen \|\| paywall\.focus == \.byok \}/)
  assert.match(view, /ForEach\(Self\.tiersShown\(current: store\.tier, ownKeyOpen: ownKeyShown\)\)/)
  assert.doesNotMatch(view, /ForEach\(StoreKitManager\.Tier\.allCases\) \{ tier in\n\s+if let product = store\.product\(tier, yearly: paywall\.yearly/)
  assert.match(view, /if store\.tier != \.byok, !ownKeyShown, store\.byok != nil \{\n\s+Button\("I have my own API key"\)/)
  assert.match(view, /needsOwnKey: tier == \.byok && store\.tier != \.byok/)
  assert.match(view, /if needsOwnKey \{\n\s+Text\("This plan needs your own OpenAI or Claude API key\. You pay that provider for the answers separately\."\)/)
  assert.doesNotMatch(view, /store\.bestYearlySaving/, "Own key's saving isn't named while its card is behind the link")
  const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")) as { strings: Record<string, { localizations?: Record<string, unknown> }> }
  for (const key of ["I have my own API key", "This plan needs your own OpenAI or Claude API key. You pay that provider for the answers separately."]) {
    assert.equal(Object.keys(catalog.strings[key]?.localizations ?? {}).length, 14, key)
  }
})

test("the site's pricing: Free, Pro and Ultra in the row, Own key under the same link, in every language", () => {
  const pages = ["site/index.html", ...readdirSync(join(root, "site"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `site/${d.name}/index.html`).filter((p) => { try { read(p); return true } catch { return false } })]
  const translated = pages.filter((p) => /site\/(ar|de|es|fr|it|ja|ko|pt-br|ru|tr|uk|vi|zh-hans|zh-hant)\/index\.html$/.test(p))
  assert.equal(translated.length, 14)
  for (const page of ["site/index.html", ...translated]) {
    const html = read(page)
    const row = html.slice(html.indexOf('<div class="plans">'), html.indexOf('<details class="own-plan">'))
    assert.ok(row.length > 0, `${page}: the row, then Own key's link`)
    assert.equal((row.match(/<div class="plan[ "]/g) ?? []).length, 3, `${page}: three plans in the row`)
    const own = html.slice(html.indexOf('<details class="own-plan">'), html.indexOf("</details>", html.indexOf('<details class="own-plan">')))
    assert.match(own, /<summary>[^<]+<\/summary><p>[^<]*OpenAI[^<]*<\/p>\s*<div class="plan">/, page)
    if (page !== "site/index.html") assert.doesNotMatch(own, /I have my own API key|This plan needs/, `${page}: translated`)
  }
  assert.match(read("site/index.html"), /<summary>I have my own API key<\/summary>/)
})
