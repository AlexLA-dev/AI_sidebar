import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import type { ConsentStatus } from "../../shared/consent"
import type { CopiedItem } from "../../shared/copied"
import { t } from "../../shared/i18n"
import type { AiFailure, FillResult } from "../../shared/insert"
import { blanks, fillBlanks, textParts, type Template } from "../../shared/templates"
import * as Icon from "../icons"
import { extractPage } from "../page"
import type { Field } from "./field"
import { follow, placeByCaret, placeSheet } from "./place"
import { report, sendBackground } from "./store"

interface Props {
  template: Template
  touch: boolean
  // A sheet over the page (iPhone, iPad without a keyboard) or a card by the caret.
  sheet: boolean
  field: Field | null
  copied: CopiedItem[]
  consent: ConsentStatus
  onConsent: () => void
  free: boolean
  onUpgrade: () => void
  onClose: () => void
  onAdapt: (text: string) => void
  onInsert: (text: string, filled: "ai" | "manual" | "none", blanks: number) => void
}

/** What the field is for, from its label (helps the AI pick the right values; no text of the field). */
function fieldLabel(field: Field | null): string {
  const el = field?.el
  if (!el) return ""
  const doc = el.ownerDocument
  const byId = el.id ? doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : ""
  const parts = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"), byId, el.getAttribute("name")]
  return parts.filter(Boolean).join(" · ").replace(/\s+/g, " ").trim().slice(0, 200)
}

/**
 * A template with blanks before it goes in: each blank is a small field (Tab moves on), an empty one
 * offers what was copied, and the AI fills them from the page only when asked. Highlighted: taken from
 * the page; a blank the AI wasn't sure about stays empty.
 */
