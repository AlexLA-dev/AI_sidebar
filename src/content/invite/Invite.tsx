// Invite a friend in the panel (2.7, plan section 5): Settings' group with the install's code and link, its friends and
// its reward, and a friend's code for a new install; the one-time card when a friend becomes active. Optional, and
// nothing waits behind it (App Store rule 3.2.2(x)): the friend gets answers, the inviter an App Store offer code.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t, uiLang } from "../../shared/i18n"
import { INVITE_DISCOUNT, INVITE_STORAGE, parseInviteCode, type InviteFailure, type InviteReply, type InviteReward, type InviteState, type InviteStored } from "../../shared/invite"
import * as Icon from "../icons"
import { sendBackground } from "../insert/store"

const use = (a: string, via?: string) => void sendBackground({ type: "useEvent", f: "invite", a, ...(via ? { via } : {}) })

/** A date in the interface's language, inside its sentences («до 21 ноября»), not the browser's. */
export const dayOf = (iso: string | number): string =>
  new Date(iso).toLocaleDateString(uiLang(), { day: "numeric", month: "long" })

const FAILURE_TEXT: Partial<Record<InviteFailure, Parameters<typeof t>[0]>> = {
  CODE_UNKNOWN: "invErrUnknown",
  OWN_CODE: "invErrOwn",
  ALREADY: "invErrAlready",
  TOO_LATE: "invErrLate",
  CODE_FULL: "invErrFull",
  DEVICE_USED: "invErrDevice",
  DEVICE_CHECK: "invErrCheck"
}
export const failureText = (code: InviteFailure): string => t(FAILURE_TEXT[code] ?? "invErrLater")

/** The share sheet with the text and the link in it (a url field would share the link alone), or a copy. */
async function share(code: string, link: string): Promise<"shared" | "copied" | "none"> {
  const text = t("invShareText", code, link)
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ text })
      return "shared"
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return "none"
    }
  }
  return navigator.clipboard?.writeText(text).then(() => "copied" as const, () => "none" as const) ?? "none"
}

/** The reward's buttons: Pro's and Ultra's offer codes (the App Store's redeem sheet), extra answers if offered. */
export function RewardButtons({ reward, onRedeem, onAnswers, via }: { reward: InviteReward; onRedeem: (code: string) => void; onAnswers?: () => void; via: string }): VNode {
  return (
    <div class="cf-card-actions cf-inv-reward">
      {reward.pro && <button type="button" class="cf-primary" onClick={() => { use("reward_pro", via); onRedeem(reward.pro!.code) }}><Icon.Sparkle size={14} /> {t("invRewardPro", reward.pro.discount)}</button>}
      {reward.ultra && <button type="button" class={reward.pro ? "cf-secondary" : "cf-primary"} onClick={() => { use("reward_ultra", via); onRedeem(reward.ultra!.code) }}>{t("invRewardUltra", reward.ultra.discount)}</button>}
      {reward.answers && reward.answers.left > 0 && onAnswers && (
        <button type="button" class="cf-link" onClick={() => { use("reward_answers", via); onAnswers() }}>{t("invRewardAnswers", reward.answers.daily, reward.answers.days)}</button>
      )}
    </div>
  )
}

