// Build 95: the panel and the app make the same text for listening from an answer: the same plain text, parts,
// language, choice to write it for the ear and parts of a text written for it, as src/shared (JS) and
// ContextFlow/Shared (App)/SpeechText.swift (built here with tests/speech-parity/main.swift) give them. A part's key is
// its words and language, so this is what lets an answer heard in Safari play in the app from what's kept, and count
// once in the week's minutes (and the other way round). Skipped where there's no Swift compiler; run on a Mac.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { textLanguage } from "../src/shared/share.ts"
import { needsScript, PartSplitter, scriptChunks, speechParts, speechText } from "../src/shared/speech.ts"

const root = new URL("..", import.meta.url).pathname
const swiftc = spawnSync("which", ["swiftc"]).status === 0
const skip = process.platform !== "darwin" ? "the app's Foundation is Apple's: run on a Mac" : !swiftc && "no swiftc here"

type Case = { op: string; s: string; first?: number | boolean; size?: number; step?: number }

function swift(cases: Case[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "cf-speech-"))
  const bin = join(dir, "speech")
  execFileSync("swiftc", ["-O", join(root, "ContextFlow/Shared (App)/SpeechText.swift"), join(root, "tests/speech-parity/main.swift"), "-o", bin], { stdio: "pipe" })
  return JSON.parse(execFileSync(bin, { input: JSON.stringify(cases), maxBuffer: 64 * 1024 * 1024 }).toString())
}

function split(s: string, step: number, first = true): string[] {
  const splitter = new PartSplitter(first)
  const out: string[] = []
  if (step <= 0) out.push(...splitter.push(s))
  else {
    for (let at = 0; at < s.length;) {
      let end = Math.min(s.length, at + step)
      const code = s.charCodeAt(end - 1)
      if (end < s.length && code >= 0xd800 && code <= 0xdbff) end++
      out.push(...splitter.push(s.slice(at, end)))
      at = end
    }
  }
  return [...out, ...splitter.end()]
}

function js(c: Case): unknown {
  switch (c.op) {
    case "text": return speechText(c.s)
    case "parts": return speechParts(c.s, typeof c.first === "number" ? c.first : undefined, c.size)
    case "needsScript": return needsScript(c.s)
    case "chunks": return scriptChunks(c.s)
    case "lang": return textLanguage(c.s) ?? null
    case "split": return split(c.s, c.step ?? 0, c.first !== false)
    case "answer": {
      const text = c.s.slice(0, 24_000)
      return { parts: speechParts(speechText(text)).slice(0, 80), lang: textLanguage(c.s) ?? null, script: needsScript(text) }
    }
    default: return null
  }
}

// ------------------------------------------------------------ cases

