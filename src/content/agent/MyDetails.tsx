// «Мои данные» in the panel's settings (2.7.1): the person's details for forms on sites, kept by the app on this device
// (FormData.swift), and in their iCloud only after they turn it on. 2.7.1 (the owner on build 121: «куда делась настройка
// вкл/выкл синк с iCloud?», and the one question vanished unanswered: it lived only until Settings re-rendered, and with
// no answer kept there was no switch): a switch always, in the style of every other one, off until the person turns it
// on («Пока только на этом устройстве»), and what the last sync did under it. Shown in one order (detailsView.ts), the
// saved rows and the add menu alike. Passwords, cards, bank and document numbers, codes and health
// data are refused before they're kept (src/shared/agent/formdata.ts). Also here: the sites where a deferred task
// starts right after its notification (switched back on with ✕).

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { FORM_KEYS, refusedEntry, type FormEntry, type FormKey } from "../../shared/agent/formdata"
import { TARGET } from "../../shared/config"
import { t, uiLang, type MessageKey } from "../../shared/i18n"
import { onReturn } from "../bgmsg"
import { sendBackground } from "../insert/store"
import { CalendarNeed } from "./AppleAccess"
import { FIELD_ORDER, orderedEntries, syncState } from "./detailsView"
import { autoStartSites, setAutoStart } from "./marks"
import { DEFAULT_RULES, readRules, RULES_KEY, type AgentRules } from "../../shared/agent/rules"

const KEY_NAME: Record<FormKey, MessageKey> = {
  "name.full": "fdNameFull", "name.given": "fdNameGiven", "name.family": "fdNameFamily", "name.latin": "fdNameLatin",
  "name.phonetic": "fdNamePhonetic", email: "fdEmail", phone: "fdPhone", "address.line": "fdAddressLine",
  "address.apartment": "fdAddressApartment", "address.city": "fdAddressCity", "address.region": "fdAddressRegion",
  "address.postal": "fdAddressPostal", "address.country": "fdAddressCountry", company: "fdCompany", jobTitle: "fdJobTitle",
  website: "fdWebsite", birthDate: "fdBirthDate", fact: "fdFact"
}

export function keyName(e: Pick<FormEntry, "key" | "label">): string {
  return e.key === "fact" ? e.label : t(KEY_NAME[e.key])
}

interface Data {
  entries: FormEntry[]
  icloud?: boolean
  // No answer from the extension (the tab's link went while Safari was away, 123).
  lost?: boolean
  // What the last sync through iCloud did (the app keeps it): when it went through, or why it didn't.
  syncedAt?: number
  syncError?: string
}

