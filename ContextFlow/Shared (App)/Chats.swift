import Combine
import Foundation
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// MARK: - A chat, as the Safari extension writes it

/// One message of a chat (src/shared/conversation.ts `Entry`). Unknown fields are ignored here and kept
/// as they are when the app renames or pins a chat (the JSON is edited, not re-encoded).
struct ChatEntry: Decodable, Hashable {
    struct Page: Decodable, Hashable {
        var url: String
        var title: String
        /// The page's readable text, kept with the chat by the extension (2.4: the first question or note
        /// on the page, and again when it changed; never from Private Browsing).
        var text: String?
    }

    struct Source: Decodable, Hashable {
        var title: String
        var url: String
    }

    struct Grounding: Decodable, Hashable {
        var sources: [Source]
    }

    /// A video transcript or PDF a question went with (or why it couldn't be read).
    struct Read: Decodable, Hashable {
        var kind: String
        var ok: Bool
        var name: String
        var detail: String?
        var reason: String?
    }

    var role: String
    var content: String
    var label: String?
    var mode: String?
    var note: Bool?
    var page: Page?
    var pageChanged: Bool?
    var grounding: Grounding?
    var sources: [Read]?
    /// The user's tags on an answer or a note.
    var tags: [String]?
    /// An answer from the app in a chat without page texts (it says so once, under this answer).
    var noPages: Bool?

    var isUser: Bool { role == "user" }
    var isNote: Bool { note == true }
}

/// A chat (src/shared/threads.ts `Thread`), from its iCloud form `{title?, a?, pin?, m}`.
struct ChatThread: Identifiable, Hashable {
    let id: String
    /// Last change (ms): the newest copy wins between devices.
    let updatedAt: Int64
    /// The JSON the extension and iCloud store.
    let data: String
    let title: String?
    /// Last message (ms): the list order.
    let lastAt: Int64
    let pin: Double?
    let entries: [ChatEntry]
    /// "Ask your chats" (Pro): questions about all the other chats.
    let isHistory: Bool
    /// The chat's own tags (answers and notes have theirs on the entry).
    let ownTags: [String]

    private struct Stored: Decodable {
        var title: String?
        var a: Int64?
        var pin: Double?
        var k: String?
        var tags: [String]?
        var m: [ChatEntry]
    }

    init?(id: String, updatedAt: Int64, data: String) {
        guard let raw = data.data(using: .utf8) else { return nil }
        let stored: Stored
        if let object = try? JSONDecoder().decode(Stored.self, from: raw) {
            stored = object
        } else if let list = try? JSONDecoder().decode([ChatEntry].self, from: raw) {
            // 2.3 (build 56) stored just the messages.
            stored = Stored(m: list)
        } else {
            return nil
        }
        self.id = id
        self.updatedAt = updatedAt
        self.data = data
        title = stored.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        lastAt = stored.a ?? updatedAt
        pin = stored.pin
        isHistory = stored.k == "history"
        ownTags = Tags.clean(stored.tags ?? [])
        entries = stored.m
    }

    /// The chat's tags and those of its answers and notes, without repeats.
    var tags: [String] { Tags.clean(ownTags + entries.flatMap { $0.tags ?? [] }) }

