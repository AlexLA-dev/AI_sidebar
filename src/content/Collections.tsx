// «Подборки» in the panel (2.7, plan section 2). «В подборку» under an answer or a note opens the sheet: where the card
// goes (Pro with the AI consent: the AI's suggestion; else by words on the device), every collection of the space with
// its sections, a new section, a new collection. The header's «Чат | Подборки» opens the collections window: a
// collection's summary, sections and cards (a tap opens the card's chat), «Сравнить» and «Сводка» (Pro), PDF and
// «← К чату». The data and its rules are src/shared/collections.ts; the app shows the same collections as columns.

import type { VNode } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import {
  COLLECTION_PREFIX, FREE_CARDS, MAX_CARDS, addCard, addComparison, addSection, canAddCard, canAddCollection, cardFrom, cardsIn,
  countedCards, deleteCard, hostOf, liveCollections, liveSections, moveCard, newCollection, placeBody, placeFromAi, setSummary, suggestPlace,
  type Card, type Collection, type Place
} from "../shared/collections"
import type { Entry } from "../shared/conversation"
import { pluralForm, t } from "../shared/i18n"
import type { SpaceList } from "../shared/spaces"
import { newThreadId } from "../shared/threads"
import type { CollectOp, CollectReply } from "../shared/types"
import * as Icon from "./icons"
import { loadCollections, onCollectionsChanged, saveCollection } from "./store"
import { when } from "./Threads"

/** A step for the counters (usage.ts "collect"): counts only, never a name, a gist or a site. */
export type CollectReport = (a: string, fields?: { via?: string; what?: "collection" | "card"; cards?: number }) => void
/** The AI's op through the background (Pro, the one consent; collect.ts). */
export type CollectAsk = (op: CollectOp, body: Record<string, unknown>) => Promise<CollectReply>
/** Pro at a limit or a Pro step: what the person reached for. */
export type CollectPro = (what: "collection" | "card" | "compare" | "summary") => void

export const newCollectionId = (): string => `${COLLECTION_PREFIX}${newThreadId().toLowerCase()}`
const newItemId = (): string => newThreadId().toLowerCase()

export function cardsLabel(n: number): string {
  return t(`colCards_${pluralForm(n)}`, n)
}

/** Every collection, live (here, another tab, iCloud, the app), and the ones of the space the panel is in. */
export function useCollections(list: SpaceList, space: string, on: boolean) {
  const [all, setAll] = useState<Collection[]>([])
  useEffect(() => {
    let live = true
    void loadCollections().then((x) => { if (live) setAll(x) }, () => undefined)
    const off = onCollectionsChanged(setAll)
    return () => {
      live = false
      off()
    }
  }, [])
  const shown = useMemo(() => liveCollections(all, list, space, on), [all, list, space, on])
  return { all, shown }
}

// ------------------------------------------------------------------ «В подборку»

