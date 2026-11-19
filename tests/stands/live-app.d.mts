// The stand-in mailbox (live-app.mjs) as the tests see it.
export declare const HINT: string
/** A set of the stand's words: "de" (all German) or "ru-en" (a Russian interface around letters in English). */
export declare function wordsOf(set?: string): any
/** The app built into `document.body`; see live-app.mjs for the options and the controls it returns. */
export declare function mountLiveApp(document: Document, opts?: Record<string, unknown>): any
