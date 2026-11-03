// 2.5 in the panel's chat, kept out of App.tsx: highlights in answers, swiping a message to delete or
// pin it, pinned messages at the top, reminders, and "Deleted · Undo".

import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import type { Entry } from "../../shared/conversation"
import { t } from "../../shared/i18n"
import { addMark, removeMark } from "../../shared/marks"
import { copyRich, panelRange, richHtml, selectionIn } from "./marks"
import { Bell, FloatAt, Marker, MessageMenu, More, PinIcon, RemindChip, RemindSheet, TrashIcon, UndoBar } from "./MessageUx"
import { PinnedBar } from "./PinnedBar"
import { Swipe } from "./Swipe"

type Setter = (update: (list: Entry[]) => Entry[]) => void

interface Options {
  messages: Entry[]
  setMessages: Setter
  chatId: () => string
  chatTitle: () => string
  list: { current: HTMLElement | null }
  touch: boolean
  open: boolean
  send: <T>(message: unknown) => Promise<T | null>
}

/** A message's key for its reminder until every message has an id (chat-organize's entryKey replaces this). */
function messageKey(m: Entry & { id?: string }): string {
  if (m.id) return m.id
  let h = 0x811c9dc5
  const s = `${m.role}\u0000${m.content}\u0000${m.page?.url ?? ""}\u0000${m.page?.at ?? ""}`
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `h${(h >>> 0).toString(16)}`
}

/** The messages a swipe or Delete removes: a note alone; an answer with its question. */
function deletedRange(messages: Entry[], idx: number): [number, number] {
  const m = messages[idx]
  if (m.role === "assistant" && idx > 0 && messages[idx - 1].role === "user" && !messages[idx - 1].note) return [idx - 1, idx]
  return [idx, idx]
}

