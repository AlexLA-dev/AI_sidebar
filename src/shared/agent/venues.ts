// The places a booking can go to (2.7.1, the director's round 3): read from a results list on the device, ranked by the
// person's rules, kept with the task, and opened one after another by their own links when one doesn't fit (the
// model's «back» didn't get out of a booking window). A place has to match what the request asks for (its cuisine or
// service words on its card), never only by rating (a restaurant site: a French restaurant for «итальянский»).

import { wordTest } from "./match.ts"
import { PROMOTED_WORDS } from "./words.ts"
import { hostOf, sameSite } from "./sites.ts"
import type { MapItem, PageMap } from "./types.ts"

export interface Venue {
  url: string
  name: string
  rating: number
  reviews: number
}

// «4.8», «4,8», «9.4» (a restaurant site's /10), next to stars or on their own.
const RATING = /(?:^|[\s(★⭐])([0-9](?:[.,][0-9])?|10)(?:\s*\/\s*(?:5|10))?(?=\s|$|[)★⭐])/
const REVIEWS = /\(?(?<![\d.,])([0-9]{1,3}(?:[,.\s\u00a0\u202f][0-9]{3})+|[0-9]+)\)?\s*(?:reviews?|ratings?|отзыв\w*|оцен\w*|avis|bewertung\w*|reseñas?|valoraciones|recension\w*|avalia\w*|yorum\w*|değerlendirme|件|レビュー|리뷰|후기|评论|評論|評價|تقييم\w*|مراجع\w*|đánh giá)|\(([0-9][0-9,.\s\u00a0\u202f]{0,8})\)/i

const num = (s: string) => Number(s.replace(/[\s ,.]/g, ""))

// A review's card (a diner's name, their own count of reviews, their score, «5 months ago») is not a place (a restaurant site, the
// round-3 run: «M Marine E. 20 reviews 10 5 months ago» was opened as a restaurant).
const REVIEW_CARD = /\b(ago|reviewed|visited)\b|назад|il y a|\bhace\b|\bfa\b|\bvor\b|\bhá\b|önce|前|전|قبل|trước/i

/** One link of a results list as a place, or null: a link of this site with a rating and its reviews on it. */
export function venueOf(item: MapItem, page: string): Venue | null {
  if (item.role !== "link" || !item.href) return null
  const own = item.label.replace(/\s+/g, " ").trim()
  // A title link beside its rating (a card whose link is just the place's name): the card's text is read with it.
  const viaCard = !!item.card && !(RATING.test(own) && REVIEWS.test(own))
  // (A photo's link has no name of its own: the card's title link names the place.)
  if (viaCard && own.length < 2) return null
  const label = viaCard ? `${own} ${item.card!.replace(/\s+/g, " ").trim()}` : own
  if (label.length < 8 || REVIEW_CARD.test(label)) return null
  const v = REVIEWS.exec(label)
  if (!v) return null
  // The rating among the card's numbers («Slide 1 of 12 … 9.3 (4120)»): a decimal one first, else the one nearest
  // before the review count.
  const all = [...label.matchAll(new RegExp(RATING.source, "g"))]
  const r = all.find((m) => /[.,]/.test(m[1])) ?? all.filter((m) => (m.index ?? 0) <= v.index).pop() ?? all[0]
  if (!r) return null
  let url: string
  try {
    const base = new URL(page)
    url = item.href.startsWith("/") ? `${base.origin}${item.href}` : new URL(`https://${item.href}`).toString()
    if (!sameSite(hostOf(url), hostOf(page))) return null
  } catch {
    return null
  }
  let rating = Number(r[1].replace(",", "."))
  if (rating > 5) rating = rating / 2
  const reviews = num(v[1] ?? v[2] ?? "0")
  const name = (label === own ? label.slice(0, Math.max(8, Math.min(label.length, label.search(/\s[0-9]/) > 0 ? label.search(/\s[0-9]/) : 60))) : own.slice(0, 80)).trim()
  // («Featured Glow Couture»: the site's badge isn't the place's name.)
  const words = name.split(/\s+/)
  while (words.length > 1 && promotedWord(words[0])) words.shift()
  return { url: url.split("#")[0], name: words.join(" ").slice(0, 80), rating, reviews }
}

/** The places a page lists (three or more links that look like places), first seen first. */
export function venuesOn(map: PageMap): Venue[] {
  const seen = new Set<string>()
  const out: Venue[] = []
  for (const it of map.items) {
    const v = venueOf(it, map.url)
    if (v && !seen.has(v.url)) {
      seen.add(v.url)
      out.push(v)
    }
  }
  // A results list's places share their path's first part (/restaurant/…, /a/…): the biggest such group is the list;
  // other rated links on the page (a review, a guide) aren't places.
  const groups = new Map<string, Venue[]>()
  for (const v of out) {
    const head = (() => {
      try {
        return new URL(v.url).pathname.split("/").filter(Boolean)[0] ?? ""
      } catch {
        return ""
      }
    })()
    groups.set(head, [...(groups.get(head) ?? []), v])
  }
  const list = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? []
  return list.length >= 3 ? out.filter((v) => list.includes(v)) : []
}

