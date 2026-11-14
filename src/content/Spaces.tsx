// Spaces in the panel (2.7, src/shared/spaces.ts): the switcher in the header (a coloured dot and the name; a tap opens
// the short list, with "Open this site here" under it), the sheet that makes or edits a space (a name and a colour,
// nothing else), the line in the header when the panel went into a site's space, and the space's mark on a search hit.
// The approved mockup: ~/ContextFlow-work/director/spaces-27/spaces-mockup.html.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../shared/i18n"
import {
  addSpace, bindSite, boundSpace, canAddSpace, chatsInSpace, cleanSpaceName, COLOR_NAMES, deleteSpace, editSpace, emptySpaces, FIRST_SPACE, FREE_SPACES, liveSpaces, MAX_SPACE_NAME,
  nextColor, resolveSpace, siteKey, SPACE_COLORS, spaceCount, spaceOfChat, type Space, type SpaceColor, type SpaceList
} from "../shared/spaces"
import { chatForPage, newThreadId, type Thread } from "../shared/threads"
import { listenAround } from "./around"
import * as Icon from "./icons"
import { activeSpaceNow, loadSpaces, loadThreads, moveChatToSpace, onActiveSpaceChanged, onSpacesChanged, saveSpaces } from "./store"

/** The gradient a space's colour makes (the ✦ circle's look). */
export function spaceGradient(color: SpaceColor): string {
  const [light, base] = SPACE_COLORS[color]
  return `linear-gradient(135deg, ${light} 0%, ${base} 100%)`
}

/** The CSS variables that tint the panel's header and the ✦ circle with a space's colour. */
export function spaceVars(color: SpaceColor): Record<string, string> {
  const [light, base] = SPACE_COLORS[color]
  // 11 % of the colour over the panel's background (an 8-digit hex: color-mix() is Safari 16.2+).
  return { "--space": base, "--space-2": light, "--space-soft": `${base}1c` }
}

export function SpaceDot({ color, size = 12 }: { color: SpaceColor; size?: number }): VNode {
  return <i class="cf-space-dot" aria-hidden="true" style={{ width: `${size}px`, height: `${size}px`, background: spaceGradient(color) }} />
}

const COLOR_LABEL: Record<SpaceColor, "spaceColorBlue" | "spaceColorGreen" | "spaceColorOrange" | "spaceColorPink" | "spaceColorViolet" | "spaceColorGraphite"> = {
  blue: "spaceColorBlue", green: "spaceColorGreen", orange: "spaceColorOrange", pink: "spaceColorPink", violet: "spaceColorViolet", graphite: "spaceColorGraphite"
}

/** "Open this site here" under the list: how the page's site stands. */
export interface SiteBind {
  site: string
  // The space it opens in now, if any (this one or another).
  in: Space | null
  onToggle: () => void
}

/**
 * The header's switcher: the space's dot and name, a tap opens the list. Picking a space switches to it; "+ New space"
 * and "Edit “…”" open the sheet; the site's switch binds the page's site to the space the panel is in.
 */
