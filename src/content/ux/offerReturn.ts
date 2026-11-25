// 2.8, the owner: «Я хочу чтобы пользователи сперва получали кнопку купить по полной цене и например если ушли - получили
// нотификацию о скидке. И при возвращении если даже нотификации не было». The first time at the free limit the card
// offers Pro at full price only; the −50 % code comes on return:
//   - the server says the install ran out of free answers on an earlier UTC day (status.limitedBefore: the answers have
//     come back since), and
//   - on this device, at least RETURN_GAP since the full-price card was first shown here. Someone who runs out at
//     23:50 UTC isn't offered the code ten minutes later, when the answers are back; someone who comes back within the
//     hour sees the full price again. No record here (another device, an older panel): the server's day alone.
// One notification may carry it: the answers-back reminder (AnswersBack), for someone who opted in, when it fires at
// least RETURN_GAP after the full-price card. Its tap opens the page with #cf-offer=1: the panel opens on the discount.

declare const __RETURN_GAP_S__: number | undefined
// Six hours (test builds with a local stand may shorten it: CF_RETURN_GAP_S, scripts/build-extension.mjs).
export const RETURN_GAP_MS = (typeof __RETURN_GAP_S__ === "number" ? __RETURN_GAP_S__ : 21_600) * 1000

const FULL_AT = "cf:limitFullAt"

/** When the full-price card was first shown on this device (ms), or null. */
export async function loadFullAt(): Promise<number | null> {
  const kept = await chrome.storage.local.get(FULL_AT).catch(() => ({} as Record<string, unknown>))
  const at = Number(kept[FULL_AT])
  return Number.isFinite(at) && at > 0 ? at : null
}

/** Notes the first full-price card (kept until a purchase clears it). */
export async function noteFullAt(now = Date.now()): Promise<number> {
  const was = await loadFullAt()
  if (was) return was
  await chrome.storage.local.set({ [FULL_AT]: now }).catch(() => undefined)
  return now
}

export async function clearFullAt(): Promise<void> {
  await chrome.storage.local.remove(FULL_AT).catch(() => undefined)
}

/** Whether this is a return: the code may be shown (on the limit card, «once more», the Pro cards). */
export function isReturn(limitedBefore: boolean | undefined, fullAt: number | null, now = Date.now()): boolean {
  return limitedBefore === true && (fullAt === null || now - fullAt >= RETURN_GAP_MS)
}

/** Whether a reminder firing at `at` comes on a return, so it may carry the code. */
export function returnBy(at: number, fullAt: number | null, now = Date.now()): boolean {
  return at - (fullAt ?? now) >= RETURN_GAP_MS
}

const MARK = /(?:^#|&)cf-offer=1(?:&|$)/

/** The page's address with the discount notification's mark (its tap opens the panel on the discount). */
export function withOfferMark(url: string): string {
  return `${url.split("#")[0]}#cf-offer=1`
}

/** The mark, taken off the address at once (without a step in the tab's history); true when it was there. */
export function takeOfferMark(where: { location: { hash: string; pathname: string; search: string }; history: { state: unknown; replaceState: (state: unknown, title: string, url: string) => void } } = { location, history }): boolean {
  if (!MARK.test(where.location.hash)) return false
  const rest = where.location.hash.replace(/^#/, "").split("&").filter((part) => part !== "cf-offer=1").join("&")
  where.history.replaceState(where.history.state, "", `${where.location.pathname}${where.location.search}${rest ? `#${rest}` : ""}`)
  return true
}

/** How fresh the app's note of the tap must be (seconds): the page opens from the tap right away. */
export const TAP_FRESH_S = 120

type Ask = (message: { type: "offerTapTake" }) => Promise<{ age?: number | null } | null>

/**
 * The address's mark taken (always, so it never stays), then the app's note of the tap asked for (taken once): true
 * only when our own app recorded the discount reminder's tap moments before. The mark alone (a page setting its hash,
 * a shared link) does nothing: no panel opening, no discount (the director on #263).
 */
export async function offerTapNow(ask: Ask, take: () => boolean = takeOfferMark): Promise<boolean> {
  if (!take()) return false
  const reply = await ask({ type: "offerTapTake" }).catch(() => null)
  const age = reply?.age
  return typeof age === "number" && age >= -5 && age <= TAP_FRESH_S
}
