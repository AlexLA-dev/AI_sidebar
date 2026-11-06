// Collapsed sections (2.5). Mobile Wikipedia folds every section after the lead (`hidden="until-found"` under a
// heading with aria-expanded="false") and Readability drops hidden nodes, so a question saw only the lead.
// Before the page is read, its copy gets folded content unfolded: content hidden to be found
// (hidden="until-found"), closed <details>, and what a collapsed control (aria-expanded="false") opens through
// aria-controls (accordions, folded sections). Only content: text with paragraphs, mostly not links, not a
// menu, list box, dialog or tooltip, not in the site's navigation or header. Everything else hidden (menus,
// dialogs, templates) stays hidden.

const NOT_CONTENT = "nav, header, [role=navigation], [role=banner], [role=menu], [role=menubar], [role=listbox], [role=dialog], [role=alertdialog], [role=tooltip]"
const INNER_NOT_CONTENT = "[role=menu], [role=menubar], [role=listbox], [role=dialog], [role=alertdialog], [role=tooltip]"

/** Unfolds the folded content in `root` (a copy of the page); returns how many parts it unfolded. */
export function unfoldCollapsed(root: Document | Element): number {
  const targets = new Set<Element>()
  root.querySelectorAll('[hidden="until-found"], details:not([open])').forEach((el) => targets.add(el))
  root.querySelectorAll('[aria-expanded="false"][aria-controls]').forEach((control) => {
    for (const id of (control.getAttribute("aria-controls") ?? "").split(/\s+/)) {
      const el = id ? root.querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`) : null
      if (el) targets.add(el)
    }
  })
  let unfolded = 0
  for (const el of targets) {
    if (!isContent(el)) continue
    show(el)
    unfolded++
  }
  return unfolded
}

/** Readable content rather than a site's menu: paragraphs or a fair amount of text, mostly not links. */
function isContent(el: Element): boolean {
  if (el.closest(NOT_CONTENT) || el.querySelector(INNER_NOT_CONTENT)) return false
  const text = words(el)
  if (text < (el.querySelector("p") ? 40 : 200)) return false
  let links = 0
  el.querySelectorAll("a").forEach((a) => (links += words(a)))
  return links / text < 0.5
}

function words(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length
}

function show(el: Element): void {
  el.removeAttribute("hidden")
  if (el.getAttribute("aria-hidden") === "true") el.removeAttribute("aria-hidden")
  if (el.tagName === "DETAILS") el.setAttribute("open", "")
  const style = (el as HTMLElement).style
  if (style?.display === "none") style.removeProperty("display")
  if (style?.visibility === "hidden") style.removeProperty("visibility")
}
