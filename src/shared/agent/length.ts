// Length rules that hold in every script (2.8, round 139): a Han, kana or Hangul character says about what three
// Latin ones do, so «a long card link» or «a short button» is judged by a weighted length, not by characters.

export const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const DENSE_ALL = new RegExp(DENSE.source, "gu")

/** A text's length for rules about «long» or «short»: a Han, kana or Hangul character counts three. */
export function weightedLength(s: string): number {
  return s.length + (s.match(DENSE_ALL) ?? []).length * 2
}
