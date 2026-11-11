// The Tips clips' language as the panel asks for it (build 95, the owner: «Важно вообще весь код проверить на наличие
// таких подгонов под меня, их быть не должно»; Russian was the one language with its own clips in the code). The
// panel sends its own language, whatever it is ("de", "pt_BR", "zh_TW"); the app picks the folder: that language's
// clips, else the person's next language that has them, else English (TipClipShare.language, SharedDefaults.swift).

/** A language code as the panel may send it ("en" for anything that isn't one). */
export function clipLanguage(lang: string | null | undefined): string {
  const code = (lang ?? "").trim()
  return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(code) ? code : "en"
}