    func has(tag: String) -> Bool { tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame } }

    var isPinned: Bool { pin != nil }

    /// The user's name for it, or its first question (or quick action and its page).
    var name: String {
        if let title { return title }
        guard let first = entries.first(where: \.isUser) else { return "" }
        if let label = first.label {
            return oneLine(first.page.map { "\(label) · \($0.title)" } ?? label, 80)
        }
        return oneLine(first.content, 80)
    }

    /// The last answer's first line.
    var snippet: String {
        guard let last = entries.last(where: { !$0.isUser }) ?? entries.last else { return "" }
        let plain = last.content
            .replacingOccurrences(of: #"\s*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[#>|]+"#, with: " ", options: .regularExpression)
        return oneLine(plain, 140)
    }

    /// The pages the chat was on, in the order it came to them.
    var pages: [ChatEntry.Page] {
        var seen = Set<String>()
        return entries.compactMap { entry in
            guard entry.isUser, let page = entry.page, seen.insert(page.url).inserted else { return nil }
            return page
        }
    }

    var lastPage: ChatEntry.Page? { entries.last(where: { $0.page != nil })?.page }

    /// The page texts kept in the chat (src/shared/conversation.ts `savedPages`): the latest of each
    /// page, the most recent page first.
    var savedPages: [ChatEntry.Page] {
        var out: [ChatEntry.Page] = []
        for entry in entries.reversed() {
            if let page = entry.page, page.text?.isEmpty == false, !out.contains(where: { $0.url == page.url }) { out.append(page) }
        }
        return out
    }

    var notes: Int { entries.filter(\.isNote).count }

    var lastActivity: Date { Date(timeIntervalSince1970: TimeInterval(lastAt) / 1000) }

    /// The same chat with its name and pin changed, as of `updatedAt`. For each: nil keeps it,
    /// `.some(nil)` removes it, `.some(value)` sets it.
    func edited(title: String??, pin: Double??, tags: [String]? = nil, entryTags: (index: Int, tags: [String])? = nil, updatedAt: Int64) -> ChatMirror.Item? {
        let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8))
        guard var object = (parsed as? [String: Any]) ?? (parsed as? [Any]).map({ ["m": $0] }) else { return nil }
        switch title {
        case .none: break
        case .some(.none): object.removeValue(forKey: "title")
        case .some(.some(let value)): object["title"] = value
        }
        switch pin {
        case .none: break
        case .some(.none): object.removeValue(forKey: "pin")
        case .some(.some(let value)): object["pin"] = value
        }
        if let tags {
            if tags.isEmpty { object.removeValue(forKey: "tags") } else { object["tags"] = tags }
        }
        if let entryTags, var list = object["m"] as? [[String: Any]], list.indices.contains(entryTags.index) {
            if entryTags.tags.isEmpty { list[entryTags.index].removeValue(forKey: "tags") } else { list[entryTags.index]["tags"] = entryTags.tags }
            object["m"] = list
        }
        // Renaming, pinning or tagging keeps the chat's place by its last message.
        if object["a"] == nil { object["a"] = lastAt }
        guard let json = try? JSONSerialization.data(withJSONObject: object), let text = String(data: json, encoding: .utf8) else { return nil }
        return ChatMirror.Item(updatedAt: updatedAt, data: text)
    }

    /// The same chat with `entries` (src/shared/conversation.ts `Entry` objects) after its messages,
    /// written at `updatedAt`: it moves to the top of the list like a chat continued in Safari.
    func appending(_ entries: [[String: Any]], updatedAt: Int64) -> ChatMirror.Item? {
        let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8))
        guard var object = (parsed as? [String: Any]) ?? (parsed as? [Any]).map({ ["m": $0] }),
              let list = object["m"] as? [Any] else { return nil }
        object["m"] = list + entries
        object["a"] = updatedAt
        guard let json = try? JSONSerialization.data(withJSONObject: object), let text = String(data: json, encoding: .utf8) else { return nil }
        return ChatMirror.Item(updatedAt: updatedAt, data: text)
    }
}

