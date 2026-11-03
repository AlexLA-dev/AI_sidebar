import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import type { ConsentStatus } from "../../shared/consent"
import { t } from "../../shared/i18n"
import { blanks, fillBlanks, normalize, type Template } from "../../shared/templates"
import * as Icon from "../icons"
import { copyToClipboard } from "./field"
import * as QIcon from "./icons"
import { loadTemplates, onTemplates, syncTemplatesNow } from "./store"
import { useHasField } from "./target"
import { TemplateEditor, type EditorStart } from "./TemplateEditor"

interface Props {
  touch: boolean
  consent: ConsentStatus
  onConsent: () => void
  host: string
  // Into the field the user was typing in (the panel closes first); templates with blanks open their form.
  onInsert: (t: Template) => void
}

/** The panel's Templates: all of them, "+", edit and delete, copy, insert into the page's field. */
export function TemplatesView(p: Props): VNode {
  const [list, setList] = useState<Template[]>([])
  const [editing, setEditing] = useState<EditorStart | null>(null)
  const [query, setQuery] = useState("")
  const [copied, setCopied] = useState<string | null>(null)
  const hasField = useHasField()

  useEffect(() => {
    void loadTemplates().then(setList)
    void syncTemplatesNow()
    return onTemplates(() => void loadTemplates().then(setList))
  }, [])

  if (editing) {
    return <TemplateEditor start={editing} touch={p.touch} consent={p.consent} onConsent={p.onConsent} host={p.host} inline onDone={() => setEditing(null)} />
  }

  const q = normalize(query)
  const shown = q ? list.filter((x) => normalize(`${x.title} ${x.keywords.join(" ")} ${x.text}`).includes(q)) : list
  return (
    <div class="cf-qi-view">
      <div class="cf-qi-head">
        <input class="cf-qi-search" type="search" value={query} placeholder={t("qiSearch")} aria-label={t("qiSearch")} onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="button" aria-label={t("qiNewTemplate")} title={t("qiNewTemplate")} onClick={() => setEditing({ text: "", from: "plus" })}><Icon.Plus /></button>
      </div>
      {list.length === 0 ? (
        <div class="cf-qi-empty big">
          <QIcon.Template size={28} />
          <p>{t("qiTemplatesIntro")}</p>
          <button type="button" class="cf-primary" onClick={() => setEditing({ text: "", from: "plus" })}><Icon.Plus /> {t("qiNewTemplate")}</button>
        </div>
      ) : (
        <div class="cf-qi-body">
          {shown.map((tpl) => (
            <div class="cf-qi-row" role="button" tabIndex={0} onClick={() => setEditing({ text: tpl.text, from: "plus", id: tpl.id })} onKeyDown={(e) => e.key === "Enter" && setEditing({ text: tpl.text, from: "plus", id: tpl.id })}>
              <span class="cf-qi-main">
                <span class="cf-qi-title">{tpl.title}</span>
                <span class="cf-qi-text">{tpl.text.replace(/\s+/g, " ")}</span>
                {blanks(tpl.text).length > 0 && <span class="cf-qi-meta">{t("qiBlanksCount", blanks(tpl.text).length)}</span>}
              </span>
              <button type="button" class="cf-qi-act" aria-label={t("copy")} title={t("copy")} onClick={(e) => {
                e.stopPropagation()
                void copyToClipboard(fillBlanks(tpl.text, {})).then((ok) => {
                  if (!ok) return
                  setCopied(tpl.id)
                  setTimeout(() => setCopied(null), 1500)
                })
              }}>{copied === tpl.id ? <Icon.Check /> : <Icon.Copy />}</button>
              {hasField && (
                <button type="button" class="cf-qi-act" aria-label={t("qiInsertIntoField")} title={t("qiInsertIntoField")} onClick={(e) => {
                  e.stopPropagation()
                  p.onInsert(tpl)
                }}><QIcon.Cursor /></button>
              )}
            </div>
          ))}
          {shown.length === 0 && <div class="cf-qi-empty">{t("qiNothing")}</div>}
        </div>
      )}
    </div>
  )
}
