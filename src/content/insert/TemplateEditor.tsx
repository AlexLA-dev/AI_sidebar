import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import type { ConsentStatus } from "../../shared/consent"
import { t } from "../../shared/i18n"
import type { AiFailure, MarkResult } from "../../shared/insert"
import { blanks, editTemplate, makeTemplate, markBlanks, MAX_TEMPLATE_CHARS, type Template } from "../../shared/templates"
import * as Icon from "../icons"
import { follow, placeSheet } from "./place"
import { deleteTemplate, loadAllTemplates, report, saveTemplate, sendBackground } from "./store"

/** Where a template starts from: a selection ("Template" by it), a copied piece (the pin), "+", or one to edit. */
export interface EditorStart {
  text: string
  from: "selection" | "plus" | "pin"
  id?: string
}

interface Props {
  start: EditorStart
  touch: boolean
  consent: ConsentStatus
  onConsent: () => Promise<void>
  host: string
  onDone: (saved: Template | null) => void
  // In the panel's Templates view: in place, not over the page.
  inline?: boolean
}

export function TemplateEditor(p: Props): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [existing, setExisting] = useState<Template | null>(null)
  const [title, setTitle] = useState("")
  const [text, setText] = useState(p.start.text.trim())
  const [keywords, setKeywords] = useState("")
  // What each blank the AI marked stood for: unmarking puts the word back.
  const [marked, setMarked] = useState<Record<string, string>>({})
  const [marking, setMarking] = useState(false)
  const [aiUsed, setAiUsed] = useState(false)
  const [askConsent, setAskConsent] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const agreed = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || p.inline) return
    return follow(el, () => placeSheet(el, p.touch, 680))
  })

  useEffect(() => {
    if (p.start.id) {
      void loadAllTemplates().then((all) => {
        const t0 = all[p.start.id!]
        if (!t0 || t0.deleted) return
        setExisting(t0)
        setTitle(t0.title)
        setText(t0.text)
        setKeywords(t0.keywords.join(", "))
      })
      return
    }
    // A selected or copied text: the AI marks what changes from time to time (only with consent).
    if (p.start.text.trim() && p.consent === "ok") void mark(p.start.text.trim())
  }, [])

  const mark = async (source: string) => {
    setMarking(true)
    setNote(null)
    const reply = await sendBackground<MarkResult | AiFailure>({ type: "qiMark", text: source.slice(0, MAX_TEMPLATE_CHARS) })
    setMarking(false)
    if (!reply || !reply.ok) {
      // Offline or busy: it's saved as plain text, blanks can be added by hand.
      if (reply?.code === "CONSENT") setAskConsent(true)
      else setNote(t("qiMarkFailed"))
      return
    }
    setText((cur) => (cur.trim() === source ? markBlanks(cur, reply.blanks) : cur))
    setMarked(Object.fromEntries(reply.blanks.map((b) => [b.label.trim(), b.value])))
    setTitle((cur) => cur || reply.title)
    setKeywords((cur) => cur || reply.keywords.join(", "))
    setAiUsed(true)
    setNote(reply.blanks.length ? t("qiMarkedHint") : t("qiMarkedNone"))
  }

  // The selected words become a blank (or a new blank goes in at the caret).
  const makeBlank = () => {
    const area = areaRef.current
    if (!area) return
    const { selectionStart: a, selectionEnd: b } = area
    const chosen = text.slice(a, b).trim()
    const label = chosen ? chosen.replace(/[{}\n]/g, "").slice(0, 40) : t("qiBlankDefault")
    const next = `${text.slice(0, a)}{${label}}${text.slice(b)}`
    setText(next)
    if (chosen) setMarked((m) => ({ ...m, [label]: text.slice(a, b) }))
    setTimeout(() => {
      area.focus()
      area.setSelectionRange(a + 1, a + 1 + label.length)
    }, 0)
  }

  const unmark = (label: string) => {
    const word = marked[label] ?? label
    setText((cur) => cur.split(`{${label}}`).join(word))
  }

  const save = async () => {
    const body = text.trim()
    if (!body) return
    const words = keywords.split(",").map((k) => k.trim()).filter(Boolean)
    const now = Date.now()
    const saved = existing
      ? editTemplate(existing, { title, text: body, keywords: words }, now)
      : makeTemplate({ text: body, title, keywords: words, site: p.host || undefined }, now)
    await saveTemplate(saved)
    if (!existing) report({ kind: "insert_tpl_new", from: p.start.from, blanks: blanks(body).length, ai: aiUsed })
    p.onDone(saved)
  }

  const remove = async () => {
    if (existing) await deleteTemplate(existing.id)
    p.onDone(null)
  }

  const labels = blanks(text)
  return (
    <div ref={ref} class={`cf-qi ${p.inline ? "inline" : ""}`} role="dialog" aria-label={t(existing ? "qiEditTemplate" : "qiNewTemplate")}>
      <div class="cf-qi-fill">
        <div class="cf-qi-fill-head">
          <button type="button" aria-label={t("back")} onClick={() => p.onDone(null)}><Icon.Back /></button>
          <span>{t(existing ? "qiEditTemplate" : "qiNewTemplate")}</span>
        </div>
        <input
          class="cf-qi-search plain"
          value={title}
          placeholder={t("qiTemplateTitle")}
          aria-label={t("qiTemplateTitle")}
          maxLength={80}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <textarea
          ref={areaRef}
          class="cf-qi-area"
          value={text}
          rows={6}
          placeholder={t("qiTemplateText")}
          aria-label={t("qiTemplateText")}
          maxLength={MAX_TEMPLATE_CHARS}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyPress={(e) => e.stopPropagation()}
        />
        <div class="cf-qi-chips">
          <button type="button" class="cf-chip small" onClick={makeBlank} onPointerDown={(e) => e.preventDefault()}>{"{ }"} {t("qiMakeBlank")}</button>
          {labels.map((label) => (
            <button type="button" class="cf-qi-chip" title={t("qiUnmark")} aria-label={`${label} — ${t("qiUnmark")}`} onClick={() => unmark(label)}>
              {label} <Icon.Close />
            </button>
          ))}
        </div>
        {marking ? (
          <div class="cf-qi-note"><Icon.Sparkle size={12} /> {t("qiMarking")}</div>
        ) : askConsent ? (
          <div class="cf-card consent">
            <strong>{t("consentTitle")}</strong>
            <p>{t("qiMarkConsent")}</p>
            <div class="cf-card-actions">
              <button type="button" class="cf-primary" onClick={() => {
                agreed.current = true
                setAskConsent(false)
                void p.onConsent().then(() => mark(text.trim()))
              }}>{t("consentAccept")}</button>
              <button type="button" class="cf-link" onClick={() => setAskConsent(false)}>{t("consentDecline")}</button>
            </div>
          </div>
        ) : (
          <div class="cf-qi-note">
            {note ?? t("qiBlankHint")}
            {!existing && !aiUsed && text.trim() && (
              <> <button type="button" class="cf-link" onClick={() => (p.consent === "ok" || agreed.current ? void mark(text.trim()) : setAskConsent(true))}><Icon.Sparkle size={12} /> {t("qiMarkAi")}</button></>
            )}
          </div>
        )}
        <input
          class="cf-qi-search plain"
          value={keywords}
          placeholder={t("qiKeywords")}
          aria-label={t("qiKeywords")}
          onInput={(e) => setKeywords(e.currentTarget.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div class="cf-qi-fill-row">
          <button type="button" class="cf-primary" disabled={!text.trim()} onClick={() => void save()}>{t("qiSave")}</button>
          <button type="button" class="cf-secondary" onClick={() => p.onDone(null)}>{t("cancel")}</button>
          {existing && <button type="button" class="cf-link danger" onClick={() => void remove()}>{t("qiDelete")}</button>}
        </div>
      </div>
    </div>
  )
}
