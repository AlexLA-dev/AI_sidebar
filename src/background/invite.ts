// Invite a friend (2.7, plan section 5) in the background: the panel's asks to /api/v2/invite, a code entered in the
// ContextFlow app taken over by this install, and the marks every request carries (src/shared/invite.ts).

import { API_BASE, TARGET } from "../shared/config"
import { INVITE_STORAGE, type InviteFailure, type InviteReply, type InviteRequest, type InviteStored } from "../shared/invite"
import { callNative } from "./native"

export interface InviteDeps {
  installId: () => Promise<string>
  entitlementJws: () => Promise<string | null>
  clientInfo: () => Promise<Record<string, unknown>>
  // The free allowance may have changed (a friend's code entered): the panel's status is asked again.
  statusChanged: () => void
}

let deps: InviteDeps
let marks: { inv?: 1; invc?: 1 } | null = null

async function stored(): Promise<InviteStored> {
  return ((await chrome.storage.local.get(INVITE_STORAGE))[INVITE_STORAGE] as InviteStored | undefined) ?? {}
}

async function keep(change: Partial<InviteStored>): Promise<void> {
  await chrome.storage.local.set({ [INVITE_STORAGE]: { ...(await stored()), ...change } })
  marks = null
}

/**
 * What every request says about invites: `inv` while this install's friend's bonus runs (the server checks it, so the
 * mark alone gains nothing), `invc` once it has a code of its own (the status then says how many friends are active).
 */
export async function inviteMarks(): Promise<{ inv?: 1; invc?: 1 }> {
  if (marks) return marks
  const s = await stored()
  marks = { ...(s.until && s.until > Date.now() ? { inv: 1 as const } : {}), ...(s.code ? { invc: 1 as const } : {}) }
  return marks
}

async function post(body: Record<string, unknown>): Promise<InviteReply | { ok: true; until: string } | { ok: true; linked: boolean }> {
  const [installId, entitlement, client] = await Promise.all([deps.installId(), deps.entitlementJws(), deps.clientInfo()])
  try {
    const res = await fetch(`${API_BASE}/api/v2/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId, client, entitlement, ...body }),
      signal: AbortSignal.timeout(20_000)
    })
    const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string }
    if (res.ok && reply.ok === true) return reply as InviteReply
    return { ok: false, code: (typeof reply.code === "string" ? reply.code : res.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST") as InviteFailure }
  } catch {
    return { ok: false, code: "NETWORK" }
  }
}

async function state(create: boolean): Promise<InviteReply> {
  const reply = (await post({ op: "state", create })) as InviteReply
  if (reply.ok) {
    const s = await stored()
    const change: Partial<InviteStored> = {}
    if (reply.code && reply.code !== s.code) {
      change.code = reply.code
      // The app shows the same code (kept in the app group).
      if (TARGET === "safari") void callNative("invite", { op: "code", code: reply.code })
    }
    const until = reply.entered ? Date.parse(reply.entered.until) : 0
    if (until && until !== s.until) change.until = until
    if (Object.keys(change).length) await keep(change)
  }
  return reply
}

async function redeem(code: string): Promise<InviteReply> {
  // One friend's bonus per device: Apple's DeviceCheck token from the native side, where Safari lets it make one.
  const token = TARGET === "safari" ? (await callNative<{ token?: string }>("invite", { op: "token" }, 8_000))?.token : undefined
  const reply = await post({ op: "redeem", code, ...(token ? { deviceToken: token } : {}) })
  if (!reply.ok) return reply as InviteReply
  const until = Date.parse((reply as { until: string }).until)
  await keep({ until })
  if (TARGET === "safari") void callNative("invite", { op: "code", until: until / 1000 })
  deps.statusChanged()
  return state(false)
}

/** A friend's code entered in the app before this install existed: this install takes it over, once. */
async function linkFromApp(): Promise<void> {
  if (TARGET !== "safari") return
  const kept = await callNative<{ appId?: string; until?: number; linked?: boolean; code?: string }>("invite", { op: "state" }, 3_000)
  if (!kept) return
  if (kept.code && !(await stored()).code) await keep({ code: kept.code })
  if (!kept.appId || kept.linked || !kept.until || kept.until * 1000 < Date.now()) return
  const reply = (await post({ op: "link", appId: kept.appId })) as { ok: boolean }
  if (!reply.ok) return
  await keep({ until: kept.until * 1000 })
  void callNative("invite", { op: "linked" })
  deps.statusChanged()
}

export function startInvite(d: InviteDeps): void {
  deps = d
  chrome.runtime.onMessage.addListener((message: InviteRequest, _sender, sendResponse) => {
    if (message?.type !== "invite") return false
    const run = message.op === "state" ? state(message.create) : message.op === "redeem" ? redeem(message.code) : post({ op: "answers" })
    void run.then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
    return true
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[INVITE_STORAGE]) marks = null
  })
  setTimeout(() => void linkFromApp().catch(() => undefined), 3_000)
}
