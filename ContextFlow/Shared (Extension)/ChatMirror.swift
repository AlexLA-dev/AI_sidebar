import Foundation

/// The chats as the ContextFlow app sees them, in the App Group: the Safari extension keeps this copy
/// of all its chats (iCloud's included), whether iCloud sync is on or not, and the app reads it for its
/// Chats screen. Changes made in the app (a chat renamed, pinned or deleted) go to an inbox the extension
/// empties on its next call; "Open in Safari" leaves the chat to continue there.
///
/// Files in the group container, written whole and atomically under a file coordinator, since the app
/// and the extension run in different processes:
/// - `Chats/chats.json`   {id: {updatedAt, data}} — `data` is the thread's JSON as iCloud stores it
/// - `Chats/inbox.json`   [{id, updatedAt?, data?, deleted?, at}] — the app's changes, oldest first
/// - `Chats/open.json`    {id, at} — the chat to continue in Safari
///
/// Compiled into the app and the extension targets.
enum ChatMirror {
    struct Item: Codable, Equatable {
        var updatedAt: Int64
        var data: String
    }

    /// A change made in the app, for the extension (and iCloud through it).
    struct AppChange: Codable, Equatable {
        var id: String
        var updatedAt: Int64?
        var data: String?
        var deleted: Bool?
        /// When it was made (ms): the extension confirms everything up to the latest it applied.
        var at: Double
        /// 2.6 (94): a change to organizing's record only, made on the copy of this time (ChatSync.Snapshot `base`).
        var base: Int64? = nil

        var dictionary: [String: Any] {
            if deleted == true { return ["id": id, "deleted": true] }
            var out: [String: Any] = ["id": id, "updatedAt": updatedAt ?? 0, "data": data ?? ""]
            if let base { out["base"] = base }
            return out
        }
    }

    private struct OpenRequest: Codable {
        var id: String
        var at: Double
    }

    /// How long an "Open in Safari" waits for the panel to open.
    private static let openWindow: TimeInterval = 15 * 60

    private static var directory: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName)?
            .appendingPathComponent("Chats", isDirectory: true)
    }

    private static func file(_ name: String) -> URL? {
        guard let directory else { return nil }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(name)
    }

    // MARK: Coordinated files

    private static func read<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        guard let url = file(name) else { return nil }
        var result: T?
        var error: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { url in
            guard let data = try? Data(contentsOf: url) else { return }
            result = try? JSONDecoder().decode(T.self, from: data)
        }
        return result
    }

    /// Reads, changes and writes a file as one step (another process may write it at the same time).
    private static func update<T: Codable>(_ name: String, empty: T, _ change: (inout T) -> Void) {
        guard let url = file(name) else { return }
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forMerging, error: &error) { url in
            var value = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(T.self, from: $0) } ?? empty
            change(&value)
            if let data = try? JSONEncoder().encode(value) { try? data.write(to: url, options: .atomic) }
        }
    }

    // MARK: Chats

    /// Every chat the app knows, by id.
    static func chats() -> [String: Item] {
        read("chats.json", as: [String: Item].self) ?? [:]
    }

    /// Stores newer copies and drops deleted chats. Returns whether anything changed. The spaces' list (2.7,
    /// `SpaceRecord.id`) is merged with the copy here instead: two copies that each have a new space keep both.
    @discardableResult
    static func apply(saves: [String: Item], deletes: [String] = []) -> Bool {
        var changed = false
        update("chats.json", empty: [String: Item]()) { chats in
            for (id, item) in saves where id == SpaceRecord.id {
                guard let next = SpaceRecord.take(chats[id], item) else { continue }
                chats[id] = next
                changed = true
            }
            for (id, item) in saves where id != SpaceRecord.id && (chats[id]?.updatedAt ?? -1) < item.updatedAt {
                chats[id] = item
                changed = true
            }
            for id in deletes where chats.removeValue(forKey: id) != nil {
                changed = true
            }
        }
        return changed
    }

    // MARK: The app's changes, for the extension

    static func queue(_ change: AppChange) {
        update("inbox.json", empty: [AppChange]()) { inbox in
            // Only the latest change of a chat matters.
            inbox.removeAll { $0.id == change.id }
            inbox.append(change)
        }
    }

    /// The app's changes the extension hasn't applied yet, and the time of the latest.
    static func pendingAppChanges() -> (changes: [AppChange], at: Double?) {
        let inbox = read("inbox.json", as: [AppChange].self) ?? []
        return (inbox, inbox.map(\.at).max())
    }

    /// The extension applied the app's changes made up to `at`.
    static func confirmAppChanges(upTo at: Double) {
        update("inbox.json", empty: [AppChange]()) { inbox in
            inbox.removeAll { $0.at <= at }
        }
    }

    // MARK: Open in Safari

    /// Continue this chat the next time the panel opens in Safari.
    static func requestOpen(_ id: String) {
        update("open.json", empty: OpenRequest(id: "", at: 0)) { request in
            request = OpenRequest(id: id, at: Date().timeIntervalSince1970)
        }
    }

    /// The chat the app asked to continue, if recent; asked once.
    static func takeOpenRequest() -> String? {
        guard let stored = read("open.json", as: OpenRequest.self), !stored.id.isEmpty else { return nil }
        var id: String?
        update("open.json", empty: OpenRequest(id: "", at: 0)) { request in
            if !request.id.isEmpty, Date().timeIntervalSince1970 - request.at < openWindow { id = request.id }
            request = OpenRequest(id: "", at: 0)
        }
        return id
    }
}

