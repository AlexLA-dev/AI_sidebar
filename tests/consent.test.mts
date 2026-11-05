import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import { CONSENT_VERSION, consentStatus } from "../src/shared/consent.ts"

const root = new URL("..", import.meta.url).pathname
const read = (file: string) => readFileSync(join(root, file), "utf8")
const locales = readdirSync(join(root, "src/locales")).filter((f) => f.endsWith(".json")).map((f) => [f.replace(".json", ""), JSON.parse(read(`src/locales/${f}`))] as const)

test("consent given for an earlier text is asked again once; the current one is not", () => {
  // 3: the one consent for every AI feature (2.5 (78)). 2: answers from Claude (2.4). `true`: OpenAI only (2.3).
  assert.equal(CONSENT_VERSION, 3)
  assert.equal(consentStatus(true), "old")
  assert.equal(consentStatus(1), "old")
  assert.equal(consentStatus(2), "old")
  assert.equal(consentStatus(3), "ok")
  assert.equal(consentStatus(4), "ok")
  // Never asked: the card as before.
  for (const none of [undefined, null, false, 0, ""]) assert.equal(consentStatus(none), "none")
})

// The owner on 2.5 (78): "creating templates with AI asks for consent again; let it be given once, saying which
// features it covers". Each feature had a card of its own (marking blanks, "Fill from the page"), and each tab read
// the consent once, when its page loaded.
test("one consent card, wherever something would go to the AI first; no feature has its own text", () => {
  const cards = execFileSync("grep", ["-rln", 'class="cf-card consent"', "src"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  assert.deepEqual(cards, ["src/content/Consent.tsx"])
  for (const file of ["src/content/App.tsx", "src/content/insert/TemplateEditor.tsx", "src/content/insert/FillForm.tsx", "src/content/insert/QuickInsert.tsx"]) {
    assert.match(read(file), /import \{ ConsentCard \} from "\.\.?\/(\.\.\/)?Consent"/, file)
  }
  for (const [lang, strings] of locales) {
    for (const own of ["qiMarkConsent", "qiFillConsent"]) assert.equal(strings[own], undefined, `${lang}: ${own}`)
  }
  // The template editor and the fill form ask the background (it knows the consent) rather than this tab's copy.
  assert.doesNotMatch(read("src/content/insert/TemplateEditor.tsx"), /p\.consent === "ok" \|\| agreed/)
  assert.doesNotMatch(read("src/content/insert/FillForm.tsx"), /p\.consent !== "ok" && !agreed/)
  // A tab hears a consent given in another one.
  assert.match(read("src/content/App.tsx"), /onConsentChanged\(setConsent\)/)
  // Suggestions send text to the AI too: the switch alone isn't enough.
  assert.match(read("src/background/index.ts"), /on: prefs\.organize && agreed/)
})

test("the consent names each feature as the panel does, in all 11 languages", () => {
  assert.equal(locales.length, 11)
  const keys = ["consentTitle", "consentAgainTitle", "consentBody", "consentAnswers", "consentChats", "consentTemplates", "consentWatch", "consentSuggest", "consentStored"]
  // Mid-sentence a name may start lowercase ("la recherche IA").
  const names = (text: string, name: string) => text.toLowerCase().includes(name.toLowerCase())
  for (const [lang, s] of locales) {
    for (const key of keys) assert.ok(typeof s[key] === "string" && s[key].trim(), `${lang}: ${key}`)
    assert.ok(names(s.consentAnswers, s.setAbout), `${lang}: "About me" goes with answers`)
    assert.ok(names(s.consentChats, s.askHistory), `${lang}: "Ask your chats"`)
    assert.ok(names(s.consentChats, s.findToggle), `${lang}: AI search`)
    assert.ok(names(s.consentTemplates, s.qiFillFromPage), `${lang}: "Fill from the page"`)
    assert.ok(names(s.consentTemplates, s.qiFindAi), `${lang}: "Find by meaning"`)
    for (const key of ["consentAnswers", "consentSuggest"]) assert.match(s[key], /OpenAI/, `${lang}: ${key} names the backup`)
    assert.match(s.consentBody, /Anthropic \(Claude\)|Anthropic（Claude）|Anthropic\(Claude\)/, `${lang}: who answers`)
    assert.match(s.consentAnswers, /Google/, `${lang}: Google answers`)
    // The suggestions card is a switch now: it no longer reads like a second consent.
    assert.doesNotMatch(s.orgConsentText, /OpenAI|Anthropic/, `${lang}: the suggestions card`)
  }
})

test("the consent and the privacy policy name the same features", () => {
  const policy = read("site/privacy.html")
  const en = Object.fromEntries(locales)["en"]
  for (const [feature, inConsent] of [
    ["Ask your chats", en.consentChats], ["AI search", en.consentChats], ["Fill from the page", en.consentTemplates],
    ["Find by meaning", en.consentTemplates], ["Page watch", en.consentWatch], ["Suggestions", en.consentSuggest], ["About me", en.consentAnswers]
  ] as const) {
    assert.ok(policy.includes(feature), `the policy names ${feature}`)
    assert.ok(inConsent.length > 0, feature)
  }
})

test("a tab hears a consent given in another tab", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-consent-"))
  const out = join(dir, "store.mjs")
  await build({ entryPoints: [join(root, "src/content/store.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"] })
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = []
  ;(globalThis as any).chrome = { storage: { onChanged: { addListener: (l: any) => listeners.push(l), removeListener: (l: any) => listeners.splice(listeners.indexOf(l), 1) } } }
  const store = await import(pathToFileURL(out).href)
  const seen: string[] = []
  const stop = store.onConsentChanged((s: string) => seen.push(s))
  for (const l of listeners) l({ "cf:consent": { newValue: 3 } }, "local")
  for (const l of listeners) l({ "cf:settings": { newValue: {} } }, "local")
  for (const l of listeners) l({ "cf:consent": { newValue: 2 } }, "sync")
  assert.deepEqual(seen, ["ok"])
  stop()
  assert.equal(listeners.length, 0)
  delete (globalThis as any).chrome
})