export function FillForm(p: Props): VNode {
  const labels = blanks(p.template.text)
  const parts = textParts(p.template.text)
  const ref = useRef<HTMLDivElement>(null)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [byAi, setByAi] = useState<Set<string>>(new Set())
  const editedAfterAi = useRef(false)
  const [picking, setPicking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [limit, setLimit] = useState(false)
  const [askConsent, setAskConsent] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return follow(el, () => (p.sheet ? placeSheet(el, p.touch) : placeByCaret(el, p.field, p.touch, 420)))
  })
  // The first blank takes the caret (on iPhone that brings the keyboard back up for it).
  useEffect(() => {
    if (!p.sheet || !p.touch) setTimeout(() => inputs.current[labels[0]]?.focus({ preventScroll: true }), 0)
  }, [])

  const set = (label: string, value: string) => {
    setValues((v) => ({ ...v, [label]: value }))
    if (byAi.has(label) && !editedAfterAi.current) {
      editedAfterAi.current = true
      report({ kind: "insert_fill_edit", blanks: labels.length })
    }
  }

  const insert = () => {
    const text = fillBlanks(p.template.text, values)
    p.onInsert(text, byAi.size > 0 ? "ai" : Object.values(values).some((v) => v.trim()) ? "manual" : "none", labels.length)
  }

  const fill = async () => {
    if (p.consent !== "ok") {
      setAskConsent(true)
      return
    }
    setBusy(true)
    setNote(null)
    const page = extractPage()
    const reply = await sendBackground<FillResult | AiFailure>({
      type: "qiFill",
      text: p.template.text,
      blanks: labels,
      page: { title: page.title, url: location.href, text: page.text.slice(0, 15_000) },
      field: fieldLabel(p.field)
    })
    setBusy(false)
    if (!reply || !reply.ok) {
      const code = reply?.code ?? "NETWORK"
      if (code === "FILL_LIMIT") setLimit(true)
      else if (code === "CONSENT") setAskConsent(true)
      else setNote(code === "NETWORK" ? t("errNetwork") : t("errUpstream"))
      return
    }
    const next = { ...values }
    const filled = new Set<string>()
    for (const label of labels) {
      const v = reply.values[label]
      if (typeof v === "string" && v.trim()) {
        next[label] = v.trim()
        filled.add(label)
      }
    }
    setValues(next)
    setByAi(filled)
    editedAfterAi.current = false
    report({ kind: "insert_fill", blanks: labels.length, found: filled.size })
    const left = reply.left
    setNote(t(filled.size < labels.length ? "qiFillPartly" : "qiFillDone") + (p.free && typeof left === "number" ? ` ${t("qiFillLeft", left)}` : ""))
    // The caret goes to the first blank left empty.
    const empty = labels.find((l) => !filled.has(l) && !next[l]?.trim())
    if (empty) setTimeout(() => inputs.current[empty]?.focus({ preventScroll: true }), 0)
  }

  const onKeyDown = (e: KeyboardEvent, label: string) => {
    e.stopPropagation()
    if (e.key === "Escape") {
      e.preventDefault()
      p.onClose()
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault()
      const i = labels.indexOf(label)
      if (e.metaKey || e.ctrlKey || i === labels.length - 1) insert()
      else inputs.current[labels[i + 1]]?.focus()
    }
  }

  const copied = p.copied.slice(0, 5)

  return (
    <div ref={ref} class={`cf-qi ${p.sheet ? "" : "suggest"}`} role="dialog" aria-label={p.template.title} onPointerDown={(e) => !(e.target as Element).closest("input") && e.preventDefault()}>
      <div class="cf-qi-fill">
        <div class="cf-qi-fill-head">
          <button type="button" aria-label={t("back")} onClick={p.onClose}><Icon.Back /></button>
          <span>{p.template.title}</span>
        </div>
        <div class="cf-qi-fill-text">
          {parts.map((part) =>
            "text" in part ? (
              <span>{part.text}</span>
            ) : (
              <input
                ref={(el) => { inputs.current[part.blank] = el }}
                class={`cf-qi-blank ${byAi.has(part.blank) && values[part.blank] ? "filled" : ""}`}
                value={values[part.blank] ?? ""}
                placeholder={part.blank}
                aria-label={part.blank}
                size={Math.max(4, Math.min(40, (values[part.blank] || part.blank).length + 1))}
                autoComplete="off"
                onFocus={() => setPicking(values[part.blank]?.trim() ? null : part.blank)}
                onInput={(e) => {
                  set(part.blank, e.currentTarget.value)
                  setPicking(e.currentTarget.value.trim() ? null : part.blank)
                }}
                onKeyDown={(e) => onKeyDown(e, part.blank)}
                onKeyUp={(e) => e.stopPropagation()}
                onKeyPress={(e) => e.stopPropagation()}
              />
            )
          )}
        </div>

        {picking && copied.length > 0 && (
          <div class="cf-qi-pick" role="listbox" aria-label={t("qiCopied")}>
            <div class="cf-qi-sec"><span>{t("qiPickCopied", picking)}</span></div>
            {copied.map((c) => (
              <button type="button" class="cf-qi-row" onClick={() => {
                set(picking, c.text)
                const i = labels.indexOf(picking)
                setPicking(null)
                const next = labels.slice(i + 1).find((l) => !values[l]?.trim())
                setTimeout(() => (next ? inputs.current[next]?.focus() : undefined), 0)
              }}>
                <span class="cf-qi-main"><span class="cf-qi-text">{c.text.replace(/\s+/g, " ")}</span></span>
              </button>
            ))}
          </div>
        )}

        {askConsent ? (
          <div class="cf-card consent">
            <strong>{t("consentTitle")}</strong>
            <p>{t("qiFillConsent")}</p>
            <div class="cf-card-actions">
              <button type="button" class="cf-primary" onClick={() => {
                p.onConsent()
                setAskConsent(false)
                setTimeout(() => void fill(), 0)
              }}>{t("consentAccept")}</button>
              <button type="button" class="cf-link" onClick={() => setAskConsent(false)}>{t("consentDecline")}</button>
            </div>
          </div>
        ) : limit ? (
          <div class="cf-card">
            <p>{t("qiFillLimit")}</p>
            <div class="cf-card-actions">
              <button type="button" class="cf-primary" onClick={p.onUpgrade}><Icon.Sparkle size={14} /> {t("upgradePro")}</button>
              <button type="button" class="cf-link" onClick={() => setLimit(false)}>{t("qiFillByHand")}</button>
            </div>
          </div>
        ) : null}

        <div class="cf-qi-fill-row">
          <button type="button" class="cf-primary" onClick={insert}>{t("qiInsert")}</button>
          <button type="button" class="cf-secondary" disabled={busy} onClick={() => void fill()}>
            <Icon.Sparkle size={14} /> {busy ? t("qiFilling") : byAi.size ? t("qiFillAgain") : t("qiFillFromPage")}
          </button>
          <button type="button" class="cf-link" onClick={() => p.onAdapt(fillBlanks(p.template.text, values))}>{t("qiAdapt")}</button>
        </div>
        <div class="cf-qi-note">{note ?? t("qiFillHint")}</div>
      </div>
    </div>
  )
}
