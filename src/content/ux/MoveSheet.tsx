// «…» ▸ Move to another chat (2.7 (109)): which chat. The latest first, every space's chats (each with its space's mark
// when there are several), a search by name, and a new chat on top. Sits above the question field like Remind.

import type { VNode } from "preact"
import { useMemo, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import type { Space } from "../../shared/spaces"
import { activity, threadName, type Thread } from "../../shared/threads"
import * as Icon from "../icons"
import { SpaceTag } from "../Spaces"
import { when } from "../Threads"
import { SheetClose, useAboveComposer } from "./MessageUx"
import { moveTargets } from "./moveAnswer"

export function MoveSheet({ all, current, note, spaceOf, onPick, onClose }: {
  all: Thread[]
  current: string
  // A note moves by itself; an answer, with its question (the title says which).
  note: boolean
  // The space a chat is in, when there are several (null: one space, no marks).
  spaceOf: ((thread: Thread) => Space) | null
  // A chat's id, or null for a new chat.
  onPick: (id: string | null) => void
  onClose: () => void
}): VNode {
  const [query, setQuery] = useState("")
  const list = useMemo(() => moveTargets(all, current, query), [all, current, query])
  const back = useRef<HTMLDivElement>(null)
  useAboveComposer(back)
  const stop = (e: KeyboardEvent) => e.stopPropagation()
  return (
    <div ref={back} class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="cf-sheet cf-move-sheet" role="dialog" aria-label={t(note ? "uxMoveNoteTitle" : "uxMoveTitle")}>
        <div class="cf-sheet-title"><Icon.MoveTo /> {t(note ? "uxMoveNoteTitle" : "uxMoveTitle")}<SheetClose onClose={onClose} /></div>
        <div class="cf-search cf-move-search" role="search">
          <Icon.Search size={15} />
          <input
            type="search"
            dir="auto"
            value={query}
            placeholder={t("searchChats")}
            aria-label={t("searchChats")}
            enterkeyhint="search"
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={stop}
            onKeyUp={stop}
            onKeyPress={stop}
          />
        </div>
        <div class="cf-move-list" role="list">
          {!query.trim() && (
            <button type="button" role="listitem" class="cf-sheet-row cf-move-new" onClick={() => onPick(null)}>
              <span class="cf-move-name"><Icon.Plus /> {t("newChat")}</span>
            </button>
          )}
          {list.map((th) => (
            <button key={th.id} type="button" role="listitem" class="cf-sheet-row cf-move-row" onClick={() => onPick(th.id)}>
              <span class="cf-move-name" dir="auto">{threadName(th)}</span>
              <span class="cf-move-meta">
                {spaceOf && <SpaceTag space={spaceOf(th)} />}
                <span class="cf-sheet-when">{when(activity(th))}</span>
              </span>
            </button>
          ))}
          {query.trim() && list.length === 0 && <p class="cf-search-none">{t("searchNone", query.trim())}</p>}
        </div>
      </div>
    </div>
  )
}
