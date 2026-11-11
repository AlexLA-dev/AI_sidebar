// Build 95: the panel and the app make the same text for listening from an answer: the same plain text, parts,
// language, choice to write it for the ear and parts of a text written for it, as src/shared (JS) and
// ContextFlow/Shared (App)/SpeechText.swift (built here with tests/speech-parity/main.swift) give them. A part's key is
// its words and language, so this is what lets an answer heard in Safari play in the app from what's kept, and count
// once in the week's minutes (and the other way round). Skipped where there's no Swift compiler; run on a Mac.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { textLanguage } from "../src/shared/share.ts"
import { addRange, coveredSeconds, listenPace, listenTotal, type Ranges, slotMask, spread } from "../src/shared/coverage.ts"
import { needsScript, PartSplitter, scriptChunks, speechParts, speechText } from "../src/shared/speech.ts"
import { voicedId } from "../src/shared/voiced.ts"

const root = new URL("..", import.meta.url).pathname
const swiftc = spawnSync("which", ["swiftc"]).status === 0
const skip = process.platform !== "darwin" ? "the app's Foundation is Apple's: run on a Mac" : !swiftc && "no swiftc here"

type Case = {
  op: string; s: string; first?: number | boolean; size?: number; step?: number; what?: string; list?: string[]; kept?: Record<string, string>
  // Build 98, "listen": a listen's stretches over parts that start at `starts` (audio in hand to `end`), what was heard
  // before, the parts' lengths; and the text's length from its parts' words and audio.
  starts?: number[]; end?: number; lengths?: number[]; before?: Record<string, Ranges>; stretches?: Ranges
  parts?: string[]; audio?: Array<number | null>; unwritten?: string; written?: string; pace?: number
}

// A run takes about a second, the build under a minute. A process stuck at 0 % CPU (a fresh binary whose launch waits
// on the system's code checks on a busy Mac, or a pipe nobody drains) fails the test after these instead of holding
// the suite for hours, as organize-parity does (#133). The run is waited for asynchronously: a process stuck in its
// launch can't be killed until the system lets it go, and a synchronous wait would hang with it.
const BUILD_MS = 300_000
const RUN_MS = 60_000

// Built once for every test here, as the app is: Swift 6 checks, the main actor by default (VoicedQuery's work must
// not need it).
let built: string | null = null
function binary(): string {
  if (built) return built
  const bin = join(mkdtempSync(join(tmpdir(), "cf-speech-")), "speech")
  execFileSync("swiftc", ["-O", "-swift-version", "6", "-default-isolation", "MainActor", join(root, "ContextFlow/Shared (App)/SpeechText.swift"), join(root, "tests/speech-parity/main.swift"), "-o", bin], { stdio: "pipe", timeout: BUILD_MS, killSignal: "SIGKILL" })
  return (built = bin)
}

async function swift(cases: Case[]): Promise<unknown[]> {
  // Texts as UTF-16 units: Foundation's JSONSerialization drops a leading U+FEFF from a string, so the app would get
  // another text than the panel.
  const units = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
  const sent = cases.map(({ s, list, parts, unwritten, written, ...rest }) => ({
    ...rest, u: units(s), ...(list ? { lu: list.map(units) } : {}),
    ...(parts ? { parts: parts.map(units) } : {}), ...(unwritten !== undefined ? { unwritten: units(unwritten) } : {}), ...(written !== undefined ? { written: units(written) } : {})
  }))
  const child = spawn(binary(), { stdio: "pipe" })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on("data", (b: Buffer) => out.push(b))
  child.stderr.on("data", (b: Buffer) => err.push(b))
  child.stdin.on("error", () => undefined)
  child.stdin.end(JSON.stringify(sent))
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code))
  })
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), RUN_MS) })
  const code = await Promise.race([done, late]).finally(() => clearTimeout(timer))
  if (code === "late") {
    child.kill("SIGKILL")
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy()
    throw new Error(`the Swift side didn't answer in ${RUN_MS / 1000} s (pid ${child.pid}, killed): ${Buffer.concat(err).toString().slice(0, 500)}`)
  }
  if (code !== 0) throw new Error(`the Swift side exited with ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`)
  return JSON.parse(Buffer.concat(out).toString())
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

