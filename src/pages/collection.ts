// A collection's printable page (2.7 «Подборки»): the panel's «PDF» opens dist/collection.html?id=<collection> in a
// tab; «Сохранить PDF» prints it (Safari's print sheet saves a PDF or shares it). The page itself is
// src/shared/collectionPage.ts, the same as the app's (BoardPDF.swift).

import { cleanCollection, countedCards, type StoredCollections } from "../shared/collections"
import { collectionHtml, PAGE_CSS, type PageWords } from "../shared/collectionPage"
import { pluralForm, t, uiLanguage } from "../shared/i18n"
import { STORAGE } from "../shared/types"

/** "12 cards" in the UI language. */
export function cardsLabel(n: number): string {
  return t(`colCards_${pluralForm(n)}`, n)
}

export function pageWords(n: number, now = new Date()): PageWords {
  const lang = uiLanguage().replace("_", "-")
  let date: string
  try {
    date = new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(now)
  } catch {
    date = now.toDateString()
  }
  return {
    cards: cardsLabel(n), date, madeWith: t("colPdfMadeWith"), brand: t("colPdfBrand"), summary: t("colSummary"),
    comparison: t("colComparison"), openChat: t("colPdfOpenChat"), footer: t("colPdfFooter"), lang, rtl: /^(ar|he|fa|ur)\b/.test(lang)
  }
}

async function show(): Promise<void> {
  const style = document.createElement("style")
  style.textContent = PAGE_CSS
  document.head.append(style)
  const id = new URLSearchParams(location.search).get("id") ?? ""
  const all = ((await chrome.storage.local.get(STORAGE.collections))[STORAGE.collections] ?? {}) as StoredCollections
  const rec = all[id] ? cleanCollection(all[id].rec, id) : null
  const page = document.getElementById("page")!
  if (!rec || rec.d) {
    page.textContent = t("colGone")
    return
  }
  const words = pageWords(countedCards(rec))
  document.documentElement.lang = words.lang
  if (words.rtl) document.documentElement.dir = "rtl"
  document.title = rec.n
  page.innerHTML = collectionHtml(rec, words)
  const save = document.getElementById("save") as HTMLButtonElement
  save.textContent = t("colPdfSave")
  save.hidden = false
  save.onclick = () => window.print()
}

void show()
