// Calibrating "organizing" (2.5) on chats in the app's chats.json format (tools/organize/make-sample.mjs makes
// synthetic ones), with the rules the panel and the app run (src/shared/organize.ts). Vectors and tag checks come
// from /api/v2/organize — a deploy preview with ORGANIZE_EVAL_TOKEN set, so the provider keys stay in Netlify.
//   node --experimental-strip-types tools/organize/calibrate.mts <chats.json> <outDir> --base=<deploy preview URL>
//   node --experimental-strip-types tools/organize/calibrate.mts <chats.json> <outDir> --fake   (no network)
// The token is read from ORGANIZE_EVAL_TOKEN or asked for (hidden). Prints numbers only; metrics.json has them all.
//
// What it measures, on a grid of thresholds:
// - piles (<chats>.truth.json): replayed block by block, the suggestions shown and whether each was right;
// - a block of chat B added to an unrelated chat A: moved back to B (or to a chat like B), elsewhere, or not at all;
//   the same with B gone: "a new chat";
// - coherent chats as they are: any suggestion is a false one;
// - tags: a tag taken off a message, suggested back after the check; tags meaning an intention ("later") suggested.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import readline from "node:readline"

import { entryKey, type Entry } from "../../src/shared/conversation.ts"
import { DEFAULT_ORGANIZE, embedText, judgedTags, judgeText, suggestMove, tagCandidates, unpackVector, type OrganizeConfig, type VectorOf } from "../../src/shared/organize.ts"
import { moveEntries, pageBlocks, threadFromCloud, type Thread, type Threads } from "../../src/shared/threads.ts"

const args = process.argv.slice(2)
const [chatsPath, outDir] = args.filter((a) => !a.startsWith("--"))
const FAKE = args.includes("--fake")
const BASE = args.find((a) => a.startsWith("--base="))?.slice(7).replace(/\/$/, "")
const NO_JUDGE = args.includes("--no-judge")
if (!chatsPath || !outDir || (!FAKE && !BASE)) {
  console.log("node --experimental-strip-types tools/organize/calibrate.mts <chats.json> <outDir> (--base=<url> | --fake) [--no-judge]")
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

async function askHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as readline.Interface & { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
  let muted = false
  rl._writeToOutput = (s) => { if (!muted) rl.output.write(s) }
  const answer = new Promise<string>((resolve) => rl.question(question, (a) => { rl.close(); process.stdout.write("\n"); resolve(a.trim()) }))
  muted = true
  return answer
}

const token = FAKE ? "" : process.env.ORGANIZE_EVAL_TOKEN || (await askHidden("ORGANIZE_EVAL_TOKEN (hidden): "))
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

// ------------------------------------------------------------ chats

const raw = JSON.parse(readFileSync(chatsPath, "utf8")) as Record<string, { updatedAt: number; data: string }>
const truthPath = chatsPath.replace(/\.json$/, "") + ".truth.json"
const truth: Record<string, Array<string | null>> = existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, "utf8")) : {}
const threads: Threads = {}
for (const [id, item] of Object.entries(raw)) {
  const t = threadFromCloud(item.data)
  if (t && t.m.length) threads[id] = { id, u: item.updatedAt, ...t }
}
const all = Object.values(threads)
console.log(`Chats ${all.length}, messages ${all.reduce((n, t) => n + t.m.length, 0)}, piles ${Object.keys(truth).length}`)

// ------------------------------------------------------------ vectors and checks (cached in outDir)

const cachePath = join(outDir, FAKE ? "cache-fake.json" : "cache.json")
const cache: { vectors: Record<string, string>; verdicts: Record<string, Array<{ tag: string; fits: boolean; confidence: number }>>; space?: string } =
  existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : { vectors: {}, verdicts: {} }
const usage = { embedRequests: 0, texts: 0, checks: 0 }
const INSTALL = "00000000-0000-4000-8000-00000000ca1b"

async function api(body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${BASE}/api/v2/organize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ installId: INSTALL, client: { version: "calibrate", platform: "other", locale: "en" }, ...body })
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`/api/v2/organize ${body.op}: ${res.status} ${out.code ?? ""}`)
  return out
}

function fakeVector(text: string): string {
  const v = new Float32Array(256)
  const t = ` ${text.toLowerCase()} `
  for (let i = 0; i + 3 <= t.length; i++) v[parseInt(sha(t.slice(i, i + 3)).slice(0, 8), 16) % 256] += 1
  let binary = ""
  let max = 0
  for (const x of v) max = Math.max(max, x)
  for (const x of v) binary += String.fromCharCode(Math.round((x / (max || 1)) * 127) & 0xff)
  return btoa(binary)
}

