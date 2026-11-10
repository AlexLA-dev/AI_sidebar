import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import type { FindReply } from "../shared/types"

import { t, uiLanguage } from "../shared/i18n"
import { activity, allTags, groupByTag, hasTag, MAX_TITLE, searchThreads, threadName, threadNotes, threadPages, threadSnippet, threadTags, threadTitle, type SearchHit, type Thread } from "../shared/threads"
import * as Icon from "./icons"
import { TagChip, TagEditor } from "./Tags"
import { PinIcon, TrashIcon } from "./ux/MessageUx"
import { Swipe } from "./ux/Swipe"
import { ThreadMenu, ThreadMoreButton } from "./ux/ThreadMenu"
import { SpeakerIcon } from "./listen/useListen"

interface Props {
  threads: Thread[] // pinned first, then the newest
  activeId: string
  // `at`: the message to show (a search result)
  onOpen: (id: string, at?: number) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onNew: () => void
  onPin: (id: string, pinned: boolean) => void
  onMove: (id: string, index: number) => void // to `index` among the pinned chats
  onOpenPage: (url: string) => void
  // Pro features: "Ask your chats" (the row on top) and AI search (✦ in the search field).
  pro: boolean
  onAskHistory: () => void
  onFind: (query: string) => Promise<FindReply>
  // Without Pro: what the feature would do.
  onUpsell: (feature: "find" | "history") => void
  // The last AI search ran out of answers or failed: shown under the field.
  findError: (code: string) => string
  /** The consent card is up: the search waits for it, nothing is sent yet. */
  findWaiting?: boolean
  // The chat's own tags (answers and notes are tagged in the chat).
  onTags: (id: string, tags: string[]) => void
  // The list in groups by tag, like folders.
  grouped: boolean
  onGrouped: (on: boolean) => void
  // iPhone and iPad (2.5): swipe a chat left to delete it, right to pin it.
  touch?: boolean
  // Recently Deleted (2.5 (83)): how many chats are there (its row ends the list when there are some), and opening it.
  trashCount?: number
  onOpenTrash?: () => void
  // Organizing (2.6, Pro with suggestions on): open suggestions per chat ("N recommendations" on its row).
  recs?: Record<string, number>
  // 2.6 (91): chats with a long answer under way off the panel (a spinner) and with one finished unseen (a dot).
  busy?: ReadonlySet<string>
  unread?: ReadonlySet<string>
  // Build 93: the chat whose text is being read aloud (a speaker on its row), null when nothing plays.
  playing?: string | null
}

/** "3 pages", in the UI language's plural form. */
function pagesLabel(count: number): string {
  const rule = new Intl.PluralRules(uiLanguage()).select(count)
  return t(rule === "one" || rule === "few" || rule === "many" ? `pages_${rule}` : "pages_other", count)
}

