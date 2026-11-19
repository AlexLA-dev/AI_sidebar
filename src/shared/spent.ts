// What the answers went on (2.7 (110), the owner on 109: «для пользователя может быть очень неочевидно, что перевод
// страниц расходует квоту <…> по тапу на счётчик <…> раскрывалась детализация на что была потрачено квота»).
//
// The server counts it, next to the counter the answers are charged to (the subscription's week for Pro and Ultra, so
// every device of it is in; the install's day for Free): one more counter per kind, `use:<kind>:<that counter>`, with
// no limit, charged and given back together with it (netlify/shared/plan.mts withUse). Answers charged before those
// counters existed, or by a path that doesn't name its kind, show as «Other»: the rows always add up to the count.

/** The kinds, in the order the breakdown lists them. */
export const USE_KINDS = ["chat", "google", "translate", "write", "chats", "similar"] as const
export type UseKind = (typeof USE_KINDS)[number]

/** The breakdown counter of `kind` next to the answers' own counter (`main`: its subject, "tx:…" or "install:…"). */
export const useSubject = (kind: UseKind, main: string): string => `use:${kind}:${main}`

export interface SpentRow {
  kind: UseKind | "other"
  n: number
}

/**
 * The rows to show for `used` answers of the period and the server's breakdown (`by`), the most first, «Other» last;
 * none with nothing in it. Null when the server sent no breakdown (an older server): the count alone is shown.
 */
export function spentRows(used: number, by: Partial<Record<UseKind, number>> | null | undefined): SpentRow[] | null {
  if (!by || typeof by !== "object") return null
  const rows: SpentRow[] = USE_KINDS.map((kind) => ({ kind, n: Math.max(0, Math.round(Number(by[kind]) || 0)) })).filter((r) => r.n > 0)
  rows.sort((a, b) => b.n - a.n || USE_KINDS.indexOf(a.kind as UseKind) - USE_KINDS.indexOf(b.kind as UseKind))
  const counted = rows.reduce((s, r) => s + r.n, 0)
  // A refund can leave a kind's counter a step behind the main one (given back after the read): never more than used.
  if (counted > used) {
    let over = counted - used
    for (let i = rows.length - 1; i >= 0 && over > 0; i--) {
      const take = Math.min(over, rows[i].n)
      rows[i] = { ...rows[i], n: rows[i].n - take }
      over -= take
    }
    return rows.filter((r) => r.n > 0)
  }
  return used > counted ? [...rows, { kind: "other", n: used - counted }] : rows
}
