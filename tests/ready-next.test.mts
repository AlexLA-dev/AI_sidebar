// 2.8, chunk 2 of the panel: the follow-up questions written with the answer (В6.1), the ready questions by page kind
// (В4.1) in every locale, the first-open test's arms by the install id (В6.2), and the free first answers marked for
// both arms (В6.4).
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"

import { NEXT_MARKER, splitNext } from "../src/shared/nextQuestions.ts"
import { NEXT_RULE, withNextRule } from "../src/shared/prompt.ts"
import { firstArm, variantOf } from "../src/shared/variant.ts"
import { uiFields, useFields, variantFields } from "../src/shared/usage.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(root + p, "utf8")

test("follow-up questions come off the answer, in any shape the model writes them, and never show while streaming", () => {
  const text = `The main point is that a shorter week kept output steady.\n\n${NEXT_MARKER}\n1. Which companies went back to five days?\n- «How was burnout measured?»\n`
  assert.deepEqual(splitNext(text), { text: "The main point is that a shorter week kept output steady.", next: ["Which companies went back to five days?", "How was burnout measured?"], web: false })
  // Streaming: the marker's start at the end is hidden, and nothing after it shows.
  assert.equal(splitNext("Answer text\n\n[[cf:ne").text, "Answer text")
  assert.equal(splitNext(`Answer\n${NEXT_MARKER}\nWhat ab`).text, "Answer")
  // No marker: the text as it is, no questions; more than two, or long lines, are left out.
  assert.deepEqual(splitNext("Just an answer."), { text: "Just an answer.", next: [], web: false })
  // В5.6: the answer needs what isn't on the page: the web mark, never shown as a question.
  assert.deepEqual(splitNext(`A\n${NEXT_MARKER}\nQ1?\nQ2?\n[[cf:web]]`), { text: "A", next: ["Q1?", "Q2?"], web: true })
  assert.equal(splitNext(`A\n${NEXT_MARKER}\nOne?\nTwo?\nThree?`).next.length, 2)
  assert.deepEqual(splitNext(`A\n${NEXT_MARKER}\n${"x".repeat(120)}\nShort one?`).next, ["Short one?"])
  // A reminder's marker after them doesn't leak into a question.
  assert.deepEqual(splitNext(`A\n${NEXT_MARKER}\nQ1?\nQ2? [[cf:add]]`).next, ["Q1?", "Q2?"])
})