const newId = () => `fd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

export function MyDetailsGroup(): VNode {
  const [data, setData] = useState<Data | null>(null)
  const [key, setKey] = useState<FormKey>("name.full")
  const [label, setLabel] = useState("")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  // Turning iCloud on or off: the answer pending.
  const [syncing, setSyncing] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const [sites, setSites] = useState<string[]>([])

  useEffect(() => {
    const load = () => void sendBackground<Data>({ type: "formData" }).then((d) => d && setData(d))
    // Read again when the page comes back (from the ContextFlow app after «Разрешить», another tab): the first read may
    // have gone to a background Safari had put away.
    load()
    void autoStartSites().then(setSites)
    const off = onReturn(load)
    // Nothing came at all: the tab's link to ContextFlow is gone (123) — said, with a reload, never an empty list.
    const empty = setTimeout(() => setData((d) => d ?? { entries: [], lost: true }), 12_000)
    return () => {
      off()
      clearTimeout(empty)
    }
  }, [])

  const live = orderedEntries((data?.entries ?? []).filter((e) => !e.deleted), uiLang())
  const put = async (changes: FormEntry[]) => {
    const d = await sendBackground<Data>({ type: "formDataPut", changes })
    if (d) setData(d)
    return d
  }

  const add = async () => {
    const v = value.trim()
    const l = key === "fact" ? label.trim() : ""
    if (!v || (key === "fact" && !l)) return
    if (refusedEntry(l || t(KEY_NAME[key]), v)) {
      setError(t("fdRefused"))
      return
    }
    setError(null)
    const d = await put([{ id: newId(), key, label: l, value: v.slice(0, 500), updatedAt: Date.now() }])
    setValue("")
    setLabel("")
    return d
  }

  const remove = (e: FormEntry) => void put([{ ...e, label: "", value: "", deleted: true, updatedAt: Date.now() }])
  const removeAll = () => {
    setConfirmAll(false)
    void put(live.map((e) => ({ ...e, label: "", value: "", deleted: true, updatedAt: Date.now() })))
  }
  const icloud = async (on: boolean) => {
    setSyncing(true)
    setData((now) => ({ ...(now ?? { entries: [] }), icloud: on }))
    const d = await sendBackground<Data>({ type: "formDataICloud", on })
    setSyncing(false)
    setData((now) => ({ ...d, entries: d?.entries?.length ? d.entries : now?.entries ?? [], icloud: on, ...(d ? {} : { syncError: "failed" }) }))
  }

  return (
    <section class="cf-group cf-mydetails">
      <span class="cf-label">{t("fdTitle")}</span>
      <p class="cf-hint">{t("fdHint")}</p>
      {data?.lost && (
        <p class="cf-hint">
          {t("errLink")} <button type="button" class="cf-link" onClick={() => location.reload()}>{t("reloadPage")}</button>
        </p>
      )}
      {live.length > 0 && (
        <ul class="cf-fd-list">
          {live.map((e) => (
            <li key={e.id}>
              <span class="cf-fd-name" dir="auto">{keyName(e)}</span>
              <span class="cf-fd-value" dir="auto">{e.value}</span>
              <button type="button" class="cf-link" onClick={() => remove(e)}>{t("fdDelete")}</button>
            </li>
          ))}
        </ul>
      )}
      <div class="cf-fd-add">
        <select value={key} onChange={(e) => setKey((e.target as HTMLSelectElement).value as FormKey)}>
          {FIELD_ORDER.filter((k) => k === "fact" || (FORM_KEYS as readonly string[]).includes(k)).map((k) => <option key={k} value={k}>{t(KEY_NAME[k])}</option>)}
        </select>
        {key === "fact" && (
          <input class="cf-input-line" value={label} placeholder={t("fdFactLabel")} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
        )}
        <input
          class="cf-input-line"
          type={key === "birthDate" ? "date" : key === "email" ? "email" : key === "phone" ? "tel" : "text"}
          value={value}
          maxLength={500}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") void add()
          }}
        />
        <button type="button" class="cf-secondary" onClick={() => void add()}>{t("fdAdd")}</button>
      </div>
      {error && <p class="cf-hint cf-fd-error" role="alert">{error}</p>}
      {/* Always here, off until the person turns it on (never by default); on: what the last sync did. */}
      {data && TARGET === "safari" && (
        <>
          <label class="cf-row toggle cf-fd-icloud">
            <span class="cf-label">{t("fdICloud")}</span>
            <input type="checkbox" checked={data.icloud === true} disabled={syncing} onChange={(e) => void icloud((e.target as HTMLInputElement).checked)} />
          </label>
          <p class="cf-hint" role="status">{syncLine(data, syncing)}</p>
        </>
      )}
      {live.length > 1 && !confirmAll && <button type="button" class="cf-link" onClick={() => setConfirmAll(true)}>{t("fdDeleteAll")}</button>}
      {confirmAll && (
        <div class="cf-card" role="alertdialog">
          <p>{t("fdDeleteAllAsk")}</p>
          <div class="cf-card-actions">
            <button type="button" class="cf-primary" onClick={removeAll}>{t("fdDeleteAll")}</button>
            <button type="button" class="cf-secondary" onClick={() => setConfirmAll(false)}>{t("cancel")}</button>
          </div>
        </div>
      )}
      <RulesGroup />
      {sites.length > 0 && (
        <>
          <span class="cf-label">{t("setAgentAuto")}</span>
          <p class="cf-hint">{t("setAgentAutoHint")}</p>
          <div class="cf-fd-sites">
            {sites.map((s) => (
              <button key={s} type="button" class="cf-qi-chip" onClick={() => void setAutoStart(s, false).then(() => setSites(sites.filter((x) => x !== s)))}>{s} ✕</button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

/** «Правила поручений» (2.7.1): set once, used for every booking without asking; on the device (storage.local). */
function RulesGroup(): VNode {
  const [rules, setRules] = useState<AgentRules>(DEFAULT_RULES)
  useEffect(() => {
    try {
      chrome.storage.local.get(RULES_KEY, (r) => setRules(readRules(r?.[RULES_KEY])))
    } catch {
      // the defaults stay
    }
  }, [])
  const set = (patch: Partial<AgentRules>) => {
    const next = readRules({ ...rules, ...patch })
    setRules(next)
    try {
      void chrome.storage.local.set({ [RULES_KEY]: next })
    } catch {
      // not kept this time
    }
  }
  const num = (key: "window" | "days" | "party", text: string, options: number[]) => (
    <label class="cf-row">
      <span>{text}</span>
      <select class="cf-fd-rule" value={String(rules[key])} onChange={(e) => set({ [key]: Number((e.target as HTMLSelectElement).value) })}>
        {options.map((o) => <option key={o} value={String(o)}>{o}</option>)}
      </select>
    </label>
  )
  // The switch at the end of its row, as every other switch in Settings (2.7.1, the owner on 121).
  const flag = (key: "anySpecialist" | "usual" | "calendar" | "auto" | "chooseVenue", text: string) => (
    <label class="cf-row toggle">
      <span>{text}</span>
      <input type="checkbox" checked={rules[key]} onChange={(e) => set({ [key]: (e.target as HTMLInputElement).checked })} />
    </label>
  )
  return (
    <div class="cf-fd-rules">
      <span class="cf-label">{t("agentRulesTitle")}</span>
      <p class="cf-hint">{t("agentRulesHint")}</p>
      {num("window", t("agentRuleWindow"), [0, 15, 30, 60, 90, 120])}
      {num("days", t("agentRuleDays"), [0, 1, 2, 3, 5, 7])}
      {num("party", t("agentRuleParty"), [1, 2, 3, 4, 5, 6, 8])}
      {flag("anySpecialist", t("agentRuleAnySpecialist"))}
      {/* Whoever does the service (2.7.1, the owner: «почему тут только мастер?»). */}
      <p class="cf-hint">{t("agentRuleAnySpecialistHint")}</p>
      {flag("usual", t("agentRuleUsual"))}
      {flag("calendar", t("agentRuleCalendar"))}
      {rules.calendar && <CalendarNeed />}
      {flag("auto", t("agentRuleAuto"))}
      {flag("chooseVenue", t("agentRuleVenue"))}
      {rules.chooseVenue && (
        <label class="cf-row">
          <span>{t("agentRuleRating")}</span>
          <select class="cf-fd-rule" value={String(rules.rating)} onChange={(e) => set({ rating: Number((e.target as HTMLSelectElement).value) })}>
            {[4, 4.3, 4.5, 4.7, 4.8].map((o) => <option key={o} value={String(o)}>{o.toLocaleString()}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}

/** The line under the iCloud switch, in words (detailsView.ts syncState). */
function syncLine(d: Pick<Data, "icloud" | "syncedAt" | "syncError">, syncing: boolean): string {
  const state = syncState(d, syncing)
  switch (state.line) {
    case "local": return t("fdICloudLocal")
    case "syncing": return t("fdICloudSyncing")
    case "noAccount": return t("fdICloudNoAccount")
    case "failed": return t("fdICloudFailed")
    case "private": return t("fdICloudHint")
    case "synced": {
      if (state.when === "now") return t("fdICloudSynced", t("fdICloudJustNow"))
      const recent = Date.now() - state.when < 20 * 3_600_000
      return t("fdICloudSynced", new Date(state.when).toLocaleString(uiLang(), recent ? { hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))
    }
  }
}
