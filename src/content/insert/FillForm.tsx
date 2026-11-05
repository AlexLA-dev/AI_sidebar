import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"

import type { ConsentStatus } from "../../shared/consent"
import type { CopiedItem } from "../../shared/copied"
import { t } from "../../shared/i18n"
import { ConsentCard } from "../Consent"
import type { AiFailure, FillResult } from "../../shared/insert"
import { blanks, fillBlanks, textParts, type Template } from "../../shared/templates"
import * as Icon from "../icons"
import { extractPage } from "../page"
import { loadConsent } from "../store"
import { conversationAround, conversationText } from "./conversation"
import type { Field } from "./field"
import { follow, placeByCaret, placeSheet } from "./place"
import { markRewriteHintSeen, report, rewriteHintSeen, sendBackground } from "./store"

interface Props {
  template: Template
  touch: boolean
  // A sheet over the page (iPhone, iPad without a keyboard) or a card by the caret.
  sheet: boolean
  field: Field | null
  copied: CopiedItem[]
  consent: ConsentStatus
  onConsent: () => Promise<void>
  free: boolean
  onUpgrade: () => void
  onClose: () => void
  // The whole text rewritten by the panel's AI for this page (`conversation`: the one around the field, when there's one).
  onAdapt: (text: string, conversation: string | null) => void
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
  // What waits for the consent: filling the blanks, or the rewrite. The card shows right here, not in the panel.
  const [askConsent, setAskConsent] = useState<null | "fill" | "rewrite">(null)
  // The conversation the field replies in (LinkedIn's messages): what the AI reads instead of the whole page, whose
  // list of other conversations gave it the wrong name (the owner, 2.5 (81)).
  const conversation = useMemo(() => (p.field ? conversationAround(p.field.el) : null), [])
  // "Fill again" vs the rewrite, said once under the buttons the first time the form shows.
  const [rewriteHint, setRewriteHint] = useState(false)
  useEffect(() => {
    void rewriteHintSeen().then((seen) => {
      if (seen) return
      setRewriteHint(true)
      void markRewriteHintSeen()
    })
  }, [])

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

  // A blank left empty went in as nothing ("Hi , thanks…"): the first one lights up and takes the caret instead.
  // Pressing Insert again with it still empty puts the text in as it is (some blanks are meant to stay empty).
  const [missing, setMissing] = useState<string | null>(null)
  const insert = () => {
    const empty = labels.find((l) => !values[l]?.trim())
    if (empty && missing !== empty) {
      setMissing(empty)
      inputs.current[empty]?.focus({ preventScroll: true })
      return
    }
    const text = fillBlanks(p.template.text, values)
    p.onInsert(text, byAi.size > 0 ? "ai" : Object.values(values).some((v) => v.trim()) ? "manual" : "none", labels.length)
  }

  // The background knows the consent (this tab's copy can be behind): without it nothing is sent, and the one card
  // shows here.
  const fill = async () => {
    setBusy(true)
    setNote(null)
    const page = conversation ? { title: conversation.title || document.title, text: conversationText(conversation) } : extractPage()
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
      else if (code === "CONSENT") setAskConsent("fill")
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

  // The rewrite goes to the panel's AI: without the consent, the card shows here first (the panel isn't opened for it).
  const rewrite = () => p.onAdapt(fillBlanks(p.template.text, values), conversation ? conversationText(conversation) : null)
  const tryRewrite = async () => {
    if ((await loadConsent()) !== "ok") return setAskConsent("rewrite")
    rewrite()
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
                class={`cf-qi-blank ${byAi.has(part.blank) && values[part.blank] ? "filled" : ""} ${missing === part.blank && !values[part.blank]?.trim() ? "missing" : ""}`}
                value={values[part.blank] ?? ""}
                placeholder={part.blank}
                aria-label={part.blank}
                size={Math.max(4, Math.min(40, (values[part.blank] || part.blank).length + 1))}
                autoComplete="off"
                onFocus={(e) => setPicking(e.currentTarget.value.trim() ? null : part.blank)}
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
                const label = picking
                set(label, c.text)
                setPicking(null)
                const el = inputs.current[label]
                if (el) el.value = c.text
                // In the tap itself (iOS raises the keyboard only then): the next empty blank, or, with a
                // keyboard in use, this one again so Enter inserts.
                const next = labels.slice(labels.indexOf(label) + 1).find((l) => !values[l]?.trim())
                if (next) inputs.current[next]?.focus()
                else if (!p.sheet || !p.touch) el?.focus()
              }}>
                <span class="cf-qi-main"><span class="cf-qi-text">{c.text.replace(/\s+/g, " ")}</span></span>
              </button>
            ))}
          </div>
        )}

        {askConsent ? (
          <ConsentCard again={p.consent === "old"} onAccept={() => {
            const then = askConsent
            setAskConsent(null)
            void p.onConsent().then(() => (then === "fill" ? fill() : rewrite()))
          }} onDecline={() => setAskConsent(null)} />
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
          <button type="button" class="cf-link" title={t("qiAdaptHint")} onClick={() => void tryRewrite()}>{t(conversation ? "qiAdaptChat" : "qiAdapt")}</button>
        </div>
        {rewriteHint && <div class="cf-qi-note">{t("qiAdaptHint")}</div>}
        <div class="cf-qi-note">{note ?? t("qiFillHint")}</div>
      </div>
    </div>
  )
}