export function useMessageUx({ messages, setMessages, chatId, chatTitle, list, touch, open, send }: Options) {
  const [pick, setPick] = useState<{ idx: number; s: number; e: number; text: string; rect: DOMRect } | null>(null)
  const [hit, setHit] = useState<{ idx: number; i: number; rect: DOMRect } | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  const [reminding, setReminding] = useState<{ idx: number; note: string | null } | null>(null)
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const update = useCallback((idx: number, change: (m: Entry) => Entry) => {
    setMessages((all) => all.map((m, i) => (i === idx ? change(m) : m)))
  }, [setMessages])

  // ---------------------------------------------------------- highlights: a selection in an answer
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const box = list.current
        const root = box?.getRootNode()
        if (!box || !(root instanceof ShadowRoot)) return
        const range = panelRange(root)
        const start = range && (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
        const md = start?.closest(".cf-msg.ai .md")
        const msg = md?.closest<HTMLElement>(".cf-msg.ai")
        const idx = msg ? Number(msg.dataset.index) : NaN
        const at = range && md && Number.isInteger(idx) ? selectionIn(md, range) : null
        if (!range || !at) {
          setPick(null)
          return
        }
        setHit(null)
        setPick({ idx, s: at.s, e: at.e, text: at.text, rect: range.getBoundingClientRect() })
      }, touch ? 350 : 200)
    }
    document.addEventListener("selectionchange", onChange)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("selectionchange", onChange)
    }
  }, [open, touch, list])

  const markPicked = useCallback(() => {
    if (!pick) return
    const { idx, s, e, text } = pick
    update(idx, (m) => ({ ...m, marks: addMark(m.marks, s, e, text) }))
    setPick(null)
    document.getSelection()?.removeAllRanges()
  }, [pick, update])

  // A tap on a highlight: "Remove highlight".
  const onListClick = useCallback((e: MouseEvent) => {
    const mark = (e.target as Element).closest?.("mark.cf-mark") as HTMLElement | null
    const msg = mark?.closest<HTMLElement>(".cf-msg.ai")
    const sel = document.getSelection()
    if (!mark || !msg || (sel && !sel.isCollapsed)) {
      setHit(null)
      return
    }
    setHit({ idx: Number(msg.dataset.index), i: Number(mark.dataset.mark), rect: mark.getBoundingClientRect() })
  }, [])

  // ---------------------------------------------------------- delete, pin, remind
  const remove = useCallback((idx: number) => {
    const all = messagesRef.current
    const [from, to] = deletedRange(all, idx)
    const gone = all.slice(from, to + 1)
    for (const m of gone) if (m.remind) void send({ type: "remind", chat: chatId(), message: messageKey(m), at: null })
    setMessages((list) => [...list.slice(0, from), ...list.slice(to + 1)])
    setMenu(null)
    setUndo({
      text: t(gone.some((m) => m.note) ? "uxDeletedNote" : "uxDeletedAnswer"),
      run: () => setMessages((list) => [...list.slice(0, from), ...gone, ...list.slice(from)])
    })
  }, [chatId, send, setMessages])

  const togglePin = useCallback((idx: number) => {
    update(idx, (m) => {
      const next = { ...m }
      if (m.pinned) delete next.pinned
      else next.pinned = Date.now()
      return next
    })
    setMenu(null)
  }, [update])

  const setReminder = useCallback(async (idx: number, at: number | null) => {
    const m = messagesRef.current[idx]
    if (!m) return
    const title = chatTitle() || "ContextFlow"
    const body = m.content.replace(/[#*_`>|[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160)
    // Stage A check: whether the extension may ask for notifications itself (#cf-ux-test).
    const ask = location.hash.includes("cf-ux-test")
    const reply = await send<{ outcome: string }>({ type: "remind", chat: chatId(), message: messageKey(m), at, title, body, ask })
    const outcome = reply?.outcome ?? "unavailable"
    if (at !== null && outcome !== "scheduled") {
      // No notification on this device: say why; the mark isn't kept.
      setReminding({ idx, note: t(outcome === "denied" ? "uxRemindOff" : outcome === "not-asked" ? "uxRemindAsk" : "uxRemindNone") })
      return
    }
    update(idx, (x) => {
      const next = { ...x }
      if (at === null) delete next.remind
      else next.remind = { at }
      return next
    })
    setReminding(null)
  }, [chatId, chatTitle, send, update])

  // ---------------------------------------------------------- copy and share with the highlights
  const copyAnswer = useCallback(async (idx: number, plain: string): Promise<boolean> => {
    const box = list.current?.querySelector(`.cf-msg.ai[data-index="${idx}"] .md`)
    if (!box || !messagesRef.current[idx]?.marks?.length) return false
    return copyRich(richHtml(box), plain)
  }, [list])

  // ---------------------------------------------------------- what App renders
  const pinnedItems = messages.map((entry, index) => ({ index, entry })).filter((x) => x.entry.pinned && (x.entry.role === "assistant" || x.entry.note))
  const strip = (
    <PinnedBar
      items={pinnedItems}
      list={list}
      onOpen={(index) => {
        const el = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
        el?.scrollIntoView({ block: "center", behavior: "smooth" })
        el?.classList.add("found")
        setTimeout(() => el?.classList.remove("found"), 1600)
      }}
    />
  )

  /** An answer or a note, with its swipes (touch), hover buttons (Mac) and reminder. */
  const wrap = (m: Entry, idx: number, body: VNode): VNode => {
    const swipe = (
      <Swipe
        enabled={touch}
        left={{ label: t("uxDelete"), icon: <TrashIcon />, tone: "delete", run: () => remove(idx) }}
        right={{ label: t(m.pinned ? "uxUnpin" : "uxPin"), icon: <PinIcon filled={Boolean(m.pinned)} />, tone: "pin", run: () => togglePin(idx) }}
      >
        {!touch && (
          <div class="cf-hover-tools">
            <button type="button" title={t(m.pinned ? "uxUnpin" : "uxPin")} aria-label={t(m.pinned ? "uxUnpin" : "uxPin")} onClick={() => togglePin(idx)}><PinIcon size={14} filled={Boolean(m.pinned)} /></button>
            <button type="button" title={t("uxRemind")} aria-label={t("uxRemind")} onClick={() => setReminding({ idx, note: null })}><Bell size={14} /></button>
            <button type="button" class="danger" title={t("uxDelete")} aria-label={t("uxDelete")} onClick={() => remove(idx)}><TrashIcon size={14} /></button>
          </div>
        )}
        {body}
        {m.remind && <RemindChip at={m.remind.at} onClick={() => setReminding({ idx, note: null })} />}
      </Swipe>
    )
    return swipe
  }

  /** "…" in the tools row: Pin, Remind, Delete. */
  const moreButton = (m: Entry, idx: number): VNode => (
    <>
      <button type="button" aria-label={t("uxMore")} aria-expanded={menu === idx} onClick={() => setMenu(menu === idx ? null : idx)}>
        <More />
      </button>
      {menu === idx && (
        <MessageMenu
          pinned={Boolean(m.pinned)}
          reminded={Boolean(m.remind)}
          onPin={() => togglePin(idx)}
          onRemind={() => {
            setMenu(null)
            setReminding({ idx, note: null })
          }}
          onDelete={() => remove(idx)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )

  /** Right-click on a message (Mac): the same menu. */
  const contextMenu = (idx: number) => (e: MouseEvent) => {
    if (touch) return
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed) return
    e.preventDefault()
    setMenu(idx)
  }

  const overlay = (
    <>
      {pick && (
        <FloatAt rect={pick.rect} touch={touch}>
          <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={markPicked}><Marker /> {t("uxMark")}</button>
        </FloatAt>
      )}
      {hit && !pick && (
        <FloatAt rect={hit.rect} touch={touch}>
          <button
            type="button"
            onClick={() => {
              update(hit.idx, (m) => ({ ...m, marks: removeMark(m.marks, hit.i) }))
              setHit(null)
            }}
          >
            <Marker /> {t("uxUnmark")}
          </button>
        </FloatAt>
      )}
      {reminding && messages[reminding.idx] && (
        <RemindSheet
          current={messages[reminding.idx].remind?.at}
          note={reminding.note}
          onPick={(at) => void setReminder(reminding.idx, at)}
          onCancel={() => void setReminder(reminding.idx, null)}
          onClose={() => setReminding(null)}
        />
      )}
      {undo && (
        <UndoBar
          text={undo.text}
          onUndo={() => {
            undo.run()
            setUndo(null)
          }}
          onDone={() => setUndo(null)}
        />
      )}
    </>
  )

  return { wrap, strip, overlay, moreButton, contextMenu, onListClick, copyAnswer, dismissUndo: () => setUndo(null) }
}
