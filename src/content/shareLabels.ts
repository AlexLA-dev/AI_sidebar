// The share labels in every language the extension speaks, so a shared chat can be labelled in the
// language its questions were typed in. Only these keys of each locale end up in the bundle.
import * as de from "../locales/de.json"
import * as en from "../locales/en.json"
import * as es from "../locales/es.json"
import * as fr from "../locales/fr.json"
import * as it from "../locales/it.json"
import * as ja from "../locales/ja.json"
import * as ko from "../locales/ko.json"
import * as pt from "../locales/pt_BR.json"
import * as ru from "../locales/ru.json"
import * as uk from "../locales/uk.json"
import * as zh from "../locales/zh_CN.json"
import { t } from "../shared/i18n"
import type { ShareLabels } from "../shared/share"

const LABELS: Record<string, ShareLabels> = {
  de: { you: de.shareYou, note: de.shareNote, sources: de.sources, source: de.shareSource, madeWith: de.shareMadeWith },
  en: { you: en.shareYou, note: en.shareNote, sources: en.sources, source: en.shareSource, madeWith: en.shareMadeWith },
  es: { you: es.shareYou, note: es.shareNote, sources: es.sources, source: es.shareSource, madeWith: es.shareMadeWith },
  fr: { you: fr.shareYou, note: fr.shareNote, sources: fr.sources, source: fr.shareSource, madeWith: fr.shareMadeWith },
  it: { you: it.shareYou, note: it.shareNote, sources: it.sources, source: it.shareSource, madeWith: it.shareMadeWith },
  ja: { you: ja.shareYou, note: ja.shareNote, sources: ja.sources, source: ja.shareSource, madeWith: ja.shareMadeWith },
  ko: { you: ko.shareYou, note: ko.shareNote, sources: ko.sources, source: ko.shareSource, madeWith: ko.shareMadeWith },
  pt_BR: { you: pt.shareYou, note: pt.shareNote, sources: pt.sources, source: pt.shareSource, madeWith: pt.shareMadeWith },
  ru: { you: ru.shareYou, note: ru.shareNote, sources: ru.sources, source: ru.shareSource, madeWith: ru.shareMadeWith },
  uk: { you: uk.shareYou, note: uk.shareNote, sources: uk.sources, source: uk.shareSource, madeWith: uk.shareMadeWith },
  zh_CN: { you: zh.shareYou, note: zh.shareNote, sources: zh.sources, source: zh.shareSource, madeWith: zh.shareMadeWith }
}

/** Labels in `language` (a locale code), or in the device's language when it isn't known. */
export function shareLabels(language: string | undefined): ShareLabels {
  return (language && LABELS[language]) || { you: t("shareYou"), note: t("shareNote"), sources: t("sources"), source: t("shareSource"), madeWith: t("shareMadeWith") }
}