const texts = [...new Set(all.flatMap((t) => t.m.map(embedText)).filter(Boolean))]
const missing = texts.filter((x) => !cache.vectors[sha(x)])
for (let i = 0; i < missing.length; i += 128) {
  const batch = missing.slice(i, i + 128)
  if (FAKE) batch.forEach((x) => { cache.vectors[sha(x)] = fakeVector(x) })
  else {
    const res = await api({ op: "embed", texts: batch })
    cache.space = res.space
    batch.forEach((x, j) => { cache.vectors[sha(x)] = res.vectors[j] })
    usage.embedRequests++
  }
  usage.texts += batch.length
  process.stdout.write(`\rVectors ${Math.min(i + 128, missing.length)}/${missing.length}`)
}
if (missing.length) process.stdout.write("\n")
writeFileSync(cachePath, JSON.stringify(cache))

const unpacked = new Map<string, Float32Array | null>()
const vectorOf: VectorOf = (e: Entry) => {
  const text = embedText(e)
  if (!text) return null
  const key = sha(text)
  if (!unpacked.has(key)) unpacked.set(key, cache.vectors[key] ? unpackVector(cache.vectors[key]) : null)
  return unpacked.get(key)
}

async function judge(chat: Thread, index: number, candidates: ReturnType<typeof tagCandidates>) {
  if (FAKE || NO_JUDGE || !candidates.length) return candidates.map((c) => ({ tag: c.tag, fits: true, confidence: 1 }))
  const message = judgeText(chat.m, index)
  const key = sha(JSON.stringify([message, candidates.map((c) => [c.tag, c.examples])]))
  if (!cache.verdicts[key]) {
    cache.verdicts[key] = (await api({ op: "tags", message, candidates: candidates.map((c) => ({ tag: c.tag, examples: c.examples })) })).verdicts
    usage.checks++
  }
  return cache.verdicts[key]
}

// ------------------------------------------------------------ moves

const piles = new Set(Object.keys(truth))
const topicChats = all.filter((t) => !piles.has(t.id))
const later = (t: Thread) => Math.max(0, ...t.m.map((e) => e.t ?? e.page?.at ?? 0))

/** A block of `from` added to the end of `to` as the newest, and gone from `from` (or `from` gone entirely). */
function graft(to: Thread, from: Thread, dropSource: boolean): Threads | null {
  const blocks = pageBlocks(from.m)
  const b = blocks[blocks.length - 1]
  if (!b || blocks.length < 2) return null
  const at = later(to) + 3_600_000
  const moved = from.m.slice(b.start, b.end + 1).map((e, i) => ({ ...e, id: undefined, from: undefined, t: at + i * 1_000, ...(e.page ? { page: { ...e.page, at: at + i * 1_000 } } : {}) }))
  const next: Threads = { ...threads }
  for (const p of piles) delete next[p]
  next[to.id] = { ...to, m: [...to.m, ...moved] }
  if (dropSource) delete next[from.id]
  else next[from.id] = { ...from, m: from.m.slice(0, b.start) }
  return next
}

// Topics of the same tag (two cooking chats) count as a right place too: the user may keep two chats on it.
const tagOf = (t: Thread) => t.m.flatMap((e) => e.tags ?? [])[0] ?? t.tags?.[0] ?? ""
let seed = 11
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const pairs: Array<[Thread, Thread]> = []
for (const a of topicChats) for (const b of topicChats) if (a.id !== b.id && tagOf(a) !== tagOf(b)) pairs.push([a, b])
pairs.sort(() => rand() - 0.5)
const PAIRS = pairs.slice(0, 160)

interface MoveRun { right: number; wrong: number; none: number; apartRight: number; apartWrong: number; apartNone: number; falseMoves: number; coherent: number; piles: { shown: number; right: number; found: number; blocks: number } }

