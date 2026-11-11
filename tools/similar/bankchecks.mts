// The error bank's live checks (tests/fixtures/similar-bank/live.json): rules an answer must keep, read from the
// answer itself, so a pass before a release re-checks the errors that already happened, end to end. The same checks
// run offline on saved answers in tests/similar-bank.test.mts.
import { marketplaceOf } from "../../netlify/shared/similar.mts"

export interface LiveItem { name: string; url: string; host?: string; why?: string; fit?: string; met?: string }
export type LiveCheck = "answer" | "one-per-marketplace" | "no-delivery-claim" | "chip-order" | `language:${string}`

// "It delivers / ships there", in the app's languages: delivery has its own line (only what its page shows). The
// verbs only: "delivery to the UK isn't shown" is honest.
const CLAIMS = /\b(?:deliver(?:s|ed)?(?= to| worldwide| there)|ships (?:to|worldwide)|livre (?:en|au|à|dans)|livrent|envía a|envían a|spedisce|spediscono|liefert (?:nach|in)|versendet (?:nach|in)|entrega (?:em|no|na) (?!não)|envia para)\b|доставля(?:ет|ют|ем) (?:в|по)|доставляє|配送します|発送します|배송(?:합니다|됩니다)|giao hàng đến|يشحن إلى/iu

export function liveFailures(items: LiveItem[], checks: LiveCheck[]): string[] {
  const out: string[] = []
  for (const check of checks) {
    if (check === "answer" && !items.length) out.push("answer: empty")
    if (check === "one-per-marketplace") {
      const seen = new Map<string, string>()
      for (const it of items) {
        let host = it.host ?? ""
        try { host ||= new URL(it.url).hostname } catch { /* no host */ }
        const m = marketplaceOf(host.replace(/^www\./, ""))
        if (m && seen.has(m)) out.push(`one-per-marketplace: ${m} twice (${seen.get(m)}; ${it.name})`)
        if (m) seen.set(m, it.name)
      }
    }
    if (check === "no-delivery-claim") for (const it of items) if (CLAIMS.test(`${it.why ?? ""} ${it.fit ?? ""}`)) out.push(`no-delivery-claim: ${it.name}: ${(`${it.why ?? ""} ${it.fit ?? ""}`).slice(0, 120)}`)
    // A tapped chip's near misses come after the items that meet it, never before.
    if (check === "chip-order") {
      const firstMiss = items.findIndex((i) => i.met === "no")
      if (firstMiss >= 0 && items.slice(firstMiss).some((i) => i.met === "yes" || i.met === "unknown")) out.push("chip-order: a near miss before items that meet the chip")
    }
    if (check.startsWith("language:")) for (const it of items) if (it.met === "no") out.push(`${check}: ${it.name} isn't in that language`)
  }
  return out
}
