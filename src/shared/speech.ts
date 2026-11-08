// Read aloud (2.6, Ultra): the text to speak, cut into parts, and what a part costs in seconds. Shared by the panel,
// the background worker (which asks /api/v2/speak part by part and keeps the audio) and the server (which charges
// seconds before it speaks). The app (Listen.swift) sends the same parts the panel made.

/** Audio from /api/v2/speak: headerless 16-bit signed little-endian PCM, mono. */
export const SPEECH_RATE = 24_000
export const SPEECH_BYTES_PER_SECOND = SPEECH_RATE * 2

/** The first part is short, so the first sound comes quickly; the rest are longer (fewer requests). */
export const FIRST_PART_CHARS = 240
// Build 91: parts of about 35 s (was 1400 characters, about 95 s): each is quick to make, so the next one is ready
// before the one playing ends, and a part that has to be asked for again costs little.
export const PART_CHARS = 500
/** At most this much text is read in one go (a long article: about 25 minutes). */
export const MAX_SPEECH_CHARS = 24_000

/**
 * Markdown (an answer) → plain text a voice can read: no code, no links' addresses, no table bars or list marks.
 * A list item or a heading becomes a sentence of its own.
 */
export function speechText(markdown: string): string {
  let text = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    // Fenced code: not read (a voice reading code helps nobody).
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/<\/?mark>/g, "")
    .replace(/<[^>\n]{1,40}>/g, "")
    // Images, then links: their words only.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    // Citations like [1] or [2, 3], and bare addresses.
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`\n]+)`/g, "$1")
  const lines: string[] = []
  const rawLines = text.split("\n")
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].trim()
    if (!line) {
      lines.push("")
      continue
    }
    // A table: each row as "first cell: column value, column value." (the owner: a table read cell by cell can't be
    // followed by ear). Without a header row, the cells joined with commas.
    if (isTableRow(line)) {
      const block: string[][] = []
      let header: string[] | null = null
      while (i < rawLines.length && isTableRow(rawLines[i].trim())) {
        const row = rawLines[i].trim()
        if (TABLE_RULE.test(row)) {
          if (block.length === 1 && !header) header = block.pop()!
        } else block.push(cells(row))
        i++
      }
      i--
      for (const row of block) lines.push(tableRow(row, header))
      continue
    }
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, "")
      .replace(/^[-*_]{3,}$/, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\p{L}\p{N}*_])[*_]([^*_\n]+)[*_](?=$|[^\p{L}\p{N}*_])/gu, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .trim()
    if (!line) continue
    // A heading or an item without its own stop reads as a sentence.
    if (!/[.!?…:;。！？؟।]$/.test(line)) line += "."
    lines.push(line)
  }
  text = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()
  return text.slice(0, MAX_SPEECH_CHARS)
}

const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/

function isTableRow(line: string): boolean {
  return TABLE_RULE.test(line) || (line.includes("|") && /^\|.*\|$/.test(line))
}

function cells(row: string): string[] {
  return row.replace(/^\||\|$/g, "").split("|").map((c) => c.replace(/(\*\*|__)(.+?)\1/g, "$2").trim())
}

/** One table row for the ear: "MARKUS: Price 299 dollars, Color dark gray." */
function tableRow(row: string[], header: string[] | null): string {
  const [head, ...rest] = row
  let line: string
  if (header && rest.length) {
    const said = rest.map((v, k) => (v ? `${header[k + 1] ? `${header[k + 1]} ` : ""}${v}` : "")).filter(Boolean)
    line = head ? `${head}: ${said.join(", ")}` : said.join(", ")
  } else line = row.filter(Boolean).join(", ")
  return /[.!?…:;。！？]$/.test(line) ? line : `${line}.`
}