/** "1 recommendation", "5 recommendations" (2.6): the open organizing suggestions of a chat, in the plural its language has. */
export function recsLabel(count: number): string {
  const rule = new Intl.PluralRules(uiLanguage()).select(count)
  return t(rule === "one" || rule === "two" || rule === "few" || rule === "many" ? `recs_${rule}` : "recs_other", count)
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** "5 min ago", "yesterday", or a date for older chats. */
function when(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  const rtf = new Intl.RelativeTimeFormat(uiLanguage(), { numeric: "auto" })
  if (minutes < 60) return rtf.format(-Math.max(0, minutes), "minute")
  if (minutes < 24 * 60) return rtf.format(-Math.round(minutes / 60), "hour")
  if (minutes < 7 * 24 * 60) return rtf.format(-Math.round(minutes / (24 * 60)), "day")
  return new Date(at).toLocaleDateString(uiLanguage(), { day: "numeric", month: "short" })
}

/** A search excerpt with the matched words marked. */
function Excerpt({ hit }: { hit: SearchHit }): VNode {
  const parts: VNode[] = []
  let from = 0
  hit.marks.forEach(([start, end], i) => {
    if (start < from) return
    if (start > from) parts.push(<span key={`t${i}`}>{hit.excerpt.slice(from, start)}</span>)
    parts.push(<mark key={`m${i}`}>{hit.excerpt.slice(start, end)}</mark>)
    from = end
  })
  parts.push(<span key="rest">{hit.excerpt.slice(from)}</span>)
  return <span class="cf-search-excerpt">{parts}</span>
}

/**
 * The search field over the list: as you type, the chats with every word, and where they matched.
 * ✦ switches to AI search (Pro): describe the chat, Enter asks.
 */
function SearchField({ value, onChange, ai, pro, onAi, onSubmit }: {
  value: string
  onChange: (value: string) => void
  ai: boolean
  pro: boolean
  onAi: () => void
  onSubmit: () => void
}): VNode {
  return (
    <div class={`cf-search ${ai ? "ai" : ""}`} role="search">
      {ai ? <Icon.Sparkle size={15} /> : <Icon.Search size={15} />}
      <input
        type="search"
        value={value}
        placeholder={t(ai ? "findPlaceholder" : "searchChats")}
        aria-label={t(ai ? "findPlaceholder" : "searchChats")}
        enterkeyhint="search"
        onInput={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          // The page must not see these keys; Escape clears the search, not the panel.
          e.stopPropagation()
          if (e.key === "Escape" && value) {
            e.preventDefault()
            onChange("")
          }
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault()
            onSubmit()
          }
        }}
        onKeyUp={(e) => e.stopPropagation()}
        onKeyPress={(e) => e.stopPropagation()}
      />
      {value && (
        <button type="button" class="cf-search-clear" onClick={() => onChange("")} aria-label={t("searchClear")} title={t("searchClear")}>×</button>
      )}
      <button
        type="button"
        class={`cf-search-ai ${ai ? "on" : ""}`}
        aria-pressed={ai}
        onClick={onAi}
        aria-label={t("findToggle")}
        title={pro ? t("findToggle") : t("findToggleLocked")}
      >
        <Icon.Sparkle size={14} />
        {!pro && <span class="cf-search-lock"><Icon.Lock /></span>}
      </button>
    </div>
  )
}

/** The row on top of the list: questions about all the chats at once (Pro). */
function AskHistoryRow({ pro, onOpen }: { pro: boolean; onOpen: () => void }): VNode {
  return (
    <div class="cf-thread cf-ask-history" role="listitem">
      <div
        class="cf-thread-main"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return
          e.preventDefault()
          onOpen()
        }}
      >
        <span class="cf-thread-title"><Icon.Sparkle size={14} /> {t("askHistory")} {!pro && <span class="cf-pro-badge">Pro</span>}</span>
        <span class="cf-thread-snippet">{t("askHistoryHint")}</span>
      </div>
    </div>
  )
}

/** The row at the end of the list: Recently Deleted and how many chats are there (2.5 (83)). */
function TrashRow({ count, onOpen }: { count: number; onOpen: () => void }): VNode {
  return (
    <div class="cf-thread cf-trash-row" role="listitem">
      <div
        class="cf-thread-main"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return
          e.preventDefault()
          onOpen()
        }}
      >
        <span class="cf-thread-title"><Icon.Trash /> {t("trashRow", count)}</span>
      </div>
    </div>
  )
}

/** The chat's name in place, being edited: Enter (or leaving the field) keeps it, Escape doesn't. */
function NameField({ thread, onDone }: { thread: Thread; onDone: (name: string | null) => void }): VNode {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(threadName(thread))
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <form class="cf-thread-main editing" onSubmit={(e) => { e.preventDefault(); finish(value) }}>
      <input
        ref={ref}
        class="cf-thread-name"
        value={value}
        maxLength={MAX_TITLE}
        placeholder={threadTitle(thread.m)}
        aria-label={t("chatName")}
        enterkeyhint="done"
        onInput={(e) => setValue(e.currentTarget.value)}
        onBlur={() => finish(value)}
        onKeyDown={(e) => {
          // The page must not see these keys; Escape cancels the edit, not the panel.
          e.stopPropagation()
          if (e.key === "Escape") {
            e.preventDefault()
            finish(null)
          }
        }}
        onKeyUp={(e) => e.stopPropagation()}
        onKeyPress={(e) => e.stopPropagation()}
      />
      <span class="cf-thread-meta">{t("chatNameHint")}</span>
    </form>
  )
}

