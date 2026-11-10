import Foundation

// Organizing the chats (2.5), the app's side of src/shared/conversation.ts, threads.ts and organize.ts:
// message keys and times, page blocks, moving a block to another chat with undo, the sweep for moved
// messages, and the suggestion rules (a better chat for a block, or a new one; the user's own tags for an
// answer or a note). Plain Foundation and the chats' own JSON (unknown fields are kept): the parity test
// (tests/organize-parity.test.mts) builds this file on its own and checks it gives what the panel gives.

/// A chat as stored: its id, the time of its copy (ms) and its JSON object `{title?, a?, pin?, k?, tags?, m}`.
/// Organizing is pure work on these (no UI): nonisolated, so the app runs it off the main thread (2.6 (91)).
nonisolated struct OrganizeThread {
    var id: String
    var u: Int64
    let object: [String: Any]
    /// Its messages, read once: each read of `object["m"]` casts the whole list again (2.6 (91): with hundreds of chats
    /// that alone took seconds).
    let entries: [[String: Any]]

    init(id: String, u: Int64, object: [String: Any]) {
        self.id = id
        self.u = u
        self.object = object
        entries = object["m"] as? [[String: Any]] ?? []
    }

    /// A chat from its stored JSON (2.3 build 56 stored just the messages); nil if it isn't one.
    init?(id: String, u: Int64, data: String) {
        let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8))
        guard let object = (parsed as? [String: Any]) ?? (parsed as? [Any]).map({ ["m": $0] }) else { return nil }
        self.init(id: id, u: u, object: object)
    }
    var isHistory: Bool { object["k"] as? String == "history" }
    /// Kept until iCloud knows it's gone (the panel's `deleted`).
    var isDeleted: Bool { Organize.truthy(object["deleted"]) }
    /// When it last got a message (ms); missing means `u`.
    var activity: Double { (object["a"] as? NSNumber)?.doubleValue ?? Double(u) }
    /// What organizing suggested for it, kept with it (2.6 (93), "org").
    var org: OrgState? { OrgState(object["org"]) }

    func with(u: Int64, a: Double, m: [[String: Any]]) -> OrganizeThread {
        var next = object
        next["m"] = m
        next["a"] = Organize.whole(a)
        return OrganizeThread(id: id, u: u, object: next)
    }
}

/// Organizing's suggestions for a chat, kept with it (2.6 (93), src/shared/threads.ts `OrgState`, iCloud "org"): worked
/// out when the chat had `n` messages, the last one `k`; another device shows them at once while the chat is still like
/// that. `mv`: the move; `tg`: [message key, tag] the check said yes to; `nm`: the name check (what it was about, the name
/// it suggests while open, the names turned down, which never come back); `mx` (2.6 (94)): the chats a merge into was
/// turned down for. Read as `cleanOrgState` reads it.
nonisolated struct OrgState: Hashable, Decodable {
    struct Move: Hashable {
        var s: Int
        var e: Int
        var to: String?
        var why: Organize.MoveReason
        var mt: Double?
    }

    struct Tag: Hashable {
        var key: String
        var tag: String
    }

    struct Name: Hashable {
        var k: String
        var t: String?
        var no: [String] = []
    }

    var n: Int
    var k: String
    var mv: Move?
    var tg: [Tag] = []
    var nm: Name?
    var mx: [String] = []

    init(n: Int, k: String, mv: Move? = nil, tg: [Tag] = [], nm: Name? = nil, mx: [String] = []) {
        self.n = n
        self.k = k
        self.mv = mv
        self.tg = tg
        self.nm = nm
        self.mx = mx
    }

    /// From the chat's JSON (`object["org"]`); nil if it isn't one.
    init?(_ raw: Any?) {
        guard let raw, raw is [String: Any], JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw), let read = try? JSONDecoder().decode(OrgState.self, from: data) else { return nil }
        self = read
    }

    private enum Keys: String, CodingKey { case n, k, mv, tg, nm, mx, s, e, to, why, mt, t, no }

    /// Each part on its own: one that doesn't make sense is left out, the rest kept.
    private struct Maybe<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        n = try c.decode(Int.self, forKey: .n)
        k = try c.decode(String.self, forKey: .k)
        if let m = try? c.nestedContainer(keyedBy: Keys.self, forKey: .mv),
           let s = try? m.decode(Int.self, forKey: .s), let e = try? m.decode(Int.self, forKey: .e),
           let why = (try? m.decode(String.self, forKey: .why)).flatMap(Organize.MoveReason.init(rawValue:)) {
            let to: String?? = (try? m.decodeNil(forKey: .to)) == true ? .some(nil) : (try? m.decode(String.self, forKey: .to)).map { .some($0) }
            if let to { mv = Move(s: s, e: e, to: to, why: why, mt: try? m.decode(Double.self, forKey: .mt)) }
        }
        let pairs = (try? c.decode([Maybe<[Maybe<String>]>].self, forKey: .tg)) ?? []
        tg = pairs.compactMap { pair in
            guard let items = pair.value, items.count >= 2, let key = items[0].value, let tag = items[1].value else { return nil }
            return Tag(key: key, tag: tag)
        }
        if let m = try? c.nestedContainer(keyedBy: Keys.self, forKey: .nm), let key = try? m.decode(String.self, forKey: .k) {
            let t = (try? m.decode(String.self, forKey: .t)).flatMap { $0.isEmpty ? nil : $0 }
            let no = ((try? m.decode([Maybe<String>].self, forKey: .no)) ?? []).compactMap(\.value)
            nm = Name(k: key, t: t, no: no)
        }
        mx = Array(((try? c.decode([Maybe<String>].self, forKey: .mx)) ?? []).compactMap(\.value).filter { !$0.isEmpty }.suffix(20))
    }

    /// As the chat's JSON keeps it (what the panel writes).
    var json: [String: Any] {
        var out: [String: Any] = ["n": n, "k": k]
        if let mv { out["mv"] = mv.json }
        if !tg.isEmpty { out["tg"] = tg.map { [$0.key, $0.tag] } }
        if let nm { out["nm"] = nm.json }
        if !mx.isEmpty { out["mx"] = mx }
        return out
    }
}

nonisolated extension OrgState.Move {
    var json: [String: Any] {
        var out: [String: Any] = ["s": s, "e": e, "to": to ?? NSNull(), "why": why.rawValue]
        if let mt { out["mt"] = Organize.whole(mt) }
        return out
    }
}

nonisolated extension OrgState.Name {
    var json: [String: Any] {
        var out: [String: Any] = ["k": k]
        if let t { out["t"] = t }
        if !no.isEmpty { out["no"] = no }
        return out
    }
}

/// What decides a suggestion (src/shared/organize.ts `OrganizeConfig`, chat-organize-2.5.md §2); the server
/// sends its own values in /api/v2/status. All numbers, as in JavaScript (the counts too).
nonisolated struct OrganizeConfig: Sendable {
    // Move: the block's fit to the other chat (mean of the two best block similarities), the margin over
    // its fit to its own chat, and the fit needed when the other chat has a single block.
    var moveT = 0.55
    var moveD = 0.1
    var moveT1 = 0.65
    // Same site: the fit to the one other chat about that site.
    var siteT = 0.35
    // Two blocks this alike are on one topic: what "a chat is mostly about this" counts (2.6: moves only make chats
    // more about one thing).
    var topicT = 0.4
    // The match shown with a move (2.6 (93), src/shared/organize.ts): 0% at `matchLo`, 100% at `matchHi`; a move by
    // topic or site from `minMatch` % only.
    var matchLo = 0.17
    var matchHi = 0.66
    var minMatch = 75.0
    // A new chat: the block fits its own chat less than this, and at least `splitMin` blocks stay in it.
    var splitT = 0.25
    var splitMin = 2.0
    // How many of the chat's last blocks get move suggestions, and of its last answers and notes tag suggestions.
    var window = 3.0
    var tagWindow = 5.0
    // Tags: the fit to the tag's examples, the margin over messages without it, how alike its examples are,
    // and the judge's confidence; at most `maxTags` per message (one: the best, so the chat stays uncluttered).
    var tagT = 0.3
    var tagD = 0.0
    var coherence = 0.2
    var judge = 0.7
    var maxTags = 1.0
    // Refused this many times in a row without one taken: no more such suggestions (in that chat; for that tag).
    var rollback = 3.0
    // "Everything in one chat?" (free, on the device): this many sites in the last 5 blocks, or this many
    // blocks. Once per chat at most, never again after ✕, and at least `messHours` apart.
    var messSites = 3.0
    var messBlocks = 6.0
    var messHours = 72.0

    /// The defaults (`DEFAULT_ORGANIZE`).
    init() {}

    /// Thresholds as received (the server's, or a stored copy): known numbers 0…1000 only, the rest from the
    /// defaults (`organizeConfig`). A JSON true or false isn't a number here either.
    init(_ raw: Any?) {
        guard let raw = raw as? [String: Any] else { return }
        for (name, path) in Self.fields {
            guard let number = raw[name] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { continue }
            let value = number.doubleValue
            if value.isFinite, value >= 0, value <= 1_000 { self[keyPath: path] = value }
        }
    }

    /// The fields by their names in /status.
    static let fields: [(name: String, path: WritableKeyPath<OrganizeConfig, Double>)] = [
        ("moveT", \.moveT), ("moveD", \.moveD), ("moveT1", \.moveT1), ("siteT", \.siteT), ("topicT", \.topicT), ("matchLo", \.matchLo), ("matchHi", \.matchHi), ("minMatch", \.minMatch), ("splitT", \.splitT),
        ("splitMin", \.splitMin), ("window", \.window), ("tagWindow", \.tagWindow), ("tagT", \.tagT), ("tagD", \.tagD),
        ("coherence", \.coherence), ("judge", \.judge), ("maxTags", \.maxTags), ("rollback", \.rollback),
        ("messSites", \.messSites), ("messBlocks", \.messBlocks), ("messHours", \.messHours)
    ]
}