const SENTENCE_END = /[.!?…。！？؟।]["'»”)\]]*\s+|\n+/g

/** Cuts the text into parts at sentence ends: a short first one, then up to PART_CHARS each. */
export function speechParts(text: string, first = FIRST_PART_CHARS, size = PART_CHARS): string[] {
  const sentences: string[] = []
  let last = 0
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length
    sentences.push(text.slice(last, end))
    last = end
  }
  if (last < text.length) sentences.push(text.slice(last))

  const parts: string[] = []
  let current = ""
  const push = () => {
    const part = current.trim()
    if (part) parts.push(part)
    current = ""
  }
  for (const sentence of sentences.flatMap((s) => splitLong(s, size))) {
    const limit = parts.length === 0 ? first : size
    if (current && current.length + sentence.length > limit) push()
    current += sentence
    // The first part ends after its first sentence once that's long enough to say something.
    if (parts.length === 0 && current.length >= first * 0.5) push()
  }
  push()
  return parts
}

/** A "sentence" longer than a part (no stops): cut at spaces. */
function splitLong(sentence: string, size: number): string[] {
  if (sentence.length <= size) return [sentence]
  const out: string[] = []
  let rest = sentence
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut + 1))
    rest = rest.slice(cut + 1)
  }
  if (rest) out.push(rest)
  return out
}

/**
 * How long the text takes to say, in seconds, for the allowance (charged before speaking; the server corrects it
 * with the real length afterwards). About 14 characters a second in alphabetic scripts, 5 in Chinese and Japanese,
 * 6 in Korean.
 */
export function speechSeconds(text: string): number {
  let units = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) units += 14 / 5
    else if (c >= 0xac00 && c <= 0xd7af) units += 14 / 6
    else units += 1
  }
  return Math.max(1, Math.ceil(units / 14))
}

/** Seconds of audio in `bytes` of PCM from /api/v2/speak. */
export function pcmSeconds(bytes: number): number {
  return bytes / SPEECH_BYTES_PER_SECOND
}

// Words that show a language Gemini Flash-Lite TTS doesn't speak (the full Flash TTS does), for text in the Latin
// script, where the script alone says nothing. Short, frequent words only; a hit needs several of them.
const LITE_LACKS: Array<[string, RegExp]> = [
  ["sv", /^(och|att|det|är|som|för|inte|med|på|av|till|jag|har|om|men|eller|också|kan|sig|vad|när|från|efter)$/],
  ["fi", /^(ja|on|ei|että|se|ovat|mutta|kun|tai|joka|myös|tämä|kanssa|niin|ole|olla|mitä|jos|sen|hän|vain|kuin)$/],
  ["lt", /^(ir|kad|yra|su|kaip|į|nėra|bet|tai|jis|ji|kuris|buvo|arba|taip|labai|apie|kas|dar|jau|nuo|iki)$/],
  ["sl", /^(in|je|da|se|za|na|ki|so|ne|tudi|kot|pa|bi|ali|sem|smo|ste|zelo|samo|lahko|vendar|kjer|ker)$/],
  ["sw", /^(na|ya|wa|kwa|ni|katika|za|la|hii|kama|lakini|pia|sana|kuwa|hiyo|wao|yake|watu|hapa|bado)$/],
  ["so", /^(iyo|oo|ka|ku|waa|ee|la|in|uu|ay|wax|aan|ayaa|kale|waxaa|isaga|iyada|sida|laakiin)$/]
]
// Words that mean the text is in a language Flash-Lite does speak (German "ja", Croatian "je"…): they cancel a hit.
const LITE_HAS = /^(und|der|die|das|ist|nicht|the|and|of|to|is|que|los|las|el|est|les|des|une|il|che|non|per|og|ikke|af|jeg|er|het|een|van|ali|što|nije|kao|ili|bio|samo|već|koji|jako)$/

/**
 * The TTS model kind for a text: "full" for a language Flash-Lite lacks (by its script, the `lang` hint the client
 * sends — the page's or the answer's language — or its words), "lite" otherwise. `fullLangs`: ISO codes Lite lacks.
 */