interface Drag {
  id: string
  from: number
  to: number
  dy: number
  startY: number
  rows: Array<{ top: number; height: number }> // the pinned rows when the drag began
}

/**
 * The list of chats (threads): open one to continue it from this page, rename, pin or delete it, or
 * start a new one. Pinned chats come first and are reordered by dragging their handle; a chat that
 * was on several pages lists them (each opens its page).
 */
export function ThreadsView({ threads, activeId, onOpen, onRename, onDelete, onNew, onPin, onMove, onOpenPage, pro, onAskHistory, onFind, onUpsell, findError, findWaiting, onTags, grouped, onGrouped, touch = false, trashCount = 0, onOpenTrash, busy, unread, recs, playing }: Props): VNode {
  const [query, setQuery] = useState("")
  // Only the chats with this tag (in the list and in search results).
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  // The chat whose tags are being picked.
  const [tagging, setTagging] = useState<string | null>(null)
  const tagsInUse = allTags(threads)
  const known = tagsInUse.map((x) => x.tag)
  const filter = tagFilter && tagsInUse.some((x) => x.tag.toLowerCase() === tagFilter.toLowerCase()) ? tagFilter : null
  const shownThreads = filter ? threads.filter((th) => hasTag(th, filter)) : threads
  const [ai, setAi] = useState(false)
  // AI search: the query asked, and its answer (null while it runs).
  const [found, setFound] = useState<{ query: string; reply: FindReply | null } | null>(null)
  const toggleAi = () => {
    if (!pro) {
      onUpsell("find")
      return
    }
    setAi(!ai)
    setFound(null)
  }
  const runFind = () => {
    const q = query.trim()
    if (!ai || !q || found?.reply === null) return
    setFound({ query: q, reply: null })
    void onFind(q).then((reply) => setFound((now) => (now?.query === q ? { query: q, reply } : now)))
  }
  const search = (
    <SearchField
      value={query}
      onChange={(v) => {
        setQuery(v)
        if (!v) setFound(null)
      }}
      ai={ai}
      pro={pro}
      onAi={toggleAi}
      onSubmit={runFind}
    />
  )
  // The tags in use, to show only the chats with one; and the switch to group the list by tag.
  const tagBar = tagsInUse.length > 0 && (
    <div class="cf-tag-bar" role="toolbar" aria-label={t("tagsFilter")}>
      {tagsInUse.map(({ tag }) => (
        <TagChip key={tag} tag={tag} active={filter?.toLowerCase() === tag.toLowerCase()} onClick={() => setTagFilter(filter?.toLowerCase() === tag.toLowerCase() ? null : tag)} />
      ))}
      <button type="button" class={`cf-tag-group ${grouped ? "on" : ""}`} aria-pressed={grouped} onClick={() => onGrouped(!grouped)} title={t("tagsGroup")}>
        <Icon.Folder /> {t("tagsGroup")}
      </button>
    </div>
  )
  const [editing, setEditing] = useState<string | null>(null)
  // The chat whose "…" menu is open (touch).
  const [menuOf, setMenuOf] = useState<string | null>(null)
  const closeMenu = useCallback(() => setMenuOf(null), [])
  const [pagesOf, setPagesOf] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())

  // The page list closes on any press outside it (its own chip toggles it).
  useEffect(() => {
    const root = pop.current?.getRootNode()
    if (!pagesOf || !root) return
    const close = (e: Event) => {
      const target = e.target as Element
      if (!pop.current?.contains(target) && !target.closest?.(".cf-pages-chip")) setPagesOf(null)
    }
    root.addEventListener("pointerdown", close, true)
    return () => root.removeEventListener("pointerdown", close, true)
  }, [pagesOf])

  const trashRow = trashCount > 0 && onOpenTrash && <TrashRow count={trashCount} onOpen={onOpenTrash} />

  if (threads.length === 0) {
    return (
      <div class="cf-threads">
        <div class="cf-empty">
          <div class="cf-empty-icon"><Icon.Chats /></div>
          <p>{t("chatsEmpty")}</p>
          <button type="button" class="cf-primary" onClick={onNew}><Icon.Plus /> {t("newChat")}</button>
        </div>
        {trashRow && <div role="list">{trashRow}</div>}
      </div>
    )
  }

  if (ai && (query.trim() || found)) {
    const byId = new Map(threads.map((th) => [th.id, th]))
    const reply = found?.reply
    return (
      <div class="cf-threads" role="list">
        {search}
        {!found && <p class="cf-search-none">{t("findHint")}</p>}
        {found && !reply && !findWaiting && <div class="cf-thinking cf-find-busy"><span /><span /><span /> {t("findBusy")}</div>}
        {reply && !reply.ok && <p class="cf-search-none">{findError(reply.code)}</p>}
        {reply?.ok && reply.results.length === 0 && <p class="cf-search-none">{t("searchNone", found?.query ?? "")}</p>}
        {reply?.ok && reply.results.map(({ id, why }) => {
          const thread = byId.get(id)
          if (!thread) return null
          return (
            <div key={id} role="listitem" class={`cf-thread ${id === activeId ? "current" : ""}`}>
              <div class="cf-thread-main" role="button" tabIndex={0} onClick={() => onOpen(id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(id) }}>
                <span class="cf-thread-title" dir="auto">{threadName(thread)}</span>
                {why && <span class="cf-search-hit cf-find-why"><Icon.Sparkle size={11} /> {why}</span>}
                <span class="cf-thread-meta"><span class="cf-thread-when">{when(activity(thread))}</span></span>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  if (query.trim()) {
    const results = searchThreads(shownThreads, query)
    return (
      <div class="cf-threads" role="list">
        {search}
        {tagBar}
        {results.length === 0 && <p class="cf-search-none">{t("searchNone", query.trim())}</p>}
        {results.map(({ thread, hits }) => (
          <div key={thread.id} role="listitem" class={`cf-thread ${thread.id === activeId ? "current" : ""}`}>
            <div
              class="cf-thread-main"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(thread.id, hits[0]?.at)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return
                e.preventDefault()
                onOpen(thread.id, hits[0]?.at)
              }}
            >
              <span class="cf-thread-title" dir="auto">{threadName(thread)}</span>
              {hits.map((hit, i) => (
                <span
                  key={i}
                  class="cf-search-hit"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpen(thread.id, hit.at)
                  }}
                >
                  <Excerpt hit={hit} />
                </span>
              ))}
              <span class="cf-thread-meta"><span class="cf-thread-when">{when(activity(thread))}</span></span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const pinned = threads.filter((th) => th.pin !== undefined)
  const startDrag = (e: PointerEvent, id: string, from: number) => {
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const measured = pinned.map((th) => rows.current.get(th.id)?.getBoundingClientRect() ?? { top: 0, height: 0 })
    setDrag({ id, from, to: from, dy: 0, startY: e.clientY, rows: measured.map((r) => ({ top: r.top, height: r.height })) })
  }
  const moveDrag = (e: PointerEvent) => {
    if (!drag) return
    const dy = e.clientY - drag.startY
    const own = drag.rows[drag.from]
    const center = own.top + own.height / 2 + dy
    const to = drag.rows.filter((r, i) => i !== drag.from && r.top + r.height / 2 < center).length
    setDrag({ ...drag, dy, to })
  }
  const endDrag = () => {
    if (drag && drag.to !== drag.from) onMove(drag.id, drag.to)
    setDrag(null)
  }
  // While dragging: the dragged row follows the finger, the rows it passes make room.
  const shift = (index: number): number => {
    if (!drag || index >= pinned.length) return 0
    if (index === drag.from) return drag.dy
    const h = drag.rows[drag.from].height
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -h
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return h
    return 0
  }

  // Pinned chats are dragged only in the plain list (not filtered, not grouped).
  const reorder = !filter && !grouped
  const row = (thread: Thread, index: number, group: string) => {
        const pages = threadPages(thread.m)
        const notes = threadNotes(thread.m)
        const isPinned = thread.pin !== undefined
        const dy = reorder ? shift(index) : 0
        const tags = threadTags(thread)
        return (
          <div
            key={`${group}:${thread.id}`}
            ref={(el) => { if (el) rows.current.set(thread.id, el); else rows.current.delete(thread.id) }}
            role="listitem"
            class={`cf-thread ${thread.id === activeId ? "current" : ""} ${drag?.id === thread.id ? "dragging" : ""} ${drag && drag.id !== thread.id ? "making-room" : ""}`}
            style={dy ? { transform: `translateY(${dy}px)` } : undefined}
          >
            {editing === thread.id ? (
              <NameField
                thread={thread}
                onDone={(name) => {
                  setEditing(null)
                  if (name !== null) onRename(thread.id, name)
                }}
              />
            ) : (
              <Swipe
                class="cf-thread-swipe"
                enabled={touch && !drag}
                left={{ label: t("uxDelete"), icon: <TrashIcon />, tone: "delete", run: () => onDelete(thread.id) }}
                right={{ label: t(isPinned ? "uxUnpin" : "uxPin"), icon: <PinIcon filled={isPinned} />, tone: "pin", run: () => onPin(thread.id, !isPinned) }}
              >
                {isPinned && reorder && (
                  <span
                    class="cf-thread-grip"
                    role="button"
                    tabIndex={0}
                    aria-label={t("reorderChat")}
                    title={t("reorderChat")}
                    onPointerDown={(e) => startDrag(e, thread.id, index)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" && index > 0) onMove(thread.id, index - 1)
                      else if (e.key === "ArrowDown" && index < pinned.length - 1) onMove(thread.id, index + 1)
                      else return
                      e.preventDefault()
                    }}
                  >
                    <Icon.Grip />
                  </span>
                )}
                <div
                  class="cf-thread-main"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(thread.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
                    e.preventDefault()
                    onOpen(thread.id)
                  }}
                >
                  <span class="cf-thread-title" dir="auto">
                    {/* Before the name (build 93): a long name is cut short with "…", and what follows it with it. */}
                    {playing === thread.id && <span class="cf-thread-audio" role="status" aria-label={t("listenPlayingHere")} title={t("listenPlayingHere")}><SpeakerIcon size={13} /></span>}
                    {thread.kind === "history" && <Icon.Sparkle size={12} />} {threadName(thread)}
                    {busy?.has(thread.id) ? <span class="cf-thread-busy" role="status" aria-label={t("busyWorking")} /> : unread?.has(thread.id) ? <span class="cf-thread-unread" role="status" aria-label={t("busyNew")} /> : null}
                  </span>
                  <span class="cf-thread-snippet" dir="auto">{threadSnippet(thread.m)}</span>
                  {tags.length > 0 && (
                    <span class="cf-thread-tags">
                      {tags.map((tag) => <TagChip key={tag} tag={tag} onClick={(e) => { e.stopPropagation(); setTagFilter(tag) }} />)}
                    </span>
                  )}
                  <span class="cf-thread-meta">
                    {notes > 0 && (
                      <span class="cf-thread-notes" title={t("chatNotes")} aria-label={t("chatNotes")}><Icon.Pencil />{notes}</span>
                    )}
                    {pages.length > 1 ? (
                      <button
                        type="button"
                        class="cf-pages-chip"
                        aria-expanded={pagesOf === thread.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPagesOf(pagesOf === thread.id ? null : thread.id)
                        }}
                      >
                        {pagesLabel(pages.length)}
                      </button>
                    ) : (
                      pages.length === 1 && <span class="cf-thread-site">{host(pages[0].url)}</span>
                    )}
                    {Boolean(recs?.[thread.id]) && (
                      <span class="cf-thread-recs"><Icon.Sparkle size={11} />{recsLabel(recs![thread.id])}</span>
                    )}
                    <span class="cf-thread-when">{when(activity(thread))}</span>
                  </span>
                </div>
                {touch ? (
                  // iPhone and iPad (2.5 (75)): the swipes pin and delete; "…" has those and the rest.
                  <span class="cf-thread-more-wrap">
                    <ThreadMoreButton open={menuOf === thread.id} onToggle={() => setMenuOf(menuOf === thread.id ? null : thread.id)} />
                    {menuOf === thread.id && (
                      <ThreadMenu
                        pinned={isPinned}
                        onPin={() => onPin(thread.id, !isPinned)}
                        onRename={() => setEditing(thread.id)}
                        onTags={() => setTagging(thread.id)}
                        onDelete={() => onDelete(thread.id)}
                        onClose={closeMenu}
                      />
                    )}
                  </span>
                ) : (
                  <>
                    <button type="button" class={`cf-icon cf-thread-tool ${thread.tags?.length ? "on" : ""}`} onClick={() => setTagging(tagging === thread.id ? null : thread.id)} aria-label={t("tagsEdit")} title={t("tagsEdit")}>
                      <Icon.Tag />
                    </button>
                    <button type="button" class={`cf-icon cf-thread-tool ${isPinned ? "on" : ""}`} onClick={() => onPin(thread.id, !isPinned)} aria-pressed={isPinned} aria-label={t(isPinned ? "unpinChat" : "pinChat")} title={t(isPinned ? "unpinChat" : "pinChat")}>
                      <Icon.Pin filled={isPinned} />
                    </button>
                    <button type="button" class="cf-icon cf-thread-tool" onClick={() => setEditing(thread.id)} aria-label={t("renameChat")} title={t("renameChat")}>
                      <Icon.Pencil />
                    </button>
                    <button type="button" class="cf-icon cf-thread-tool cf-thread-delete" onClick={() => onDelete(thread.id)} aria-label={t("deleteChat")} title={t("deleteChat")}>
                      <Icon.Trash />
                    </button>
                  </>
                )}
              </Swipe>
            )}
            {tagging === thread.id && (
              <TagEditor tags={thread.tags ?? []} known={known} onChange={(next) => onTags(thread.id, next)} onClose={() => setTagging(null)} />
            )}
            {pagesOf === thread.id && (
              <div class="cf-pages-pop" ref={pop} role="menu" aria-label={t("chatPages")}>
                <div class="cf-pages-pop-title">{t("chatPages")}</div>
                {pages.map((page) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={page.url}
                    class="cf-pages-item"
                    title={t("openPage")}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPagesOf(null)
                      onOpenPage(page.url)
                    }}
                  >
                    <span class="cf-pages-item-title" dir="auto">{page.title || host(page.url)}</span>
                    <span class="cf-pages-item-host">{host(page.url)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
  }

  const groups = grouped ? groupByTag(shownThreads) : null
  return (
    <div class="cf-threads" role="list">
      {search}
      {tagBar}
      {!filter && threads.some((th) => th.kind !== "history") && <AskHistoryRow pro={pro} onOpen={onAskHistory} />}
      {groups
        ? groups.map((g) => (
            <div key={g.tag ?? ""} class="cf-tag-group-section" role="group" aria-label={g.tag ?? t("tagsNone")}>
              <div class="cf-tag-group-head"><Icon.Folder /> {g.tag ? `#${g.tag}` : t("tagsNone")} <span>{g.threads.length}</span></div>
              {g.threads.map((thread) => row(thread, -1, g.tag ?? ""))}
            </div>
          ))
        : shownThreads.map((thread, index) => row(thread, index, ""))}
      {!filter && trashRow}
    </div>
  )
}