function runMoves(cfg: OrganizeConfig): MoveRun {
  const r: MoveRun = { right: 0, wrong: 0, none: 0, apartRight: 0, apartWrong: 0, apartNone: 0, falseMoves: 0, coherent: 0, piles: { shown: 0, right: 0, found: 0, blocks: 0 } }
  for (const [a, b] of PAIRS) {
    const g = graft(a, b, false)
    if (!g) continue
    const s = suggestMove(g[a.id], Object.values(g), vectorOf, cfg)
    const lastStart = pageBlocks(g[a.id].m).at(-1)!.start
    if (!s || s.end < lastStart) r.none++
    else if (s.to === b.id || (s.to && tagOf(g[s.to]) === tagOf(b) && s.start >= lastStart)) r.right++
    else r.wrong++
    // Nowhere else to go: a new chat.
    const gone = graft(a, b, true)
    if (!gone) continue
    const n = suggestMove(gone[a.id], Object.values(gone), vectorOf, cfg)
    if (!n || n.end < lastStart) r.apartNone++
    else if (n.to === null) r.apartRight++
    else if (tagOf(gone[n.to]) === tagOf(b)) r.apartRight++
    else r.apartWrong++
  }
  const base = Object.values(threads).filter((t) => !piles.has(t.id))
  for (const t of topicChats) {
    r.coherent++
    if (suggestMove(t, base, vectorOf, cfg)) r.falseMoves++
  }
  // Piles: block by block, as written; a right suggestion is taken (moved), a wrong one turned down.
  for (const [pileId, expected] of Object.entries(truth)) {
    const pile = threads[pileId]
    const blocks = pageBlocks(pile.m)
    // Which pile block each message is (by its key: it stays the same when messages move).
    const owner = new Map<string, number>()
    blocks.forEach((b, k) => pile.m.slice(b.start, b.end + 1).forEach((e) => owner.set(entryKey(e), k)))
    const doneBlocks = new Set<number>()
    let world: Threads = Object.fromEntries(Object.entries(threads).filter(([id]) => !piles.has(id) || id === pileId))
    world[pileId] = { ...pile, m: [] }
    for (let i = 0; i < blocks.length; i++) {
      const current = world[pileId]
      world = { ...world, [pileId]: { ...current, m: [...current.m, ...pile.m.slice(blocks[i].start, blocks[i].end + 1)] } }
      const s = suggestMove(world[pileId], Object.values(world), vectorOf, cfg)
      if (!s) continue
      r.piles.shown++
      const covered = [...new Set(world[pileId].m.slice(s.start, s.end + 1).map((e) => owner.get(entryKey(e))!))]
      const ok = covered.every((k) => (expected[k] === null ? s.to === null : s.to === expected[k]))
      if (ok) {
        r.piles.right++
        covered.forEach((k) => doneBlocks.add(k))
        const moved = moveEntries(world, {}, pileId, s.start, s.end, s.to ?? `new-${pileId}-${i}`, Date.now())
        if (moved) world = moved.threads
      } else {
        // Turned down: marked on its messages, as the panel does.
        const m = world[pileId].m.map((e, x) => (x >= s.start && x <= s.end ? { ...e, dismissed: { ...e.dismissed, move: true as const } } : e))
        world = { ...world, [pileId]: { ...world[pileId], m } }
      }
    }
    r.piles.blocks += blocks.length
    r.piles.found += doneBlocks.size
  }
  return r
}

// ------------------------------------------------------------ tags

interface TagCase { chat: Thread; index: number; hidden: string; intent: boolean }
const INTENT = new Set(["later", "потом", "나중에"])
const tagCases: TagCase[] = []
for (const t of topicChats) {
  t.m.forEach((e, i) => {
    for (const tag of e.tags ?? []) tagCases.push({ chat: t, index: i, hidden: tag, intent: INTENT.has(tag) })
  })
}

async function runTags(cfg: OrganizeConfig) {
  const r = { cases: 0, intentCases: 0, suggested: 0, right: 0, wrong: 0, intentSuggested: 0, missed: 0 }
  for (const c of tagCases) {
    const e = c.chat.m[c.index]
    const without: Entry = { ...e, tags: (e.tags ?? []).filter((x) => x !== c.hidden) }
    const chat: Thread = { ...c.chat, m: c.chat.m.map((x, i) => (i === c.index ? without : x)) }
    const world = Object.values({ ...threads, [chat.id]: chat }).filter((t) => !piles.has(t.id))
    const candidates = tagCandidates(chat, c.index, world, vectorOf, cfg)
    const shown = judgedTags(candidates, await judge(chat, c.index, candidates), cfg)
    if (c.intent) {
      r.intentCases++
      if (shown.some((x) => x === c.hidden)) r.intentSuggested++
      continue
    }
    r.cases++
    r.suggested += shown.length
    if (shown.includes(c.hidden)) r.right++
    else r.missed++
    r.wrong += shown.filter((x) => x !== c.hidden && !(e.tags ?? []).includes(x)).length
  }
  return r
}

// ------------------------------------------------------------ the grid

const pct = (x: number, n: number) => (n ? `${Math.round((x / n) * 100)}%` : "–")
const moveGrid: Array<{ cfg: Partial<OrganizeConfig>; run: MoveRun; precision: number; recall: number; falseRate: number }> = []
for (const moveT of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
  for (const moveD of [0, 0.05, 0.1, 0.15]) {
    for (const splitT of [0.15, 0.2, 0.25, 0.3, 0.35]) {
      const cfg = { ...DEFAULT_ORGANIZE, moveT, moveD, moveT1: moveT + 0.1, splitT }
      const run = runMoves(cfg)
      const shown = run.right + run.wrong + run.apartRight + run.apartWrong + run.piles.shown + run.falseMoves
      const right = run.right + run.apartRight + run.piles.right
      moveGrid.push({ cfg: { moveT, moveD, splitT }, run, precision: shown ? right / shown : 0, recall: right / (PAIRS.length * 2 + run.piles.blocks), falseRate: run.falseMoves / (run.coherent || 1) })
    }
  }
}
const goodMoves = moveGrid.filter((g) => g.precision >= 0.8 && g.falseRate <= 0.1).sort((a, b) => b.recall - a.recall)
const bestMove = goodMoves[0] ?? [...moveGrid].sort((a, b) => b.precision - a.precision || b.recall - a.recall)[0]