/** Settings' group. */
export function InviteGroup({ onRedeem, onStatusChange }: { onRedeem: (code: string) => void; onStatusChange: () => void }): VNode {
  const [state, setState] = useState<InviteState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState("")
  const [entered, setEntered] = useState<string | null>(null)

  const load = async (create: boolean) => {
    setBusy(true)
    const reply = await sendBackground<InviteReply>({ type: "invite", op: "state", create })
    setBusy(false)
    if (reply?.ok) {
      setState(reply)
      setError(null)
    } else if (create) setError(failureText(reply?.code ?? "NETWORK"))
  }
  // What's there already (a code made before, a friend's code entered): nothing is made just by looking.
  useEffect(() => void load(false), [])

  const open = () => {
    use("open", "settings")
    void load(true)
  }
  const copy = (code: string, link: string) => {
    void navigator.clipboard?.writeText(t("invShareText", code, link)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, () => undefined)
    use("copy", "settings")
  }
  const redeem = async () => {
    const code = parseInviteCode(draft)
    if (!code) {
      setError(failureText("CODE_UNKNOWN"))
      return
    }
    setBusy(true)
    const reply = await sendBackground<InviteReply>({ type: "invite", op: "redeem", code })
    setBusy(false)
    use(reply?.ok ? "code_ok" : "code_bad", "settings")
    if (!reply?.ok) {
      setError(failureText(reply?.code ?? "NETWORK"))
      return
    }
    setState(reply)
    setError(null)
    setDraft("")
    if (reply.entered) setEntered(t("invEntered", reply.friendDaily, dayOf(reply.entered.until)))
    onStatusChange()
  }
  const answers = async () => {
    const reply = await sendBackground<InviteReply>({ type: "invite", op: "answers" })
    if (reply?.ok) {
      setState(reply)
      onStatusChange()
    } else setError(failureText(reply?.code ?? "NETWORK"))
  }

  const daily = state?.friendDaily ?? 5
  return (
    <section class="cf-group cf-invite">
      <div class="cf-row">
        <span class="cf-label">{t("invTitle")}</span>
      </div>
      <p class="cf-hint">{t("invHint", daily, INVITE_DISCOUNT)}</p>
      {state?.code && state.link ? (
        <>
          <div class="cf-inv-code" aria-label={t("invYourCode")}>
            <span class="cf-inv-label">{t("invYourCode")}</span>
            <strong dir="ltr">{state.code}</strong>
            <small dir="ltr">{state.link.replace(/^https:\/\//, "")}</small>
          </div>
          <div class="cf-row buttons">
            <button type="button" class="cf-primary" onClick={() => void share(state.code!, state.link!).then((how) => how !== "none" && use(how === "shared" ? "share" : "copy", "settings"))}>{t("invShare")}</button>
            <button type="button" class="cf-secondary" onClick={() => copy(state.code!, state.link!)}>{copied ? t("invCopied") : t("invCopy")}</button>
          </div>
          {state.joined > 0 && <p class="cf-hint">{t("invFriends", state.joined, state.active)}</p>}
          {state.reward && (
            <div class="cf-inv-reward-box" role="note">
              <strong>{t("invRewardTitle")}</strong>
              <p>{t("invRewardBody", state.reward.pro?.discount ?? state.reward.ultra?.discount ?? INVITE_DISCOUNT)}</p>
              <RewardButtons reward={state.reward} onRedeem={onRedeem} onAnswers={() => void answers()} via="settings" />
            </div>
          )}
          {state.answersUntil && <p class="cf-hint">{t("invAnswersOn", dayOf(state.answersUntil))}</p>}
        </>
      ) : (
        <div class="cf-row buttons">
          <button type="button" class="cf-primary" disabled={busy} onClick={open}>{t("invButton")}</button>
        </div>
      )}
      {state?.entered && <p class="cf-hint cf-inv-entered">{entered ?? t("invEnteredOn", state.friendDaily, dayOf(state.entered.until))}</p>}
      {state?.canEnter && !state.entered && (
        <>
          <span class="cf-label cf-inv-enter-title">{t("invEnterTitle")}</span>
          <div class="cf-row buttons">
            <input
              class="cf-text cf-inv-input"
              type="text"
              dir="ltr"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellcheck={false}
              maxLength={200}
              placeholder={t("invEnterPlaceholder")}
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter") void redeem()
              }}
            />
            <button type="button" class="cf-secondary" disabled={busy || !draft.trim()} onClick={() => void redeem()}>{t("invEnter")}</button>
          </div>
        </>
      )}
      {error && <p class="cf-hint cf-inv-error" role="alert">{error}</p>}
    </section>
  )
}

/** Active friends already shown to the inviter: the card shows once for each new one. */
export async function seenActive(): Promise<number> {
  const kept = (await chrome.storage.local.get(INVITE_STORAGE))[INVITE_STORAGE] as InviteStored | undefined
  return kept?.seenActive ?? 0
}

export async function markActiveSeen(active: number): Promise<void> {
  const kept = ((await chrome.storage.local.get(INVITE_STORAGE))[INVITE_STORAGE] as InviteStored | undefined) ?? {}
  await chrome.storage.local.set({ [INVITE_STORAGE]: { ...kept, seenActive: active } })
}

/** The one-time card in the chat when a friend has become active: the reward right there. */
export function InviteRewardCard({ onRedeem, onDone }: { onRedeem: (code: string) => void; onDone: () => void }): VNode | null {
  const [reward, setReward] = useState<InviteReward | null>(null)
  useEffect(() => {
    void sendBackground<InviteReply>({ type: "invite", op: "state", create: false }).then((reply) => {
      if (reply?.ok && reply.reward) {
        setReward(reply.reward)
        use("reward_shown", "card")
      } else onDone()
    })
  }, [])
  if (!reward) return null
  return (
    <div class="cf-hint cf-inv-card" role="note">
      <span class="cf-hint-icon"><Icon.Sparkle size={16} /></span>
      <div class="cf-hint-text">
        <strong>{t("invRewardTitle")}</strong>
        <p>{t("invRewardBody", reward.pro?.discount ?? reward.ultra?.discount ?? INVITE_DISCOUNT)}</p>
        <RewardButtons reward={reward} onRedeem={(code) => { onRedeem(code); onDone() }} via="card" />
      </div>
      <button type="button" class="cf-link cf-hint-done" onClick={onDone}>{t("hintGot")}</button>
    </div>
  )
}
