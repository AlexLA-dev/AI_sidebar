// The field the user last typed in on this page. "Insert into the field" under answers and notes puts
// text there; the button shows only while there is one.

import { useEffect, useState } from "preact/hooks"

import type { Field } from "./field"

let remembered: Field | null = null
const listeners = new Set<() => void>()
// The button by a field sits where the panel's ✦ is: the ✦ steps aside.
let buttonShown = false
const buttonListeners = new Set<() => void>()

export function setButtonShown(shown: boolean): void {
  if (shown === buttonShown) return
  buttonShown = shown
  for (const listener of buttonListeners) listener()
}

export function useButtonShown(): boolean {
  const [shown, setShown] = useState(buttonShown)
  useEffect(() => {
    const update = () => setShown(buttonShown)
    buttonListeners.add(update)
    update()
    return () => void buttonListeners.delete(update)
  }, [])
  return shown
}
let inserter: ((text: string, what: "answer" | "note") => void) | null = null

export function rememberField(field: Field | null): void {
  if (field === remembered) return
  remembered = field
  for (const listener of listeners) listener()
}

export function rememberedField(): Field | null {
  return remembered && remembered.el.isConnected ? remembered : null
}

/** Quick insert puts the panel's text in (it knows the caret, and what to do when the field refuses). */
export function setPanelInserter(fn: ((text: string, what: "answer" | "note") => void) | null): void {
  inserter = fn
}

export function insertFromPanel(text: string, what: "answer" | "note"): void {
  inserter?.(text, what)
}

/** There's a field on this page to insert into (for the panel's buttons). */
export function useHasField(): boolean {
  const [has, setHas] = useState(() => rememberedField() !== null)
  useEffect(() => {
    const update = () => setHas(rememberedField() !== null)
    listeners.add(update)
    update()
    return () => void listeners.delete(update)
  }, [])
  return has
}