const tagGrid: Array<{ cfg: Partial<OrganizeConfig>; run: Awaited<ReturnType<typeof runTags>>; precision: number; recall: number }> = []
for (const tagT of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
  for (const tagD of [0, 0.03, 0.05, 0.1]) {
    for (const coherence of [0.1, 0.15, 0.2, 0.3, 0.4]) {
      const cfg = { ...DEFAULT_ORGANIZE, tagT, tagD, coherence }
      const run = await runTags(cfg)
      tagGrid.push({ cfg: { tagT, tagD, coherence }, run, precision: run.suggested ? run.right / run.suggested : 0, recall: run.right / (run.cases || 1) })
    }
  }
  process.stdout.write(`\rTag grid ${tagGrid.length}/140`)
}
process.stdout.write("\n")
writeFileSync(cachePath, JSON.stringify(cache))
const goodTags = tagGrid.filter((g) => g.precision >= 0.85 && g.run.intentSuggested === 0).sort((a, b) => b.recall - a.recall)
const bestTag = goodTags[0] ?? [...tagGrid].sort((a, b) => b.precision - a.precision || b.recall - a.recall)[0]

const at = DEFAULT_ORGANIZE
const atDefaults = moveGrid.find((g) => g.cfg.moveT === at.moveT && g.cfg.moveD === at.moveD && g.cfg.splitT === at.splitT)!
const tagsAtDefaults = tagGrid.find((g) => g.cfg.tagT === at.tagT && g.cfg.tagD === at.tagD && g.cfg.coherence === at.coherence)!
const line = (g: typeof moveGrid[number]) =>
  `T=${g.cfg.moveT} Δ=${g.cfg.moveD} split=${g.cfg.splitT}: precision ${pct(g.precision, 1)}, recall ${pct(g.recall, 1)}; back to B ${pct(g.run.right, PAIRS.length)}, elsewhere ${pct(g.run.wrong, PAIRS.length)}; ` +
  `new chat ${pct(g.run.apartRight, PAIRS.length)} (wrong ${pct(g.run.apartWrong, PAIRS.length)}); false in coherent chats ${g.run.falseMoves}/${g.run.coherent}; piles ${g.run.piles.right}/${g.run.piles.shown} right, ${g.run.piles.found}/${g.run.piles.blocks} blocks placed`
const tagLine = (g: typeof tagGrid[number]) =>
  `tagT=${g.cfg.tagT} Δ=${g.cfg.tagD} coherence=${g.cfg.coherence}: precision ${pct(g.precision, 1)}, recall ${pct(g.recall, 1)} (${g.run.right}/${g.run.cases}), wrong ${g.run.wrong}, "later"-like suggested ${g.run.intentSuggested}/${g.run.intentCases}`

console.log(`\nMoves (${PAIRS.length} grafts, ${topicChats.length} coherent chats, ${Object.keys(truth).length} piles)`)
console.log(`  at the starting values  ${line(atDefaults)}`)
console.log(`  best with precision ≥ 80% and ≤ 10% false: ${goodMoves.length ? line(bestMove) : `none; most precise: ${line(bestMove)}`}`)
console.log(`Tags (${tagCases.length} hidden tags, ${FAKE || NO_JUDGE ? "no judge" : "with the judge"})`)
console.log(`  at the starting values  ${tagLine(tagsAtDefaults)}`)
console.log(`  best with precision ≥ 85% and no "later"-like: ${goodTags.length ? tagLine(bestTag) : `none; most precise: ${tagLine(bestTag)}`}`)
console.log(`Requests: ${usage.embedRequests} embedding batches (${usage.texts} texts), ${usage.checks} tag checks`)

writeFileSync(join(outDir, "metrics.json"), JSON.stringify({
  fake: FAKE, space: cache.space ?? null, chats: all.length, pairs: PAIRS.length, usage,
  moves: { atDefaults, best: bestMove, grid: moveGrid },
  tags: { atDefaults: tagsAtDefaults, best: bestTag, grid: tagGrid }
}, null, 1))
console.log(`Numbers: ${join(outDir, "metrics.json")}`)