/** A part's key, as the server, the panel and the app name it. */
const partKey = (part: string, lang: string) => createHash("sha256").update(`v1|${lang}|${part}`).digest("hex")

/** src/background/speak.ts textPartKeys for an answer, with what's kept on the device given (the panel's language else "en"). */
function textKeys(text: string, kept: Record<string, string>): string[] {
  const source = text.slice(0, 24_000)
  const lang = textLanguage(text) ?? "en"
  let parts: string[] = []
  if (needsScript(source)) {
    for (const chunk of scriptChunks(source)) {
      const script = kept[`script|answer|${partKey(chunk, lang)}`]
      if (script === undefined) return []
      const splitter = new PartSplitter(parts.length === 0)
      parts.push(...splitter.push(script), ...splitter.end())
    }
  } else {
    parts = speechParts(speechText(source)).slice(0, 80)
  }
  return parts.filter((part) => /[\p{L}\p{N}]/u.test(part)).map((part) => partKey(part, lang))
}

/** The scripts the panel or the app would have kept for an answer written for the ear (made up here, one per chunk). */
function scriptsFor(text: string): Record<string, string> {
  const lang = textLanguage(text) ?? "en"
  const kept: Record<string, string> = {}
  scriptChunks(text.slice(0, 24_000)).forEach((chunk, i) => {
    kept[`script|answer|${partKey(chunk, lang)}`] = `Here is part ${i + 1}, written for listening. ${speechText(chunk).slice(0, 700)} That is all for this part.`
  })
  return kept
}