export function CollectSheet({ entries, index, chat, all, shown, space, pro, ai, lang, ask, onPro, onAdded, onClose, report }: {
  entries: Entry[]
  index: number
  chat: string
  all: Collection[]
  shown: Collection[]
  space: string
  pro: boolean
  // The AI may be asked (Pro, the consent given): its suggestion first.
  ai: boolean
  lang: string
  ask: CollectAsk
  onPro: CollectPro
  onAdded: (text: string) => void
  onClose: () => void
  report: CollectReport
}): VNode | null {
  const card = useMemo(() => cardFrom(entries, index, chat, newItemId(), ""), [entries, index, chat])
  const words = useMemo<Place | null>(() => {
    if (!card) return null
    const best = suggestPlace(shown, card)
    return best ? { collection: best.collection, section: best.section, by: "words" } : null
  }, [card, shown])
  const [aiPlace, setAiPlace] = useState<Place | null>(null)
  const [asking, setAsking] = useState(ai && shown.length > 0)
  const [open, setOpen] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ kind: "section"; collection: string } | { kind: "collection" } | null>(null)
  const [name, setName] = useState("")
  const [limit, setLimit] = useState<"collection" | "card" | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (!card || !ai || shown.length === 0) return
    let live = true
    void ask("place", placeBody(card, shown, lang)).then((reply) => {
      if (!live) return
      setAsking(false)
      if (reply.ok) setAiPlace(placeFromAi(reply.body, shown))
    }, () => live && setAsking(false))
    return () => { live = false }
    // Once per sheet: the collections changing while it's open don't ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const suggestion = aiPlace ?? (asking ? null : words)
  useEffect(() => {
    if (suggestion?.collection) setOpen((x) => x ?? suggestion.collection)
  }, [suggestion?.collection])

  if (!card) return null

  const byId = (id: string) => all.find((c) => c.id === id)

  /** Adds the card at `place`; `via`: the suggestion taken or a place picked. */
  const add = async (place: Place, via: "suggested" | "picked") => {
    if (busy.current) return
    const now = Date.now()
    if (place.collection) {
      const rec = byId(place.collection)
      if (!rec) return
      if (!canAddCard(rec, pro)) {
        setLimit("card")
        report("limit", { via: "panel", what: "card", cards: countedCards(rec) })
        return
      }
      busy.current = true
      let sid = place.section
      const saved = await saveCollection(rec.id, (cur) => {
        if (!cur) return null
        let next = cur
        if (!sid) {
          sid = newItemId()
          next = addSection(next, sid, place.newSection || t("colFirstSection"), now, place.by === "ai")
          if (!liveSections(next).some((s) => s.id === sid)) sid = liveSections(next)[0]?.id ?? null
        }
        return sid ? addCard(next, { ...card, sec: sid }, now) : null
      })
      busy.current = false
      if (!saved) return
      if (!place.section) report("section_add", { via: "panel" })
      report("add", { via, cards: countedCards(saved) })
      onAdded(t("colAdded", saved.n, liveSections(saved).find((s) => s.id === sid)?.n ?? ""))
      return
    }
    // A new collection.
    if (!canAddCollection(all, pro)) {
      setLimit("collection")
      report("limit", { via: "panel", what: "collection", cards: 0 })
      return
    }
    const title = (place.newCollection ?? "").trim()
    if (!title) return
    busy.current = true
    const cid = newCollectionId()
    const sid = newItemId()
    const saved = await saveCollection(cid, () => addCard(newCollection(cid, title, space, now, { id: sid, name: place.newSection || t("colFirstSection") }), { ...card, sec: sid }, now))
    busy.current = false
    if (!saved) return
    report("create", { via: "panel", what: "collection" })
    report("add", { via, cards: 1 })
    onAdded(t("colAdded", saved.n, liveSections(saved)[0]?.n ?? ""))
  }

  const label = (p: Place): string => {
    if (p.collection) {
      const rec = byId(p.collection)
      const sec = rec && p.section ? liveSections(rec).find((s) => s.id === p.section)?.n : null
      return `${rec?.n ?? ""} → ${sec ?? `+ ${p.newSection ?? ""}`}`
    }
    return `${t("colNewCollection")}: ${p.newCollection ?? ""}`
  }

  const submitName = () => {
    const value = name.trim()
    if (!value || !naming) return
    if (naming.kind === "section") void add({ collection: naming.collection, section: null, newSection: value, by: "words" }, "picked")
    else void add({ collection: null, section: null, newCollection: value, by: "words" }, "picked")
  }

  return (
    <div class="cf-col-sheet-wrap" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class="cf-col-sheet" role="dialog" aria-label={t("colAdd")}>
        <div class="cf-col-sheet-head">
          <strong>{t("colAdd")}</strong>
          <button type="button" class="cf-icon" onClick={onClose} aria-label={t("close")}><Icon.Close /></button>
        </div>
        <p class="cf-col-sheet-gist" dir="auto">{card.t}</p>
        {asking && <div class="cf-col-status" role="status">{t("colWorking")}</div>}
        {suggestion && (
          <button type="button" class="cf-col-option suggested" onClick={() => void add(suggestion, "suggested")}>
            <span class="cf-col-option-name" dir="auto">{label(suggestion)}</span>
            <span class="cf-col-option-why">{suggestion.by === "ai" ? t("colSuggestAi") : t("colSuggestWords")}</span>
          </button>
        )}
        {shown.map((rec) => (
          <div key={rec.id} class="cf-col-pick">
            <button type="button" class="cf-col-option" aria-expanded={open === rec.id} onClick={() => setOpen(open === rec.id ? null : rec.id)}>
              <span class="cf-col-option-name" dir="auto">{rec.n}</span>
              <span class="cf-col-option-count">{countedCards(rec)}</span>
            </button>
            {open === rec.id && (
              <div class="cf-col-sections">
                {liveSections(rec).map((s) => (
                  <button key={s.id} type="button" class="cf-col-chip" dir="auto" onClick={() => void add({ collection: rec.id, section: s.id, by: "words" }, "picked")}>{s.n}</button>
                ))}
                <button type="button" class="cf-col-chip add" onClick={() => { setName(""); setNaming({ kind: "section", collection: rec.id }) }}>{t("colNewSection")}</button>
              </div>
            )}
            {naming?.kind === "section" && naming.collection === rec.id && (
              <form class="cf-col-name" onSubmit={(e) => { e.preventDefault(); submitName() }}>
                <input value={name} maxLength={40} placeholder={t("colSectionPlaceholder")} onInput={(e) => setName((e.target as HTMLInputElement).value)} ref={(el) => el?.focus()} />
                <button type="submit" disabled={!name.trim()}>{t("colCreate")}</button>
              </form>
            )}
          </div>
        ))}
        {naming?.kind === "collection" ? (
          <form class="cf-col-name" onSubmit={(e) => { e.preventDefault(); submitName() }}>
            <input value={name} maxLength={60} placeholder={t("colNamePlaceholder")} onInput={(e) => setName((e.target as HTMLInputElement).value)} ref={(el) => el?.focus()} />
            <button type="submit" disabled={!name.trim()}>{t("colCreate")}</button>
          </form>
        ) : (
          <button type="button" class="cf-col-option new" onClick={() => {
            if (!canAddCollection(all, pro)) {
              setLimit("collection")
              report("limit", { via: "panel", what: "collection", cards: 0 })
              return
            }
            setName(suggestion?.newCollection ?? "")
            setNaming({ kind: "collection" })
          }}>{t("colNewCollection")}</button>
        )}
        {limit && (
          <div class="cf-col-limit">
            <span>{limit === "collection" ? t("colLimitCollections") : t("colLimitCards", FREE_CARDS, MAX_CARDS)}</span>
            <button type="button" class="cf-col-pro" onClick={() => onPro(limit)}>Pro</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ the window

/** One card in the window: its gist, where it's from and when; a tap opens its chat (or picks it to compare). */
function CardRow({ card, rec, pageUrl, picking, picked, onTap, onMenu, menu, onMove, onRemove, onOpenPage }: {
  card: Card
  rec: Collection
  pageUrl: string
  picking: boolean
  picked: boolean
  onTap: () => void
  onMenu: () => void
  menu: boolean
  onMove: (sid: string) => void
  onRemove: () => void
  onOpenPage: (() => void) | null
}): VNode {
  const from = card.k === "compare"
    ? `${t("colComparison")} · ${cardsLabel(card.of?.length ?? 0)}`
    : card.src ? (card.src.url === pageUrl ? t("colThisPage") : hostOf(card.src.url)) : t("colNote")
  return (
    <div class={`cf-col-card ${picked ? "picked" : ""} ${card.k === "compare" ? "table" : ""}`}>
      <button type="button" class="cf-col-card-main" aria-pressed={picking ? picked : undefined} onClick={onTap}>
        <span class="cf-col-card-gist" dir="auto">{card.t}</span>
        <span class="cf-col-card-from">{from} · {when(card.at || card.u)}</span>
        {card.k === "compare" && card.tbl && (
          <table class="cf-col-table">
            <thead><tr>{card.tbl.h.map((h, i) => <th key={i} dir="auto">{h}</th>)}</tr></thead>
            <tbody>{card.tbl.r.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} dir="auto">{v}</td>)}</tr>)}</tbody>
          </table>
        )}
      </button>
      {!picking && (
        <button type="button" class="cf-icon cf-col-card-more" aria-haspopup="menu" aria-expanded={menu} aria-label={t("colCardMenu")} onClick={onMenu}><Icon.Dots /></button>
      )}
      {menu && (
        <div class="cf-col-menu" role="menu">
          {card.chat && <button type="button" role="menuitem" onClick={onTap}>{t("colOpenChat")}</button>}
          {onOpenPage && <button type="button" role="menuitem" onClick={onOpenPage}>{hostOf(card.src!.url)} ↗</button>}
          {liveSections(rec).filter((s) => s.id !== card.sec).map((s) => (
            <button key={s.id} type="button" role="menuitem" dir="auto" onClick={() => onMove(s.id)}>{t("colMoveTo", s.n)}</button>
          ))}
          <button type="button" role="menuitem" class="danger" onClick={onRemove}>{t("colRemove")}</button>
        </div>
      )}
    </div>
  )
}