/** Answers as the models write them: prose, lists, tables, code, links and citations, in the panel's 14 languages. */
const ANSWERS = [
  "The Deepal S05 is a comfortable electric crossover with a long range.",
  "Most likely a date: the eleventh of February.",
  "Electric trains draw power from overhead lines or a third rail. Modern ones return energy to the grid when they brake, so a busy line uses less than its timetable suggests. Regenerative braking alone saves between a tenth and a third of the energy, depending on how often trains stop. Lighter cars and smoother driving save the rest.",
  "## Short answer\n\nYes, **it folds flat** — see [the spec](https://example.com/spec?a=(1)) [1].\n\n## Details\n\n- Weight: 6.2 kg\n- Wheels: *no*\n- Price: 189 €\n- Rain cover: included\n\n1. Open the frame.\n2. Click the lock.\n\n> Note: prices change.\n\n---\n\nSource: https://example.com/backvac",
  "| Model | Price | Wheels |\n|---|---:|:---:|\n| **Pro** | 189 € | no |\n| Pro Max | 272,95 € | yes |\n| Lite | 129 € |  |\n\nThe Pro is the best value.",
  "| a | b |\n| c | d |\n\nNo header row here.",
  "Use `npm test` to run it:\n\n```bash\nnpm test -- --watch\n```\n\nThen open `http://localhost:8787`.",
  "Unclosed fence:\n```js\nconst x = 1\n",
  "Ответ: да. Модель **Pro** складывается, а у Pro Max есть колёса — но она дороже (272,95 €). Что выбрать? Если летаете пару раз в год, хватит Pro.\n\n- Вес: 6,2 кг\n- Цена: 189 €",
  "Що це таке? Це складаний рюкзак-переноска. Він важить 6,2 кг і коштує 189 євро.",
  "Die Bahn fährt um 10:15 ab. Warum ist sie so pünktlich? Weil der Fahrplan für diese Strecke großzügig ist und es fast nie Störungen gibt.",
  "¿Qué es esto? Es una mochila plegable para viajar. Cuesta 189 euros y pesa poco más de seis kilos.",
  "Qu’est-ce que c’est ? C’est un sac pliable. Il coûte 189 euros et pèse 6,2 kg — idéal pour les vols courts.",
  "Che cosa è questo? È uno zaino pieghevole per il viaggio, costa 189 euro e pesa poco.",
  "O que é isso? É uma mochila dobrável. Não é cara: custa 189 euros e pesa pouco mais de seis quilos.",
  "Đây là gì? Đây là một chiếc ba lô gấp gọn cho chuyến bay. Giá của nó là 189 euro và nặng hơn sáu ký một chút.",
  "这是什么？这是一款可折叠的旅行背包。它的价格是189欧元，重6.2公斤。总结：适合经常出差的人。",
  "這是什麼？這是一款可折疊的旅行背包。它的價格是189歐元，重6.2公斤。總結：適合經常出差的人。",
  "これは何ですか？旅行用の折りたたみリュックです。価格は189ユーロで、重さは6.2キロです。",
  "이것은 무엇인가요? 여행용 접이식 배낭입니다. 가격은 189유로이고 무게는 6.2킬로그램입니다.",
  "ما هذا؟ إنها حقيبة ظهر قابلة للطي للسفر. سعرها 189 يورو ووزنها 6.2 كيلوغرام.",
  "यह क्या है? यह यात्रा के लिए एक फोल्डिंग बैग है। इसकी कीमत 189 यूरो है।",
  "Prices: 10-20 €, 30–40 $, 5 × 3, ≈ 7 %, 1-2, 3-4, `a`, `b`, → done ← back ≤ ≥",
  "Links: [one](https://a.example) and [two](https://b.example/x_(y)) and ![img](https://c.example/i.png) and <mark>this</mark> <b>bold</b>.",
  "A *quiet* word, an _emphasis_, a **strong** one, __another__, ~~gone~~, snake_case_name and 2*3*4 stay.",
  "No stops at all just words going on and on " + "and on ".repeat(120) + "until the end",
  `${"Word".repeat(130)} then a space and more text after a very long token.`,
  "Line one\r\nLine two\r\n\r\n\r\n\r\nLine three with spaces　and\ttabs.",
  "Emoji 🙂 in a sentence. Another 👍🏽 one! And a question 🤔? Fine.",
  "Short. Short. Short. Short. Short. Short. Short. Short. Short. Short. Short. Short. Short. Short.",
  "e.g. this is fine. i.e. that too. Mr. Smith arrived at 3.5 p.m. on Jan. 5. He left.",
  "  1. first\n  2. nested\n    - deeper\n",
  "# One\n## Two\nText.",
  "",
  "   \n\n  ",
  "—",
  "Visit www.example.com or https://example.com/path for more; then [3, 4] and [1–2] citations [12].",
  "Ask: «Что это?» — ответ: «Это рюкзак.» Потом (в скобках.) и «кавычки!» дальше."
]

/** Seeded pieces for answers no one wrote by hand: where the two regex engines could part ways. */
const PIECES = [
  "Hello world. ", "Привет, мир! ", "Що це? ", "中文句子。", "日本語です。", "한국어 문장입니다. ", "مرحبا بالعالم؟ ", "हिंदी वाक्य। ",
  "\n", "\n\n", "\n\n\n", "\r\n", "  ", "\t", " ", " ", "﻿", "\u0085",
  "# Heading\n", "### Small heading\n", "- item\n", "* item\n", "+ item\n", "• item\n", "12) item\n", "3. item\n", "> quote\n", "---\n",
  "| a | b |\n", "|---|---|\n", "| **x** | y |\n", "|:-:|\n",
  "**bold** ", "__bold__ ", "*it* ", "_it_ ", "~~del~~ ", "`code` ", "```\nblock\n``` ", "```",
  "[link](https://x.example/a) ", "![alt](https://x.example/i.png) ", "[1] ", "[2, 3] ", "https://bare.example/x?y=1 ", "www.site.example ",
  "<mark>m</mark> ", "<br> ", "<a href=x> ", "10-20 ", "5 – 7 ", "×", "%", "€", "$ ", "→ ",
  "e.g. ", "3.5 ", "Dr. ", "?! ", "…", "» ", "\") ", "] ", "word", "Wörter ", "ñandú ", "œuvre ", "đường ", "ăn ",
  "the ", "and ", "der ", "und ", "el ", "que ", "le ", "est ", "il ", "che ", "não ", "của ", "🙂 ", "👍🏽", "a".repeat(30), " ".repeat(5)
]