const fold = (s: string) => s.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")

/**
 * The places that fit, best first: the request's words on the card (when it has any), rated at least `minRating`
 * with 20 reviews or more; the page's own order kept among them (a site sorts by distance or relevance).
 */
export function rankVenues(list: Venue[], cards: Map<string, string>, match: string[], minRating: number, area: string[] = []): Venue[] {
  const words = match.map(fold).filter((w) => w.length >= 3)
  const card = (v: Venue) => fold(cards.get(v.url) ?? v.name)
  // The area the request names («Soho»): when some cards name it, only those (a salon marketplace, 121 sweep: a Shropshire salon
  // for «Soho, London»); when none does, the list is the site's answer to the search and stays.
  const places = area.map(fold).filter((w) => w.length >= 3)
  const near = places.length ? list.filter((v) => places.some((w) => card(v).includes(w))) : []
  const inArea = near.length ? near : list
  // A term fits when each of its words is on the card, in any order («men's haircut» on «Men's Wash, Haircut & Style»;
  // a possessive or plural ending aside).
  const stem = (w: string) => w.replace(/['’]s$|s$/u, "")
  const has = (text: string, term: string) => term.split(/[\s\-–,&/]+/).map(stem).filter((x) => x.length >= 3).every((x) => text.includes(x))
  const fits = inArea.filter((v) => !words.length || words.some((w) => card(v).includes(w) || has(card(v), w)))
  const good = fits.filter((v) => v.rating >= minRating && v.reviews >= 20)
  return byRules(good.length ? good : fits.filter((v) => v.rating >= minRating - 0.3), cards)
}

// A distance a card shows («0.3 mi away», «1,2 km», «850 m»), in metres.
const DISTANCE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(km|mi|m|км|м|公里|千米|キロ|킬로미터)(?![\p{L}])/u
function distanceOf(text: string): number | null {
  const m = DISTANCE.exec(text)
  if (!m) return null
  const n = Number(m[1].replace(",", "."))
  const unit = m[2]
  return unit === "mi" ? n * 1609 : unit === "m" || unit === "м" ? n : n * 1000
}

const promotedWord = wordTest(PROMOTED_WORDS)

/** The fitting places in the rules' order, never the page's: nearest first when the cards show distances, else the
 *  best rated and most reviewed; a promoted card («Featured», «Sponsored») loses a tie, never wins by its place. */
export function byRules(list: Venue[], cards: Map<string, string>): Venue[] {
  const text = (v: Venue) => cards.get(v.url) ?? v.name
  const dist = new Map(list.map((v) => [v.url, distanceOf(text(v))]))
  const useDistance = list.filter((v) => dist.get(v.url) !== null).length >= 2
  const promoted = (v: Venue) => (promotedWord(text(v)) ? 1 : 0)
  return [...list].sort((a, b) => {
    if (useDistance) {
      const d = (dist.get(a.url) ?? Infinity) - (dist.get(b.url) ?? Infinity)
      if (Math.abs(d) > 50) return d
    }
    const r = Math.round(b.rating * 10) - Math.round(a.rating * 10)
    if (r) return r
    const p = promoted(a) - promoted(b)
    if (p) return p
    return b.reviews - a.reviews
  })
}

/** What a card says of a place for the card's question: its rating, its count of reviews and its area when it shows one
 *  («★ 4.8 · 1,523 · Germasogeia, Limassol»). */
export function venueNote(v: Venue, cards: Map<string, string>): string {
  const text = (cards.get(v.url) ?? "").replace(v.name, " ")
  const area = /(?<![\d\p{L}])(\p{Lu}[\p{L}'’.-]+(?:\s[\p{L}'’.-]+){0,2}\s?,\s?\p{Lu}[\p{L}'’.-]+(?:\s\p{Lu}[\p{L}'’.-]+)?)/u.exec(text)?.[1]
  const d = distanceOf(text)
  return [`★ ${(Math.round(v.rating * 10) / 10).toString()}`, v.reviews ? v.reviews.toLocaleString("en-US") : "", area ?? "", d !== null ? (d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`) : ""].filter(Boolean).join(" · ")
}

/** The cards' words by place (all of each link's text: the cuisine or service is there, not in the name only). */
export function cardsOf(map: PageMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const it of map.items) {
    const v = venueOf(it, map.url)
    if (v) out.set(v.url, it.card ? `${it.label} ${it.card}` : it.label)
  }
  return out
}

/** Whether this page is one of the places (its own page or its booking under it). */
export function onVenue(page: string, v: Venue): boolean {
  try {
    const a = new URL(page)
    const b = new URL(v.url)
    return a.hostname === b.hostname && (a.pathname === b.pathname || a.pathname.startsWith(`${b.pathname.replace(/\/$/, "")}/`))
  } catch {
    return false
  }
}
