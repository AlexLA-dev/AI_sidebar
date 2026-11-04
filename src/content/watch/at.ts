// Is a selection something the eye takes (a price, stock, a date with an event, a status with its order)? Shared by
// the eye in the bubble and by the bubble itself: on a Mac the bubble waits for a few words, but a price ("$40",
// "USD 40") is one or two, and the eye has to show for it too (the owner's notes on build 75).

import { eyeFor, priceAround, type WatchWhat } from "../../shared/watch/detect"

/** The selection's paragraph or row: what a date or a status is read with (its own words aren't enough). */
export function aroundOf(range: Range | null): string {
  const node = range?.commonAncestorContainer ?? null
  const el = node ? (node instanceof Element ? node : node.parentElement) : null
  const block = el?.closest("p,li,td,th,dd,dt,tr,h1,h2,h3,h4,h5,h6,figcaption,label,section,article,div") ?? null
  return (block?.textContent ?? "").replace(/\s+/g, " ").slice(0, 400)
}

// An event in the page's own markup (schema.org Event, an Offer that starts selling then): a date there counts.
let markupFor = ""
let markup = false
function eventMarkup(): boolean {
  if (markupFor === location.href) return markup
  markupFor = location.href
  markup = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) =>
    /"@type"\s*:\s*"(?:\w*Event|Festival)"|"(?:availabilityStarts|validFrom|startDate)"/.test(s.textContent ?? ""))
  return markup
}

/** What the eye watches here, and the value as the page writes it ("USD 40" for a "40" tapped alone); null: no eye. */
export function watchableAt(selection: string, range: Range | null): { what: WatchWhat; value: string } | null {
  const around = aroundOf(range)
  const what = eyeFor(selection, around, eventMarkup())
  return what ? { what, value: priceAround(selection, around) ?? selection } : null
}