export function speechKind(text: string, lang: string | null | undefined, fullLangs: readonly string[]): "lite" | "full" {
  // Scripts only the full model reads: Thai, Myanmar (Burmese), Tibetan (Dzongkha), Ethiopic (Tigrinya).
  const sample = text.slice(0, 2000)
  const scripts = /[฀-๿]|[က-႟]|[ༀ-࿿]|[ሀ-፿]/gu
  const letters = sample.match(/\p{L}/gu)?.length ?? 0
  if (letters && (sample.match(scripts)?.length ?? 0) / letters > 0.3) return "full"

  const primary = (lang ?? "").toLowerCase().split(/[-_]/)[0]
  if (primary && fullLangs.includes(primary)) return "full"

  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? []
  if (words.length < 6) return "lite"
  let cancel = 0
  const hits = new Map<string, number>()
  for (const word of words) {
    if (LITE_HAS.test(word)) cancel++
    for (const [code, re] of LITE_LACKS) if (re.test(word)) hits.set(code, (hits.get(code) ?? 0) + 1)
  }
  for (const [code, n] of hits) {
    if (fullLangs.includes(code) && n >= Math.max(3, words.length * 0.12) && n > cancel * 1.5) return "full"
  }
  return "lite"
}

/**
 * Whether an answer needs writing for the ear (Claude Haiku, /api/v2/speak-script) before the voice reads it: a table,
 * a long or nested list, code, a formula or symbols, several links or headings. Plain prose goes straight to the voice.
 */
export function needsScript(markdown: string): boolean {
  const text = String(markdown ?? "")
  if (/^\s*\|.*\|\s*$/m.test(text) && /^\s*\|?\s*:?-{2,}/m.test(text)) return true
  if (/```/.test(text)) return true
  const items = text.match(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm)?.length ?? 0
  if (items >= 4 || /^\s{2,}(?:[-*+•]|\d{1,3}[.)])\s+/m.test(text)) return true
  if ((text.match(/^#{1,6}\s/gm)?.length ?? 0) >= 2) return true
  if ((text.match(/https?:\/\/|\]\(/g)?.length ?? 0) >= 2) return true
  if ((text.match(/[→←↔×÷±≈≤≥≠∑√∞°%‰€$£¥₽]|\b\d+\s*[–-]\s*\d+\b|`[^`]+`/g)?.length ?? 0) >= 6) return true
  return false
}

/** A long text for /api/v2/speak-script in pieces of at most `size` characters, cut between paragraphs (or sentences). */
export function scriptChunks(text: string, size = 5000): string[] {
  const out: string[] = []
  let current = ""
  for (const paragraph of String(text ?? "").split(/\n{2,}/)) {
    const pieces = paragraph.length > size ? speechParts(paragraph, size, size) : [paragraph]
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > size) {
        out.push(current.trim())
        current = ""
      }
      current += (current ? "\n\n" : "") + piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out.filter(Boolean)
}

/**
 * Cuts text that streams in (the text for listening) into parts as soon as they're complete, at sentence ends: the
 * very first part as soon as there's a sentence of `min` characters (the first sound comes early), then parts of up
 * to PART_CHARS. end() gives the rest.
 */
export class PartSplitter {
  private buffer = ""
  private first: boolean
  private readonly min: number

  constructor(first = true, min = 40) {
    this.first = first
    this.min = min
  }

  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    while (true) {
      const limit = this.first ? FIRST_PART_CHARS : PART_CHARS
      let cut = -1
      let firstEnd = -1
      for (const m of this.buffer.matchAll(SENTENCE_END)) {
        const end = (m.index ?? 0) + m[0].length
        if (firstEnd < 0) firstEnd = end
        if (end <= limit) cut = end
        else break
      }
      if (cut < 0 && firstEnd >= 0 && this.buffer.length > limit) cut = firstEnd
      if (cut < 0) break
      // A part waits until it's full, except the very first, which goes as soon as it says something.
      const ready = this.buffer.length >= limit || (this.first && cut >= this.min)
      if (!ready) break
      const part = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (part) {
        out.push(part)
        this.first = false
      }
    }
    return out
  }

  end(): string[] {
    const rest = speechParts(this.buffer.trim(), this.first ? FIRST_PART_CHARS : PART_CHARS)
    this.buffer = ""
    if (rest.length) this.first = false
    return rest
  }
}