nonisolated enum Organize {
    // MARK: Keys and times

    /// A new message's id: 12 random letters and digits (src/shared/conversation.ts `newEntryId`).
    static func newEntryId() -> String {
        let letters = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<12).map { _ in letters[Int.random(in: 0..<letters.count)] })
    }

    /// A message as it's written: with an id and the time (ms), kept when it has them.
    static func stamped(_ entry: [String: Any], at time: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> [String: Any] {
        var next = entry
        if next["id"] == nil { next["id"] = newEntryId() }
        if next["t"] == nil { next["t"] = NSNumber(value: time) }
        return next
    }

    /// FNV-1a (32 bit) of the UTF-16 code units of `text`, from `seed`, as 8 hex digits.
    private static func fnv(_ text: String, _ seed: UInt32) -> String {
        var hash = seed
        for unit in text.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return String(format: "%08x", hash)
    }

    /// A 64-bit fingerprint of `text` (two FNV-1a passes), as in the panel.
    static func textKey(_ text: String) -> String {
        fnv(text, 0x811c_9dc5) + fnv(text, 0x050c_5d1f)
    }

    /// A number as JavaScript writes it in a template string (whole numbers without ".0").
    static func jsNumber(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }

    /// A whole number of ms as JSON keeps it.
    static func whole(_ value: Double) -> Any {
        value.rounded() == value && abs(value) < 1e15 ? NSNumber(value: Int64(value)) : NSNumber(value: value)
    }

    static func page(_ entry: [String: Any]) -> [String: Any]? { entry["page"] as? [String: Any] }
    static func isUser(_ entry: [String: Any]) -> Bool { entry["role"] as? String == "user" }
    static func isNote(_ entry: [String: Any]) -> Bool { entry["note"] as? Bool == true }

    /// A message's stable key: its id, or for one written before 2.5 a fingerprint of its role, text, page
    /// and the page's time (src/shared/conversation.ts `entryKey`).
    static func entryKey(_ entry: [String: Any]) -> String {
        if let id = entry["id"] as? String { return id }
        let page = page(entry)
        let at = (page?["at"] as? NSNumber).map { jsNumber($0.doubleValue) } ?? ""
        let text = "\(entry["role"] as? String ?? "")\u{0}\(entry["content"] as? String ?? "")\u{0}\(page?["url"] as? String ?? "")\u{0}\(at)"
        return "h" + textKey(text)
    }

    /// When each message was written: its `t`, else its page's time, else the message before's; nil before
    /// the first known time.
    static func entryTimes(_ entries: [[String: Any]]) -> [Double?] {
        var last: Double?
        return entries.map { entry in
            if let own = (entry["t"] as? NSNumber)?.doubleValue ?? (page(entry)?["at"] as? NSNumber)?.doubleValue, own.isFinite { last = own }
            return last
        }
    }

    /// "Page updated" worked out again for the messages' order.
    static func withPageChanges(_ entries: [[String: Any]]) -> [[String: Any]] {
        var seen: [String: String] = [:]
        return entries.map { entry in
            guard isUser(entry), let page = page(entry) else { return entry }
            let url = page["url"] as? String ?? ""
            let before = seen[url]
            let hash = page["hash"] as? String
            if let hash, !hash.isEmpty { seen[url] = hash }
            if isNote(entry) { return entry }
            let changed = before != nil && hash != nil && before != hash
            if changed == (entry["pageChanged"] as? Bool == true) { return entry }
            var next = entry
            if changed { next["pageChanged"] = true } else { next.removeValue(forKey: "pageChanged") }
            return next
        }
    }

    // MARK: Page blocks

    /// A run of messages on one page (`start`…`end`, inclusive), as src/shared/threads.ts `pageBlocks`.
    struct Block: Equatable {
        var start: Int
        var end: Int
        var url: String?
    }

    static func pageBlocks(_ entries: [[String: Any]]) -> [Block] {
        var blocks: [Block] = []
        for (i, entry) in entries.enumerated() {
            let url = page(entry)?["url"] as? String
            if let current = blocks.last {
                let loose = isNote(entry) && (url ?? "").isEmpty
                let elsewhere = url != nil && url != current.url
                if !(isUser(entry) && (loose || elsewhere)) {
                    blocks[blocks.count - 1].end = i
                    continue
                }
            }
            blocks.append(Block(start: i, end: i, url: url))
        }
        return blocks
    }

    // MARK: Moving

    /// What a move changed, so "Undo" can put it back. A nil thread after the move: it was deleted.
    struct MoveUndo {
        let source: String
        let target: String
        let keys: [String]
        let beforeSource: OrganizeThread
        let beforeTarget: OrganizeThread?
        let afterSource: OrganizeThread?
        let afterTarget: OrganizeThread
    }

    struct Moved {
        /// Nil: the source is left empty and goes.
        let source: OrganizeThread?
        let target: OrganizeThread
        let undo: MoveUndo
    }

    private static func later(_ u: Int64?, _ now: Int64) -> Int64 { max(now, (u ?? 0) + 1) }

    /// Where messages written at `time` go: after the last turn written by then, not between a question and its answer.
    private static func insertAt(_ entries: [[String: Any]], _ time: Double?) -> Int {
        var at = 0
        for (i, t) in entryTimes(entries).enumerated() where t == nil || (time != nil && t! <= time!) { at = i + 1 }
        while at < entries.count, entries[at]["role"] as? String == "assistant" { at += 1 }
        return at
    }

    /// The block with its page's text on its first message on each page, from the source, when neither the
    /// block nor the target has it.
    private static func withPageText(_ block: [[String: Any]], _ source: [[String: Any]], _ target: [[String: Any]]) -> [[String: Any]] {
        func key(_ e: [String: Any]) -> String? {
            guard let page = page(e) else { return nil }
            return "\(page["url"] as? String ?? "")\u{0}\(page["hash"] as? String ?? "")"
        }
        func text(_ e: [String: Any]) -> String? { (page(e)?["text"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        func has(_ list: [[String: Any]], _ k: String) -> Bool { list.contains { text($0) != nil && key($0) == k } }
        var done = Set<String>()
        return block.map { entry in
            guard isUser(entry), var page = page(entry), let k = key(entry), done.insert(k).inserted else { return entry }
            if has(block, k) || has(target, k) { return entry }
            guard let found = source.reversed().first(where: { text($0) != nil && key($0) == k }).flatMap(text) else { return entry }
            // At most 8,000 UTF-16 units, as the panel cuts it (MAX_SAVED_PAGE_CHARS).
            page["text"] = String(decoding: Array(found.utf16.prefix(8_000)), as: UTF16.self)
            var next = entry
            next["page"] = page
            return next
        }
    }

    /// Moves messages `start`…`end` of `source` to `target` (nil: a new chat with `targetId`), as
    /// src/shared/threads.ts `moveEntries`. Nil when it can't be moved.
    static func move(source: OrganizeThread, start: Int, end: Int, target: OrganizeThread?, targetId: String, now: Int64) -> Moved? {
        let entries = source.entries
        guard !source.isHistory, target?.isHistory != true, source.id != targetId, start >= 0, end >= start, end < entries.count else { return nil }
        let times = entryTimes(entries)
        let into = target?.entries ?? []
        let moved = withPageText(Array(entries[start...end]), entries, into).map { entry -> [String: Any] in
            var next = entry
            next["id"] = entryKey(entry)
            next["from"] = ["chat": source.id, "at": NSNumber(value: now)]
            return next
        }
        let rest = withPageChanges(Array(entries[..<start]) + Array(entries[(end + 1)...]))
        let at = insertAt(into, times[start])
        let newest = times[end]
        let m = withPageChanges(Array(into[..<at]) + moved + Array(into[at...]))
        let nextTarget: OrganizeThread
        if let target {
            // The chat the block goes to keeps its place in the list (2.5 (77): a move isn't a new message).
            nextTarget = target.with(u: later(target.u, now), a: target.activity, m: m)
        } else {
            nextTarget = OrganizeThread(id: targetId, u: now, object: [:]).with(u: now, a: newest ?? source.activity, m: m)
        }
        let nextSource = rest.isEmpty ? nil : source.with(u: later(source.u, now), a: entryTimes(rest).last.flatMap { $0 } ?? source.activity, m: rest)
        let undo = MoveUndo(source: source.id, target: targetId, keys: moved.map { $0["id"] as? String ?? "" },
                            beforeSource: source, beforeTarget: target, afterSource: nextSource, afterTarget: nextTarget)
        return Moved(source: nextSource, target: nextTarget, undo: undo)
    }

    /// Puts moved messages back (src/shared/threads.ts `undoMove`): both chats as they were when neither
    /// changed since, else the messages by key back among the source's by time. Nil: that chat goes.
    /// Returns nil when there's nothing to put back.
    static func undo(_ undo: MoveUndo, source: OrganizeThread?, target: OrganizeThread?, now: Int64) -> (source: OrganizeThread, target: OrganizeThread?)? {
        func mark(_ t: OrganizeThread?) -> String { t.map { "\($0.u):\($0.entries.count)" } ?? "-" }
        if mark(source) == mark(undo.afterSource), mark(target) == mark(undo.afterTarget) {
            var back = undo.beforeSource
            back.u = later(source?.u, now)
            var before = undo.beforeTarget
            before?.u = later(target?.u, now)
            return (back, before)
        }
        guard let target else { return nil }
        let keys = Set(undo.keys)
        let back = target.entries.filter { keys.contains(entryKey($0)) }.map { entry -> [String: Any] in
            var next = entry
            next.removeValue(forKey: "from")
            return next
        }
        guard !back.isEmpty else { return nil }
        let left = withPageChanges(target.entries.filter { !keys.contains(entryKey($0)) })
        // The move emptied the source: it comes back with its name, pin and tags.
        let base = source ?? undo.beforeSource.with(u: undo.beforeSource.u, a: undo.beforeSource.activity, m: [])
        let at = insertAt(base.entries, entryTimes(back).first.flatMap { $0 })
        let m = withPageChanges(Array(base.entries[..<at]) + back + Array(base.entries[at...]))
        let newest = entryTimes(back).last.flatMap { $0 }
        let restored = base.with(u: later(source?.u, now), a: newest.map { $0 > base.activity ? $0 : base.activity } ?? base.activity, m: m)
        return (restored, left.isEmpty ? nil : target.with(u: later(target.u, now), a: target.activity, m: left))
    }

    /// The sweep for moved messages (src/shared/threads.ts `sweepMoved`): the chats it changes, and those it
    /// leaves empty (they go).
    static func sweep(_ threads: [OrganizeThread], now: Int64) -> (changed: [OrganizeThread], emptied: [String]) {
        var latest: [String: (thread: String, from: String, at: Double)] = [:]
        for thread in threads {
            for entry in thread.entries {
                guard let from = entry["from"] as? [String: Any], let at = (from["at"] as? NSNumber)?.doubleValue else { continue }
                let key = entryKey(entry)
                if let seen = latest[key], !(at > seen.at || (at == seen.at && thread.id < seen.thread)) { continue }
                latest[key] = (thread.id, from["chat"] as? String ?? "", at)
            }
        }
        guard !latest.isEmpty else { return ([], []) }
        var changed: [OrganizeThread] = []
        var emptied: [String] = []
        for thread in threads {
            let entries = thread.entries
            let kept = entries.filter { entry in
                guard let move = latest[entryKey(entry)] else { return true }
                return move.thread == thread.id || (thread.id != move.from && entry["from"] == nil)
            }
            guard kept.count != entries.count else { continue }
            if kept.isEmpty { emptied.append(thread.id) } else { changed.append(thread.with(u: later(thread.u, now), a: thread.activity, m: withPageChanges(kept))) }
        }
        return (changed, emptied)
    }

    // MARK: JSON as JavaScript reads it

    /// JavaScript's truthiness of a JSON value.
    static func truthy(_ value: Any?) -> Bool {
        guard let value, !(value is NSNull) else { return false }
        if let text = value as? String { return !text.isEmpty }
        if let number = value as? NSNumber { return number.doubleValue != 0 && !number.doubleValue.isNaN }
        return true
    }

    private static func content(_ entry: [String: Any]) -> String { entry["content"] as? String ?? "" }
    private static func strings(_ value: Any?) -> [String] { value as? [String] ?? [] }
    /// The page's title, when it has one (JavaScript's `e.page?.title ?`).
    private static func pageTitle(_ entry: [String: Any]) -> String? { (page(entry)?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    private static func isMoveDismissed(_ entry: [String: Any]) -> Bool { truthy((entry["dismissed"] as? [String: Any])?["move"]) }
    /// JavaScript's `toLowerCase` (Foundation's, not Swift's: it knows the Greek final sigma, as JavaScript does).
    private static func lower(_ text: String) -> String { text.lowercased(with: nil) }
    /// `Math.max`: NaN when either is.
    private static func jsMax(_ a: Double, _ b: Double) -> Double { a.isNaN || b.isNaN ? .nan : max(a, b) }

    /// `Math.round`: the closer whole number, a half up (toward +∞), as V8 works it out.
    static func jsRound(_ x: Double) -> Double {
        let up = x.rounded(.up)
        return up - 0.5 > x ? up - 1 : up
    }

    /// The first `count` UTF-16 units of `text`, as JavaScript's `slice(0, count)`. A cut through an emoji
    /// leaves U+FFFD here and half of the emoji in the panel (a Swift string can't hold half of one).
    static func prefix16(_ text: String, _ count: Int) -> String {
        text.utf16.count <= count ? text : String(decoding: Array(text.utf16.prefix(count)), as: UTF16.self)
    }

    // MARK: Texts and vectors

    // A question needs this much text (or a page) to be judged; a note this much.
    private static let minQuestion = 15
    private static let minNote = 40
    static let maxEmbedChars = 1_200

    // JavaScript's whitespace (`\s`, and what `trim` drops), spelled out: ICU's `\s` lacks U+000B and U+FEFF,
    // and its `\d` takes any digits, JavaScript's only 0–9.
    private static let jsSpace = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private static let citations = try! NSRegularExpression(pattern: "[ \\t]*\\[[0-9]{1,2}\\]\\(https?:[^)\(jsSpace)]+\\)")
    private static let marks = try! NSRegularExpression(pattern: "[*_`#>|]+")
    private static let spaces = try! NSRegularExpression(pattern: "[\(jsSpace)]+")

    private static func replacing(_ pattern: NSRegularExpression, in text: String, with template: String) -> String {
        pattern.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: text.utf16.count), withTemplate: template)
    }

    /// A text as the rules read it: no citation links (`stripCitations`), no Markdown marks, its whitespace as
    /// single spaces, trimmed (src/shared/organize.ts `plain`).
    static func plain(_ text: String) -> String {
        let bare = replacing(spaces, in: replacing(marks, in: replacing(citations, in: text, with: ""), with: " "), with: " ")
        // Only spaces are left of the whitespace.
        return bare.trimmingCharacters(in: CharacterSet(charactersIn: " "))
    }

    /// What a message is about, as its vector sees it: a question with its page's title (a quick action by its
    /// name, not its fixed prompt), the start of an answer, a note with its page's title (`embedText`).
    static func embedText(_ entry: [String: Any]) -> String {
        let title = pageTitle(entry).map { "\n" + plain($0) } ?? ""
        let text: String
        if isNote(entry) {
            text = prefix16(plain(content(entry)), 1_000) + title
        } else if isUser(entry) {
            let label = (entry["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            text = (label.map(plain) ?? prefix16(plain(content(entry)), 600)) + title
        } else {
            text = prefix16(plain(content(entry)), 800)
        }
        return prefix16(text, maxEmbedChars)
    }

    /// A vector as it travels and is kept: its numbers scaled to −127…127 (int8), base64 (`packVector`), byte
    /// for byte as the panel packs it.
    static func packVector(_ v: [Double]) -> String {
        var top = 0.0
        for x in v { top = jsMax(top, abs(x)) }
        let bytes = v.map { x -> UInt8 in
            // All zeros (or NaN somewhere): zeros, as JavaScript's `max ? … : 0`.
            guard top != 0, !top.isNaN else { return 0 }
            let scaled = jsRound((x / top) * 127)
            return scaled.isFinite ? UInt8(truncatingIfNeeded: Int(scaled)) : 0
        }
        return Data(bytes).base64EncodedString()
    }

    static func packVector(_ v: [Float]) -> String { packVector(v.map(Double.init)) }

    /// A packed vector back, of unit length (nil when it isn't one), as `unpackVector`.
    static func unpackVector(_ packed: String) -> [Float]? {
        guard let bytes = atob(packed), !bytes.isEmpty else { return nil }
        return unit(bytes.map { Float(Int8(bitPattern: $0)) })
    }

    /// `atob`: base64 as browsers read it (spaces dropped, the padding optional, stray low bits ignored), nil
    /// when it isn't base64.
    static func atob(_ text: String) -> [UInt8]? {
        var units = text.utf16.filter { ![0x09, 0x0A, 0x0C, 0x0D, 0x20].contains($0) }
        if units.count % 4 == 0 {
            if units.last == 0x3D { units.removeLast() }
            if units.last == 0x3D { units.removeLast() }
        }
        if units.count % 4 == 1 { return nil }
        var bytes: [UInt8] = []
        var buffer: UInt32 = 0
        var bits: UInt32 = 0
        for unit in units {
            let value: UInt16
            switch unit {
            case 0x41...0x5A: value = unit - 0x41
            case 0x61...0x7A: value = unit - 0x61 + 26
            case 0x30...0x39: value = unit - 0x30 + 52
            case 0x2B: value = 62
            case 0x2F: value = 63
            default: return nil
            }
            buffer = (buffer << 6) | UInt32(value)
            bits += 6
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8(truncatingIfNeeded: buffer >> bits))
            }
        }
        return bytes
    }

    // The numbers below are worked out as the panel works them out: a vector's numbers are kept as Float
    // (a Float32Array there) and every sum, product and mean is taken in Double (JavaScript's numbers), so
    // both give the same suggestions, not just close ones.

    /// `v` of unit length, nil when it has none: the length in Double, each number divided in Double and
    /// kept as Float.
    private static func unit(_ v: [Float]) -> [Float]? {
        var n = 0.0
        for x in v { n += Double(x) * Double(x) }
        n = n.squareRoot()
        guard n != 0, !n.isNaN else { return nil }
        return v.map { Float(Double($0) / n) }
    }

    static func dot(_ a: [Float], _ b: [Float]) -> Double {
        var s = 0.0
        for i in 0..<min(a.count, b.count) { s += Double(a[i]) * Double(b[i]) }
        return s
    }

    /// The mean of the `k` best similarities of `v` to `list`, each times its weight (0 for an empty list).
    private static func topMean(_ v: [Float], _ list: [(v: [Float], w: Double)], _ k: Int) -> Double {
        if list.isEmpty { return 0 }
        let sims = list.map { dot(v, $0.v) * $0.w }.sorted(by: >).prefix(k)
        return sims.reduce(0, +) / Double(sims.count)
    }

    /// The vectors' mean, of unit length: summed as Float (a Float32Array's `+=`), then `unit`.
    private static func mean(_ vectors: [[Float]]) -> [Float]? {
        guard let first = vectors.first else { return nil }
        var out = [Float](repeating: 0, count: first.count)
        for v in vectors {
            for i in out.indices { out[i] += i < v.count ? v[i] : .nan }
        }
        return unit(out)
    }

    /// The message's vector, if the device has it (by its key and text).
    typealias VectorOf = ([String: Any]) -> [Float]?

    // MARK: Blocks

    /// A page block with what the rules need: its vector, whether it says enough, its time and site, and
    /// whether someone already decided about it (it was moved here, or a move was turned down).
    struct ScoredBlock {
        var start: Int
        var end: Int
        var url: String?
        var v: [Float]?
        var weak: Bool
        var t: Double?
        var host: String
        var settled: Bool
        var dismissed: Bool
    }

    private static let urlCharacters = CharacterSet(charactersIn: "!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~")

    /// A page's site: its host without "www." ("" for none), as `new URL(url).hostname` gives it for web pages.
    static func hostOf(_ url: String?) -> String {
        guard let url, !url.isEmpty else { return "" }
        // iOS 16 takes no unencoded characters (Safari's URLs have none; a pasted one may).
        let parsed = URL(string: url) ?? url.addingPercentEncoding(withAllowedCharacters: urlCharacters).flatMap { URL(string: $0) }
        guard let host = parsed?.host?.lowercased() else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    static func scoredBlocks(_ entries: [[String: Any]], _ vectorOf: VectorOf) -> [ScoredBlock] {
        let times = entryTimes(entries)
        return pageBlocks(entries).map { scored(entries, times, $0.start, $0.end, $0.url, vectorOf) }
    }

    /// Messages `start`…`end` scored as a block.
    private static func scored(_ entries: [[String: Any]], _ times: [Double?], _ start: Int, _ end: Int, _ url: String?, _ vectorOf: VectorOf) -> ScoredBlock {
        let list = entries[start...end]
        var signal = 0
        for e in list where isUser(e) {
            signal += plain(e["label"] as? String ?? content(e)).utf16.count + (pageTitle(e) != nil ? minQuestion : 0)
        }
        let notesOnly = list.allSatisfy(isNote)
        return ScoredBlock(
            start: start, end: end, url: url, v: mean(list.compactMap(vectorOf)),
            weak: signal < (notesOnly ? minNote : minQuestion), t: times[start], host: hostOf(url),
            settled: list.contains { truthy($0["from"]) }, dismissed: list.contains(where: isMoveDismissed)
        )
    }

    /// 2.6 (94): a block's exchanges — each question or note with the answers after it — scored like blocks, on its
    /// page (src/shared/organize.ts `exchangesOf`).
    static func exchanges(_ entries: [[String: Any]], _ b: ScoredBlock, _ vectorOf: VectorOf) -> [ScoredBlock] {
        var ranges: [(start: Int, end: Int)] = []
        for i in b.start...b.end {
            if isUser(entries[i]) || ranges.isEmpty { ranges.append((i, i)) } else { ranges[ranges.count - 1].end = i }
        }
        let times = entryTimes(entries)
        return ranges.map { scored(entries, times, $0.start, $0.end, b.url, vectorOf) }
    }

    // MARK: Moves

    enum MoveReason: String {
        case merge, page, site, topic, apart

        /// The strongest reason first.
        var rank: Int {
            switch self {
            case .merge: return 0
            case .page: return 1
            case .site: return 2
            case .topic: return 3
            case .apart: return 4
            }
        }
    }

    struct MoveSuggestion: Equatable {
        // The messages to move (a block, or several in a row), shown under the last one.
        var start: Int
        var end: Int
        // The chat to move them to; nil: a new chat.
        var to: String?
        // Why: the whole chat joins a newer one on its topic and pages (2.6 (94)), the same page is in that chat, the
        // same site, the same topic, or none fits (a new chat).
        var why: MoveReason
        var score: Double
        var current: Double
        /// How well it fits there, in % (`matchPercent`), for a move by topic or by site.
        var match: Double? = nil
    }

    /// A block's fit to a chat as people read it (src/shared/organize.ts `matchPercent`).
    static func matchPercent(_ score: Double, _ cfg: OrganizeConfig) -> Double {
        let span = cfg.matchHi - cfg.matchLo
        guard span > 0 else { return 0 }
        return max(0, min(100, jsRound((score - cfg.matchLo) / span * 100)))
    }

    /// What one pass over many chats works out once (the chats list's counts, 2.6 (91): working it out again for each
    /// chat hung the app): each chat's scored blocks, and when a move out of each chat was last taken.
    final class MoveCache {
        fileprivate var blocks: [String: [ScoredBlock]] = [:]
        fileprivate var taken: [String: Double]?
        init() {}

        fileprivate func scored(_ thread: OrganizeThread, _ vectorOf: VectorOf) -> [ScoredBlock] {
            if let hit = blocks[thread.id] { return hit }
            let out = Organize.scoredBlocks(thread.entries, vectorOf)
            blocks[thread.id] = out
            return out
        }
    }

    /// True while move suggestions stay on in this chat: fewer than `rollback` refused since the last one taken.
    static func movesAllowed(_ chat: OrganizeThread, _ all: [OrganizeThread], _ cfg: OrganizeConfig, _ cache: MoveCache? = nil) -> Bool {
        var taken = -Double.infinity
        if let cache {
            if cache.taken == nil {
                var map: [String: Double] = [:]
                for thread in all {
                    for e in thread.entries {
                        guard let from = e["from"] as? [String: Any], let id = from["chat"] as? String else { continue }
                        map[id] = jsMax(map[id] ?? -.infinity, (from["at"] as? NSNumber)?.doubleValue ?? .nan)
                    }
                }
                cache.taken = map
            }
            taken = cache.taken?[chat.id] ?? -.infinity
        } else {
            for thread in all {
                for e in thread.entries {
                    guard let from = e["from"] as? [String: Any], from["chat"] as? String == chat.id else { continue }
                    taken = jsMax(taken, (from["at"] as? NSNumber)?.doubleValue ?? .nan)
                }
            }
        }
        let entries = chat.entries
        let times = entryTimes(entries)
        var refused = 0
        for b in pageBlocks(entries) where entries[b.start...b.end].contains(where: isMoveDismissed) {
            if (times[b.start] ?? 0) > taken { refused += 1 }
        }
        return Double(refused) < cfg.rollback
    }

    private typealias Other = (thread: OrganizeThread, blocks: [ScoredBlock])

    /// The one move to suggest in `chat` now (or nil): of its last `window` blocks, those nobody decided about yet
    /// are checked — first whether the same page is in another chat (no vectors needed; a short note or question
    /// will do), then, for those that say enough, the same site, then the topic; a block that fits no chat and not
    /// its own goes to a new chat. Blocks in a row with the same place are one suggestion. The strongest reason wins.
    /// A move only makes chats more about one thing (2.6, `suggestMove`): see `goesTo`. 2.6 (94): first, the whole chat
    /// may join a newer chat on its topic and pages (`mergeFit`); last, when no block goes anywhere, the end of a block
    /// off the chat's topic (`tailMove`).
    static func suggestMove(_ chat: OrganizeThread, _ chats: [OrganizeThread], _ vectorOf: VectorOf, _ cfg: OrganizeConfig, _ cache: MoveCache? = nil) -> MoveSuggestion? {
        if chat.isHistory || chat.isDeleted { return nil }
        let blocks = cache?.scored(chat, vectorOf) ?? scoredBlocks(chat.entries, vectorOf)
        guard !blocks.isEmpty, movesAllowed(chat, chats, cfg, cache) else { return nil }
        let others: [Other] = chats
            .filter { $0.id != chat.id && !$0.isDeleted && !$0.isHistory && !$0.entries.isEmpty }
            .map { ($0, cache?.scored($0, vectorOf) ?? scoredBlocks($0.entries, vectorOf)) }
        var merge: (to: String, score: Double, match: Double)?
        for o in others {
            if let fit = mergeFit((chat, blocks), o, cfg), merge == nil || fit.score > merge!.score { merge = (o.thread.id, fit.score, fit.match) }
        }
        if let merge {
            return MoveSuggestion(start: 0, end: chat.entries.count - 1, to: merge.to, why: .merge, score: merge.score, current: 0, match: merge.match)
        }
        // `window` is a whole number (the panel stops at a fraction; here it starts at the next whole block).
        let first = Int(max(0, Double(blocks.count) - cfg.window).rounded(.up))
        var found: [(suggestion: MoveSuggestion, index: Int)] = []
        for i in first..<blocks.count {
            let b = blocks[i]
            if b.settled || b.dismissed { continue }
            var rest = blocks
            rest.remove(at: i)
            if let pick = movePlace(chat, b, i, blocks, rest, others, cfg) {
                found.append((MoveSuggestion(start: b.start, end: b.end, to: pick.to, why: pick.why, score: pick.score, current: pick.current, match: pick.match), i))
            }
        }
        // Blocks in a row going to the same chat (or, for a new chat, alike) are moved together.
        var groups: [(suggestion: MoveSuggestion, index: Int)] = []
        for (s, index) in found {
            if let last = groups.last, last.index + 1 == index, last.suggestion.to == s.to, last.suggestion.why == s.why,
               s.to != nil || alike(blocks[last.index].v, blocks[index].v, cfg.moveT) {
                var merged = last.suggestion
                merged.end = s.end
                merged.score = max(merged.score, s.score)
                if merged.match != nil || s.match != nil { merged.match = max(merged.match ?? 0, s.match ?? 0) }
                merged.current = min(merged.current, s.current)
                groups[groups.count - 1] = (merged, index)
            } else {
                groups.append((s, index))
            }
        }
        // A new chat for the chat's blocks but not everything: something stays.
        let possible = groups.map(\.suggestion).filter { g in
            g.to != nil || Double(blocks.filter { $0.end < g.start || $0.start > g.end }.count) >= cfg.splitMin
        }
        let best = possible.min { a, b in
            if a.why != b.why { return a.why.rank < b.why.rank }
            if a.score - a.current != b.score - b.current { return a.score - a.current > b.score - b.current }
            return a.end > b.end
        }
        return best ?? tailMove(chat, blocks, others, vectorOf, cfg)
    }

    /// When a chat was started: its first message's time (else its last activity).
    private static func startedAt(_ t: OrganizeThread) -> Double {
        entryTimes(t.entries).first(where: { $0 != nil }).flatMap { $0 } ?? t.activity
    }

    /// Of two chats, the newer one: started later, then written in last, then by id.
    private static func newer(_ a: OrganizeThread, _ b: OrganizeThread) -> Bool {
        if startedAt(a) != startedAt(b) { return startedAt(a) > startedAt(b) }
        if a.activity != b.activity { return a.activity > b.activity }
        return a.id > b.id
    }

    /// 2.6 (94): whether chat `from` joins `to` whole, and how well it fits there (src/shared/organize.ts `mergeFit`): `to`
    /// is newer and has two blocks at least, more than half of `from`'s pages are pages `to` has, nothing in `from` was
    /// turned down or moved in, the chats fit each other from `minMatch` % on average both ways, and that merge wasn't
    /// turned down (`org.mx`).
    private static func mergeFit(_ from: Other, _ to: Other, _ cfg: OrganizeConfig) -> (score: Double, match: Double)? {
        if to.blocks.count < 2 || (from.thread.org?.mx ?? []).contains(to.thread.id) || !newer(to.thread, from.thread) { return nil }
        let pages = from.blocks.filter { $0.url != nil && !$0.url!.isEmpty }
        if pages.isEmpty || from.blocks.contains(where: { $0.settled || $0.dismissed }) { return nil }
        let urls = Set(to.blocks.compactMap { $0.url.flatMap { $0.isEmpty ? nil : $0 } })
        if pages.filter({ urls.contains($0.url!) }).count * 2 <= pages.count { return nil }
        let mine = from.blocks.compactMap(\.v).map { (v: $0, w: 1.0) }
        let theirs = to.blocks.compactMap(\.v).map { (v: $0, w: 1.0) }
        if mine.isEmpty || theirs.isEmpty { return nil }
        func fit(_ a: [(v: [Float], w: Double)], _ b: [(v: [Float], w: Double)]) -> Double {
            a.reduce(0) { $0 + topMean($1.v, b, 2) } / Double(a.count)
        }
        let score = min(fit(mine, theirs), fit(theirs, mine))
        let match = matchPercent(score, cfg)
        return match >= cfg.minMatch ? (score, match) : nil
    }

    /// 2.6 (94): the end of a block off its chat's topic — an answer about something else asked on the same page, or in
    /// the app (no page) — (src/shared/organize.ts `tailMove`): its longest run of last exchanges that each fit the rest of the chat less
    /// than `splitT`, alike among themselves, with `splitMin` exchanges or blocks staying, go to a chat mostly about them
    /// from `minMatch` %, else to a new chat when no chat fits them.
    private static func tailMove(_ chat: OrganizeThread, _ blocks: [ScoredBlock], _ others: [Other], _ vectorOf: VectorOf, _ cfg: OrganizeConfig) -> MoveSuggestion? {
        let first = Int(max(0, Double(blocks.count) - cfg.window).rounded(.up))
        guard first < blocks.count else { return nil }
        for i in stride(from: blocks.count - 1, through: first, by: -1) {
            let b = blocks[i]
            if b.settled || b.dismissed { continue }
            let xs = exchanges(chat.entries, b, vectorOf)
            if xs.count < 2 { continue }
            let outer = blocks.enumerated().filter { $0.offset != i && $0.element.v != nil }.map { (v: $0.element.v!, w: 1.0) }
            // The longest such end.
            var from = -1
            for k in 1..<xs.count {
                let part = Array(xs[k...])
                if part.contains(where: { $0.v == nil || $0.settled || $0.dismissed }) || Double(blocks.count - 1 + k) < cfg.splitMin { continue }
                let rest = outer + xs[..<k].compactMap(\.v).map { (v: $0, w: 1.0) }
                if rest.isEmpty || part.contains(where: { topMean($0.v!, rest, 2) >= cfg.splitT }) { continue }
                if part.indices.contains(where: { a in part.indices.contains { z in z > a && dot(part[a].v!, part[z].v!) < cfg.topicT } }) { continue }
                from = k
                break
            }
            if from < 0 || xs[from...].allSatisfy(\.weak) { continue }
            let part = Array(xs[from...])
            var x = b
            x.start = part[0].start
            x.end = part[part.count - 1].end
            x.v = mean(part.compactMap(\.v))
            x.weak = false
            x.t = part[0].t
            x.settled = false
            x.dismissed = false
            let current = topMean(x.v!, outer + xs[..<from].compactMap(\.v).map { (v: $0, w: 1.0) }, 2)
            var fits = false
            var best: (to: String, score: Double)?
            for o in others {
                let vs = o.blocks.compactMap(\.v).map { (v: $0, w: 1.0) }
                if vs.isEmpty { continue }
                let score = topMean(x.v!, vs, 2)
                if score < (vs.count >= 2 ? cfg.moveT : cfg.moveT1) || matchPercent(score, cfg) < cfg.minMatch { continue }
                fits = true
                if shareOn(x, o.blocks, cfg).share <= 0.5 || (o.blocks.count == 1 && joins(o.blocks[0], o.thread, (chat, blocks), cfg)) { continue }
                if best == nil || score > best!.score { best = (o.thread.id, score) }
            }
            if let best, best.score - current >= cfg.moveD {
                return MoveSuggestion(start: x.start, end: x.end, to: best.to, why: .topic, score: best.score, current: current, match: matchPercent(best.score, cfg))
            }
            if !fits { return MoveSuggestion(start: x.start, end: x.end, to: nil, why: .apart, score: 0, current: current) }
        }
        return nil
    }

    private static func alike(_ a: [Float]?, _ b: [Float]?, _ threshold: Double) -> Bool {
        guard let a, let b else { return false }
        return dot(a, b) >= threshold
    }

    /// Whether block `x` is on block `b`'s subject: the same page, or a topic this alike; without the vectors to tell,
    /// the same site (with them, a site isn't a subject: one video site holds every topic).
    private static func onSubject(_ b: ScoredBlock, _ x: ScoredBlock, _ cfg: OrganizeConfig) -> Bool {
        if let url = b.url, !url.isEmpty, x.url == url { return true }
        if let bv = b.v, let xv = x.v { return dot(bv, xv) >= cfg.topicT }
        return !b.host.isEmpty && x.host == b.host
    }

    /// How many of `list` are on `b`'s subject, and their share of it (0 for an empty list).
    private static func shareOn(_ b: ScoredBlock, _ list: [ScoredBlock], _ cfg: OrganizeConfig) -> (on: Int, share: Double) {
        let on = list.filter { onSubject(b, $0, cfg) }.count
        return (on, list.isEmpty ? 0 : Double(on) / Double(list.count))
    }

    /// Of two chats, the one the other joins: more messages, then written in last, then by id.
    private static func larger(_ a: OrganizeThread, _ b: OrganizeThread) -> Bool {
        if a.entries.count != b.entries.count { return a.entries.count > b.entries.count }
        if a.activity != b.activity { return a.activity > b.activity }
        return a.id < b.id
    }

    /// Whether a chat's blocks are on more than one topic: one of them is off the rest (less than half of them on it).
    private static func isMix(_ blocks: [ScoredBlock], _ cfg: OrganizeConfig) -> Bool {
        guard blocks.count > 1 else { return false }
        return blocks.indices.contains { i in
            var others = blocks
            others.remove(at: i)
            return shareOn(blocks[i], others, cfg).share < 0.5
        }
    }

    /// Whether a chat of one block `b` joins `to`: `to` is on one topic and mostly about `b`'s (more than half its
    /// blocks), and has more on it or, with one such block each, is the larger chat. Never into a mix, and of two chats
    /// one way.
    private static func joins(_ b: ScoredBlock, _ from: OrganizeThread, _ to: Other, _ cfg: OrganizeConfig) -> Bool {
        // `to` joins this one whole (2.6 (94)): not the other way too.
        if mergeFit(to, (from, [b]), cfg) != nil { return false }
        // Most of `to` is on `b`'s site (its pages, whatever each one is about): that site's chat (2.6 (91)).
        let onSite = b.host.isEmpty ? 0 : to.blocks.filter { $0.host == b.host }.count
        if onSite * 2 > to.blocks.count { return onSite > 1 || larger(to.thread, from) }
        if isMix(to.blocks, cfg) { return false }
        let there = shareOn(b, to.blocks, cfg)
        return there.share > 0.5 && (there.on > 1 || larger(to.thread, from))
    }

    /// Whether block `b` of chat `from` (with its other blocks `rest`) goes to `to`. A block that is the whole chat
    /// joins (`joins`). A block of a chat goes when it's off that chat's topic (less than half of `rest` is on it), to a
    /// chat that has its page or is mostly about it (more than half its blocks), unless that chat is one block that
    /// would rather join this one.
    private static func goesTo(_ b: ScoredBlock, _ rest: [ScoredBlock], _ from: OrganizeThread, _ to: Other, _ cfg: OrganizeConfig, samePage: Bool = false) -> Bool {
        if rest.isEmpty { return joins(b, from, to, cfg) }
        if shareOn(b, rest, cfg).share >= 0.5 { return false }
        if !samePage, shareOn(b, to.blocks, cfg).share <= 0.5 { return false }
        return !(to.blocks.count == 1 && joins(to.blocks[0], to.thread, (from, rest + [b]), cfg))
    }

    private static func movePlace(
        _ chat: OrganizeThread, _ b: ScoredBlock, _ i: Int, _ blocks: [ScoredBlock], _ rest: [ScoredBlock], _ others: [Other], _ cfg: OrganizeConfig
    ) -> (to: String?, why: MoveReason, score: Double, current: Double, match: Double?)? {
        // The same page, already in another chat and not elsewhere in this one (the chat written in last;
        // of equals, the first, as the panel's stable sort).
        if let url = b.url, !url.isEmpty, !rest.contains(where: { $0.url == url }) {
            var there: OrganizeThread?
            for o in others where o.blocks.contains(where: { $0.url == url }) && goesTo(b, rest, chat, o, cfg, samePage: true) {
                if there == nil || o.thread.activity > there!.activity { there = o.thread }
            }
            if let there { return (there.id, .page, 1, 0, nil) }
        }
        // A chat of one block on a site (a note, a question) joins the chat with the most of that site, when more than
        // half of it is that site and the block isn't about something else entirely there (2.6 (91)). A short note says
        // too little to be judged by its words: its site will do. 2.6 (93): that chat may be one page's questions too
        // (one block), when it has more messages than this one.
        var onHost: [(o: Other, on: Int)] = []
        if !b.host.isEmpty, !rest.contains(where: { $0.host == b.host }) {
            onHost = others.map { o in (o, o.blocks.filter { $0.host == b.host }.count) }
        }
        let sites = onHost.filter { $0.on >= 2 && $0.on * 2 >= $0.o.blocks.count }
        if rest.isEmpty {
            var home: (o: Other, on: Int)?
            for x in onHost where x.on * 2 > x.o.blocks.count && (x.on >= 2 || x.o.thread.entries.count > chat.entries.count) && mergeFit(x.o, (chat, blocks), cfg) == nil {
                if let h = home, !(x.on > h.on || (x.on == h.on && larger(x.o.thread, h.o.thread))) { continue }
                home = x
            }
            if let home {
                let vs = home.o.blocks.compactMap(\.v).map { (v: $0, w: 1.0) }
                if b.v == nil || vs.isEmpty || topMean(b.v!, vs, 2) >= cfg.siteT { return (home.o.thread.id, .site, 1, 0, nil) }
            }
        }
        // Below, the block has to say enough.
        guard let v = b.v, !b.weak else { return nil }
        // The fit to its own chat: its blocks outside the window, else all its other blocks.
        let outside = blocks.enumerated().filter { j, x in Double(j) < Double(blocks.count) - cfg.window && j != i && x.v != nil }.map(\.element)
        let base = (outside.isEmpty ? rest.filter { $0.v != nil } : outside).map { (v: $0.v!, w: 1.0) }
        let current = topMean(v, base, 2)
        // The same site: one other chat is about it (half its blocks or more, two at least), this one isn't.
        if !sites.isEmpty {
            let about = sites.map(\.o)
            if about.count == 1, goesTo(b, rest, chat, about[0], cfg) {
                let vs = about[0].blocks.compactMap(\.v).map { (v: $0, w: 1.0) }
                let score = topMean(v, vs, 2)
                let match = matchPercent(score, cfg)
                if !vs.isEmpty, score >= cfg.siteT, score >= current, match >= cfg.minMatch { return (about[0].thread.id, .site, score, current, match) }
            }
        }
        // A chat it fits but that isn't mostly about it (a mix) gets nothing; it still keeps it from a new chat.
        var fits = false
        var best: (to: String, score: Double)?
        for o in others {
            let vs = o.blocks.compactMap(\.v).map { (v: $0, w: 1.0) }
            if vs.isEmpty { continue }
            let score = topMean(v, vs, 2)
            if score < (vs.count >= 2 ? cfg.moveT : cfg.moveT1) || matchPercent(score, cfg) < cfg.minMatch { continue }
            fits = true
            if !goesTo(b, rest, chat, o, cfg) { continue }
            if best == nil || score > best!.score { best = (o.thread.id, score) }
        }
        if let best, best.score - current >= cfg.moveD { return (best.to, .topic, best.score, current, matchPercent(best.score, cfg)) }
        if !fits, !base.isEmpty, current < cfg.splitT { return (nil, .apart, 0, current, nil) }
        return nil
    }

    // MARK: Tags

    struct TagCandidate {
        var tag: String
        var pos: Double
        var neg: Double
        var coherence: Double
        // A few of the user's messages with this tag, for the judge.
        var examples: [String]
    }

    /// The judge's answer about one tag.
    struct TagVerdict {
        var tag: String
        var fits: Bool
        var confidence: Double
    }

    /// Answers and notes: the messages tags go on.
    static func isTaggable(_ entry: [String: Any]) -> Bool { entry["role"] as? String == "assistant" || isNote(entry) }

    /// Tags refused on `rollback` messages since one was last taken: not suggested any more (lowercase).
    static func refusedTags(_ chats: [OrganizeThread], _ cfg: OrganizeConfig) -> Set<String> {
        var taken: [String: Double] = [:]
        var refused: [String: [Double]] = [:]
        for thread in chats {
            let entries = thread.entries
            let times = entryTimes(entries)
            for (i, e) in entries.enumerated() {
                for tag in strings((e["accepted"] as? [String: Any])?["tags"]) {
                    taken[lower(tag)] = jsMax(taken[lower(tag)] ?? -.infinity, times[i] ?? 0)
                }
                for tag in strings((e["dismissed"] as? [String: Any])?["tags"]) { refused[lower(tag), default: []].append(times[i] ?? 0) }
            }
        }
        var out = Set<String>()
        for (tag, at) in refused {
            let since = taken[tag] ?? -.infinity
            if Double(at.filter { $0 > since }.count) >= cfg.rollback { out.insert(tag) }
        }
        return out
    }

    /// A message as a tag's example (its question first): what the judge reads.
    private static func exampleText(_ entries: [[String: Any]], _ i: Int) -> String {
        let e = entries[i]
        var question = ""
        if !isNote(e) {
            for j in stride(from: i - 1, through: 0, by: -1) where isUser(entries[j]) && !isNote(entries[j]) {
                question = prefix16(plain(entries[j]["label"] as? String ?? content(entries[j])), 120) + " → "
                break
            }
        }
        return question + prefix16(plain(content(e)), 300) + (pageTitle(e).map { " (\(plain($0)))" } ?? "")
    }

    /// The text the judge gets for the message itself.
    static func judgeText(_ entries: [[String: Any]], _ i: Int) -> String {
        prefix16(exampleText(entries, i), 1_500)
    }

    /// Tags to check for message `index` of `chat` (best first, at most 3): only tags the user put on at least two
    /// other messages (their messages count fully, blocks of chats with that tag a little less), whose examples are
    /// alike, that fit the message, and fit it better than the closest messages without the tag. Tags it (or its
    /// chat) has, refused here, or refused too often are left out. The judge decides among them (`tagCandidates`).
    static func tagCandidates(_ chat: OrganizeThread, _ index: Int, _ chats: [OrganizeThread], _ vectorOf: VectorOf, _ cfg: OrganizeConfig) -> [TagCandidate] {
        let m = chat.entries
        guard m.indices.contains(index), isTaggable(m[index]), !chat.isHistory, let v = vectorOf(m[index]) else { return [] }
        let e = m[index]
        let own = pageBlocks(m).first { $0.start <= index && index <= $0.end }
        func inOwn(_ thread: OrganizeThread, _ j: Int) -> Bool { thread.id == chat.id && own.map { $0.start <= j && j <= $0.end } == true }
        func has(_ x: [String: Any], _ key: String) -> Bool { strings(x["tags"]).contains { lower($0) == key } }
        var skip = Set((strings(e["tags"]) + strings(chat.object["tags"]) + strings((e["dismissed"] as? [String: Any])?["tags"])).map(lower))
        skip.formUnion(refusedTags(chats, cfg))
        let live = chats.filter { !$0.isDeleted && !$0.isHistory }
        // The user's tags in the order they come, each by its first spelling.
        var keys: [String] = []
        var spelling: [String: String] = [:]
        for thread in live {
            for tag in strings(thread.object["tags"]) + thread.entries.flatMap({ strings($0["tags"]) }) where spelling[lower(tag)] == nil {
                spelling[lower(tag)] = tag
                keys.append(lower(tag))
            }
        }
        var out: [TagCandidate] = []
        for key in keys where !skip.contains(key) {
            var examples: [(v: [Float], w: Double, text: String)] = []
            var tagged = Set<String>()
            for thread in live {
                let entries = thread.entries
                let chatTagged = strings(thread.object["tags"]).contains { lower($0) == key }
                if chatTagged { tagged.insert(thread.id) }
                for (j, x) in entries.enumerated() where has(x, key) && !inOwn(thread, j) {
                    if let xv = vectorOf(x) { examples.append((xv, 1, exampleText(entries, j))) }
                }
                if chatTagged && thread.id != chat.id {
                    for b in scoredBlocks(entries, vectorOf) where !b.weak {
                        if let bv = b.v { examples.append((bv, 0.9, exampleText(entries, b.end))) }
                    }
                }
            }
            if examples.count < 2 { continue }
            let list = Array(examples.prefix(30))
            var s = 0.0
            var n = 0
            for a in 0..<list.count {
                for b in (a + 1)..<list.count {
                    s += dot(list[a].v, list[b].v)
                    n += 1
                }
            }
            let coherence = n > 0 ? s / Double(n) : 0
            if coherence < cfg.coherence { continue }
            let pos = topMean(v, examples.map { ($0.v, $0.w) }, 3)
            if pos < cfg.tagT { continue }
            var negatives: [(v: [Float], w: Double)] = []
            for thread in live where !tagged.contains(thread.id) {
                for (j, x) in thread.entries.enumerated() where isTaggable(x) && !inOwn(thread, j) && !has(x, key) {
                    if let xv = vectorOf(x) { negatives.append((xv, 1)) }
                }
            }
            let neg = topMean(v, negatives, 3)
            if pos - neg < cfg.tagD { continue }
            // The closest first; equals keep their order, as in the panel's (stable) sort.
            let ranked = examples.enumerated()
                .map { (fit: dot(v, $0.element.v) * $0.element.w, at: $0.offset, text: $0.element.text) }
                .sorted { $0.fit != $1.fit ? $0.fit > $1.fit : $0.at < $1.at }
            out.append(TagCandidate(tag: spelling[key] ?? key, pos: pos, neg: neg, coherence: coherence, examples: ranked.prefix(4).map(\.text)))
        }
        // Equal margins go by name: the panel's `localeCompare` (the browser's language), here the device's
        // `localizedCompare`; both give plain words the same order.
        let sorted = out.enumerated().sorted { a, b in
            let x = a.element, y = b.element
            if x.pos - x.neg != y.pos - y.neg { return x.pos - x.neg > y.pos - y.neg }
            let names = x.tag.localizedCompare(y.tag)
            return names != .orderedSame ? names == .orderedAscending : a.offset < b.offset
        }
        return sorted.prefix(3).map(\.element)
    }

    /// The messages that get tag suggestions now: the chat's last `tagWindow` answers and notes.
    static func tagTargets(_ chat: OrganizeThread, _ cfg: OrganizeConfig) -> [Int] {
        let m = chat.entries
        var out: [Int] = []
        var i = m.count - 1
        while i >= 0, Double(out.count) < cfg.tagWindow {
            if isTaggable(m[i]) { out.insert(i, at: 0) }
            i -= 1
        }
        return out
    }

    /// The judge's verdicts → the tags to show (confident yes only, at most `maxTags`, in the candidates' order).
    static func judgedTags(_ candidates: [TagCandidate], _ verdicts: [TagVerdict], _ cfg: OrganizeConfig) -> [String] {
        let yes = Set(verdicts.filter { $0.fits && $0.confidence >= cfg.judge }.map { verdict in
            lower(String(String.UnicodeScalarView(verdict.tag.unicodeScalars.drop { $0 == "#" })))
        })
        return Array(candidates.filter { yes.contains(lower($0.tag)) }.map(\.tag).prefix(Int(cfg.maxTags)))
    }

    // MARK: "Everything in one chat?" (no AI)

    /// The chat looks like a pile (for the card that shows what organizing does): many sites lately, or many blocks.
    static func looksMixed(_ chat: OrganizeThread, _ cfg: OrganizeConfig) -> Bool {
        if chat.isHistory { return false }
        let blocks = pageBlocks(chat.entries)
        if Double(blocks.count) >= cfg.messBlocks { return true }
        let sites = Set(blocks.suffix(5).map { hostOf($0.url) }.filter { !$0.isEmpty })
        return Double(sites.count) >= cfg.messSites
    }

    /// The messages whose vectors the device lacks: their keys and texts (to embed), the newest chats first.
    static func missingVectors(_ chats: [OrganizeThread], has: (_ key: String, _ text: String) -> Bool, limit: Int = .max) -> [(key: String, text: String)] {
        var out: [(key: String, text: String)] = []
        var seen = Set<String>()
        // The chat written in last first; of equals, the first, as the panel's stable sort.
        let newest = chats.filter { !$0.isDeleted && !$0.isHistory }.enumerated()
            .sorted { $0.element.activity != $1.element.activity ? $0.element.activity > $1.element.activity : $0.offset < $1.offset }
        for (_, thread) in newest {
            for e in thread.entries {
                let text = embedText(e)
                let key = entryKey(e)
                if text.isEmpty || seen.contains(key) || has(key, text) { continue }
                seen.insert(key)
                out.append((key, text))
                if out.count >= limit { return out }
            }
        }
        return out
    }

    // MARK: The chat's name by its topic (2.6)

    static let maxNameText = 6_000

    /// What the AI reads to name a chat (/api/v2/organize op "name", src/shared/organize.ts `nameText`): page by page,
    /// the page's title, the person's questions and notes, and the start of each answer. A long chat keeps its first
    /// page and as many of the latest as fit.
    static func nameText(_ entries: [[String: Any]]) -> String {
        var parts: [String] = []
        for b in pageBlocks(entries) {
            let list = Array(entries[b.start...b.end])
            var lines: [String] = []
            if let title = list.lazy.compactMap(pageTitle).first { lines.append("Page: " + prefix16(plain(title), 150)) }
            for e in list {
                if isNote(e) {
                    lines.append("Note: " + prefix16(plain(content(e)), 300))
                } else if isUser(e) {
                    lines.append("Question: " + prefix16(plain(e["label"] as? String ?? content(e)), 300))
                } else if !plain(content(e)).isEmpty {
                    lines.append("Answer: " + prefix16(plain(content(e)), 200))
                }
            }
            let part = lines.joined(separator: "\n")
            if !part.isEmpty { parts.append(part) }
        }
        let all = parts.joined(separator: "\n\n")
        if all.utf16.count <= maxNameText || parts.count < 2 { return prefix16(all, maxNameText) }
        let first = prefix16(parts[0], 1_200)
        var latest: [String] = []
        var size = first.utf16.count
        for i in stride(from: parts.count - 1, to: 0, by: -1) {
            if size + parts[i].utf16.count + 2 > maxNameText { break }
            latest.insert(parts[i], at: 0)
            size += parts[i].utf16.count + 2
        }
        return ([first] + latest).joined(separator: "\n\n")
    }

    /// The user named the chat themselves: a name that isn't the AI's (src/shared/threads.ts `namedByUser`).
    static func namedByUser(_ chat: OrganizeThread) -> Bool {
        guard let title = (chat.object["title"] as? String).flatMap({ $0.isEmpty ? nil : $0 }) else { return false }
        return title != chat.object["ait"] as? String
    }

    /// Whether the chat's name gets checked by itself: not one the user typed, and two questions or notes at least.
    static func wantsNameCheck(_ chat: OrganizeThread) -> Bool {
        if chat.isHistory || chat.isDeleted || namedByUser(chat) { return false }
        return chat.entries.filter(isUser).count >= 2
    }

    /// What a name check was about (this device's own record): the name, the chat's pages, how many questions (up to 3).
    static func nameCheckKey(_ chat: OrganizeThread, title: String? = nil) -> String {
        let entries = chat.entries
        let asks = min(3, entries.filter(isUser).count)
        let pages = pageBlocks(entries).map { entryKey(entries[$0.start]) }.joined(separator: "\u{1}")
        return textKey([title ?? chat.object["title"] as? String ?? "", pages, String(asks)].joined(separator: "\u{0}"))
    }

    // MARK: Organizing's state, kept with the chat (2.6 (93), src/shared/organize.ts)

    /// The key of the chat's last message ("" without one): what OrgState.k is checked against.
    static func lastKey(_ entries: [[String: Any]]) -> String {
        entries.last.map(entryKey) ?? ""
    }

    /// The name `org` (the chat's own, by default) suggests while it's open: not turned down, not the chat's `name`
    /// already, not one the user typed.
    static func openName(_ chat: OrganizeThread, name: String, org: OrgState? = nil) -> String? {
        guard let nm = (org ?? chat.org)?.nm, let t = nm.t, wantsNameCheck(chat), t != name else { return nil }
        return nm.no.contains { lower($0) == lower(t) } ? nil : t
    }

    /// The tags the chat's record says the check confirmed, still open: the message is there, without that tag, not
    /// turned down.
    static func openTags(_ chat: OrganizeThread, org: OrgState? = nil) -> [(index: Int, key: String, tag: String)] {
        var out: [(index: Int, key: String, tag: String)] = []
        for item in (org ?? chat.org)?.tg ?? [] {
            guard let index = chat.entries.firstIndex(where: { entryKey($0) == item.key }) else { continue }
            let e = chat.entries[index]
            func has(_ list: Any?) -> Bool { strings(list).contains { lower($0) == lower(item.tag) } }
            if !has(e["tags"]), !has((e["dismissed"] as? [String: Any])?["tags"]) { out.append((index, item.key, item.tag)) }
        }
        return out
    }

    /// The move the chat's record suggests, while the chat is as it was then and the move still stands.
    static func openMove(_ chat: OrganizeThread, _ chats: [OrganizeThread]) -> OrgState.Move? {
        guard let org = chat.org, let mv = org.mv, org.n == chat.entries.count, org.k == lastKey(chat.entries) else { return nil }
        guard mv.s >= 0, mv.s <= mv.e, mv.e < chat.entries.count else { return nil }
        if chat.entries[mv.s...mv.e].contains(where: { isMoveDismissed($0) || truthy($0["from"]) }) { return nil }
        if let to = mv.to, !chats.contains(where: { $0.id == to && !$0.isDeleted }) { return nil }
        return mv
    }

    /// The state to keep with the chat after a run: the move and tags worked out now, and the name check as it stands.
    static func orgState(for chat: OrganizeThread, move: MoveSuggestion?, tags: [(key: String, tag: String)], nm: OrgState.Name?) -> OrgState {
        OrgState(n: chat.entries.count, k: lastKey(chat.entries),
                 mv: move.map { OrgState.Move(s: $0.start, e: $0.end, to: $0.to, why: $0.why, mt: $0.match) },
                 tg: tags.map { OrgState.Tag(key: $0.key, tag: $0.tag) }, nm: nm, mx: chat.org?.mx ?? [])
    }

    /// The name check after asking: what it was about, the name it suggests (unless that one was turned down), and the
    /// names turned down.
    static func nameState(after previous: OrgState.Name?, key: String, fits: Bool, title: String, current: String) -> OrgState.Name {
        let no = previous?.no ?? []
        let refused = no.contains { lower($0) == lower(title) }
        return OrgState.Name(k: key, t: !fits && !title.isEmpty && title != current && !refused ? title : nil, no: no)
    }
}

/// Organizing's work for the app, off its main thread (2.6 (91): with hundreds of chats it hung the app for seconds when
/// the chats list or a chat opened): reading the chats, which messages lack vectors, one chat's suggestions, every
/// chat's counts. Plain values in, plain values out; OrganizeModel does the network and keeps the state.
nonisolated enum OrganizeWork {
    /// Chats (their JSON objects aren't Sendable) carried to and from the work: nothing else touches them meanwhile.
    struct Carry<T>: @unchecked Sendable {
        let value: T
    }

    /// A chat as stored (strings only: it crosses to the work).
    struct Source: Sendable {
        let id: String
        let u: Int64
        let data: String
    }

    static func read(_ sources: [Source]) -> [OrganizeThread] {
        sources.compactMap { OrganizeThread(id: $0.id, u: $0.u, data: $0.data) }
    }

    /// The messages of `live` without a vector in `known` (entryKey → "textKey:packed"), up to `limit`.
    static func missing(_ live: [OrganizeThread], known: [String: String], limit: Int) -> [(key: String, text: String)] {
        Organize.missingVectors(live, has: { key, text in known[key]?.hasPrefix(Organize.textKey(text) + ":") == true }, limit: limit)
    }

    /// `known` without the vectors of messages no chat has any more.
    static func keep(_ known: [String: String], _ live: [OrganizeThread]) -> [String: String] {
        let keys = Set(live.flatMap { $0.entries.map(Organize.entryKey) })
        return known.filter { keys.contains($0.key) }
    }

    private final class Unpacked {
        var v: [String: [Float]?] = [:]
    }

    /// Reads vectors as the device keeps them (a message's vector only while its text is the one embedded), each
    /// unpacked once.
    static func reader(_ known: [String: String]) -> Organize.VectorOf {
        let unpacked = Unpacked()
        return { entry in
            let text = Organize.embedText(entry)
            guard !text.isEmpty, let hit = known[Organize.entryKey(entry)], let colon = hit.firstIndex(of: ":"),
                  hit[..<colon] == Organize.textKey(text) else { return nil }
            if let v = unpacked.v[hit] { return v }
            let v = Organize.unpackVector(String(hit[hit.index(after: colon)...]))
            unpacked.v[hit] = v
            return v
        }
    }

    /// A message that has tag candidates, and what the judge reads for it.
    struct Tagging {
        let index: Int
        let message: String
        let candidates: [Organize.TagCandidate]
    }

    /// Chat `chatId`'s move, and its messages with tag candidates (the judge's answers come from the network).
    static func suggest(_ chatId: String, _ live: [OrganizeThread], known: [String: String], _ cfg: OrganizeConfig) -> (move: Organize.MoveSuggestion?, tags: [Tagging])? {
        guard let chat = live.first(where: { $0.id == chatId }) else { return nil }
        let vectorOf = reader(known)
        let move = Organize.suggestMove(chat, live, vectorOf, cfg, Organize.MoveCache())
        let tags = Organize.tagTargets(chat, cfg).compactMap { index -> Tagging? in
            let candidates = Organize.tagCandidates(chat, index, live, vectorOf, cfg)
            return candidates.isEmpty ? nil : Tagging(index: index, message: Organize.judgeText(chat.entries, index), candidates: candidates)
        }
        return (move, tags)
    }

    /// Every chat's open suggestions, for the chats list ("N recommendations"): its move (every chat scored once), and
    /// the name and tags its record still suggests (2.6 (93): kept with the chat; `names`: each chat's name now).
    static func counts(_ live: [OrganizeThread], known: [String: String], _ cfg: OrganizeConfig, names: [String: String]) -> [String: Int] {
        let vectorOf = reader(known)
        let cache = Organize.MoveCache()
        var out: [String: Int] = [:]
        for chat in live {
            var n = Organize.suggestMove(chat, live, vectorOf, cfg, cache) == nil ? 0 : 1
            if let name = names[chat.id], Organize.openName(chat, name: name) != nil { n += 1 }
            n += Organize.openTags(chat).count
            if n > 0 { out[chat.id] = n }
        }
        return out
    }
}
