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
  de: { you: de.shareYou, sources: de.sources, source: de.shareSource, madeWith: de.shareMadeWith },
  en: { you: en.shareYou, sources: en.sources, source: en.shareSource, madeWith: en.shareMadeWith },
  es: { you: es.shareYou, sources: es.sources, source: es.shareSource, madeWith: es.shareMadeWith },
  fr: { you: fr.shareYou, sources: fr.sources, source: fr.shareSource, madeWith: fr.shareMadeWith },
  it: { you: it.shareYou, sources: it.sources, source: it.shareSource, madeWith: it.shareMadeWith },
  ja: { you: ja.shareYou, sources: ja.sources, source: ja.shareSource, madeWith: ja.shareMadeWith },
  ko: { you: ko.shareYou, sources: ko.sources, source: ko.shareSource, madeWith: ko.shareMadeWith },
  pt_BR: { you: pt.shareYou, sources: pt.sources, source: pt.shareSource, madeWith: pt.shareMadeWith },
  ru: { you: ru.shareYou, sources: ru.sources, source: ru.shareSource, madeWith: ru.shareMadeWith },
  uk: { you: uk.shareYou, sources: uk.sources, source: uk.shareSource, madeWith: uk.shareMadeWith },
  zh_CN: { you: zh.shareYou, sources: zh.sources, source: zh.shareSource, madeWith: zh.shareMadeWith }
}

/** Labels in `language` (a locale code), or in the device's language when it isn't known. */
export function shareLabels(language: string | undefined): ShareLabels {
  return (language && LABELS[language]) || { you: t("shareYou"), sources: t("sources"), source: t("shareSource"), madeWith: t("shareMadeWith") }
}
