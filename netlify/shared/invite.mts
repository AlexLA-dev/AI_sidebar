// Invite a friend (2.7, plan section 5): codes, friends, the friend's extra answers and the inviter's reward, kept in
// contextflow.invite_codes and contextflow.invites (supabase/migrations/20261114120000_contextflow_invites.sql) and
// reached through the cf_invite_* functions. Until that migration is applied the calls fail: /api/v2/invite answers
// UNAVAILABLE and every answer counts as before (no extra answers).

import { randomInt } from "node:crypto"

import { config } from "./config.mts"
import { db } from "./db.mts"
import { INVITE_ALPHABET, INVITE_CODE_LENGTH, inviteLink, type InviteReward, type InviteState } from "../../src/shared/invite.ts"
import type { Plan } from "../../src/shared/plan.ts"

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

/** A new code: 6 of the alphabet's 31 signs (about 890 million). */
export function newCode(): string {
  let code = ""
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
  return code
}

/** The ids a request may stand for: the extension's install and, from the app, the app's own id. */
export function idsOf(installId: string, appId: unknown, isUuid: (v: unknown) => v is string): string[] {
  return isUuid(appId) && appId.toLowerCase() !== installId.toLowerCase() ? [installId, appId] : [installId]
}

/**
 * The friend's extra answers a day, for a request that says it came with a friend's code (`client.inv`, kept by the
 * panel and the app while the bonus runs): the database decides, so the mark alone gains nothing. Requests without it
 * cost no extra call. 0 when the bonus is over, the code was never entered, or the database can't say.
 */
export async function inviteExtra(client: unknown, ids: string[], plan: Plan): Promise<number> {
  if (plan !== "free" && plan !== "byok") return 0
  if (!client || typeof client !== "object" || (client as { inv?: unknown }).inv !== 1) return 0
  try {
    const on = await rpc<boolean>("cf_invite_bonus", { p_ids: ids, p_answer_days: config.invite.friendDays })
    return on === true ? config.invite.friendDaily : 0
  } catch {
    return 0
  }
}

/** The install's code, made on the first ask; null when the database can't make one. */
export async function codeFor(ids: string[]): Promise<string | null> {
  for (let i = 0; i < 4; i++) {
    const code = await rpc<string | null>("cf_invite_code", { p_install: ids[0], p_other: ids[1] ?? null, p_new: newCode() })
    if (code) return code
  }
  return null
}

interface StateRow {
  code: string | null
  joined: number
  active: number
  new_active: number
  answers_taken: number
  answers_last: string | null
  entered_until: string | null
  first_seen: string | null
}

/** The install's invites, with friends who became active since the last look marked so. */
export async function readState(ids: string[]): Promise<StateRow> {
  return rpc<StateRow>("cf_invite_state", { p_ids: ids, p_days: config.invite.activeDays })
}

/** What the inviter can take now: the offer codes once a friend is active (Ultra's once it's set up). */
export function rewardOf(row: Pick<StateRow, "active" | "answers_taken">, proOfferCode: string, proOfferDiscount: number): InviteReward | null {
  if (row.active < 1) return null
  const pro = proOfferCode && proOfferCode.toLowerCase() !== "off" ? { code: proOfferCode, discount: proOfferDiscount } : null
  const ultra = config.invite.ultraOfferCode && config.invite.ultraOfferCode.toLowerCase() !== "off"
    ? { code: config.invite.ultraOfferCode, discount: config.invite.ultraOfferDiscount }
    : null
  const answers = config.invite.inviterAnswers
    ? { daily: config.invite.friendDaily, days: config.invite.friendDays, left: Math.max(0, row.active - row.answers_taken) }
    : null
  return pro || ultra || answers ? { pro, ultra, answers } : null
}

const DAY = 86_400_000

/** /api/v2/invite's state from the database row. */
export function stateOf(row: StateRow, proOfferCode: string, proOfferDiscount: number, now = Date.now()): InviteState {
  const answersUntil = row.answers_last ? new Date(Date.parse(row.answers_last) + config.invite.friendDays * DAY) : null
  const firstSeen = row.first_seen ? Date.parse(row.first_seen) : null
  return {
    ok: true,
    code: row.code,
    link: row.code ? inviteLink(row.code) : null,
    joined: row.joined,
    active: row.active,
    reward: rewardOf(row, proOfferCode, proOfferDiscount),
    answersUntil: answersUntil && answersUntil.getTime() > now ? answersUntil.toISOString() : null,
    entered: row.entered_until ? { until: row.entered_until } : null,
    canEnter: !row.entered_until && (firstSeen === null || now - firstSeen < config.invite.newDays * DAY),
    friendDaily: config.invite.friendDaily,
    friendDays: config.invite.friendDays
  }
}

export type RedeemResult = "ok" | "unknown" | "own" | "already" | "old" | "full"

/** Enters a friend's code for an install (the app's own id and, once known, the extension's install). */
export function redeem(friendId: string, installId: string | null, code: string, device: "checked" | "unchecked", until: Date): Promise<RedeemResult> {
  return rpc<RedeemResult>("cf_invite_redeem", {
    p_friend: friendId, p_install: installId, p_code: code, p_device: device, p_until: until.toISOString(),
    p_cap: config.invite.cap, p_new_days: config.invite.newDays
  })
}

/** A code entered in the app before the extension ran: the extension's install takes the bonus over. */
export const linkInstall = (appId: string, installId: string) => rpc<boolean>("cf_invite_link", { p_app: appId, p_install: installId })

/** The inviter takes extra answers for one active friend (the proposal behind INVITE_INVITER_ANSWERS). */
export const takeAnswers = (ids: string[]) => rpc<boolean>("cf_invite_take_answers", { p_ids: ids })