export function CollectionsWindow({ all, shown, space, pro, lang, pageUrl, ask, askConsent, onPro, onOpenCard, onOpenPage, onPdf, onBack, report }: {
  all: Collection[]
  shown: Collection[]
  space: string
  pro: boolean
  lang: string
  // The page open now («эта страница» on its cards).
  pageUrl: string
  ask: CollectAsk
  // The AI consent, asked when it isn't given (false: not now).
  askConsent: () => Promise<boolean>
  onPro: CollectPro
  onOpenCard: (card: Card) => void
  onOpenPage: (url: string) => void
  onPdf: (id: string) => void
  onBack: () => void
  report: CollectReport
}): VNode {
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [picking, setPicking] = useState<string[] | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [working, setWorking] = useState<"compare" | "summary" | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState("")
  const rec = shown.find((c) => c.id === currentId) ?? shown[0] ?? null

  useEffect(() => { report("open", { via: "header", what: "collection", cards: rec ? countedCards(rec) : 0 }) }, [])
  useEffect(() => { setPicking(null); setMenu(null); setNote(null) }, [rec?.id])

  const failed = (code: string) => setNote(code === "LIMIT_REACHED" ? t("colLimitDay") : t("colFailed"))

  /** A Pro step with the AI: Pro first, then the consent; `run` gets the answer. */
  const withAi = async (what: "compare" | "summary", op: CollectOp, body: Record<string, unknown>, run: (out: Record<string, unknown>) => void) => {
    if (!pro) return onPro(what)
    if (!(await askConsent())) return
    setWorking(what)
    setNote(null)
    const reply = await ask(op, body).catch(() => ({ ok: false as const, code: "NETWORK" as const }))
    setWorking(null)
    if (!reply.ok) return reply.code === "PRO_ONLY" ? onPro(what) : failed(reply.code)
    run(reply.body)
  }

  const summary = () => {
    if (!rec) return
    const body = { sections: liveSections(rec).map((s) => ({ name: s.n, cards: cardsIn(rec, s.id).map((c) => c.t) })).filter((s) => s.cards.length), lang }
    void withAi("summary", "summary", body, (out) => {
      const text = typeof out.text === "string" ? out.text.trim() : ""
      if (!text) return failed("UPSTREAM")
      void saveCollection(rec.id, (cur) => (cur ? setSummary(cur, text) : null))
      report("summary", { via: "panel", cards: countedCards(rec) })
    })
  }

  const compare = () => {
    if (!rec || !picking || picking.length < 2) return
    const cards = picking.map((id) => rec.c.find((c) => c.id === id)!).filter(Boolean)
    const body = { cards: cards.map((c) => ({ id: c.id, gist: c.t, text: c.x ?? "", site: c.src ? hostOf(c.src.url) : "" })), lang }
    void withAi("compare", "compare", body, (out) => {
      const h = Array.isArray(out.h) ? out.h.filter((x): x is string => typeof x === "string") : []
      const r = Array.isArray(out.r) ? out.r.filter(Array.isArray).map((row) => (row as unknown[]).map((x) => (typeof x === "string" ? x : ""))) : []
      if (h.length < 2 || r.length < 2) return failed("UPSTREAM")
      const table = { h, r, ...(typeof out.note === "string" && out.note.trim() ? { note: out.note.trim() } : {}) }
      void saveCollection(rec.id, (cur) => (cur ? addComparison(cur, newItemId(), picking, table) : null))
      report("compare", { via: "panel", cards: cards.length })
      setPicking(null)
    })
  }

  const createCollection = async () => {
    const title = name.trim()
    if (!title) return
    if (!canAddCollection(all, pro)) {
      report("limit", { via: "panel", what: "collection", cards: 0 })
      return onPro("collection")
    }
    const cid = newCollectionId()
    const saved = await saveCollection(cid, () => newCollection(cid, title, space, Date.now(), { id: newItemId(), name: t("colFirstSection") }))
    if (!saved) return
    report("create", { via: "panel", what: "collection" })
    setCurrentId(cid)
    setNaming(false)
    setPicker(false)
  }

  const tapCard = (card: Card) => {
    setMenu(null)
    if (picking) {
      if (card.k === "compare") return
      setPicking(picking.includes(card.id) ? picking.filter((x) => x !== card.id) : picking.length < 8 ? [...picking, card.id] : picking)
      return
    }
    if (card.chat) {
      report("open", { via: "panel", what: "card" })
      onOpenCard(card)
    } else if (card.src) onOpenPage(card.src.url)
  }

  const sections = rec ? liveSections(rec) : []
  const total = rec ? countedCards(rec) : 0

  return (
    <div class="cf-col-window">
      <div class="cf-col-scroll">
        {rec ? (
          <>
            <div class="cf-col-head">
              <button type="button" class="cf-col-current" aria-haspopup="listbox" aria-expanded={picker} aria-label={t("colPick", rec.n)} onClick={() => setPicker(!picker)}>
                <span class="cf-col-current-name" dir="auto">{rec.n}</span>
                <span class="cf-col-current-count">{cardsLabel(total)}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
              {picker && (
                <div class="cf-col-list" role="listbox">
                  {shown.map((c) => (
                    <button key={c.id} type="button" role="option" aria-selected={c.id === rec.id} onClick={() => { setCurrentId(c.id); setPicker(false) }}>
                      <span dir="auto">{c.n}</span><span class="cf-col-option-count">{countedCards(c)}</span>
                    </button>
                  ))}
                  {naming ? (
                    <form class="cf-col-name" onSubmit={(e) => { e.preventDefault(); void createCollection() }}>
                      <input value={name} maxLength={60} placeholder={t("colNamePlaceholder")} onInput={(e) => setName((e.target as HTMLInputElement).value)} ref={(el) => el?.focus()} />
                      <button type="submit" disabled={!name.trim()}>{t("colCreate")}</button>
                    </form>
                  ) : (
                    <button type="button" class="new" onClick={() => {
                      if (!canAddCollection(all, pro)) {
                        report("limit", { via: "panel", what: "collection", cards: 0 })
                        return onPro("collection")
                      }
                      setName("")
                      setNaming(true)
                    }}>{t("colNewCollection")}</button>
                  )}
                </div>
              )}
            </div>
            <div class="cf-col-actions">
              <button type="button" onClick={summary} disabled={working !== null || total === 0}>{t("colSummary")}{!pro && <span class="cf-col-badge">Pro</span>}</button>
              <button type="button" onClick={() => { report("pdf", { via: "panel", cards: total }); onPdf(rec.id) }} disabled={total === 0}>{t("colPdf")}</button>
            </div>
            {working && <div class="cf-col-status" role="status">{t("colWorking")}</div>}
            {note && <div class="cf-col-status warn" role="status">{note}</div>}
            {picking && <div class="cf-col-status">{t("colComparePick")}</div>}
            {rec.sum?.t && <p class="cf-col-summary" dir="auto">{rec.sum.t}</p>}
            {total === 0 && <p class="cf-col-empty">{t("colEmptyCards")}</p>}
            {sections.map((s) => {
              const cards = cardsIn(rec, s.id)
              if (!cards.length) return null
              return (
                <section key={s.id} class="cf-col-section">
                  <h3><span dir="auto">{s.n}</span><span class="cf-col-section-count">{cards.filter((c) => c.k !== "compare").length}</span></h3>
                  {cards.map((c) => (
                    <CardRow
                      key={c.id}
                      card={c}
                      rec={rec}
                      pageUrl={pageUrl}
                      picking={picking !== null}
                      picked={picking?.includes(c.id) ?? false}
                      onTap={() => tapCard(c)}
                      menu={menu === c.id}
                      onMenu={() => setMenu(menu === c.id ? null : c.id)}
                      onMove={(sid) => {
                        setMenu(null)
                        void saveCollection(rec.id, (cur) => (cur ? moveCard(cur, c.id, sid, Number.MAX_SAFE_INTEGER) : null))
                        report("move", { via: "panel" })
                      }}
                      onRemove={() => {
                        setMenu(null)
                        void saveCollection(rec.id, (cur) => (cur ? deleteCard(cur, c.id) : null))
                        report("delete", { via: "panel", what: "card" })
                      }}
                      onOpenPage={c.src ? () => { setMenu(null); onOpenPage(c.src!.url) } : null}
                    />
                  ))}
                </section>
              )
            })}
          </>
        ) : (
          <p class="cf-col-empty first">{t("colEmpty")}</p>
        )}
      </div>
      <div class="cf-col-foot">
        {picking ? (
          <>
            <button type="button" class="cf-col-btn" onClick={() => setPicking(null)}>{t("cancel")}</button>
            <button type="button" class="cf-col-btn primary" disabled={picking.length < 2 || working !== null} onClick={compare}>{t("colCompareN", picking.length)}</button>
          </>
        ) : (
          <>
            {rec && total >= 2 && (
              <button type="button" class="cf-col-btn" onClick={() => (pro ? setPicking([]) : onPro("compare"))}>
                {t("colCompare")}{!pro && <span class="cf-col-badge">Pro</span>}
              </button>
            )}
            <button type="button" class="cf-col-btn primary" onClick={onBack}>{t("colToChat")}</button>
          </>
        )}
      </div>
    </div>
  )
}
