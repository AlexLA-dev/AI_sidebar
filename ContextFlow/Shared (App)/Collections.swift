import Foundation

// Подборки in the app (2.7, plan section 2; src/shared/collections.ts): a collection ("board" here: Swift's `Collection`
// is taken) is one record with its sections and cards, kept with the chats (`CollectionRecord`, ChatMirror.swift) and in
// iCloud. The edits below are the panel's, in Swift; every item gets its own time, so copies merge item by item.

/// Free: one collection of up to ten cards; Pro: no limit (src/shared/collections.ts FREE_COLLECTIONS, FREE_CARDS).
enum BoardLimits {
    static let freeBoards = 1
    static let freeCards = 10
    static let maxCards = 200
    static let maxSections = 20
    static let maxGist = 160
    static let maxText = 2_000
}

struct BoardTable: Hashable {
    var h: [String]
    var r: [[String]]
    var note: String?
}

struct BoardCard: Identifiable, Hashable {
    let id: String
    var sec: String
    var o: Double
    var u: Double
    var deleted = false
    /// "answer", "note" or "compare".
    var kind: String
    var gist: String
    var text: String?
    var srcURL: String?
    var srcTitle: String?
    var at: Double
    var tags: [String] = []
    var chat: String?
    var msg: String?
    var table: BoardTable?
    var of: [String] = []

    var site: String? { srcURL.map(host(of:)).flatMap { $0.isEmpty ? nil : $0 } }
    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

struct BoardSection: Identifiable, Hashable {
    let id: String
    var name: String
    var o: Double
    var u: Double
    var deleted = false
    /// Made by the AI's layout; the user's own sections have none.
    var ai = false
}

struct Board: Identifiable, Hashable {
    let id: String
    var name: String
    var space: String?
    var order: Double?
    var mu: Double
    var deleted = false
    var summary: String?
    var summaryU: Double?
    var sections: [BoardSection] = []
    var cards: [BoardCard] = []

    // MARK: Reading and writing the record

    init(id: String, name: String, space: String?, now: Double, first: (id: String, name: String)? = nil) {
        self.id = id
        self.name = Board.clean(name, 60)
        self.space = space == SpaceRecord.first ? nil : space
        mu = now
        if let first { sections = [BoardSection(id: first.id, name: Board.clean(first.name, 40), o: 0, u: now)] }
    }

