// Invite a friend (2.7, plan section 5; the owner's decisions of 2026-11-12). Shared by the panel, the background worker,
// the server and the tests; the app (Invite.swift) and the site page (site/i.html) follow the same rules.
//
// - Each install gets one code (6 letters and digits, nothing that reads as another: no 0/O, 1/I/L) and the link
//   context-flow.app/i/<code>. No account: the code belongs to the install, and nothing personal is kept.
// - The friend enters or pastes it on the app's first screen (or in the panel's settings) while the install is new:
//   extra free answers each day of their first week.
// - Once the friend has asked on two different days, the inviter gets 50 % off the first month of Pro or Ultra, their
//   choice: App Store offer codes (rule 3.1.1), each one a person can use once (App Store checks that).
// - Inviting is optional and nothing waits behind it (3.2.2(x)); the friend gets answers, not Pro.

/** The code's letters: no 0, O, 1, I or L. */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
export const INVITE_CODE_LENGTH = 6
const CODE = /^[A-HJKMNP-Z2-9]{6}$/

export const INVITE_SITE = "https://context-flow.app"

/** The link a code is shared with. */
export const inviteLink = (code: string): string => `${INVITE_SITE}/i/${code}`

/**
 * The code in what a person typed or pasted: the code itself in any case, with spaces or a dash, or the whole link
 * (or a message with the link in it). null when there's no valid code in it.
 */
export function parseInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const text = raw.trim().slice(0, 2000)
  const linked = /\/i\/([A-Za-z0-9]{6})(?![A-Za-z0-9])/.exec(text)
  if (linked) return CODE.test(linked[1].toUpperCase()) ? linked[1].toUpperCase() : null
  if (text.length > 20) return null
  const bare = text.replace(/[\s\-–—_.]/g, "").toUpperCase()
  return CODE.test(bare) ? bare : null
}

/** What the inviter can take once a friend is active. */
export interface InviteReward {
  // App Store offer codes, first month at `discount` % off; Ultra's is missing until it's set up in App Store Connect.
  pro: { code: string; discount: number } | null
  ultra: { code: string; discount: number } | null
  // Proposed by the director, not decided by the owner yet (config INVITE_INVITER_ANSWERS): when both discounts are
  // used, extra answers like the friend's, one week for each active friend; `left` is how many can still be taken.
  answers: { daily: number; days: number; left: number } | null
}

/** /api/v2/invite's answer for an install: its code, its friends, its reward, and its own friend's code. */
export interface InviteState {
  ok: true
  code: string | null
  link: string | null
  // Friends who entered the code, and those of them who asked on two different days.
  joined: number
  active: number
  reward: InviteReward | null
  // The inviter's extra answers (the proposal above) run until then.
  answersUntil: string | null
  // This install came with a friend's code: its extra answers run until then.
  entered: { until: string } | null
  // A friend's code can still be entered here (a new install that hasn't entered one).
  canEnter: boolean
  // What a friend gets: extra answers a day, for so many days.
  friendDaily: number
  friendDays: number
}

export type InviteFailure =
  | "CODE_UNKNOWN" // no such code
  | "OWN_CODE" // the install's own code
  | "ALREADY" // a friend's code was entered here before
  | "TOO_LATE" // the install isn't new any more
  | "CODE_FULL" // the inviter has as many friends as one code takes
  | "DEVICE_USED" // this device has already had a friend's bonus (Apple DeviceCheck)
  | "DEVICE_CHECK" // the device couldn't be checked
  | "LIMIT_REACHED" // too many tries
  | "UNAVAILABLE"
  | "BAD_REQUEST"
  | "NETWORK"

/** The panel's messages to the background worker. */
export type InviteRequest =
  | { type: "invite"; op: "state"; create: boolean }
  | { type: "invite"; op: "redeem"; code: string }
  | { type: "invite"; op: "answers" }

export type InviteReply = InviteState | { ok: false; code: InviteFailure }

/** Kept by the panel: the install's own code (so status can say a friend became active) and its friend's bonus. */
export const INVITE_STORAGE = "cf:invite"
export interface InviteStored {
  code?: string
  // The friend's extra answers run until then (ms): requests say so, and the server checks it.
  until?: number
  // Active friends already shown to the inviter.
  seenActive?: number
}

/** The inviter's discount as the panel and the app name it before the server says (App Store shows the real price). */
export const INVITE_DISCOUNT = 50