function js(c: Case): unknown {
  switch (c.op) {
    case "text": return speechText(c.s)
    case "parts": return speechParts(c.s, typeof c.first === "number" ? c.first : undefined, c.size)
    case "needsScript": return needsScript(c.s)
    case "chunks": return scriptChunks(c.s)
    case "lang": return textLanguage(c.s) ?? null
    case "split": return split(c.s, c.step ?? 0, c.first !== false)
    case "voicedId": return voicedId((c.what ?? "answer") as "answer" | "page", c.s)
    case "answers": {
      const out: string[][] = []
      for (const text of (c.list ?? []).slice(-30)) {
        if (!text) continue
        const id = voicedId("answer", text)
        if (!out.some(([known]) => known === id)) out.push([id, text])
      }
      return out
    }
    case "keys": return textKeys(c.s, c.kept ?? {})
    case "listen": {
      const ranges: Record<number, Ranges> = {}
      for (const [part, list] of Object.entries(c.before ?? {})) ranges[Number(part)] = list.map(([a, b]) => [a, b])
      for (const [a, b] of c.stretches ?? []) {
        for (const piece of spread(a, b, c.starts ?? [], c.end ?? 0)) ranges[piece.part] = addRange(ranges[piece.part] ?? [], piece.from, piece.to)
      }
      const round = (v: number) => Math.round(v * 1000) / 1000
      const parts = (c.starts ?? []).map((_, part) => {
        const r = ranges[part] ?? []
        return { r: r.map(([a, b]) => [round(a), round(b)]), s: coveredSeconds(r), c: slotMask(r, c.lengths?.[part] ?? 0) }
      })
      const audio = (c.audio ?? []).map((v) => v ?? undefined)
      return { parts, total: listenTotal({ parts: c.parts ?? [], audio, unwritten: c.unwritten ?? "", written: c.written ?? "", pace: c.pace ?? 1 }), pace: listenPace(c.parts ?? [], audio) }
    }
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

test("the app makes the same text for listening as the panel: plain text, parts, language, written for the ear", { skip }, async () => {
  const cases: Case[] = []
  for (const s of TEXTS) {
    cases.push({ op: "text", s }, { op: "needsScript", s }, { op: "lang", s }, { op: "chunks", s }, { op: "answer", s })
    const plain = speechText(s)
    cases.push({ op: "parts", s: plain }, { op: "parts", s: plain, first: 500, size: 500 }, { op: "parts", s: plain, first: 60, size: 120 })
  }
  // Long texts: chunks for writing them for the ear, cut between paragraphs (and sentences, when a paragraph is longer).
  const long = Array.from({ length: 30 }, (_, i) => ANSWERS[i % ANSWERS.length]).join("\n\n")
  cases.push({ op: "chunks", s: long }, { op: "chunks", s: long.replace(/\n\n/g, " ") }, { op: "answer", s: long.repeat(12) })
  const app = await swift(cases)
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

test("a text written for the ear gives the same parts streamed in any pieces and whole (its replay), here and in the app", { skip }, async () => {
  const scripts = [
    "Here are the three options. The first one, the Backvac Pro, costs 189 euros and folds flat for travel. The second, the Pro Max, has wheels and a bigger frame, but it costs 272 euros and weighs more. The third is the Lite, which is the cheapest at 129 euros, though it has no rain cover. If you want wheels under 200 euros, none of these fits; the Pro is the closest. Overall the Pro is the best value for most people who fly a few times a year.",
    ...ANSWERS.map(speechText).filter((s) => s.length > 60),
    ...generated(60, 7).map(speechText)
  ]
  const cases: Case[] = []
  for (const s of scripts) for (const step of [0, 1, 3, 7, 16, 41, 97]) for (const first of [true, false]) cases.push({ op: "split", s, step, first })
  const app = await swift(cases)
  const differ: string[] = []
  cases.forEach((c, i) => {
    const mine = js(c)
    const whole = js({ ...c, step: 0 })
    if (JSON.stringify(mine) !== JSON.stringify(whole) && differ.length < 6) differ.push(`panel, streamed by ${c.step} vs whole: ${JSON.stringify(c.s.slice(0, 80))}\n  ${JSON.stringify(mine).slice(0, 300)}\n  ${JSON.stringify(whole).slice(0, 300)}`)
    if (JSON.stringify(app[i]) !== JSON.stringify(mine) && differ.length < 6) differ.push(`app vs panel, by ${c.step}: ${JSON.stringify(c.s.slice(0, 80))}\n  ${JSON.stringify(app[i]).slice(0, 300)}\n  ${JSON.stringify(mine).slice(0, 300)}`)
  })
  assert.equal(differ.length, 0, differ.join("\n"))
})

test("a chat's answers asked about as it opens: the same ids and parts' keys as the panel, worked out off the main thread (build 95)", { skip }, async () => {
  const cases: Case[] = []
  for (const s of TEXTS) {
    cases.push({ op: "voicedId", s, what: "answer" }, { op: "voicedId", s, what: "page" }, { op: "keys", s })
    // Written for the ear: its parts' keys once its writing is kept here, none while a chunk's writing is missing.
    if (needsScript(s.slice(0, 24_000))) {
      const kept = scriptsFor(s)
      cases.push({ op: "keys", s, kept })
      const [first] = Object.keys(kept)
      if (Object.keys(kept).length > 1) cases.push({ op: "keys", s, kept: Object.fromEntries(Object.entries(kept).filter(([k]) => k !== first)) })
    }
  }
  const long = Array.from({ length: 30 }, (_, i) => ANSWERS[i % ANSWERS.length]).join("\n\n").repeat(3)
  cases.push({ op: "voicedId", s: long }, { op: "keys", s: long }, { op: "keys", s: long, kept: scriptsFor(long) })
  // The chat's last 30 answers, each once, empty ones left out.
  cases.push({ op: "answers", s: "", list: [...TEXTS.slice(0, 40), "", TEXTS[39], TEXTS[38]] }, { op: "answers", s: "", list: ["", ANSWERS[0], ANSWERS[0]] })
  const app = await swift(cases)
  const differ: string[] = []
  cases.forEach((c, i) => {
    const mine = js(c)
    if (JSON.stringify(app[i]) !== JSON.stringify(mine) && differ.length < 6) differ.push(`${c.op} ${JSON.stringify(c.s.slice(0, 80))}\n  panel: ${JSON.stringify(mine).slice(0, 300)}\n  app:   ${JSON.stringify(app[i]).slice(0, 300)}`)
  })
  assert.equal(differ.length, 0, `the app differs from the panel:\n${differ.join("\n")}`)
  // Not trivially equal: written for the ear, kept scripts give keys and a missing one gives none.
  const keyed = cases.filter((c) => c.op === "keys" && c.kept && Object.keys(c.kept).length > 0)
  assert.ok(keyed.some((c) => (js(c) as string[]).length > 0))
})

test("a listen's stretches, the parts' tenths and the text's length: the same in the app as in the panel (build 98)", { skip }, async () => {
  // Seeded, so a failure repeats.
  let seed = 98
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const cases: Case[] = []
  for (let n = 0; n < 160; n++) {
    const lengths = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => Math.round((0.2 + rand() * 25) * 100) / 100)
    const starts: number[] = []
    let at = 0
    for (const length of lengths) {
      starts.push(Math.round(at * 100) / 100)
      at += length
    }
    const end = Math.round(at * 100) / 100
    // Plays in ticks, with seeks forward and back, at 1× to 2×.
    const stretches: Ranges = []
    let pos = rand() < 0.7 ? 0 : rand() * end
    for (let step = 0; step < 200 && pos < end; step++) {
      if (rand() < 0.04) pos = Math.max(0, Math.min(end - 0.1, pos + (rand() - 0.4) * 12))
      const next = Math.min(end, pos + 0.25 * (1 + Math.floor(rand() * 4) * 0.25))
      stretches.push([Math.round(pos * 1000) / 1000, Math.round(next * 1000) / 1000])
      pos = next
    }
    const before: Record<string, Ranges> = rand() < 0.4 ? { "0": [[0, Math.round(rand() * lengths[0] * 100) / 100]] } : {}
    const parts = Array.from({ length: lengths.length }, (_, i) => TEXTS[(n * 7 + i) % TEXTS.length].slice(0, 400))
    const audio = parts.map((p) => (rand() < 0.5 ? null : Math.round(rand() * 40 * 10) / 10))
    const written = rand() < 0.5 ? TEXTS[(n * 3) % TEXTS.length].slice(0, 300) : ""
    const unwritten = written ? TEXTS[(n * 5) % TEXTS.length].slice(0, 500) : ""
    cases.push({ op: "listen", s: "", starts, end, lengths, before, stretches, parts, audio, unwritten, written, pace: Math.round((0.5 + rand() * 1.5) * 100) / 100 })
  }
  const app = await swift(cases)
  const differ: string[] = []
  cases.forEach((c, i) => {
    try {
      assert.deepEqual(app[i], js(c))
    } catch {
      if (differ.length < 4) differ.push(`case ${i}\n  panel: ${JSON.stringify(js(c)).slice(0, 400)}\n  app:   ${JSON.stringify(app[i]).slice(0, 400)}`)
    }
  })
  assert.equal(differ.length, 0, `the app differs from the panel:\n${differ.join("\n")}`)
  // Not trivially equal: some parts whole, some not; some totals from audio, some from words.
  const results = cases.map(js) as Array<{ parts: Array<{ c: number }> }>
  assert.ok(results.some((r) => r.parts.some((p) => p.c === 1023)) && results.some((r) => r.parts.some((p) => p.c !== 1023 && p.c !== 0)))
})
