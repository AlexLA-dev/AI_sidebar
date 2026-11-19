// A stand-in for a web mailbox and pages like it (feeds, single-page apps), for testing page translation (2.7,
// build 110; the owner: «надо разобраться по коду как ведет себя страница при разных переключениях, чтобы проверять
// это потом на тестах эмулируя поведение таких и подобных страниц»).
//
// It does to its page what a real mailbox was recorded doing (Gmail, 18 switches, shapes and counts only: the record
// is in the PR and in the director's notes). The kinds of behaviour, by letter:
//   A  a view hidden and shown again as the same nodes (the list while a letter is open; a folder seen before)
//   B  a view built new each time it's opened (a letter; a folder the first time; a page of the list)
//   C  a view removed when it's left (search results)
//   D  shown rows redrawn in place after the list comes back: the same words in new cells, in several waves
//   E  a stub hidden and the whole thing added beside it (a collapsed letter of a thread opened)
//   F  attributes: labels and tooltips set late, `title` moved to `data-tooltip`, the same value written again, a
//      field's placeholder changed with the tab
//   G  tooltip elements: in the page beforehand (aria-hidden), and one added at the pointer
//   H  an editor opened inside the page (contenteditable), with the letter's words quoted in it: stays as it is
//   I  the address: `#…` changes for a letter, a folder, a search, a page of the list; none for a tab, a collapsed
//      letter, the reply box
//   J  a quiet tick: a wordless node added and removed and styles changed, twice a second
//   K  content that keeps arriving in pieces for a while after a switch
//   L  a hint the site keeps writing back (a shop's search field): by a timer, or by an observer of its own
//   M  the page's own words that aren't controls: a label's chip and a date in each row, «to: me» and the time in a
//      letter's head, a line that comes up after an action («marked as unread · Undo») and goes away
//   N  buttons the page calls links (role="link": «Reply», «Forward»), one with a badge («New»)
//   O  the search field's hint set again, with the words it had, on every switch of view
//
// Two sets of words (`opts.words`): "de", everything German (a page in another language, translated whole); and
// "ru-en", the interface Russian around letters in English: what the owner had, with only «buttons and menus»
// translated into English, the letters being in the reader's language already.
//
// One emulation, two users: the automated tests (tests/translate-live-app.test.mts: linkedom has no layout and its
// MutationObserver isn't the browsers', so every change made here is also reported through `opts.records`, and time
// is moved by hand with `run`), and the page live-app.html (real browsers: WebKit, the simulators), where the same
// code runs on clicks and real timers.
//
// Names (senders) are marked translate="no" as the mailbox marks them.