test("the rule is added only when the panel asks, in the rules part, and the server passes body.next", () => {
  const parts: [string, string] = ["You are X.\nRules:\n- one\n- two\n\nPage:", "rest"]
  assert.deepEqual(withNextRule(parts, false), parts)
  const [rules, rest] = withNextRule(parts, true)
  assert.equal(rest, "rest")
  assert.ok(rules.includes(NEXT_RULE) && rules.indexOf(NEXT_RULE) < rules.indexOf("Page:"))
  assert.match(NEXT_RULE, /language of your answer/)
  assert.ok(NEXT_RULE.includes(NEXT_MARKER))
  assert.match(read("netlify/functions/v2-chat.mts"), /withNextRule\(withAgentRule\(withItemRule\([^\n]*\), body\.next === true\)/)
  assert.match(read("src/background/chat.ts"), /\.\.\.\(req\.payload\.next \? \{ next: true \} : \{\}\)/)
  // The background's job (the panel closed while it answered) keeps them off the stored text too.
  assert.match(read("src/background/jobs.ts"), /const \{ text, next, web \} = splitNext\(whole\)/)
})

test("ready questions: every kind has two or three, each in all 15 locales and not left in English", () => {
  const src = read("src/content/ready/questions.ts")
  const keys = [...src.matchAll(/"(rq[A-Z][A-Za-z]+)"/g)].map((m) => m[1])
  assert.ok(keys.length >= 15)
  for (const kind of ["product", "article", "video", "form", "event", "stay", "any"]) {
    const row = new RegExp(`${kind}: \\[([^\\]]+)\\]`).exec(src)
    assert.ok(row, kind)
    const n = row[1].split(",").length
    assert.ok(n >= 2 && n <= 3, `${kind}: ${n}`)
  }
  const en = JSON.parse(read("src/locales/en.json"))
  for (const file of readdirSync(root + "src/locales")) {
    const msgs = JSON.parse(read(`src/locales/${file}`))
    for (const key of [...keys, "rqTitle", "rqAgree", "rqAgreeNote", "rqContinue", "rqOwnWords", "fabFirstLabel", "phAgent", "googleOffer", "googleOfferFree", "googleOfferPro", "collectTip", "collectTipAdd"]) {
      assert.ok(typeof msgs[key] === "string" && msgs[key].length > 1, `${file} ${key}`)
      if (file !== "en.json") assert.notEqual(msgs[key], en[key], `${file} ${key} left in English`)
    }
    for (const key of ["rqContinue", "googleOfferFree", "googleOfferPro"]) assert.ok(msgs[key].includes("{0}"), `${file} ${key}`)
  }
})

test("the first-open test: arms by the install id's last hex digit, sent as client.variant and kept by the server", () => {
  assert.equal(firstArm("3f2504e0-4f89-41d3-9a0c-0305e82c3300"), "guide")
  assert.equal(firstArm("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "ask")
  assert.equal(firstArm("3f2504e0-4f89-41d3-9a0c-0305e82c330f"), "ask")
  assert.equal(firstArm("3f2504e0-4f89-41d3-9a0c-0305e82c330e"), "guide")
  assert.equal(firstArm(""), null)
  assert.equal(variantOf("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "first=ask")
  assert.deepEqual(variantFields({ variant: "first=ask" }), { variant: "first=ask" })
  // Only a new install is in the test (one updated from 2.7 keeps 2.7's first run, unlabelled).
  assert.match(read("src/background/index.ts"), /const variant = armed \? variantOf\(id\) : null/)
  assert.match(read("src/content/coach/seed.ts"), /armed: !before,/)
  // Both arms: the first three answers free (the guide's mark, and the first answers of every install).
  assert.match(read("src/content/App.tsx"), /\(guideRef\.current && !planTour\.current\) \|\| \(coachRef\.current\?\.ready && coachRef\.current\.answers < 3\) \? \{ tour: true as const \}/)
  // The "ask" arm starts with ready questions: its first run is over as the panel first opens.
  assert.match(read("src/content/App.tsx"), /if \(armRef\.current === "ask" && firstGuideRef\.current\(\)\) endTour\(\)/)
})

test("answers' rows know how a question came and the page's kind; the consent given by a ready question is counted", () => {
  assert.deepEqual(uiFields({ via: "ready", page: "product" }, "ask"), { via: "ready", page: "product" })
  assert.deepEqual(uiFields({ via: "followup", page: "https://x.example" }, "ask"), { via: "followup" })
  assert.deepEqual(useFields({ f: "consent", a: "accepted", via: "ready" }), { f: "consent", a: "accepted", via: "ready" })
  assert.deepEqual(useFields({ f: "chat", a: "continue" }), { f: "chat", a: "continue" })
})

test("one capability a day (В5): a line's tap does its feature here; forms get the agent's line; Google and collections offered where they fit", async () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /const DO_IT: ReadonlySet<string> = new Set\(\["similar", "listen", "watch", "summary", "agent"\]\)/)
  assert.match(app, /if \(!DO_IT\.has\(id\)\) return pageHints\.tap\(\)\n\s+\/\/[^\n]*\n\s+pageHints\.act\(\)\n\s+coach\.done\(`page_\$\{id\}` as CoachHint\)/)
  assert.match(app, /if \(id === "agent"\) \{\n\s+if \(!hasPro\(plan\)\) return setAgentUpsell\(true\)/)
  assert.match(app, /wantIf\("google_offer", open && view === "chat" && webFor\)/)
  assert.match(app, /ask\(webFor\.content, \{ mode: "google", via: "hint" \}\)/)
  assert.match(app, /wantIf\("collect_tip", open && view === "chat" && collectOffer !== null/)
  const rules = read("src/content/pagehints/rules.ts")
  assert.match(rules, /case "form":\n\s+return \["agent", "templates"\]/)
})
