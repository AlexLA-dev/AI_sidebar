// The error bank's replay of saved answers (tests/fixtures/similar-bank/answers.json): each item an answer listed
// becomes the page the writer saw (its title, name, price and stock as the answer showed them; unopened ones as only a
// search result), and the writer's verdict comes back as it wrote it (page, name, met, shares from its similarity).
import { describePage } from "../netlify/shared/pagecheck.mts"
import { checkCondition, finishItems, type CheckedCandidate, type Plan } from "../netlify/shared/similar.mts"

export interface SavedItem { name: string; url: string; title: string; met: string; checked: boolean; price?: string; stock?: "in" | "out"; similarity?: number; same?: boolean; source?: string }
export interface SavedAnswer { id: string; source: string; from: string; plan: Plan; page: { url: string; title: string }; items: SavedItem[] }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export function pageOf(it: SavedItem, plan: Plan): CheckedCandidate {
  const kind = it.source === "list" ? "list" as const : "item" as const
  if (!it.checked) {
    const page = describePage("<html></html>", it.url, it.url, 0, 0)
    return { url: it.url, name: it.name, kind, resultTitle: it.title || it.name, pageAge: null, page: { ...page, status: "blocked" }, score: 0, condition: { met: "unknown", note: "not opened" }, kept: false, why: "unchecked" }
  }
  const m = /^([\d.]+) ([A-Z]{3})$/.exec(it.price ?? "")
  const offer = m ? `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: it.name, offers: { "@type": "Offer", price: m[1], priceCurrency: m[2], ...(it.stock ? { availability: it.stock === "in" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock" } : {}) } })}</script>` : ""
  const html = `<html><head><title>${esc(it.title || it.name)}</title>${offer}</head><body><main><h1>${esc(it.name)}</h1><p>${esc(it.title || it.name)}</p></main></body></html>`
  const page = describePage(html, it.url, it.url, 200, 0)
  return { url: it.url, name: it.name, kind, resultTitle: it.title || it.name, pageAge: null, page, score: 1, condition: checkCondition(plan, {}, page), kept: true, why: "ok" }
}

/** The answer replayed through today's checks: what is shown, what is dropped and why. */
export function replay(a: SavedAnswer): { shown: string[]; dropped: Array<[string, string]> } {
  const pages = a.items.map((it) => pageOf(it, a.plan))
  const traits = a.plan.traits.length
  const raw = {
    intro: "", note: "",
    items: a.items.map((it, i) => ({
      page: i + 1, name: it.name, why: "w", fit: "", met: it.met === "no" ? "no" : it.met === "yes" ? "yes" : it.met === "n/a" ? "n/a" : "unknown", words_met: a.plan.words ? "unknown" : "n/a",
      same: it.same === true, shares: Array.from({ length: Math.max(1, Math.round(((it.similarity ?? 100) / 100) * traits)) }, (_, k) => k + 1), differs: ""
    }))
  }
  const { result, dropped } = finishItems(raw, pages, a.plan, { title: a.page.title, url: a.page.url, text: "" })
  return { shown: result.items.map((i) => i.name), dropped: dropped.map((d) => [d.name, d.why]) }
}