const DE = (() => {
const LETTERS = [
  { from: "Stadtwerke Köln", subject: "Ihre Abrechnung für Oktober", snippet: "Die Rechnung liegt in Ihrem Kundenkonto bereit.", date: "16. Nov.", full: "Montag, 16. November", body: ["Guten Tag, Ihre Abrechnung für Oktober ist fertig.", "Der Betrag wird in zehn Tagen von Ihrem Konto abgebucht."], thread: 3 },
  { from: "Buchhandlung Lesezeichen", subject: "Ihre Bestellung ist unterwegs", snippet: "Das Paket wurde heute an den Zusteller übergeben.", date: "15. Nov.", full: "Sonntag, 15. November", body: ["Ihre Bücher sind auf dem Weg zu Ihnen.", "Die Zustellung erfolgt voraussichtlich am Mittwoch."], thread: 1 },
  { from: "Zahnarztpraxis Dr. Weber", subject: "Erinnerung an Ihren Termin", snippet: "Wir erwarten Sie am Donnerstag um neun Uhr.", date: "14. Nov.", full: "Samstag, 14. November", body: ["Bitte denken Sie an Ihren Termin am Donnerstag.", "Sagen Sie rechtzeitig ab, wenn Sie nicht kommen können."], thread: 1 },
  { from: "Sportverein Blau-Weiß", subject: "Einladung zur Jahresversammlung", snippet: "Alle Mitglieder sind herzlich eingeladen.", date: "12. Nov.", full: "Donnerstag, 12. November", body: ["Die Versammlung findet im Vereinsheim statt.", "Auf der Tagesordnung steht die Wahl des Vorstands."], thread: 1 }
]
const SENT = [
  { from: "An: Hausverwaltung", subject: "Frage zur Nebenkostenabrechnung", snippet: "Können Sie mir die Belege zusenden?", date: "10. Nov.", full: "Dienstag, 10. November", body: ["Ich habe eine Frage zur letzten Abrechnung."], thread: 1 },
  { from: "An: Reisebüro Fernweh", subject: "Umbuchung der Bahnfahrt", snippet: "Ich möchte einen Tag später fahren.", date: "8. Nov.", full: "Sonntag, 8. November", body: ["Bitte buchen Sie meine Fahrt um."], thread: 1 }
]
const PAGE_TWO = [
  ["Stromanbieter Nordlicht", "Neuer Tarif ab Januar", "Ihr Vertrag wird günstiger."],
  ["Bibliothek am Markt", "Ihre Leihfrist endet bald", "Zwei Bücher sind nächste Woche fällig."],
  ["Fahrradladen Kette", "Ihr Rad ist abholbereit", "Die Reparatur ist abgeschlossen."],
  ["Volkshochschule", "Ihr Kurs beginnt am Montag", "Bitte bringen Sie ein Heft mit."],
  ["Gartenverein Sonnenhang", "Arbeitseinsatz im Frühjahr", "Wir treffen uns am Geräteschuppen."],
  ["Stadtbücherei", "Neue Hörbücher eingetroffen", "Sie können sie ab sofort ausleihen."]
]
const TABS = [["Allgemein", "In allen Nachrichten suchen"], ["Werbung", "In der Werbung suchen"], ["Benachrichtigungen", "In den Benachrichtigungen suchen"]]
const LIST_TOOLS = [["Archivieren", "archive"], ["Als Spam melden", "report"], ["Löschen", "delete"], ["Als ungelesen markieren", "mail"]]
const LETTER_TOOLS = [["Zurück zum Posteingang", "back"], ["Archivieren", "archive"], ["Löschen", "delete"], ["Alle drucken", "print"], ["In neuem Fenster öffnen", "open"]]
const EDITOR_TOOLS = ["Fett", "Kursiv", "Liste mit Aufzählungszeichen", "Formatierung entfernen"]

  return {
    LETTERS, SENT, PAGE_TWO, TABS, LIST_TOOLS, LETTER_TOOLS, EDITOR_TOOLS,
    hint: "Suche nach Angeboten der Woche!", title: "Postfach", searchLabel: "Nachrichten durchsuchen",
    inbox: "Posteingang", sent: "Gesendet", searchLink: "Suche: gelesene Nachrichten", chip: "Posteingang",
    toMe: "an: mich", ago: "13:47 (vor 21 Minuten)", reply: "Antworten", forward: "Weiterleiten", share: "Im Chat teilen", badge: "Neu",
    quick: ["Vielen Dank!", "Ich melde mich später.", "Das passt mir gut."], searching: "Suche läuft…",
    expanded: ["Vielen Dank für Ihre Nachricht vom letzten Monat.", "Wir haben Ihre Angaben geprüft und alles ist in Ordnung."],
    editor: "Nachrichtentext", to: "An", recipients: "Empfänger", subject: "Betreff", send: "Senden",
    toast: "Die Unterhaltung wurde als ungelesen markiert.", undo: "Rückgängig",
    page2: (i) => ({ date: `${9 - i}. Nov.`, full: `${9 - i}. November` })
  }
})()