    init?(id: String, data: String) {
        guard let o = CollectionRecord.parse(data) else { return nil }
        self.id = id
        name = o["n"] as? String ?? ""
        space = (o["sp"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        order = (o["o"] as? NSNumber)?.doubleValue
        mu = (o["mu"] as? NSNumber)?.doubleValue ?? 0
        deleted = o["d"] as? Bool == true
        if let sum = o["sum"] as? [String: Any], let t = sum["t"] as? String {
            summary = t
            summaryU = (sum["u"] as? NSNumber)?.doubleValue
        }
        sections = (o["s"] as? [[String: Any]] ?? []).compactMap { s in
            guard let id = s["id"] as? String, let u = (s["u"] as? NSNumber)?.doubleValue else { return nil }
            return BoardSection(id: id, name: s["n"] as? String ?? "", o: (s["o"] as? NSNumber)?.doubleValue ?? 0, u: u, deleted: s["d"] as? Bool == true, ai: s["ai"] as? Bool == true)
        }
        cards = (o["c"] as? [[String: Any]] ?? []).compactMap { c in
            guard let id = c["id"] as? String, let u = (c["u"] as? NSNumber)?.doubleValue else { return nil }
            let src = c["src"] as? [String: Any]
            let tbl = c["tbl"] as? [String: Any]
            let table = (tbl?["h"] as? [String]).map { BoardTable(h: $0, r: (tbl?["r"] as? [[String]]) ?? [], note: tbl?["note"] as? String) }
            return BoardCard(
                id: id, sec: c["sec"] as? String ?? "", o: (c["o"] as? NSNumber)?.doubleValue ?? 0, u: u, deleted: c["d"] as? Bool == true,
                kind: c["k"] as? String ?? "answer", gist: c["t"] as? String ?? "", text: c["x"] as? String,
                srcURL: src?["url"] as? String, srcTitle: src?["title"] as? String, at: (c["at"] as? NSNumber)?.doubleValue ?? u,
                tags: c["tags"] as? [String] ?? [], chat: c["chat"] as? String, msg: c["msg"] as? String, table: table, of: c["of"] as? [String] ?? []
            )
        }
    }

    private static func number(_ x: Double) -> NSNumber {
        x == x.rounded() && abs(x) < 9e15 ? NSNumber(value: Int64(x)) : NSNumber(value: x)
    }

    /// The record's JSON (CollectionRecord.json: one form whatever the order).
    var json: String? {
        var o: [String: Any] = ["v": 1, "kind": "collection", "id": id, "n": name, "mu": Board.number(mu)]
        if let space { o["sp"] = space }
        if let order { o["o"] = Board.number(order) }
        if deleted { o["d"] = true }
        if let summary, let summaryU { o["sum"] = ["t": summary, "u": Board.number(summaryU)] }
        o["s"] = sections.map { s -> [String: Any] in
            if s.deleted { return ["id": s.id, "n": "", "o": 0, "u": Board.number(s.u), "d": true] }
            var out: [String: Any] = ["id": s.id, "n": s.name, "o": Board.number(s.o), "u": Board.number(s.u)]
            if s.ai { out["ai"] = true }
            return out
        }
        o["c"] = cards.map { c -> [String: Any] in
            if c.deleted { return ["id": c.id, "sec": "", "o": 0, "u": Board.number(c.u), "d": true, "k": c.kind, "t": "", "at": 0] }
            var out: [String: Any] = ["id": c.id, "sec": c.sec, "o": Board.number(c.o), "u": Board.number(c.u), "k": c.kind, "t": c.gist, "at": Board.number(c.at)]
            if let text = c.text { out["x"] = text }
            if let url = c.srcURL { out["src"] = ["url": url, "title": c.srcTitle ?? ""] }
            if !c.tags.isEmpty { out["tags"] = c.tags }
            if let chat = c.chat { out["chat"] = chat }
            if let msg = c.msg { out["msg"] = msg }
            if let t = c.table {
                var tbl: [String: Any] = ["h": t.h, "r": t.r]
                if let note = t.note { tbl["note"] = note }
                out["tbl"] = tbl
            }
            if !c.of.isEmpty { out["of"] = c.of }
            return out
        }
        return CollectionRecord.json(o)
    }

    static func clean(_ text: String, _ max: Int) -> String {
        let line = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return line.count > max ? String(line.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : line
    }

    // MARK: Views

    var liveSections: [BoardSection] {
        sections.filter { !$0.deleted }.sorted { $0.o != $1.o ? $0.o < $1.o : $0.id < $1.id }
    }

    var liveCards: [BoardCard] { cards.filter { !$0.deleted } }

    /// A section's cards in their order; cards whose section is gone are in the first section.
    func cards(in sectionId: String) -> [BoardCard] {
        let live = liveSections
        let ids = Set(live.map(\.id))
        let first = live.first?.id
        return liveCards.filter { (ids.contains($0.sec) ? $0.sec : first) == sectionId }
            .sorted { $0.o != $1.o ? $0.o < $1.o : ($0.at != $1.at ? $0.at > $1.at : $0.id < $1.id) }
    }

    /// Cards that count against Free's ten (a comparison is made from cards already there).
    var countedCards: Int { liveCards.filter { $0.kind != "compare" }.count }

    func canAddCard(pro: Bool) -> Bool { countedCards < (pro ? BoardLimits.maxCards : BoardLimits.freeCards) }

    // MARK: Edits (each at `now`, newer than what it changes)

    private static func later(_ u: Double, _ now: Double) -> Double { max(now, u + 1) }

    mutating func rename(_ to: String, now: Double) {
        let n = Board.clean(to, 60)
        guard !n.isEmpty, n != name else { return }
        name = n
        mu = Board.later(mu, now)
    }

    mutating func delete(now: Double) {
        guard !deleted else { return }
        deleted = true
        mu = Board.later(mu, now)
    }

    mutating func addSection(_ sid: String, _ name: String, now: Double, ai: Bool = false) {
        guard liveSections.count < BoardLimits.maxSections else { return }
        let o = (liveSections.map(\.o).max() ?? -1) + 1
        sections.removeAll { $0.id == sid }
        sections.append(BoardSection(id: sid, name: Board.clean(name, 40), o: o, u: now, ai: ai))
    }

    mutating func renameSection(_ sid: String, _ to: String, now: Double) {
        let n = Board.clean(to, 40)
        guard !n.isEmpty, let i = sections.firstIndex(where: { $0.id == sid && !$0.deleted }) else { return }
        sections[i].name = n
        // Renamed by the user, it's theirs: the AI's layout keeps it.
        sections[i].ai = false
        sections[i].u = Board.later(sections[i].u, now)
    }

    mutating func moveSection(_ sid: String, to index: Int, now: Double) {
        var order = liveSections.filter { $0.id != sid }
        guard let moving = sections.first(where: { $0.id == sid && !$0.deleted }) else { return }
        order.insert(moving, at: max(0, min(index, order.count)))
        for (i, s) in order.enumerated() {
            if let k = sections.firstIndex(where: { $0.id == s.id }), sections[k].o != Double(i) {
                sections[k].o = Double(i)
                sections[k].u = Board.later(sections[k].u, now)
            }
        }
    }

    /// Its cards go to the first other section; the last section with cards stays.
    mutating func deleteSection(_ sid: String, now: Double) {
        let live = liveSections
        guard live.contains(where: { $0.id == sid }) else { return }
        let moved = cards(in: sid).map(\.id)
        let other = live.first { $0.id != sid }
        guard moved.isEmpty || other != nil, let k = sections.firstIndex(where: { $0.id == sid }) else { return }
        sections[k] = BoardSection(id: sid, name: "", o: 0, u: Board.later(sections[k].u, now), deleted: true)
        for cid in moved { moveCard(cid, to: other!.id, at: Int.max, now: now) }
    }

    mutating func addCard(_ card: BoardCard, now: Double) {
        var c = card
        c.o = (cards(in: card.sec).map(\.o).max() ?? -1) + 1
        c.u = now
        cards.removeAll { $0.id == card.id }
        cards.append(c)
    }

    mutating func moveCard(_ cid: String, to sid: String, at index: Int, now: Double) {
        guard let card = cards.first(where: { $0.id == cid && !$0.deleted }), liveSections.contains(where: { $0.id == sid }) else { return }
        var order = cards(in: sid).filter { $0.id != cid }
        order.insert(card, at: max(0, min(index, order.count)))
        for (i, c) in order.enumerated() {
            guard let k = cards.firstIndex(where: { $0.id == c.id }) else { continue }
            if c.id == cid {
                cards[k].sec = sid
                cards[k].o = Double(i)
                cards[k].u = Board.later(cards[k].u, now)
            } else if cards[k].o != Double(i) {
                cards[k].o = Double(i)
                cards[k].u = Board.later(cards[k].u, now)
            }
        }
    }

    mutating func deleteCard(_ cid: String, now: Double) {
        guard let k = cards.firstIndex(where: { $0.id == cid && !$0.deleted }) else { return }
        cards[k] = BoardCard(id: cid, sec: "", o: 0, u: Board.later(cards[k].u, now), deleted: true, kind: cards[k].kind, gist: "", at: 0)
    }

    mutating func setSummary(_ text: String, now: Double) {
        summary = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1_000))
        summaryU = Board.later(summaryU ?? 0, now)
    }

    /// «Сравнить»: a table card right after the compared cards, in the last one's section.
    mutating func addComparison(_ cid: String, of picked: [String], table: BoardTable, now: Double) {
        let chosen = liveCards.filter { picked.contains($0.id) }
        guard chosen.count >= 2, let sec = chosen.last?.sec else { return }
        addCard(BoardCard(id: cid, sec: sec, o: 0, u: now, kind: "compare", gist: table.note ?? String(chosen.map(\.gist).joined(separator: " · ").prefix(BoardLimits.maxGist)), at: now, table: table, of: chosen.map(\.id)), now: now)
        let here = cards(in: sec)
        let last = here.enumerated().filter { picked.contains($0.element.id) }.map(\.offset).max() ?? (here.count - 1)
        moveCard(cid, to: sec, at: last + 1, now: now)
    }

    /// The AI's layout: its sections (an existing id, or nil for a new one) and each card's section by index. The
    /// user's own sections stay; the AI's old ones it didn't keep go once empty.
    mutating func applyLayout(sections laid: [(id: String?, name: String)], cards placed: [(id: String, section: Int)], newId: () -> String, now: Double) {
        var ids: [String] = []
        for s in laid {
            if let id = s.id, liveSections.contains(where: { $0.id == id }) { ids.append(id) } else {
                let sid = newId()
                addSection(sid, s.name, now: now, ai: true)
                ids.append(sid)
            }
        }
        var counter: [String: Int] = [:]
        for c in placed where ids.indices.contains(c.section) {
            let sid = ids[c.section]
            let at = counter[sid, default: 0]
            counter[sid] = at + 1
            moveCard(c.id, to: sid, at: at, now: now)
        }
        for s in liveSections where s.ai && !ids.contains(s.id) && cards(in: s.id).isEmpty { deleteSection(s.id, now: now) }
    }

    // MARK: Cards from a chat

    /// A card's gist: the text's first sentences without Markdown or citations, up to `maxGist` characters.
    static func gist(_ text: String) -> String {
        let source = RowMarks.unlinked(text)
            .replacingOccurrences(of: #"\s*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?s)```.*?```"#, with: "\n", options: .regularExpression)
        let raw = source.components(separatedBy: "\n")
        let isTable = { (line: String) in line.range(of: #"^\s*\|"#, options: .regularExpression) != nil }
        var lines: [String] = []
        for (i, line) in raw.enumerated() {
            // A table is no gist; neither is a title line (a heading, or bold alone) with text after it.
            if isTable(line) { continue }
            if line.range(of: #"^\s{0,3}(#{1,6}\s+\S.*|\*\*[^*]+\*\*:?)\s*$"#, options: .regularExpression) != nil,
               raw[(i + 1)...].contains(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !isTable($0) }) { continue }
            var plain = line
            for (pattern, template) in [
                (#"!\[[^\]]*\]\([^)]*\)"#, " "), (#"\[([^\]]+)\]\([^)]*\)"#, "$1"), (#"^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+"#, ""),
                (#"[*_`~|]+"#, ""), (#"\s+"#, " ")
            ] {
                plain = plain.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
            }
            plain = plain.trimmingCharacters(in: .whitespaces)
            guard !plain.isEmpty else { continue }
            // Each line or bullet is a sentence of its own.
            lines.append(plain.range(of: #"[.!?。！？:：…]$"#, options: .regularExpression) != nil ? plain : plain + ".")
        }
        let joined = lines.joined(separator: " ")
        let plain = joined.isEmpty
            ? source.replacingOccurrences(of: #"[*_`~|#>-]+"#, with: " ", options: .regularExpression)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            : joined
        guard plain.count > BoardLimits.maxGist else { return plain }
        // Whole sentences from the start (a decimal point isn't the end of one).
        var out = ""
        let pieces = plain.replacingOccurrences(of: #"(?<=[.!?])\s+|(?<=[。！？])"#, with: "\u{1}", options: .regularExpression).components(separatedBy: "\u{1}")
        for piece in pieces where !piece.isEmpty {
            let next = out.isEmpty ? piece : out + " " + piece
            if next.count > BoardLimits.maxGist { break }
            out = next
        }
        return out.count >= 40 ? out : String(plain.prefix(BoardLimits.maxGist - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The card an answer or a note of `thread` becomes (src/shared/collections.ts cardFrom).
    static func card(from thread: ChatThread, _ index: Int, id cid: String, section: String, now: Double) -> BoardCard? {
        guard thread.entries.indices.contains(index) else { return nil }
        let e = thread.entries[index]
        guard !e.isUser || e.isNote else { return nil }
        // An answer's page is its question's; a note has only its own.
        var page = e.page
        var i = index - 1
        while page == nil, !e.isNote, i >= 0 {
            if thread.entries[i].isUser { page = thread.entries[i].page }
            i -= 1
        }
        let raw = thread.organized?.entries
        let msg = raw.flatMap { $0.indices.contains(index) ? Organize.entryKey($0[index]) : nil } ?? e.id
        let url = page?.url.lowercased().hasPrefix("http") == true ? page?.url : nil
        return BoardCard(
            id: cid, sec: section, o: 0, u: now, kind: e.isNote ? "note" : "answer", gist: gist(e.content),
            text: String(RowMarks.unlinked(e.content).prefix(BoardLimits.maxText)), srcURL: url, srcTitle: url == nil ? nil : page?.title,
            at: e.t ?? now, tags: Array((e.tags ?? []).prefix(10)), chat: thread.id, msg: msg
        )
    }

    // MARK: «В подборку» by words (Free, and when the AI can't)

    /// The words a card or a section is about: the panel's (TopicWords.swift), so Chinese, Japanese and Korean cards
    /// find their section too.
    private static func words(_ text: String) -> Set<String> { TopicWords.of(text) }

    /// The collection and section that share most of the card's words (src/shared/collections.ts suggestPlace).
    static func suggest(_ boards: [Board], gist: String, title: String?) -> (board: String, section: String?)? {
        let mine = words("\(gist) \(title ?? "")")
        var best: (board: String, section: String?, score: Double)?
        for b in boards where !b.deleted {
            var top: (section: String?, score: Double) = (b.liveSections.first?.id, 0)
            for s in b.liveSections {
                let theirs = words(([s.name] + b.cards(in: s.id).map { "\($0.gist) \($0.srcTitle ?? "")" }).joined(separator: " "))
                let n = Double(mine.filter { theirs.contains($0) }.count)
                let score = mine.isEmpty ? 0 : n / Double(mine.count)
                if score > top.score { top = (s.id, score) }
            }
            let score = top.score + Double(words(b.name).filter { mine.contains($0) }.count) * 0.1
            if best == nil || score > best!.score { best = (b.id, top.section, score) }
        }
        return best.map { ($0.board, $0.section) }
    }
}

// MARK: - The library's collections

extension ChatLibrary {
    /// The collections there are in the space shown (every one with Spaces off), by order, then newest.
    var liveBoards: [Board] {
        boards.filter { !$0.deleted && (!hasSpaces || SpaceRecord.resolve(spaceList, $0.space) == shownSpace) }
            .sorted { ($0.order ?? 0) != ($1.order ?? 0) ? ($0.order ?? 0) < ($1.order ?? 0) : ($0.mu != $1.mu ? $0.mu > $1.mu : $0.id < $1.id) }
    }

    /// Whether another collection can be made: Free has one (in every space together), Pro no limit.
    func canAddBoard(pro: Bool) -> Bool { pro || boards.filter { !$0.deleted }.count < BoardLimits.freeBoards }

    func newBoardId() -> String { CollectionRecord.prefix + UUID().uuidString.lowercased() }
    func newItemId() -> String { UUID().uuidString.lowercased() }

    /// Changes a collection (`change` gets it, or nil for a new one) and stores it here, for the extension and in iCloud.
    @discardableResult
    func changeBoard(_ id: String, _ change: (inout Board?) -> Void) -> Board? {
        var board = boards.first { $0.id == id }
        let before = board
        change(&board)
        guard let board, board != before, let data = board.json else { return before }
        let at = max(Int64(Date().timeIntervalSince1970 * 1000), (boardTimes[id] ?? 0) + 1)
        storeRecord(id, ChatMirror.Item(updatedAt: at, data: data))
        return board
    }

    /// A new collection in the space shown, with its first section; returns its id (nil: Free has one already).
    @discardableResult
    func addBoard(name: String, firstSection: String, pro: Bool) -> String? {
        guard canAddBoard(pro: pro) else { return nil }
        let id = newBoardId()
        let now = Double(Date().timeIntervalSince1970 * 1000)
        let space = spacesOn ? shownSpace : nil
        changeBoard(id) { $0 = Board(id: id, name: name, space: space, now: now, first: (newItemId(), firstSection)) }
        return id
    }
}