function seeded(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

function generated(count: number, seed = 95): string[] {
  const random = seeded(seed)
  return Array.from({ length: count }, () => {
    const n = 3 + Math.floor(random() * 60)
    return Array.from({ length: n }, () => PIECES[Math.floor(random() * PIECES.length)]).join("")
  })
}

const TEXTS = [...ANSWERS, ...generated(300)]

test("the app makes the same text for listening as the panel: plain text, parts, language, written for the ear", { skip }, () => {
  const cases: Case[] = []
  for (const s of TEXTS) {
    cases.push({ op: "text", s }, { op: "needsScript", s }, { op: "lang", s }, { op: "chunks", s }, { op: "answer", s })
    const plain = speechText(s)
    cases.push({ op: "parts", s: plain }, { op: "parts", s: plain, first: 500, size: 500 }, { op: "parts", s: plain, first: 60, size: 120 })
  }
  // Long texts: chunks for writing them for the ear, cut between paragraphs (and sentences, when a paragraph is longer).
  const long = Array.from({ length: 30 }, (_, i) => ANSWERS[i % ANSWERS.length]).join("\n\n")
  cases.push({ op: "chunks", s: long }, { op: "chunks", s: long.replace(/\n\n/g, " ") }, { op: "answer", s: long.repeat(12) })
  const app = swift(cases)
  const differ: string[] = []
  cases.forEach((c, i) => {
    const mine = js(c)
    try {
      assert.deepEqual(app[i], mine)
    } catch {
      if (differ.length < 8) differ.push(`${c.op} ${JSON.stringify(c.s.slice(0, 120))}\n  panel: ${JSON.stringify(mine).slice(0, 400)}\n  app:   ${JSON.stringify(app[i]).slice(0, 400)}`)
    }
  })
  assert.equal(differ.length, 0, `the app differs from the panel:\n${differ.join("\n")}`)
})

test("a text written for the ear gives the same parts streamed in any pieces and whole (its replay), here and in the app", { skip }, () => {
  const scripts = [
    "Here are the three options. The first one, the Backvac Pro, costs 189 euros and folds flat for travel. The second, the Pro Max, has wheels and a bigger frame, but it costs 272 euros and weighs more. The third is the Lite, which is the cheapest at 129 euros, though it has no rain cover. If you want wheels under 200 euros, none of these fits; the Pro is the closest. Overall the Pro is the best value for most people who fly a few times a year.",
    ...ANSWERS.map(speechText).filter((s) => s.length > 60),
    ...generated(60, 7).map(speechText)
  ]
  const cases: Case[] = []
  for (const s of scripts) for (const step of [0, 1, 3, 7, 16, 41, 97]) for (const first of [true, false]) cases.push({ op: "split", s, step, first })
  const app = swift(cases)
  const differ: string[] = []
  cases.forEach((c, i) => {
    const mine = js(c)
    const whole = js({ ...c, step: 0 })
    if (JSON.stringify(mine) !== JSON.stringify(whole) && differ.length < 6) differ.push(`panel, streamed by ${c.step} vs whole: ${JSON.stringify(c.s.slice(0, 80))}\n  ${JSON.stringify(mine).slice(0, 300)}\n  ${JSON.stringify(whole).slice(0, 300)}`)
    if (JSON.stringify(app[i]) !== JSON.stringify(mine) && differ.length < 6) differ.push(`app vs panel, by ${c.step}: ${JSON.stringify(c.s.slice(0, 80))}\n  ${JSON.stringify(app[i]).slice(0, 300)}\n  ${JSON.stringify(mine).slice(0, 300)}`)
  })
  assert.equal(differ.length, 0, differ.join("\n"))
})