// The interface in Russian around letters in English.
const RU_EN = {
  LETTERS: [
    { from: "Northwind Power", subject: "Your October statement", snippet: "The invoice is ready in your account.", date: "16 нояб.", full: "понедельник, 16 ноября", body: ["Hello, your statement for October is ready.", "The amount will be taken from your account in ten days."], thread: 3 },
    { from: "Bookmark Books", subject: "Your order is on its way", snippet: "The parcel was handed to the courier today.", date: "15 нояб.", full: "воскресенье, 15 ноября", body: ["Your books are on their way to you.", "Delivery is expected on Wednesday."], thread: 1 },
    { from: "Dr. Weber Dental", subject: "A reminder of your appointment", snippet: "We expect you on Thursday at nine.", date: "14 нояб.", full: "суббота, 14 ноября", body: ["Please remember your appointment on Thursday.", "Let us know in time if you can't come."], thread: 1 },
    { from: "Blue and White Sports Club", subject: "Invitation to the annual meeting", snippet: "All members are warmly invited.", date: "12 нояб.", full: "четверг, 12 ноября", body: ["The meeting takes place at the clubhouse.", "The election of the board is on the agenda."], thread: 1 }
  ],
  SENT: [
    { from: "To: Property Office", subject: "A question about the service charges", snippet: "Could you send me the receipts?", date: "10 нояб.", full: "вторник, 10 ноября", body: ["I have a question about the last statement."], thread: 1 },
    { from: "To: Wanderlust Travel", subject: "Changing the train booking", snippet: "I'd like to travel a day later.", date: "8 нояб.", full: "воскресенье, 8 ноября", body: ["Please change my booking."], thread: 1 }
  ],
  PAGE_TWO: [
    ["Northern Light Energy", "A new tariff from January", "Your contract gets cheaper."],
    ["Market Library", "Your loan period ends soon", "Two books are due next week."],
    ["Chain Bike Shop", "Your bike is ready to collect", "The repair is finished."],
    ["Adult Education Centre", "Your course starts on Monday", "Please bring a notebook."],
    ["Sunny Slope Garden Club", "Spring work day", "We meet at the tool shed."],
    ["City Library", "New audiobooks have arrived", "You can borrow them from today."]
  ],
  TABS: [["Несортированные", "Поиск в почте"], ["Промоакции", "Поиск в промоакциях"], ["Оповещения", "Поиск в оповещениях"]],
  LIST_TOOLS: [["Архивировать", "archive"], ["В спам", "report"], ["Удалить", "delete"], ["Отметить как непрочитанное", "mail"]],
  LETTER_TOOLS: [["Назад во входящие", "back"], ["Архивировать", "archive"], ["Удалить", "delete"], ["Распечатать все", "print"], ["Открыть в новом окне", "open"]],
  EDITOR_TOOLS: ["Полужирный", "Курсив", "Маркированный список", "Удалить форматирование"],
  hint: "Ищите предложения недели!", title: "Почта", searchLabel: "Поиск по письмам",
  inbox: "Входящие", sent: "Отправленные", searchLink: "Поиск: прочитанные письма", chip: "Входящие",
  toMe: "кому: мне", ago: "13:47 (21 минуту назад)", reply: "Ответить", forward: "Переслать", share: "Поделиться в чате", badge: "Новое",
  quick: ["Большое спасибо!", "Отвечу позже.", "Мне подходит."], searching: "Идёт поиск…",
  expanded: ["Thank you for your message of last month.", "We have checked your details and everything is in order."],
  editor: "Текст письма", to: "Кому", recipients: "Получатели", subject: "Тема", send: "Отправить",
  toast: "Цепочка отмечена как непрочитанная.", undo: "Отменить",
  page2: (i) => ({ date: `${9 - i} нояб.`, full: `${9 - i} ноября` })
}
const WORDS = { de: DE, "ru-en": RU_EN }
export const HINT = DE.hint
export const wordsOf = (set) => WORDS[set] ?? DE

/**
 * The app, built into `document.body` (which should be empty). `opts`:
 *   records(list)  every change made to the page, as a browser's MutationObserver would report it (tests)
 *   manual         time is moved with `run(ms)` instead of real timers (tests)
 *   onAddress(u)   the address changed (tests; in a browser the page's own location does)
 *   hint           "timer" | "observer": the search hint is kept as the site wrote it (L)
 *   words          "de" (all German) or "ru-en" (a Russian interface around letters in English)
 * Returns the controls a person has: open(i), back(), folder(name), tab(i), search(), nextPage(), expand(),
 * reply(), hover(i), tick(), and for tests: run(ms), url(), els (the parts by name).
 */