func host(of url: String) -> String {
    guard let host = URL(string: url)?.host else { return "" }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

private func oneLine(_ text: String, _ max: Int) -> String {
    let line = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    return line.count > max ? String(line.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : line
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - The chats

/// The chats for the app's Chats screen: the copy the Safari extension keeps in the App Group (this
/// device's chats, and those iCloud brought), plus, when iCloud sync is on, the newest from iCloud
/// itself (a chat continued on the Mac shows up on the iPhone without opening Safari first).
/// Renaming, pinning and deleting go to iCloud and to the extension (it applies them next time).
@MainActor
final class ChatLibrary: ObservableObject {
    static let shared = ChatLibrary()

    enum Cloud: Equatable {
        /// Sync is switched off (here or in the extension's settings).
        case off
        /// No iCloud account, or iCloud isn't reachable right now.
        case unavailable
        case syncing
        case ok
    }

    @Published private(set) var threads: [ChatThread] = []
    @Published private(set) var cloud: Cloud = .off
    @Published private(set) var loaded = false

    private static let tokenKey = "cf_chats_cloud_token"
    private var cloudTask: Task<Void, Never>?

    private init() {
        reload()
        // Until the first refresh: not "off" when sync is on, or the Chats screen flashes the sync-off card.
        cloud = syncOn ? .syncing : .off
    }

    /// iCloud sync of chats (the extension's setting, shared through the App Group; on by default).
    var syncOn: Bool {
        SharedDefaults.shared.readSettings()?.settings["syncChats"] as? Bool ?? true
    }

    /// Re-reads the extension's copy, then asks iCloud for anything newer.
    func refresh() {
        reload()
        guard syncOn else {
            cloud = .off
            return
        }
        cloudTask?.cancel()
        cloudTask = Task { await syncCloud([]) }
    }

    /// Waits for the refresh from iCloud (pull to refresh).
    func refreshNow() async {
        refresh()
        await cloudTask?.value
    }

    private func reload() {
        let items = ChatMirror.chats()
        threads = items.compactMap { id, item in ChatThread(id: id, updatedAt: item.updatedAt, data: item.data) }
            .filter { !$0.entries.isEmpty }
            .sorted(by: Self.listOrder)
        loaded = true
    }

    /// Pinned chats first in their order, then the others, the latest first (the extension's order).
    private static func listOrder(_ a: ChatThread, _ b: ChatThread) -> Bool {
        switch (a.pin, b.pin) {
        case let (x?, y?): return x < y
        case (.some, nil): return true
        case (nil, .some): return false
        default: return a.lastAt > b.lastAt
        }
    }

    private func syncCloud(_ changes: [ChatSync.Change]) async {
        if cloud != .ok { cloud = .syncing }
        let token = UserDefaults.standard.string(forKey: Self.tokenKey)
        do {
            let result = try await ChatSync.sync(token: token, changes: changes)
            guard !Task.isCancelled else { return }
            var saves: [String: ChatMirror.Item] = [:]
            for snapshot in result.changed { saves[snapshot.id] = ChatMirror.Item(updatedAt: snapshot.updatedAt, data: snapshot.data) }
            if ChatMirror.apply(saves: saves, deletes: result.deleted) { reload() }
            UserDefaults.standard.set(result.token, forKey: Self.tokenKey)
            cloud = .ok
        } catch {
            if !Task.isCancelled { cloud = .unavailable }
        }
    }

    // MARK: Changes

    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// Stores a changed chat here, for the extension, and in iCloud.
    private func save(_ thread: ChatThread, title: String??, pin: Double??, tags: [String]? = nil, entryTags: (index: Int, tags: [String])? = nil) {
        // Always later than the copy it replaces, whatever the clocks say.
        let at = max(now, thread.updatedAt + 1)
        guard let item = thread.edited(title: title, pin: pin, tags: tags, entryTags: entryTags, updatedAt: at) else { return }
        store(thread, item)
    }

    /// Adds messages at the end of a chat (a question asked in the app and its answer, or a note).
    func append(_ thread: ChatThread, _ entries: [[String: Any]]) {
        let current = threads.first { $0.id == thread.id } ?? thread
        guard let item = current.appending(entries, updatedAt: max(now, current.updatedAt + 1)) else { return }
        store(current, item)
    }

    private func store(_ thread: ChatThread, _ item: ChatMirror.Item) {
        ChatMirror.apply(saves: [thread.id: item])
        ChatMirror.queue(.init(id: thread.id, updatedAt: item.updatedAt, data: item.data, deleted: nil, at: Double(now)))
        reload()
        if syncOn {
            Task { await syncCloud([.save(.init(id: thread.id, updatedAt: item.updatedAt, data: item.data))]) }
        }
    }

    /// Names a chat; an empty name goes back to its first question.
    func rename(_ thread: ChatThread, to name: String) {
        let clean = String(name.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces).prefix(80))
        guard clean != (thread.title ?? "") else { return }
        save(thread, title: .some(clean.nilIfEmpty), pin: nil)
    }

    /// Pins a chat at the top of the list, or unpins it.
    func setPinned(_ thread: ChatThread, _ pinned: Bool) {
        guard pinned != thread.isPinned else { return }
        let top = threads.compactMap(\.pin).min()
        save(thread, title: nil, pin: .some(pinned ? (top.map { $0 - 1 } ?? 0) : nil))
    }

    /// The chat's own tags.
    func setTags(_ thread: ChatThread, _ tags: [String]) {
        let clean = Tags.clean(tags)
        guard clean != thread.ownTags else { return }
        save(thread, title: nil, pin: nil, tags: clean)
    }

    /// The tags of one answer or note of the chat.
    func setTags(_ thread: ChatThread, entry index: Int, _ tags: [String]) {
        let clean = Tags.clean(tags)
        guard thread.entries.indices.contains(index), clean != Tags.clean(thread.entries[index].tags ?? []) else { return }
        save(thread, title: nil, pin: nil, entryTags: (index, clean))
    }

    /// Every tag in use, the most used first.
    var allTags: [String] {
        var counts: [String: (tag: String, count: Int)] = [:]
        for thread in threads {
            for tag in thread.tags { counts[tag.lowercased(), default: (tag, 0)].count += 1 }
        }
        return counts.values.sorted { $0.count != $1.count ? $0.count > $1.count : $0.tag.localizedCompare($1.tag) == .orderedAscending }.map(\.tag)
    }

    /// The chat list in groups by tag, like folders (the extension's setting, shared with the app).
    var groupByTags: Bool {
        get { SharedDefaults.shared.readSettings()?.settings["groupByTags"] as? Bool ?? false }
        set {
            var stored = SharedDefaults.shared.readSettings()?.settings ?? [:]
            stored["groupByTags"] = newValue
            SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
            objectWillChange.send()
        }
    }

    func delete(_ thread: ChatThread) {
        ChatMirror.apply(saves: [:], deletes: [thread.id])
        ChatMirror.queue(.init(id: thread.id, updatedAt: nil, data: nil, deleted: true, at: Double(now)))
        reload()
        if syncOn {
            Task { await syncCloud([.delete(thread.id)]) }
        }
    }

    // MARK: Safari

    // MARK: Ask your chats

    /// Stores an "Ask your chats" chat (questions and answers only) here, for the extension and in iCloud.
    func saveHistory(id: String, messages: [[String: String]]) {
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        let previous = threads.first { $0.id == id }
        var object: [String: Any] = ["k": "history", "a": at, "m": messages]
        if let title = previous?.title { object["title"] = title }
        if let pin = previous?.pin { object["pin"] = pin }
        guard let json = try? JSONSerialization.data(withJSONObject: object), let data = String(data: json, encoding: .utf8) else { return }
        let updatedAt = max(at, (previous?.updatedAt ?? 0) + 1)
        ChatMirror.apply(saves: [id: ChatMirror.Item(updatedAt: updatedAt, data: data)])
        ChatMirror.queue(.init(id: id, updatedAt: updatedAt, data: data, deleted: nil, at: Double(at)))
        reload()
        if syncOn {
            Task { await syncCloud([.save(.init(id: id, updatedAt: updatedAt, data: data))]) }
        }
    }

    /// Opens a page of a chat in Safari (not another default browser).
    func open(_ url: String) {
        guard let link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") else { return }
        #if os(iOS)
        if #available(iOS 17, *), let safari = URL(string: "x-safari-\(url)") {
            UIApplication.shared.open(safari) { opened in
                if !opened { UIApplication.shared.open(link) }
            }
        } else {
            UIApplication.shared.open(link)
        }
        #else
        if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
            NSWorkspace.shared.open([link], withApplicationAt: safari, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(link)
        }
        #endif
    }

    /// Opens the chat's last page in Safari and has the panel continue this chat there.
    func continueInSafari(_ thread: ChatThread) {
        guard let page = thread.lastPage else { return }
        ChatMirror.requestOpen(thread.id)
        open(page.url)
    }
}

// MARK: - Search

/// Chats with every word of a query (in the name, messages, notes or page titles), as in the Safari
/// panel (src/shared/threads.ts `searchThreads`): case and accents ignored, chats named after it first.
enum ChatSearch {
    struct Hit: Hashable {
        /// The message's index in the chat, or nil for a page it was on.
        let index: Int?
        let excerpt: AttributedString
    }

    struct Result: Identifiable {
        let thread: ChatThread
        let hits: [Hit]
        var id: String { thread.id }
    }

    private static let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]

    /// The query's words; quotes keep a phrase together.
    static func words(_ query: String) -> [String] {
        var out: [String] = []
        let pattern = try? NSRegularExpression(pattern: #""([^"]+)"|(\S+)"#)
        let text = query as NSString
        for match in pattern?.matches(in: query, range: NSRange(location: 0, length: text.length)) ?? [] {
            let range = match.range(at: 1).location != NSNotFound ? match.range(at: 1) : match.range(at: 2)
            let word = text.substring(with: range).trimmingCharacters(in: .whitespaces)
            if !word.isEmpty { out.append(word) }
        }
        return out
    }

    static func search(_ threads: [ChatThread], _ query: String, maxHits: Int = 2) -> [Result] {
        let words = words(query)
        guard !words.isEmpty else { return [] }
        var scored: [(Result, Int)] = []
        for thread in threads {
            let name = thread.name
            var fields: [(index: Int?, text: String)] = thread.entries.enumerated().map { index, entry in
                (index, plain(entry.label.map { "\($0) \(entry.content)" } ?? entry.content))
            }
            fields += thread.pages.map { (nil, "\($0.title) \($0.url)") }
            let all = [name] + fields.map(\.text)
            guard words.allSatisfy({ word in all.contains { $0.range(of: word, options: options) != nil } }) else { continue }
            let named = words.filter { name.range(of: $0, options: options) != nil }.count
            var together = words.count == named
            var hits: [Hit] = []
            for field in fields {
                let present = words.filter { field.text.range(of: $0, options: options) != nil }
                guard !present.isEmpty else { continue }
                if present.count == words.count { together = true }
                // The first question is already the chat's name in the list.
                if hits.count < maxHits, oneLine(field.text) != name {
                    hits.append(Hit(index: field.index, excerpt: excerpt(field.text, present)))
                }
            }
            scored.append((Result(thread: thread, hits: hits), named * 100 + (together ? 10 : 0)))
        }
        return scored.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.thread.lastAt > $1.0.thread.lastAt }.map(\.0)
    }

    private static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: #"\s*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`#>|]+"#, with: "", options: .regularExpression)
    }

    private static func oneLine(_ text: String) -> String {
        text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    /// About 120 characters around the first matched word, the words highlighted.
    private static func excerpt(_ text: String, _ words: [String], size: Int = 120) -> AttributedString {
        let line = oneLine(text)
        let first = words.compactMap { line.range(of: $0, options: options)?.lowerBound }.min() ?? line.startIndex
        let offset = line.distance(from: line.startIndex, to: first)
        let from = max(0, min(offset - size / 3, line.count - size))
        let start = line.index(line.startIndex, offsetBy: from)
        let end = line.index(start, offsetBy: min(size, line.distance(from: start, to: line.endIndex)))
        var piece = (from > 0 ? "…" : "") + line[start..<end] + (end < line.endIndex ? "…" : "")
        piece = piece.replacingOccurrences(of: "\n", with: " ")
        var out = AttributedString(piece)
        for word in words {
            var search = piece.startIndex..<piece.endIndex
            while let range = piece.range(of: word, options: options, range: search) {
                if let lower = AttributedString.Index(range.lowerBound, within: out), let upper = AttributedString.Index(range.upperBound, within: out) {
                    out[lower..<upper].backgroundColor = .yellow.opacity(0.35)
                    out[lower..<upper].foregroundColor = .primary
                }
                search = range.upperBound..<piece.endIndex
            }
        }
        return out
    }
}

// MARK: - Tags

/// Tags as the extension keeps them (src/shared/threads.ts): no leading #, one space between words,
/// at most 24 characters, no repeats whatever the case, at most 8.
enum Tags {
    static func clean(_ tag: String) -> String {
        var text = tag.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        while text.hasPrefix("#") { text.removeFirst() }
        return String(text.trimmingCharacters(in: .whitespaces).prefix(24)).trimmingCharacters(in: .whitespaces)
    }

    static func clean(_ tags: [String]) -> [String] {
        var out: [String] = []
        for raw in tags {
            let tag = clean(raw)
            if !tag.isEmpty, !out.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) { out.append(tag) }
        }
        return Array(out.prefix(8))
    }

    /// One of 8 colours, the same as in Safari for the same name.
    static func color(_ tag: String) -> Color {
        var hash: UInt32 = 0
        for scalar in tag.lowercased().unicodeScalars { hash = hash &* 31 &+ scalar.value }
        let palette: [(Double, Double, Double)] = [(37, 99, 235), (13, 148, 136), (202, 138, 4), (219, 39, 119), (124, 58, 237), (22, 163, 74), (234, 88, 12), (71, 85, 105)]
        let c = palette[Int(hash % 8)]
        return Color(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255)
    }
}
