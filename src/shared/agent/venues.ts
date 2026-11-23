// The places a booking can go to (2.7.1, the director's round 3): read from a results list on the device, ranked by the
// person's rules, kept with the task, and opened one after another by their own links when one doesn't fit (the
// model's «back» didn't get out of a booking window). A place has to match what the request asks for (its cuisine or
// service words on its card), never only by rating (TheFork: a French restaurant for «итальянский»).

import { hostOf, sameSite } from "./sites.ts"
import type { MapItem, PageMap } from "./types.ts"

export interface Venue {
  url: string
  name: string
  rating: number
  reviews: number
}

// «4.8», «4,8», «9.4» (TheFork's /10), next to stars or on their own.
const RATING = /(?:^|[\s(★⭐])([0-9](?:[.,][0-9])?|10)(?:\s*\/\s*(?:5|10))?(?=\s|$|[)★⭐])/
const REVIEWS = /\(?([0-9][0-9,.\s ]{0,8})\)?\s*(?:reviews?|ratings?|отзыв\w*|оцен\w*|avis|bewertung\w*|reseñas?|valoraciones|recension\w*|avalia\w*|yorum\w*|değerlendirme|件|レビュー|리뷰|후기|评论|評論|評價|تقييم\w*|مراجع\w*|đánh giá)|\(([0-9][0-9,.]{0,8})\)/i

const num = (s: string) => Number(s.replace(/[\s ,.]/g, ""))

// A review's card (a diner's name, their own count of reviews, their score, «5 months ago») is not a place (TheFork, the
// round-3 run: «M Marine E. 20 reviews 10 5 months ago» was opened as a restaurant).
const REVIEW_CARD = /\b(ago|reviewed|visited)\b|назад|il y a|\bhace\b|\bfa\b|\bvor\b|\bhá\b|önce|前|전|قبل|trước/i

/** One link of a results list as a place, or null: a link of this site with a rating and its reviews on it. */
export function venueOf(item: MapItem, page: string): Venue | null {
  if (item.role !== "link" || !item.href || item.label.length < 8) return null
  const label = item.label.replace(/\s+/g, " ").trim()
  if (REVIEW_CARD.test(label)) return null
  const r = RATING.exec(label)
  const v = REVIEWS.exec(label)
  if (!r || !v) return null
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
  const name = label.slice(0, Math.max(8, Math.min(label.length, label.search(/\s[0-9]/) > 0 ? label.search(/\s[0-9]/) : 60))).trim()
  return { url: url.split("#")[0], name: name.slice(0, 80), rating, reviews }
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
export function rankVenues(list: Venue[], cards: Map<string, string>, match: string[], minRating: number): Venue[] {
  const words = match.map(fold).filter((w) => w.length >= 3)
  const fits = list.filter((v) => !words.length || words.some((w) => fold(cards.get(v.url) ?? v.name).includes(w)))
  const good = fits.filter((v) => v.rating >= minRating && v.reviews >= 20)
  return good.length ? good : fits.filter((v) => v.rating >= minRating - 0.3)
}

/** The cards' words by place (all of each link's text: the cuisine or service is there, not in the name only). */
export function cardsOf(map: PageMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const it of map.items) {
    const v = venueOf(it, map.url)
    if (v) out.set(v.url, it.label)
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