export function mountLiveApp(document, opts = {}) {
  const W = wordsOf(opts.words)
  const { LETTERS, SENT, PAGE_TWO, TABS, LIST_TOOLS, LETTER_TOOLS, EDITOR_TOOLS } = W
  const HINT_NOW = W.hint
  const base = opts.base ?? "https://post.example/mail/u/0/"
  let hash = "#inbox"
  let pending = []
  const timers = []
  let clock = 0

  // ---- every change goes through these, so it can be reported
  const flush = () => {
    if (!pending.length || !opts.records) return void (pending = [])
    const list = pending
    pending = []
    opts.records(list)
  }
  const el = (tag, attrs = {}, kids = []) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    for (const kid of [].concat(kids)) node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
    return node
  }
  const put = (parent, node, before = null) => {
    parent.insertBefore(node, before)
    pending.push({ type: "childList", target: parent, addedNodes: [node], removedNodes: [] })
    return node
  }
  const take = (node) => {
    const parent = node.parentNode
    if (!parent) return
    parent.removeChild(node)
    pending.push({ type: "childList", target: parent, addedNodes: [], removedNodes: [node] })
  }
  const attr = (node, name, value) => {
    if (value === null) node.removeAttribute(name)
    else node.setAttribute(name, value)
    pending.push({ type: "attributes", target: node, attributeName: name })
  }
  const hide = (node) => attr(node, "style", "display: none")
  const show = (node) => attr(node, "style", "")
  const later = (ms, fn) => {
    const task = () => {
      fn()
      flush()
    }
    if (opts.manual) timers.push({ at: clock + ms, task })
    else setTimeout(task, ms)
  }
  const go = (to) => {
    hash = to
    if (opts.onAddress) opts.onAddress(base + to)
    else if (typeof location !== "undefined" && location.hash !== to) location.hash = to
  }

  // ---- the frame of the app: header, tabs, toolbar, folders, the holder of the views
  const body = document.body
  const search = el("input", { type: "search", placeholder: TABS[0][1], "aria-label": W.searchLabel })
  const hint = el("label", { class: "hint" }, [el("span", {}, HINT_NOW)])
  const tabs = el("div", { role: "tablist" }, TABS.map(([name], i) => el("div", { role: "tab", "aria-selected": String(i === 0), "data-tab": String(i) }, name)))
  // An icon button as the mailbox draws it: no words of its own, a label, a tooltip element beside it (G).
  const tool = ([label, icon]) => el("span", { class: "tool" }, [
    el("div", { role: "button", "aria-label": label, title: label, "data-icon": icon }, [el("span", { class: "icon", "aria-hidden": "true" }, "■")]),
    el("div", { role: "tooltip", "aria-hidden": "true", class: "tip" }, label)
  ])
  const listTools = el("div", { role: "toolbar", class: "tools list-tools" }, LIST_TOOLS.map(tool))
  const folders = el("nav", {}, [el("a", { href: "#inbox", "data-folder": "inbox" }, W.inbox), el("a", { href: "#sent", "data-folder": "sent" }, W.sent), el("a", { href: "#search", "data-folder": "search" }, W.searchLink)])
  const main = el("div", { class: "views" })
  const ticker = el("div", { class: "ticker", "aria-hidden": "true" })
  body.appendChild(el("header", {}, [el("strong", {}, W.title), el("div", { class: "search" }, [search, hint]), tabs]))
  body.appendChild(folders)
  body.appendChild(listTools)
  body.appendChild(main)
  body.appendChild(ticker)

  // ---- a list of letters (the inbox, a folder, a page of the list, search results)
  const cells = (m) => [
    el("td", { class: "from" }, [el("span", { translate: "no", class: "name" }, m.from)]),
    // M: the label's chip stands in the row, before the letter's own words.
    el("td", { role: "gridcell", class: "what" }, [el("div", { class: "chip" }, W.chip), el("span", { class: "subject" }, m.subject), el("span", { class: "snippet" }, " — " + m.snippet)]),
    // The date as the mailbox writes it: the short one for the eye (aria-hidden), the long one in a title beside it.
    el("td", { class: "when" }, [el("span", { title: m.full, "aria-label": m.full }, [el("span", { "aria-hidden": "true" }, m.date)])])
  ]
  const row = (m, i) => el("tr", { role: "row", "data-letter": String(i) }, cells(m))
  const list = (name, letters) => {
    const tbody = el("tbody", {}, letters.map(row))
    const view = el("div", { role: "main", class: "view list", "data-view": name }, [el("table", { role: "grid" }, [tbody])])
    view.letters = letters
    view.tbody = tbody
    return view
  }
  const views = { inbox: list("inbox", LETTERS) }
  main.appendChild(views.inbox)
  let shown = views.inbox
  let listShown = views.inbox
  let letterView = null
  let tooltip = null

  const swap = (view) => {
    if (shown === view) return
    if (shown) hide(shown)
    if (view.parentNode) show(view)
    else put(main, view)
    shown = view
  }
  // D: the rows of a list that has just come back are drawn again, the same words in new cells, in waves.
  const redraw = (view) => {
    const rows = Array.from(view.tbody.childNodes)
    const wave = (from, to) => {
      for (const tr of rows.slice(from, to)) {
        if (!tr.parentNode) continue
        const m = view.letters[Number(tr.getAttribute("data-letter"))]
        for (const td of Array.from(tr.childNodes)) take(td)
        for (const td of cells(m)) put(tr, td)
      }
    }
    const third = Math.ceil(rows.length / 3)
    later(300, () => wave(0, third))
    later(1100, () => wave(third, third * 2))
    later(1500, () => wave(third * 2, rows.length))
  }
  // F: the toolbar's buttons get their labels late; `title` is moved to `data-tooltip`; a label is written again
  // with the value it had.
  const dress = (toolbar) => {
    for (const b of Array.from(toolbar.querySelectorAll("[role=button]"))) {
      const label = b.getAttribute("title") ?? b.getAttribute("aria-label")
      if (b.hasAttribute("title")) {
        attr(b, "data-tooltip", label)
        attr(b, "title", null)
      }
      attr(b, "aria-label", label)
    }
  }

  // O: the search field's hint, set again with the words it has (the tab's) on a switch of view.
  let tabNow = 0
  const again = () => attr(search, "placeholder", TABS[tabNow][1])

  // ---- what a person does
  const app = {
    els: { search, hint, tabs, listTools, folders, main, views },
    url: () => base + hash,
    /** B, A, F, K, I: a letter opened from the list that shows. */
    open(i) {
      const m = listShown.letters[i]
      go(`${hash.split("/")[0]}/letter${i}`)
      const items = []
      for (let n = 0; n < m.thread; n++) {
        const last = n === m.thread - 1
        // E: the earlier letters of a thread are stubs until they're opened.
        const item = el("div", { role: "listitem", class: last ? "letter" : "letter collapsed" }, last
          ? [el("div", { class: "head" }, [el("span", { translate: "no", class: "name" }, m.from), el("span", { title: m.full, class: "when" }, W.ago)]), el("div", { class: "tome" }, W.toMe), el("div", { class: "body" }, m.body.map((p) => el("p", {}, p)))]
          : [el("div", { class: "stub", "data-stub": String(n) }, [el("span", { translate: "no", class: "name" }, m.from), el("span", { class: "snippet" }, " " + m.body[0])])])
        items.push(item)
      }
      const tools = el("div", { role: "toolbar", class: "tools letter-tools" }, LETTER_TOOLS.map(tool))
      const view = el("div", { role: "main", class: "view letter-view", "data-view": "letter" }, [tools, el("h2", {}, m.subject), el("div", { role: "list" }, items), el("div", { class: "answer" }, [el("span", { role: "link", class: "reply" }, W.reply), el("span", { role: "link", class: "forward" }, W.forward), el("span", { role: "link", class: "share" }, [el("span", { class: "share-words" }, W.share), el("span", { class: "badge" }, W.badge)])])])
      view.letter = m
      letterView = view
      hide(listShown)
      put(main, view)
      shown = view
      again()
      later(120, () => dress(tools))
      // K: pieces that come later (quick answers under the letter).
      later(600, () => put(view, el("div", { class: "quick" }, W.quick.map((q) => el("button", {}, q)))))
      flush()
    },
    /** A, D, I: back to the list the letter was opened from. The letter's view is taken out. */
    back() {
      if (!letterView) return
      go(hash.split("/")[0])
      take(letterView)
      letterView = null
      show(listShown)
      shown = listShown
      redraw(listShown)
      again()
      // M: a line about what was just done, with a way back, for a few seconds.
      later(500, () => {
        const toast = put(body, el("div", { role: "alert", class: "toast" }, [el("span", { class: "toast-words" }, W.toast), el("span", { role: "link", class: "undo" }, W.undo)]))
        later(4000, () => take(toast))
      })
      flush()
    },
    /** B the first time, A afterwards; C for the search (its view is removed when left). */
    folder(name) {
      if (name === "search") return app.search()
      go(`#${name}`)
      if (views.search) {
        take(views.search)
        if (shown === views.search) shown = null
        delete views.search
      }
      if (letterView) {
        take(letterView)
        letterView = null
      }
      if (!views[name]) views[name] = list(name, name === "sent" ? SENT : LETTERS)
      swap(views[name])
      listShown = views[name]
      later(150, () => dress(listTools))
      flush()
    },
    /** C, K: the search results come a moment after the address changed, and are removed when left. */
    search() {
      go("#search/gelesen")
      const view = el("div", { role: "main", class: "view list", "data-view": "search" }, [el("p", { class: "searching" }, W.searching)])
      views.search = view
      swap(view)
      later(400, () => {
        if (views.search !== view) return
        const found = list("search", LETTERS.slice(1, 3))
        take(view.firstChild)
        put(view, found.firstChild)
        view.letters = found.letters
        view.tbody = found.tbody
        listShown = view
      })
      flush()
    },
    /** F, I: a category tab: no address change; the search field's hint changes; the tab's own list shows. */
    tab(i) {
      for (const t of Array.from(tabs.childNodes)) attr(t, "aria-selected", String(t.getAttribute("data-tab") === String(i)))
      tabNow = i
      attr(search, "placeholder", TABS[i][1])
      // The same value written again, as the mailbox does.
      attr(search, "aria-label", search.getAttribute("aria-label"))
      const name = i === 0 ? "inbox" : `tab${i}`
      if (!views[name]) views[name] = list(name, LETTERS.slice(i, i + 2))
      swap(views[name])
      listShown = views[name]
      flush()
    },
    /** B, K, I: the next page of the list comes in chunks. */
    nextPage() {
      go("#inbox/p2")
      const view = list("page2", [])
      view.letters = PAGE_TWO.map(([from, subject, snippet], i) => ({ from, subject, snippet, ...W.page2(i), body: [snippet], thread: 1 }))
      swap(view)
      listShown = view
      views.page2 = view
      for (let chunk = 0; chunk < 3; chunk++) later(200 + chunk * 350, () => view.letters.slice(chunk * 2, chunk * 2 + 2).forEach((m, k) => put(view.tbody, row(m, chunk * 2 + k))))
      flush()
    },
    /** E: a collapsed letter of the open thread: its stub hidden, its body added. */
    expand(n = 0) {
      const stub = letterView?.querySelector(`[data-stub="${n}"]`)
      if (!stub) return false
      hide(stub)
      put(stub.parentNode, el("div", { class: "body" }, W.expanded.map((p) => el("p", {}, p))))
      flush()
      return true
    },
    /** H, F: the reply box under the letter: an editor with the letter quoted in it, its fields and its toolbar. */
    reply() {
      if (!letterView) return
      const editor = el("div", { role: "textbox", contenteditable: "true", "aria-label": W.editor, class: "editor" }, [el("div", {}, [el("br")]), el("blockquote", {}, letterView.letter.body[0])])
      const box = el("div", { class: "compose" }, [
        el("div", { class: "to" }, [el("span", {}, W.to), el("input", { "aria-label": W.recipients, value: letterView.letter.from })]),
        el("input", { "aria-label": W.subject, placeholder: W.subject, value: "Re: " + letterView.letter.subject }),
        editor,
        el("div", { role: "toolbar", class: "tools editor-tools" }, [...EDITOR_TOOLS.map((t) => tool([t, "fmt"])), el("div", { role: "button", class: "send" }, W.send)])
      ])
      put(letterView, box)
      later(100, () => dress(box.querySelector("[role=toolbar]")))
      flush()
    },
    /** G: the pointer over the i-th button of the shown toolbar: a tooltip element is added to the page. */
    hover(i = 0) {
      const b = Array.from((letterView ?? body).querySelectorAll("[role=toolbar] [role=button]"))[i]
      if (tooltip) take(tooltip)
      tooltip = put(body, el("div", { role: "tooltip", "aria-hidden": "true", class: "tip floating" }, b.getAttribute("data-tooltip") ?? b.getAttribute("aria-label") ?? ""))
      flush()
      return b
    },
    /** J: one beat of the quiet tick. */
    tick() {
      for (const dot of Array.from(ticker.childNodes)) take(dot)
      put(ticker, el("i", { class: "dot" }))
      attr(ticker, "style", `opacity: ${clock % 2 ? "0.4" : "0.9"}`)
      flush()
    },
    /** L: the site writes its hint again (what its timer or its observer does when the words aren't its own). */
    hintAgain() {
      if (hint.textContent === HINT_NOW) return false
      for (const kid of Array.from(hint.childNodes)) take(kid)
      put(hint, el("span", {}, HINT_NOW))
      flush()
      return true
    },
    /** Tests: `ms` of the app's time pass (its late pieces arrive, in order, each as a change of its own). */
    run(ms) {
      const until = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > until) break
        timers.shift()
        clock = next.at
        next.task()
      }
      clock = until
    }
  }
  if (!opts.manual) {
    if (opts.tick !== false) setInterval(() => app.tick(), 550)
    if (opts.hint === "timer") setInterval(() => app.hintAgain(), 220)
    if (opts.hint === "observer" && typeof MutationObserver !== "undefined") new MutationObserver(() => app.hintAgain()).observe(hint, { childList: true, subtree: true, characterData: true })
  }
  return app
}