export function SpaceSwitcher({ spaces, current, counts, bind, onPick, onNew, onEdit }: {
  spaces: Space[]
  current: Space
  counts: Record<string, number>
  bind?: SiteBind | null
  onPick: (id: string) => void
  onNew: () => void
  onEdit: () => void
}): VNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open || !ref.current) return
    const stop = listenAround(ref.current, "pointerdown", (_, path) => {
      if (!path.includes(ref.current as EventTarget)) setOpen(false)
    })
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", esc, true)
    return () => {
      stop()
      document.removeEventListener("keydown", esc, true)
    }
  }, [open])
  const item = (run: () => void) => () => {
    setOpen(false)
    run()
  }
  const here = bind?.in?.id === current.id
  return (
    <span class="cf-space-wrap" ref={ref}>
      <button type="button" class="cf-space-switch" aria-haspopup="menu" aria-expanded={open} aria-label={t("spaceSwitcher", current.name)} title={t("spaceSwitcher", current.name)} onClick={() => setOpen(!open)}>
        <SpaceDot color={current.color} />
        <span class="cf-space-name" dir="auto">{current.name}</span>
        <span class="cf-space-chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div class="cf-space-pop" role="menu" aria-label={t("spacesTitle")}>
          {spaces.map((space) => (
            <button key={space.id} type="button" role="menuitemradio" aria-checked={space.id === current.id} class="cf-space-item" onClick={item(() => onPick(space.id))}>
              <SpaceDot color={space.color} />
              <span class="cf-space-item-name" dir="auto">{space.name}</span>
              <small>{counts[space.id] ?? 0}</small>
              {space.id === current.id && <span class="cf-space-check"><Icon.Check /></span>}
            </button>
          ))}
          <button type="button" role="menuitem" class="cf-space-item cf-space-add" onClick={item(onNew)}><Icon.Plus /> {t("spaceNew")}</button>
          <button type="button" role="menuitem" class="cf-space-item cf-space-edit" onClick={item(onEdit)}><Icon.Pencil /> <span dir="auto">{t("spaceEdit", current.name)}</span></button>
          {bind && (
            <button type="button" role="menuitemcheckbox" aria-checked={here} class="cf-space-bind" onClick={item(bind.onToggle)}>
              <span dir="auto">{bind.in && !here ? t("spaceBoundElsewhere", bind.site, bind.in.name) : t("spaceBind", bind.site)}</span>
              <i class={`cf-space-toggle${here ? " on" : ""}`} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </span>
  )
}

/** What the sheet is for: a new space, or editing one (the first can't be deleted). */
export type SpaceSheetMode =
  | { kind: "new"; color: SpaceColor; name?: string }
  | { kind: "edit"; space: Space; canDelete: boolean; firstName: string }
  | { kind: "limit"; free: number }

/**
 * The sheet over the panel: a name and a colour (the mockup's two fields), Create or Save. Editing has Delete for any
 * space but the first (its chats go to the first). Free with its spaces all made: what Pro gives, and Pro.
 */
export function SpaceSheet({ mode, onSave, onDelete, onPro, onCancel }: {
  mode: SpaceSheetMode
  onSave: (name: string, color: SpaceColor) => void
  onDelete: () => void
  onPro: () => void
  onCancel: () => void
}): VNode {
  const [name, setName] = useState(mode.kind === "edit" ? mode.space.name : mode.kind === "new" ? mode.name ?? "" : "")
  const [color, setColor] = useState<SpaceColor>(mode.kind === "edit" ? mode.space.color : mode.kind === "new" ? mode.color : "blue")
  const [asking, setAsking] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // On a Mac the field is ready to type in; on iPhone and iPad the keyboard waits for a tap (it would cover the colours).
    if (!matchMedia("(pointer: coarse)").matches) input.current?.focus()
  }, [])
  const keys = (e: KeyboardEvent) => {
    // The page must not see these keys; Escape closes the sheet, not the panel.
    e.stopPropagation()
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    }
  }
  if (mode.kind === "limit") {
    return (
      <div class="cf-space-veil" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
        <div class="cf-space-sheet" role="dialog" aria-label={t("spaceNew")} onKeyDown={keys}>
          <strong>{t("spaceNew")} <span class="cf-pro-badge">Pro</span></strong>
          <p class="cf-space-note">{t("spaceLimit", mode.free)}</p>
          <div class="cf-space-buttons">
            <button type="button" onClick={onCancel}>{t("cancel")}</button>
            <button type="button" class="cf-primary" onClick={onPro}>{t("getPro")}</button>
          </div>
        </div>
      </div>
    )
  }
  // A space needs its name; only the first one's may be empty (it's then called by its default name).
  const named = Boolean(cleanSpaceName(name)) || (mode.kind === "edit" && mode.space.id === FIRST_SPACE)
  const save = () => {
    if (named) onSave(name, color)
  }
  return (
    <div class="cf-space-veil" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <form class="cf-space-sheet" role="dialog" aria-label={mode.kind === "new" ? t("spaceNew") : t("spaceEdit", mode.space.name)} onKeyDown={keys} onSubmit={(e) => { e.preventDefault(); save() }}>
        <strong dir="auto">{mode.kind === "new" ? t("spaceNew") : t("spaceEdit", mode.space.name)}</strong>
        <label class="cf-space-label" for="cf-space-name">{t("spaceName")}</label>
        <input
          id="cf-space-name"
          ref={input}
          class="cf-space-input"
          value={name}
          maxLength={MAX_SPACE_NAME}
          placeholder={mode.kind === "edit" && mode.space.id === FIRST_SPACE ? mode.firstName : t("spaceNamePlaceholder")}
          autocomplete="off"
          enterkeyhint="done"
          dir="auto"
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyPress={(e) => e.stopPropagation()}
        />
        <span class="cf-space-label">{t("spaceColor")}</span>
        <div class="cf-space-colors" role="radiogroup" aria-label={t("spaceColor")}>
          {COLOR_NAMES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={t(COLOR_LABEL[c])} title={t(COLOR_LABEL[c])} class={`cf-space-color${color === c ? " on" : ""}`} style={{ background: spaceGradient(c) }} onClick={() => setColor(c)} />
          ))}
        </div>
        {mode.kind === "edit" && mode.canDelete && (
          asking ? (
            <div class="cf-space-delete-ask">
              <span>{t("spaceDeleteNote", mode.firstName)}</span>
              <button type="button" class="danger" onClick={onDelete}>{t("spaceDelete")}</button>
            </div>
          ) : (
            <button type="button" class="cf-space-delete" onClick={() => setAsking(true)}>{t("spaceDelete")}</button>
          )
        )}
        <div class="cf-space-buttons">
          <button type="button" onClick={onCancel}>{t("cancel")}</button>
          <button type="submit" class="cf-primary" disabled={!named}>{mode.kind === "new" ? t("spaceCreate") : t("save")}</button>
        </div>
      </form>
    </div>
  )
}

