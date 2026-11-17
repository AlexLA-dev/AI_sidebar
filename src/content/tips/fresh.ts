// Tips' quiet «New» (107, the owner: «подсвечивались слегка те новые функции, которые добавлены в текущей версии»).
// Apart from data.ts so the rule can be checked without the extension's globals.

/** A card whose feature is new in the installed version (the one What's new is about): marked until the next version. */
export function isNewTip(tip: { since?: string } | null | undefined, data: { newIn?: string } | null | undefined): boolean {
  return Boolean(tip?.since && data?.newIn && tip.since === data.newIn)
}
