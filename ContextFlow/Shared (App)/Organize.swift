import Foundation

// Organizing the chats (2.5), the app's side of src/shared/conversation.ts, threads.ts and organize.ts:
// message keys and times, page blocks, moving a block to another chat with undo, and the sweep for moved
// messages. Plain Foundation and the chats' own JSON (unknown fields are kept): the parity test
// (tests/organize-parity.test.mts) builds this file on its own and checks it gives what the panel gives.

/// A chat as stored: its id, the time of its copy (ms) and its JSON object `{title?, a?, pin?, k?, tags?, m}`.
struct OrganizeThread {
    var id: String
    var u: Int64
    var object: [String: Any]

    var entries: [[String: Any]] { object["m"] as? [[String: Any]] ?? [] }
    var isHistory: Bool { object["k"] as? String == "history" }
    /// When it last got a message (ms); missing means `u`.
    var activity: Double { (object["a"] as? NSNumber)?.doubleValue ?? Double(u) }

    func with(u: Int64, a: Double, m: [[String: Any]]) -> OrganizeThread {
        var next = object
        next["m"] = m
        next["a"] = Organize.whole(a)
        return OrganizeThread(id: id, u: u, object: next)
    }
}

enum Organize {
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
            let a = newest.map { $0 > target.activity ? $0 : target.activity } ?? target.activity
            nextTarget = target.with(u: later(target.u, now), a: a, m: m)
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
}
