// The words of a Find similar answer's text (its chat turn's Markdown), in the person's language: the panel and the
// background write the same text (build 95: with the price ≈ theirs, how close, how it differs, what people say).
import { t, uiLang } from "./i18n"
import type { MarkdownWords } from "./similar"
import { moneyIn } from "./watch/compare"

/** A price as the page's markup states it ("169.99 USD") in the person's way of writing money. */
export function moneyText(price: string): string {
  const m = /^(\d+(?:\.\d+)?)\s([A-Z]{3})$/.exec(price.trim())
  if (!m) return price
  try {
    return moneyIn(uiLang(), Number(m[1]), m[2])
  } catch {
    return price
  }
}

export function markdownWords(): MarkdownWords {
  const count = new Intl.NumberFormat(uiLang())
  return {
    inStock: t("similarStockIn"),
    outOfStock: t("similarStockOut"),
    notConfirmed: t("similarNotConfirmed"),
    notOpened: t("similarNotOpened"),
    percent: (n) => t("similarPercent", n),
    estimated: t("similarEstimated"),
    differs: (s) => t("similarDiffers", s),
    say: t("similarSay"),
    ratings: (n) => t("similarRatings", count.format(n)),
    pros: (s) => t("similarPros", s),
    cons: (s) => t("similarCons", s),
    same: t("similarSame"),
    misses: t("similarMisses"),
    money: moneyText,
    delivery: (d) => {
      let country = d.to
      try {
        country = new Intl.DisplayNames([uiLang()], { type: "region" }).of(d.to) ?? d.to
      } catch {
        // the code itself
      }
      return d.ships === "yes" ? t("similarShipListed", country) : t("similarShipUnshown", country)
    }
  }
}
