// What the coordinator learns once from what 2.7 already keeps on the device, so nobody who closed, used or saw a
// hint before 2.8 is asked again, and someone who has used ContextFlow for weeks isn't treated as on their first day.
// Pure, for tests: `stored` is the storage's answer for SEED_KEYS.

import { HINT_IDS, type CoachHint, type CoachState, type HintCount } from "./rules"

export const SEED_KEYS = [
  "cf:pageHints", "cf:selHint", "cf:noteHint", "cf:hintsSeen", "cf:offerCard", "cf:orgCards", "cf:selIconsTip",
  "cf:insertTipSeen", "cf:trHidden", "cf:tourSeen", "cf:valueMoments", "cf:threads", "cf:consent", "cf:invite"
] as const

const PAGE_IDS: Record<string, CoachHint> = {
  similar: "page_similar", watch: "page_watch", summary: "page_summary", listen: "page_listen",
  video: "page_video", templates: "page_templates", remind: "page_remind", calendar: "page_calendar", agent: "page_agent"
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** The earliest time anything in the chats was written: when ContextFlow was first used here. */
function firstUse(threads: unknown): number | null {
  if (!threads || typeof threads !== "object") return null
  let first: number | null = null
  // A message's time is its `t` (conversation.ts); a chat without any: its last message's time `a`.
  for (const t of Object.values(threads as Record<string, { a?: unknown; u?: unknown; m?: Array<{ t?: unknown }> }>)) {
    for (const at of [t?.a ?? t?.u, ...(Array.isArray(t?.m) ? t.m.map((m) => m?.t) : [])]) {
      const n = num(at)
      if (n && n > 1_500_000_000_000 && (first === null || n < first)) first = n
    }
  }
  return first
}

function answersIn(threads: unknown): number {
  if (!threads || typeof threads !== "object") return 0
  let n = 0
  for (const t of Object.values(threads as Record<string, { m?: Array<{ role?: unknown }>; deleted?: unknown }>)) {
    if (Array.isArray(t?.m)) n += t.m.filter((m) => m?.role === "assistant").length
  }
  return n
}

export function seedCoach(s: CoachState, stored: Record<string, unknown>, now: number): CoachState {
  if (s.seeded) return s
  const hints: Partial<Record<CoachHint, HintCount>> = { ...s.hints }
  const retire = (id: CoachHint, how: "done" | "closed" | "seen") => {
    const c = hints[id] ?? { shown: 0, dismissed: 0, done: false }
    hints[id] = how === "done" ? { ...c, done: true } : how === "closed" ? { ...c, dismissed: Math.max(c.dismissed, 2) } : { ...c, shown: Math.max(c.shown, 2) }
  }

  // The page-hint lines (2.7): turned off, used, or shown their twice.
  const ph = stored["cf:pageHints"] as { off?: boolean; used?: string[]; shownIds?: Record<string, number> } | undefined
  if (ph && typeof ph === "object") {
    for (const [what, id] of Object.entries(PAGE_IDS)) {
      if (ph.off) retire(id, "closed")
      else if (ph.used?.includes(what)) retire(id, "done")
      else if ((ph.shownIds?.[what] ?? 0) >= 2) retire(id, "seen")
    }
  }
  // Counters that say -1 once used, or how many times shown.
  const counter = (key: string, id: CoachHint, cap: number) => {
    const n = num(stored[key])
    if (n === -1) retire(id, "done")
    else if (n !== null && n >= cap) retire(id, "seen")
  }
  counter("cf:selHint", "sel_ask", 3)
  counter("cf:noteHint", "note_tip", 3)
  counter("cf:offerCard", "pro_offer", 3)
  if (stored["cf:selIconsTip"]) retire("sel_icons", "seen")
  if (stored["cf:insertTipSeen"]) retire("write_tip", "seen")
  const seen = Array.isArray(stored["cf:hintsSeen"]) ? (stored["cf:hintsSeen"] as unknown[]) : []
  if (seen.includes("chats")) retire("chats_tip", "seen")
  if (seen.includes("video") && seen.includes("pdf")) retire("media_tip", "seen")
  if (seen.includes("side")) retire("side", "seen")
  if (seen.includes("new27")) retire("whatsnew", "seen")
  const org = stored["cf:orgCards"] as { consent?: string; mess?: { closed?: boolean }; thirdTag?: boolean } | undefined
  if (org?.consent) retire("organize_consent", "done")
  if (org?.mess?.closed) retire("organize_mess", "closed")
  if (org?.thirdTag) retire("organize_tags", "seen")
  if (Array.isArray(stored["cf:trHidden"]) && (stored["cf:trHidden"] as unknown[]).length >= 2) retire("translate_pill", "closed")

  // The rungs: someone who used the panel before 2.8.
  const threads = stored["cf:threads"]
  const answers = Math.max(s.answers, answersIn(threads), num(stored["cf:valueMoments"]) ?? 0)
  const used = firstUse(threads)
  const opened = stored["cf:tourSeen"] === true || answers > 0
  return {
    ...s,
    hints,
    first: used !== null ? Math.min(s.first, used) : s.first,
    answers,
    panelOpens: Math.max(s.panelOpens, opened ? 1 : 0),
    // Answers on a day before today: they have come back before (rung 12 needs two days).
    askDays: used !== null && used < now - 86_400_000 && answers > 1 && s.askDays.length < 2 ? ["seed-1", "seed-2", ...s.askDays].slice(-8) : s.askDays,
    // The fab pulse is for the first open only.
    ...(opened ? { hints: { ...hints, fab_pulse: { shown: 0, dismissed: 0, done: true } } } : {}),
    // A new install: nothing used before (no chat, no first run, no answer counted).
    armed: !opened && answers === 0 && used === null,
    seeded: true
  }
}

export const KNOWN_HINTS: ReadonlySet<string> = new Set(HINT_IDS)
