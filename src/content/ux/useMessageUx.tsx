// 2.5 in the panel's chat, kept out of App.tsx: highlights in answers, swiping a message to delete or
// pin it, pinned messages at the top, reminders. "Deleted · Undo" uses the chat's undo bar (UndoBar.tsx).

import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import { citedNote, entryKey, type Entry } from "../../shared/conversation"
import { t } from "../../shared/i18n"
import { addMark, removeMark } from "../../shared/marks"
import { reminderNotice, remindWords, withRemindWords } from "../../shared/reminders"
import { itemNotes } from "../../shared/appleItems"
import { STORAGE } from "../../shared/types"
import { AddCard, type CardState, type Draft } from "./AddCard"
import { addToApple, appleNow, chatLink, handoffInTap, loadApple, mirrorReminder, readItems, appleAction, type AppleStatus } from "./apple"
import { copyRich, panelRange, richHtml, selectionIn } from "./marks"
import { Bell, CalendarIcon, FloatAt, Marker, MessageMenu, More, PinIcon, RemindChip, RemindSheet, TrashIcon } from "./MessageUx"
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
  // The chat's undo bar ("Answer deleted · Undo"), shown until the next action.
  showUndo: (text: string, undo: () => void) => void
}

/** The messages a swipe or Delete removes: a note alone; an answer with its question. */
function deletedRange(messages: Entry[], idx: number): [number, number] {
  const m = messages[idx]
  if (m.role === "assistant" && idx > 0 && messages[idx - 1].role === "user" && !messages[idx - 1].note) return [idx - 1, idx]
  return [idx, idx]
}

/** This device, for a reminder's `dev`: the notification rings only where it was set. */
let deviceId: string | null = null
export async function thisDevice(): Promise<string | undefined> {
  if (deviceId) return deviceId
  try {
    const got = await chrome.storage.local.get(STORAGE.installId)
    deviceId = typeof got[STORAGE.installId] === "string" ? (got[STORAGE.installId] as string).slice(0, 12) : null
  } catch {
    deviceId = null
  }
  return deviceId ?? undefined
}

/** What a reminder is on, for ux_remind: a page (the bell by a selection), a note or an answer. */
function remindWhat(m: Entry): "page" | "note" | "answer" {
  return m.remind?.page ? "page" : m.note ? "note" : "answer"
}

/**
 * Asks the extension to set (or, with `at` null, cancel) a message's reminder on this device. The system
 * may first ask about notifications: the answer waits for that.
 * `apple` (2.7, «Также в Напоминания»): the Remind window's choice; left out, the reminder stays where it was (in Apple
 * Reminders when it was put there: moved, taken back, put back after an undo). A reminder that's in Apple Reminders
 * counts as set even when notifications are off here.
 */
export async function scheduleReminder(send: Options["send"], chat: string, entry: Entry, at: number | null, chatTitle: string, apple?: boolean): Promise<string> {
  const notice = reminderNotice(entry, chatTitle, (text) => t("uxRemindAsked", text))
  const reply = await send<{ outcome: string }>({ type: "remind", chat, message: entryKey(entry), at, title: notice.title, body: notice.body, url: notice.url, ask: true })
  let outcome = reply?.outcome ?? "unavailable"
  const was = entry.remind?.apple === true
  if (at === null || !(apple ?? was)) {
    if (was) await mirrorReminder(send, chat, entry, null)
    return outcome
  }
  const mirrored = await mirrorReminder(send, chat, entry, at)
  if (outcome !== "scheduled" && (mirrored === "saved" || mirrored === "app")) outcome = "scheduled"
  return outcome
}