/** The line over the header for a moment: the space the panel just went into (a bound site, a new space, a move). */
export function SpaceToast({ space, text }: { space: Space; text: string }): VNode {
  return (
    <div class="cf-space-toast" role="status">
      <SpaceDot color={space.color} size={10} />
      <span dir="auto">{text}</span>
    </div>
  )
}

/** The space a search hit is in (search goes through every space). */
export function SpaceTag({ space }: { space: Space }): VNode {
  return (
    <span class="cf-space-tag" dir="auto">
      <SpaceDot color={space.color} size={8} />
      {space.name}
    </span>
  )
}

/** «Переместить в…» in a chat's menu: the other spaces. */
export function MoveToSpace({ spaces, onMove }: { spaces: Space[]; onMove: (id: string) => void }): VNode {
  return (
    <div class="cf-space-move" role="group" aria-label={t("spaceMoveTo")}>
      <span class="cf-space-move-title">{t("spaceMoveTo")}</span>
      {spaces.map((space) => (
        <button key={space.id} type="button" role="menuitem" onClick={() => onMove(space.id)}>
          <SpaceDot color={space.color} size={10} />
          <span dir="auto">{space.name}</span>
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------ the panel's spaces

/** The line in the header for a moment: which space, and what happened (rendered with the names as they are then). */
type Flash = { space: string; kind: "site" | "in" | "moved" | "bound"; site?: string }

/** What the panel asks of the spaces' state, and the panel's own steps it uses. */
interface SpacesDeps {
  // Settings' switch.
  on: boolean
  // Every chat (pinned first, then the newest), and the one shown.
  threads: Thread[]
  shownId: string
  pro: boolean
  // The page's address now.
  href: () => string
  openChat: (id: string) => void
  newChatIn: (space: string) => void
  onPro: () => void
  report: (a: string, fields?: { via?: string; val?: "on" | "off" }) => void
}

/**
 * The spaces as the panel shows them (2.7): the list, the space it's in (the shown chat's, else the one a new chat was
 * started in), that space's chats, and the steps: switch, make, edit, delete, bind the site, move a chat.
 */
export function useSpaces(deps: SpacesDeps) {
  const [list, setList] = useState<SpaceList>(emptySpaces())
  // The space a new chat (not stored yet) is in, as this device keeps it with the open chat (store.ts setActiveThread).
  const [activeSp, setActiveSp] = useState<string | undefined>(undefined)
  const [sheet, setSheet] = useState<SpaceSheetMode | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    void loadSpaces().then(setList)
    void activeSpaceNow().then(setActiveSp)
    const a = onSpacesChanged(setList)
    const b = onActiveSpaceChanged(setActiveSp)
    return () => {
      a()
      b()
      clearTimeout(flashTimer.current)
    }
  }, [])

  const firstName = t("spaceFirst")
  const spaces = liveSpaces(list, firstName)
  const multi = deps.on && spaces.length > 1
  const shown = deps.threads.find((x) => x.id === deps.shownId)
  const currentId = !deps.on ? FIRST_SPACE : shown ? spaceOfChat(list, shown) : resolveSpace(list, activeSp)
  const current = spaces.find((x) => x.id === currentId) ?? spaces[0]
  const inSpace = chatsInSpace(deps.threads, list, current.id, deps.on)
  const counts: Record<string, number> = {}
  for (const chat of deps.threads) {
    const id = spaceOfChat(list, chat)
    counts[id] = (counts[id] ?? 0) + 1
  }
  const byId = (id: string) => spaces.find((x) => x.id === id) ?? spaces[0]
  const site = siteKey(deps.href())
  const bound = boundSpace(list, site)

  const show = (next: Flash) => {
    setFlash(next)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 1900)
  }

  /** Into space `id`: its chat for this page, else a new chat there. */
  const switchTo = async (id: string, via: string) => {
    if (id === current.id) return
    const { threads } = await loadThreads()
    const live = await loadSpaces()
    const found = chatForPage(threads, deps.href(), (x) => spaceOfChat(live, x) === id)
    setActiveSp(id)
    if (found) deps.openChat(found)
    else deps.newChatIn(id)
    deps.report("switch", { via })
  }

  return {
    list, spaces, multi, current, inSpace, counts, sheet, setSheet,
    /** For the ✦ circle on this page: the space a tap opens in (a bound site's), when there are spaces. */
    fabSpace: multi ? byId(bound ?? current.id) : null,
    /** A switch the panel made by itself as it opened (a bound site): the space and the line in the header. */
    flashSite: (space: string, href: string) => {
      setActiveSp(space)
      show({ space, kind: "site", site: siteKey(href) })
      deps.report("switch", { via: "site" })
    },
    /** A chat opened from another space (a search hit): the panel goes there with it. */
    followChat: (thread: Thread | undefined) => {
      if (multi && thread && spaceOfChat(list, thread) !== current.id) deps.report("switch", { via: "chat" })
    },
    toast: flash ? { space: byId(flash.space), text: flash.kind === "site" ? `${byId(flash.space).name} · ${flash.site ?? ""}` : flash.kind === "in" ? t("spaceIn", byId(flash.space).name) : flash.kind === "moved" ? t("spaceMoved", byId(flash.space).name) : `${flash.site ?? ""} → ${byId(flash.space).name}` } : null,
    pick: (id: string) => void switchTo(id, "header"),
    openNew: (via: string) => {
      if (!canAddSpace(list, deps.pro)) {
        deps.report("limit", { via })
        setSheet({ kind: "limit", free: FREE_SPACES })
        return
      }
      setSheet({ kind: "new", color: nextColor(list, firstName) })
    },
    openEdit: () => setSheet({ kind: "edit", space: current, canDelete: current.id !== FIRST_SPACE, firstName }),
    save: async (name: string, color: SpaceColor) => {
      const mode = sheet
      setSheet(null)
      if (mode?.kind === "new") {
        const id = newThreadId()
        await saveSpaces((l) => addSpace(l, id, cleanSpaceName(name), color))
        setActiveSp(id)
        deps.newChatIn(id)
        show({ space: id, kind: "in" })
        deps.report("create")
      } else if (mode?.kind === "edit") {
        // The first space under its default name keeps none: it follows the language.
        const kept = mode.space.id === FIRST_SPACE && cleanSpaceName(name) === firstName ? "" : name
        await saveSpaces((l) => editSpace(l, mode.space.id, kept, color))
        deps.report("edit")
      }
    },
    remove: async () => {
      const mode = sheet
      setSheet(null)
      if (mode?.kind !== "edit" || mode.space.id === FIRST_SPACE) return
      await saveSpaces((l) => deleteSpace(l, mode.space.id))
      if (current.id === mode.space.id) setActiveSp(undefined)
      deps.report("delete")
    },
    pro: () => {
      setSheet(null)
      deps.onPro()
    },
    /** «Открывать этот сайт здесь»: on for the space the panel is in, or off again. */
    bind: site ? {
      site,
      in: bound ? byId(bound) : null,
      onToggle: () => {
        const on = bound !== current.id
        void saveSpaces((l) => bindSite(l, site, on ? current.id : null))
        if (on) show({ space: current.id, kind: "bound", site })
        deps.report("bind", { val: on ? "on" : "off" })
      }
    } : null,
    /** «Переместить в…»: the chat goes; the shown one leaves the panel on a new chat here. */
    move: async (id: string, space: string) => {
      await moveChatToSpace(id, space)
      if (id === deps.shownId) deps.newChatIn(current.id)
      show({ space, kind: "moved" })
      deps.report("move")
    },
    count: () => spaceCount(list),
    /** The space a chat is in. */
    of: (thread: Thread) => byId(spaceOfChat(list, thread))
  }
}