/// Spaces (2.7, src/shared/spaces.ts): "Work", "Personal", "Shopping", each with its own chats and colour. The list is one
/// record next to the chats (`id`), in iCloud's chats zone with the chats' record type and fields (no schema change), and
/// in `Chats/chats.json`; a chat says which space it's in ("sp"), and one that doesn't is in the first space. Copies are
/// merged wherever they meet: each space and each site's binding as its newest copy says (`merge`, the same as the
/// panel's `mergeSpaces`). Older versions skip the record: it has no "m", so it isn't a chat.
///
/// `{"v":1,"s":[{"id","n"?,"c"?,"o"?,"u","d"?}],"b":{"host":{"s":id|null,"u"}}}` — `d`: deleted, `s` null: unbound;
/// both kept so an older copy never brings them back.
nonisolated enum SpaceRecord {
    static let id = "cf-spaces"
    /// The first space: always there, never deleted; every chat without a space of its own is in it.
    static let first = "first"
    /// Spaces in Free, the first one included (src/shared/spaces.ts FREE_SPACES; the owner hasn't decided: two proposed).
    static let freeSpaces = 2
    static let maxName = 32
    /// The colours, [light, base] (src/shared/spaces.ts SPACE_COLORS); the first is the ✦ circle's before 2.7.
    static let colors: [(name: String, light: UInt32, base: UInt32)] = [
        ("blue", 0x38bdf8, 0x2563eb), ("green", 0x4ade80, 0x16a34a), ("orange", 0xfdba74, 0xea580c),
        ("pink", 0xf9a8d4, 0xdb2777), ("violet", 0xc4b5fd, 0x7c3aed), ("graphite", 0x94a3b8, 0x475569)
    ]

    struct Space: Equatable {
        var id: String
        var n: String?
        var c: String?
        var o: Double?
        var u: Double
        var d = false
    }

    struct Binding: Equatable {
        var s: String?
        var u: Double
    }

    struct List: Equatable {
        var spaces: [String: Space] = [:]
        var bindings: [String: Binding] = [:]
    }

    static func cleanName(_ name: String) -> String {
        let line = name.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return String(line.prefix(maxName)).trimmingCharacters(in: .whitespaces)
    }

    /// The list in a record's JSON, or nil if it isn't one (src/shared/spaces.ts cleanSpaceList).
    static func parse(_ data: String) -> List? {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any],
              let raw = object["s"] as? [Any] else { return nil }
        var list = List()
        for item in raw {
            guard let r = item as? [String: Any], let id = r["id"] as? String, !id.isEmpty, id.count <= 64,
                  let u = (r["u"] as? NSNumber)?.doubleValue, u.isFinite, list.spaces[id] == nil else { continue }
            if r["d"] as? Bool == true, id != first {
                list.spaces[id] = Space(id: id, u: u, d: true)
                continue
            }
            let n = (r["n"] as? String).map(cleanName).flatMap { $0.isEmpty ? nil : $0 }
            let c = (r["c"] as? String).flatMap { name in colors.contains { $0.name == name } ? name : nil }
            let o = (r["o"] as? NSNumber)?.doubleValue
            list.spaces[id] = Space(id: id, n: n, c: c, o: o.flatMap { $0.isFinite ? $0 : nil }, u: u)
        }
        for (host, value) in object["b"] as? [String: Any] ?? [:] {
            guard !host.isEmpty, host.count <= 253, let r = value as? [String: Any], let u = (r["u"] as? NSNumber)?.doubleValue, u.isFinite else { continue }
            if let s = r["s"] as? String, !s.isEmpty { list.bindings[host] = Binding(s: s, u: u) }
            else if r["s"] is NSNull { list.bindings[host] = Binding(s: nil, u: u) }
        }
        return list
    }

    private static func number(_ x: Double) -> Any {
        x == x.rounded() && abs(x) < 9e15 ? NSNumber(value: Int64(x)) : NSNumber(value: x)
    }

    /// The record's JSON, in one form whatever order the list was built in (src/shared/spaces.ts spacesForCloud).
    static func json(_ list: List) -> String {
        let s: [[String: Any]] = list.spaces.keys.sorted().map { id in
            let x = list.spaces[id]!
            if x.d { return ["id": id, "u": number(x.u), "d": true] }
            var out: [String: Any] = ["id": id, "u": number(x.u)]
            if let n = x.n { out["n"] = n }
            if let c = x.c { out["c"] = c }
            if let o = x.o { out["o"] = number(o) }
            return out
        }
        var b: [String: Any] = [:]
        for (host, x) in list.bindings { b[host] = ["s": x.s ?? NSNull(), "u": number(x.u)] }
        let object: [String: Any] = ["v": 1, "s": s, "b": b]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else { return "{\"v\":1,\"s\":[],\"b\":{}}" }
        return text
    }

    /// Two copies as one: each space and binding as its newest copy says; the same time on both, the one whose JSON sorts
    /// first (the panel picks the same).
    static func merge(_ a: List, _ b: List) -> List {
        var out = List()
        for id in Set(a.spaces.keys).union(b.spaces.keys) {
            switch (a.spaces[id], b.spaces[id]) {
            case let (x?, y?): out.spaces[id] = x.u != y.u ? (x.u > y.u ? x : y) : (key(x) <= key(y) ? x : y)
            case let (x?, nil): out.spaces[id] = x
            case let (nil, y?): out.spaces[id] = y
            default: break
            }
        }
        for host in Set(a.bindings.keys).union(b.bindings.keys) {
            switch (a.bindings[host], b.bindings[host]) {
            case let (x?, y?): out.bindings[host] = x.u != y.u ? (x.u > y.u ? x : y) : (bindsFirst(x, y) ? x : y)
            case let (x?, nil): out.bindings[host] = x
            case let (nil, y?): out.bindings[host] = y
            default: break
            }
        }
        return out
    }

    /// The same time on both: as the panel's JSON sorts them, a space before an unbinding (`"` before `null`).
    private static func bindsFirst(_ x: Binding, _ y: Binding) -> Bool {
        switch (x.s, y.s) {
        case let (a?, b?): return a <= b
        case (.some, nil): return true
        case (nil, .some): return false
        case (nil, nil): return true
        }
    }

    private static func key(_ x: Space) -> String {
        json(List(spaces: [x.id: x], bindings: [:]))
    }

    /// Another copy taken in where `current` is kept (src/shared/spaces.ts takeSpaces): nil when it says nothing new
    /// here; the copy itself when it has everything (its time never going back); else the merge, newer than both.
    static func take(_ current: ChatMirror.Item?, _ theirs: ChatMirror.Item) -> ChatMirror.Item? {
        guard let incoming = parse(theirs.data) else { return nil }
        guard let current, let mine = parse(current.data) else { return theirs }
        let merged = merge(mine, incoming)
        if merged == mine && current.updatedAt >= theirs.updatedAt { return nil }
        if merged == incoming { return ChatMirror.Item(updatedAt: max(theirs.updatedAt, current.updatedAt), data: theirs.data) }
        return ChatMirror.Item(updatedAt: max(current.updatedAt, theirs.updatedAt) + 1, data: json(merged))
    }

    // MARK: Read by the app

    /// A space as the app shows it.
    struct Shown: Identifiable, Hashable {
        let id: String
        let name: String
        let color: String
        let order: Double
    }

    /// The spaces there are, the first one always (its name and colour as given, else `firstName` in blue).
    static func live(_ list: List, firstName: String) -> [Shown] {
        let f = list.spaces[first]
        let head = Shown(id: first, name: f?.n ?? firstName, color: f?.c ?? "blue", order: f?.o ?? 0)
        let others = list.spaces.values.filter { $0.id != first && !$0.d }.sorted { $0.id < $1.id }.enumerated()
            .map { i, x in Shown(id: x.id, name: x.n ?? firstName, color: x.c ?? "blue", order: x.o ?? Double(i + 1)) }
            .sorted { $0.order != $1.order ? $0.order < $1.order : $0.id < $1.id }
        return [head] + others
    }

    /// The space `id` is, if it's one there is; else the first (a deleted space's chats are in the first).
    static func resolve(_ list: List, _ id: String?) -> String {
        guard let id, id != first, let x = list.spaces[id], !x.d else { return first }
        return id
    }
}