export function useMessageUx({ messages, setMessages, chatId, chatTitle, list, touch, open, send, showUndo }: Options) {
  const [pick, setPick] = useState<{ idx: number; s: number; e: number; text: string; rect: DOMRect } | null>(null)
  const [hit, setHit] = useState<{ idx: number; i: number; rect: DOMRect } | null>(null)
  // The menu of a message: under its "…" or, on a right-click, where the pointer is.
  const [menu, setMenu] = useState<{ idx: number; x?: number; y?: number } | null>(null)
  const [reminding, setReminding] = useState<{ idx: number; note: string | null } | null>(null)
  // 2.7: the cards suggesting a reminder or an event, by message key; what this device can add.
  const [cards, setCards] = useState<Record<string, CardState>>({})
  const [apple, setApple] = useState<AppleStatus | null>(appleNow())
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
    void send({ type: "uxEvent", kind: "ux_mark", action: "added" })
  }, [pick, update, send])

  // A tap on a highlight: "Remove highlight". A tap anywhere else closes the menu.
  const onListClick = useCallback((e: MouseEvent) => {
    const target = e.target as Element
    if (!target.closest?.(".cf-msg-menu, .cf-msg-more")) setMenu(null)
    const mark = target.closest?.("mark.cf-mark") as HTMLElement | null
    const msg = mark?.closest<HTMLElement>(".cf-msg.ai")
    const sel = document.getSelection()
    if (!mark || !msg || (sel && !sel.isCollapsed)) {
      setHit(null)
      return
    }
    setHit({ idx: Number(msg.dataset.index), i: Number(mark.dataset.mark), rect: mark.getBoundingClientRect() })
  }, [])

  // ---------------------------------------------------------- delete, pin, remind
  const remove = useCallback((idx: number, how: "swipe" | "menu" | "hover") => {
    const all = messagesRef.current
    const [from, to] = deletedRange(all, idx)
    const gone = all.slice(from, to + 1)
    for (const m of gone) if (m.remind) void scheduleReminder(send, chatId(), m, null, "")
    setMessages((list) => [...list.slice(0, from), ...list.slice(to + 1)])
    setMenu(null)
    const what = gone.some((m) => m.note) ? "note" : "answer"
    void send({ type: "uxEvent", kind: "ux_delete", action: "deleted", what, how })
    showUndo(t(gone.some((m) => m.note) ? "uxDeletedNote" : "uxDeletedAnswer"), () => {
      // Back where they were (by key: other messages may have come in meanwhile).
      setMessages((list) => {
        const keys = new Set(list.map(entryKey))
        const back = gone.filter((m) => !keys.has(entryKey(m)))
        return [...list.slice(0, from), ...back, ...list.slice(from)]
      })
      for (const m of gone) if (m.remind && m.remind.at > Date.now()) void scheduleReminder(send, chatId(), m, m.remind.at, chatTitle())
      void send({ type: "uxEvent", kind: "ux_delete", action: "undone", what })
    })
  }, [chatId, chatTitle, send, setMessages, showUndo])

  const togglePin = useCallback((idx: number, how: "swipe" | "menu" | "hover" | "list", on?: boolean) => {
    const m = messagesRef.current[idx]
    const pin = on ?? !m?.pinned
    update(idx, (x) => {
      const next = { ...x }
      if (pin) next.pinned = Date.now()
      else delete next.pinned
      return next
    })
    setMenu(null)
    void send({ type: "uxEvent", kind: "ux_pin", action: pin ? "pinned" : "unpinned", what: m?.note ? "note" : "answer", how })
  }, [update, send])

  const unpinAll = useCallback(() => {
    setMessages((all) => all.map((m) => {
      if (!m.pinned) return m
      const next = { ...m }
      delete next.pinned
      return next
    }))
    void send({ type: "uxEvent", kind: "ux_pin", action: "unpinned_all", how: "list" })
  }, [setMessages, send])

  const setReminder = useCallback(async (idx: number, at: number | null, preset?: string, words?: string, apple?: boolean) => {
    const found = messagesRef.current[idx]
    if (!found) return
    // A reminder made with Remind on a selection or a page: its new words go with its new time (2.6 (97)).
    const m = at === null ? found : withRemindWords(found, words)
    const outcome = await scheduleReminder(send, chatId(), m, at, chatTitle(), at === null ? undefined : apple === true)
    if (at !== null && outcome !== "scheduled") {
      if (outcome === "denied") void send({ type: "uxEvent", kind: "ux_remind", action: "denied", what: remindWhat(m) })
      // No notification on this device: say why; the mark isn't kept.
      setReminding({ idx, note: t(outcome === "denied" ? "uxRemindOff" : "uxRemindNone") })
      return
    }
    const dev = await thisDevice()
    update(idx, (x) => {
      const next = at === null ? { ...x } : { ...withRemindWords(x, words) }
      if (at === null) delete next.remind
      else next.remind = { ...(x.remind?.page ? { page: true as const } : {}), at, ...(dev ? { dev } : {}), ...(apple ? { apple: true as const } : {}) }
      return next
    })
    setReminding(null)
    void send({ type: "uxEvent", kind: "ux_remind", action: at === null ? "cancelled" : "set", what: remindWhat(m), ...(preset ? { preset } : {}) })
  }, [chatId, chatTitle, send, update])

  // ---------------------------------------------------------- Calendar and Reminders (2.7)
  useEffect(() => {
    if (open) void loadApple(send).then(setApple)
  }, [open, send])

  /** The card for message `idx`: the server reads what to add out of it (and the question it answers). */
  const openCard = useCallback(async (idx: number, via: "chat" | "menu" | "chip") => {
    const all = messagesRef.current
    const m = all[idx]
    if (!m) return
    const key = entryKey(m)
    const asked = idx > 0 && all[idx - 1].role === "user" && !all[idx - 1].note ? all[idx - 1] : null
    setCards((c) => ({ ...c, [key]: { step: "reading" } }))
    void send({ type: "useEvent", f: "apple", a: "open", via })
    const [status, read] = await Promise.all([
      loadApple(send),
      readItems(send, { text: m.content, words: asked ? asked.label ?? asked.content : undefined, title: (asked ?? m).page?.title })
    ])
    setApple(status)
    const next: CardState = "error" in read ? { step: "error", code: read.error } : read.items.length ? { step: "ready", items: read.items } : { step: "none" }
    setCards((c) => (c[key] ? { ...c, [key]: next } : c))
    if (!("error" in read)) void send({ type: "useEvent", f: "apple", a: read.items.length ? "shown" : "nothing", via })
  }, [send])

  // An answer that came with the chat's marker while the panel watched (or a moment ago): its card opens by itself.
  const offered = useRef(new Set<string>())
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!open || !apple?.available || !last || last.role !== "assistant" || !last.addable) return
    const key = entryKey(last)
    if (offered.current.has(key) || cards[key] || Date.now() - (last.t ?? 0) > 120_000) return
    offered.current.add(key)
    void openCard(messages.length - 1, "chat")
  }, [messages, open, apple, cards, openCard])

  const closeCard = (idx: number) => {
    const m = messagesRef.current[idx]
    if (!m) return
    const key = entryKey(m)
    setCards(({ [key]: _, ...rest }) => rest)
    // Not offered again under this answer (the "…" menu still has it).
    if (m.addable) update(idx, ({ addable: _, ...rest }) => rest)
  }

  const changeDraft = (key: string, i: number, draft: Draft) => {
    setCards((c) => {
      const card = c[key]
      if (card?.step !== "ready") return c
      return { ...c, [key]: { step: "ready", items: card.items.map((d, j) => (j === i ? draft : d)) } }
    })
  }

  /** Add tapped: written here, or the app opens in this tap to ask for access (iPhone, iPad; a Mac opens it itself). */
  const addDraft = (idx: number, i: number) => {
    const m = messagesRef.current[idx]
    const card = m && cards[entryKey(m)]
    if (!m || card?.step !== "ready") return
    const key = entryKey(m)
    const draft = card.items[i]
    const handoff = handoffInTap(draft.kind)
    changeDraft(key, i, { ...draft, state: "adding" })
    const all = messagesRef.current
    const asked = idx > 0 && all[idx - 1].role === "user" ? all[idx - 1] : m
    const url = asked.page && /^https?:\/\//.test(asked.page.url) ? asked.page.url : undefined
    const notes = itemNotes(draft.notes, { url, chat: chatLink(chatId(), m) }, asked.page?.title)
    const { list: chosen, state: _, ...item } = draft
    const list = chosen ?? apple?.defaultList
    void addToApple(send, item, notes, { url, ...(list && draft.kind === "reminder" ? { list } : {}), ...(handoff ? { handoff } : {}) }).then((outcome) => {
      changeDraft(key, i, { ...draft, state: outcome })
      void send({ type: "useEvent", f: "apple", a: appleAction(outcome), what: draft.kind, via: "card" })
    })
  }

  /** Under an answer or a note: its card, or for an answer with the chat's marker, the way to open one. */
  const addCard = (m: Entry, idx: number): VNode | null => {
    const card = cards[entryKey(m)]
    if (card) {
      return (
        <AddCard
          card={card}
          status={apple}
          onChange={(i, draft) => changeDraft(entryKey(m), i, draft)}
          onAdd={(i) => addDraft(idx, i)}
          onRetry={() => void openCard(idx, "menu")}
          onClose={() => closeCard(idx)}
        />
      )
    }
    if (!m.addable || !apple?.available) return null
    return (
      <button type="button" class="cf-chip cf-add-offer" onClick={() => void openCard(idx, "chip")}>
        <CalendarIcon size={14} /> {t("appleMenu")}
      </button>
    )
  }

  // ---------------------------------------------------------- copy with the highlights
  const copyAnswer = useCallback(async (idx: number, plain: string): Promise<boolean> => {
    const box = list.current?.querySelector(`.cf-msg.ai[data-index="${idx}"] .md`)
    if (!box || !messagesRef.current[idx]?.marks?.length) return false
    const ok = await copyRich(richHtml(box), plain)
    if (ok) void send({ type: "uxEvent", kind: "ux_mark", action: "copied" })
    return ok
  }, [list, send])

  // ---------------------------------------------------------- what App renders
  const pinnedItems = messages.map((entry, index) => ({ index, entry })).filter((x) => x.entry.pinned && (x.entry.role === "assistant" || x.entry.note))
  const strip = (
    <PinnedBar
      items={pinnedItems}
      list={list}
      onOpen={(index) => {
        void send({ type: "uxEvent", kind: "ux_pin", action: "bar_tap", how: "bar" })
        const el = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
        el?.scrollIntoView({ block: "center", behavior: "smooth" })
        if (el) {
          el.classList.remove("pin-flash")
          void el.offsetWidth
          el.classList.add("pin-flash")
          setTimeout(() => el.classList.remove("pin-flash"), 1200)
        }
      }}
      onUnpin={(index) => togglePin(index, "list", false)}
      onUnpinAll={unpinAll}
    />
  )

  /** An answer or a note, with its swipes (touch only) and reminder. */
  const wrap = (m: Entry, idx: number, body: VNode, enabled = true): VNode => (
    <Swipe
      enabled={touch && enabled}
      left={{ label: t("uxDelete"), icon: <TrashIcon />, tone: "delete", run: () => remove(idx, "swipe") }}
      right={{ label: t(m.pinned ? "uxUnpin" : "uxPin"), icon: <PinIcon filled={Boolean(m.pinned)} />, tone: "pin", run: () => togglePin(idx, "swipe") }}
    >
      {body}
      {m.remind && <RemindChip at={m.remind.at} onClick={() => setReminding({ idx, note: null })} />}
    </Swipe>
  )

  /** In the tools row: on a Mac, pin, remind and delete on hover; then "…" with the same in a menu. */
  const moreButton = (m: Entry, idx: number): VNode => (
    <>
      {!touch && (
        <span class="cf-hover-tools">
          <button type="button" title={t(m.pinned ? "uxUnpin" : "uxPin")} aria-label={t(m.pinned ? "uxUnpin" : "uxPin")} onClick={() => togglePin(idx, "hover")}><PinIcon size={14} filled={Boolean(m.pinned)} /></button>
          <button type="button" title={t("uxRemind")} aria-label={t("uxRemind")} onClick={() => setReminding({ idx, note: null })}><Bell size={14} /></button>
          <button type="button" class="danger" title={t("uxDelete")} aria-label={t("uxDelete")} onClick={() => remove(idx, "hover")}><TrashIcon size={14} /></button>
        </span>
      )}
      <button type="button" class="cf-msg-more" aria-label={t(m.note ? "uxMoreNote" : "uxMoreAnswer")} title={t(m.note ? "uxMoreNote" : "uxMoreAnswer")} aria-expanded={menu?.idx === idx && menu.x === undefined} onClick={() => setMenu(menu?.idx === idx ? null : { idx })}>
        <More />
      </button>
      {menu?.idx === idx && menu.x === undefined && menuFor(m, idx)}
    </>
  )

  const menuFor = (m: Entry, idx: number, at?: { x: number; y: number }): VNode => (
    <MessageMenu
      at={at}
      pinned={Boolean(m.pinned)}
      reminded={Boolean(m.remind)}
      onPin={() => togglePin(idx, "menu")}
      onRemind={() => {
        setMenu(null)
        setReminding({ idx, note: null })
      }}
      onAdd={apple?.available ? () => {
        setMenu(null)
        void openCard(idx, "menu")
      } : undefined}
      onDelete={() => remove(idx, "menu")}
      onClose={() => setMenu(null)}
    />
  )

  /** Right-click on a message (Mac): the same menu, where the pointer is. */
  const contextMenu = (idx: number) => (e: MouseEvent) => {
    if (touch) return
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed) return
    e.preventDefault()
    setMenu({ idx, x: e.clientX, y: e.clientY })
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
              void send({ type: "uxEvent", kind: "ux_mark", action: "removed" })
            }}
          >
            <Marker /> {t("uxUnmark")}
          </button>
        </FloatAt>
      )}
      {menu && menu.x !== undefined && messages[menu.idx] && menuFor(messages[menu.idx], menu.idx, { x: menu.x, y: menu.y ?? 0 })}
      {reminding && messages[reminding.idx] && (
        <RemindSheet
          current={messages[reminding.idx].remind?.at}
          note={reminding.note}
          quote={citedNote(messages[reminding.idx])?.cite}
          words={remindWords(messages[reminding.idx])}
          onPick={(at, preset, words, apple) => void setReminder(reminding.idx, at, preset, words, apple)}
          onCancel={() => void setReminder(reminding.idx, null)}
          onClose={() => setReminding(null)}
        />
      )}
    </>
  )

  return { wrap, strip, overlay, moreButton, contextMenu, onListClick, copyAnswer, addCard }
}
