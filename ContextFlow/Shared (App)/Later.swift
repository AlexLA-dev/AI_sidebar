import SwiftUI

// Reminders and watching in the app (2.5, the owner's "remind or watch"): the bell is about time ("I know when"),
// the eye about a change ("I don't know when"), never mixed. 2.5 (77), the director's split: two words and two
// icons everywhere, never one list: "Reminders" (the bell) holds the reminders in the chats (here), "Watching" (the
// eye) what's watched (watching registers its source with LaterCenter, one line in its AppDelegate). The same
// shape as src/content/ux/later.ts.

/// A row in "Reminders" (a reminder, the bell) or in "Watching" (something watched, the eye).
struct LaterItem: Identifiable, Hashable {
    enum Kind: String, Identifiable {
        case remind, watch
        var id: String { rawValue }
    }
    /// "remind:<chat>:<message key>" | "watch:<id>"
    let id: String
    let kind: Kind
    /// The page or the chat.
    let title: String
    let url: URL?
    /// Ready to show: "Tomorrow 9:00" / "Watching: size 42 · checked an hour ago".
    let status: String
    /// 2.6 (97): the person's own words on it (a reminder made with Remind on a selection or a page, a watch's note).
    var detail: String? = nil
    /// A reminder: when it rings; a watch: its last check.
    let sortAt: Date
    /// A reminder: it rings on this device (it's set to ring where it was set).
    var here = true
}

/// Rows that aren't reminders in the chats (watching's, in "Watching"): listed, and stopped from the list.
protocol LaterSource {
    /// What its rows are: the Chats screen shows that list (watching's eye).
    var kind: LaterItem.Kind { get }
    func items() async -> [LaterItem]
    func cancel(_ id: String) async
}

@MainActor
final class LaterCenter {
    static let shared = LaterCenter()
    private(set) var sources: [LaterSource] = []

    func register(_ source: LaterSource) {
        sources.append(source)
    }

    /// Whether there's a list of `kind`: reminders always; watching once its source is in.
    func lists(_ kind: LaterItem.Kind) -> Bool {
        kind == .remind || sources.contains { $0.kind == kind }
    }
}

// MARK: - Reminders in the chats

extension ChatLibrary {
    /// Sets (or with nil cancels) a message's reminder on this device; the chat keeps the bell. The chat screen and
    /// "Reminders" both go through here. False: notifications are off for ContextFlow.
    /// `words`: a reminder made with Remind on a selection or a page gets the person's new words with its new time
    /// (2.6 (97)); the notification says them.
    func remind(_ thread: ChatThread, entry index: Int, at: Date?, preset: String?, how: String? = nil, words: String? = nil) async -> Bool {
        guard let raw = thread.organized?.entries, raw.indices.contains(index), thread.entries.indices.contains(index) else { return true }
        var entry = thread.entries[index]
        let key = Organize.entryKey(raw[index])
        var event: [String: String] = ["what": entry.remind?.page == true ? "page" : entry.isNote ? "note" : "answer"]
        if let how { event["how"] = how }
        let appleKey = MessageReminders.identifier(chat: thread.id, message: key)
        guard let at else {
            MessageReminders.cancel(chat: thread.id, message: key)
            if entry.remind?.apple == true { AppleItems.remove(key: appleKey) }
            setRemind(thread, entry: index, nil)
            ChatAI.reportUx("ux_remind", event.merging(["action": "cancelled"]) { $1 })
            return true
        }
        // A note made on a page says that page's title; a page reminder ("Remind me about this page") opens the page
        // (src/shared/reminders.ts reminderNotice).
        let title = entry.isNote ? (entry.page.map { $0.title.isEmpty ? $0.url : $0.title } ?? thread.name) : thread.name
        let page = entry.remind?.page == true ? entry.page.flatMap { URL(string: $0.url) } : nil
        let worded = words.flatMap { entry.withRemindWords($0) }.flatMap { $0 == entry.content ? nil : $0 }
        if let worded { entry.content = worded }
        let outcome = await MessageReminders.schedule(chat: thread.id, message: key, at: at, title: title,
                                                      body: ReminderTimes.asked(entry.reminderText), open: page, ask: true)
        // «Также в Напоминания» (2.7): into Apple Reminders as well, asked for once; a time changed moves the same one.
        let apple = await alsoInReminders(entry, chat: thread.id, message: key, at: at, key: appleKey, pageTitle: title)
        guard outcome == .scheduled || apple else {
            ChatAI.reportUx("ux_remind", event.merging(["action": "denied"]) { $1 })
            return false
        }
        if let worded { setRemindWords(thread, entry: index, worded) }
        setRemind(thread, entry: index, ChatRemind(at: at.timeIntervalSince1970 * 1000, dev: String(Activation.shared.appId.prefix(12)),
                                                    page: entry.remind?.page, apple: apple ? true : nil))
        ChatAI.reportUx("ux_remind", event.merging(["action": "set", "preset": preset ?? "custom"]) { $1 })
        return true
    }

    /// «Также в Напоминания» (2.7), when it's on: the reminder in Apple Reminders too, with the page and a link back to
    /// the message in its notes. True when it's there (asked for access first when never asked).
    private func alsoInReminders(_ entry: ChatEntry, chat: String, message: String, at: Date, key: String, pageTitle: String) async -> Bool {
        guard AppleItems.available, UserDefaults.standard.bool(forKey: AppleItems.alsoKey) else {
            if entry.remind?.apple == true { AppleItems.remove(key: key) }
            return false
        }
        if AppleItems.access(.reminder) == .none { _ = await AppleItems.ask(.reminder) }
        guard AppleItems.access(.reminder) == .write else {
            ChatAI.reportUse("apple", "denied", ["what": "reminder", "via": "remind"])
            return false
        }
        var item = AppleItems.Item(kind: .reminder, title: String(entry.reminderText.prefix(120)))
        let wall = AppleItems.wall(at)
        item.date = wall.date
        item.time = wall.time
        let pageURL = entry.page.map { $0.url }.flatMap { $0.hasPrefix("http") ? $0 : nil }
        item.notes = [pageURL.map { pageTitle.isEmpty || pageTitle == $0 ? $0 : "\(pageTitle)\n\($0)" },
                      MessageReminders.link(chat: chat, message: message)?.absoluteString]
            .compactMap { $0 }.joined(separator: "\n\n")
        do {
            try AppleItems.save(item, key: key)
            ChatAI.reportUse("apple", "added", ["what": "reminder", "via": "remind"])
            return true
        } catch {
            AppleItems.log("also in Reminders failed: \(error)")
            ChatAI.reportUse("apple", "failed", ["what": "reminder", "via": "remind"])
            return false
        }
    }

    /// A chat going to Recently Deleted: its reminders don't ring on this device (the marks stay on the messages).
    func pauseReminders(_ thread: ChatThread) {
        guard let raw = thread.organized?.entries else { return }
        for entry in raw where entry["remind"] != nil {
            MessageReminders.cancel(chat: thread.id, message: Organize.entryKey(entry))
        }
    }

    /// A chat back from Recently Deleted: the reminders still ahead that were set here ring again (others ring on
    /// the device that set them).
    func resumeReminders(_ thread: ChatThread) {
        guard let raw = thread.organized?.entries else { return }
        let here = String(Activation.shared.appId.prefix(12))
        let now = Date().timeIntervalSince1970 * 1000
        for (index, entry) in thread.entries.enumerated() where raw.indices.contains(index) {
            guard let remind = entry.remind, remind.at > now, remind.dev == nil || remind.dev == here else { continue }
            let title = entry.isNote ? (entry.page.map { $0.title.isEmpty ? $0.url : $0.title } ?? thread.name) : thread.name
            let page = remind.page == true ? entry.page.flatMap { URL(string: $0.url) } : nil
            let key = Organize.entryKey(raw[index])
            Task {
                _ = await MessageReminders.schedule(chat: thread.id, message: key, at: Date(timeIntervalSince1970: remind.at / 1000), title: title,
                                                    body: ReminderTimes.asked(entry.reminderText), open: page, ask: false)
            }
        }
    }

    /// The reminders still to ring, in every chat, as rows: a page reminder titled with its page and opening it.
    func reminderItems(pending: [String: Date]) -> [LaterItem] {
        let now = Date().timeIntervalSince1970 * 1000
        var out: [LaterItem] = []
        for thread in threads {
            guard let raw = thread.organized?.entries else { continue }
            for (index, entry) in thread.entries.enumerated() where raw.indices.contains(index) {
                guard let remind = entry.remind, remind.at > now else { continue }
                let key = Organize.entryKey(raw[index])
                let page = entry.isNote ? entry.page : nil
                let at = Date(timeIntervalSince1970: remind.at / 1000)
                let here = pending[MessageReminders.identifier(chat: thread.id, message: key)] != nil
                out.append(LaterItem(
                    id: "remind:\(thread.id):\(key)",
                    kind: .remind,
                    title: page.map { $0.title.isEmpty ? host(of: $0.url) : $0.title } ?? thread.name,
                    url: remind.page == true ? page.flatMap { URL(string: $0.url) } : nil,
                    status: here ? ReminderTimes.label(at) : String(localized: "\(ReminderTimes.label(at)) · on another device"),
                    detail: entry.remindWords.flatMap { $0.isEmpty ? nil : $0 },
                    sortAt: at,
                    here: here
                ))
            }
        }
        return out
    }
}

// MARK: - The list

/// "Reminders" (the bells, the soonest first) or "Watching" (the eyes, the latest checked first), each row with its
/// status; a tap opens what it's about, a swipe cancels it, and a reminder's time can be changed. Empty, each says
/// where its own are set.
struct RemindersView: View {
    @ObservedObject var library: ChatLibrary
    var kind: LaterItem.Kind = .remind
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var items: [LaterItem] = []
    @State private var loaded = false
    @State private var changing: LaterItem?
    @State private var note: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(items) { item in
                    Button { open(item) } label: { row(item) }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { Task { await cancel(item) } } label: {
                                Label(item.kind == .remind ? "Don't remind" : "Stop watching", systemImage: item.kind == .remind ? "bell.slash" : "eye.slash")
                            }
                        }
                        .contextMenu {
                            if item.kind == .remind { Button("Change time") { changing = item } }
                            Button(item.kind == .remind ? "Don't remind" : "Stop watching", role: .destructive) { Task { await cancel(item) } }
                        }
                }
            }
            .overlay {
                if loaded && items.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: kind == .remind ? "bell" : "eye").font(.largeTitle).foregroundColor(.secondary)
                        if kind == .remind {
                            Text("No reminders").font(.headline)
                            Text("Set one on an answer or a note, with the bell by selected text in Safari, or on a page: … → Remind me about this page.")
                                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                        } else {
                            Text("Nothing watched").font(.headline)
                            Text("In Safari, select a price, stock or a date and tap the eye. For the whole page: … → Watch this page.")
                                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                        }
                    }
                    .padding(32)
                }
            }
            .navigationTitle(kind == .remind ? "Reminders" : "Watching")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $changing) { item in
                RemindSheet(current: item.sortAt, note: note, quote: reminderEntry(item)?.cited?.cite, words: reminderEntry(item)?.remindWords, pick: { at, preset, words in
                    Task { await change(item, at: at, preset: preset, words: words) }
                }, cancel: {
                    changing = nil
                    Task { await cancel(item) }
                })
            }
            .task {
                await reload()
                // A step for the feature counters (the "use" kind, src/shared/usage.ts): how many of each it held.
                ChatAI.reportOrganize("use", ["f": "later", "a": "open", "via": "tab", "s": "app", "what": kind.rawValue,
                                              "reminders": String(kind == .remind ? items.count : 0),
                                              "watches": String(kind == .watch ? items.count : 0)])
            }
            .refreshable { await reload() }
        }
        .frame(minWidth: 360, minHeight: 420)
    }

    private func row(_ item: LaterItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: item.kind == .remind ? "bell" : "eye")
                .foregroundColor(item.here ? brandBlue : .secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).lineLimit(1)
                if let detail = item.detail { Text(detail).font(.subheadline).lineLimit(3) }
                // All of it, wrapped (2.5 (75)): a watch's status can be long, and "Today 15:41 · on another device"
                // doesn't fit one line at 375 pt in every language.
                Text(item.status).font(.subheadline).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func reload() async {
        if kind == .remind {
            // The soonest first.
            items = library.reminderItems(pending: await MessageReminders.pending()).sorted { $0.sortAt < $1.sortAt }
        } else {
            // The latest checked first.
            var all: [LaterItem] = []
            for source in LaterCenter.shared.sources where source.kind == kind { all += await source.items() }
            items = all.filter { $0.kind == kind }.sorted { $0.sortAt > $1.sortAt }
        }
        loaded = true
    }

    /// A page reminder or a watch opens its page in Safari; a reminder on an answer or a note, its chat at the message.
    private func open(_ item: LaterItem) {
        if let url = item.url {
            openURL(url)
            return
        }
        guard item.kind == .remind, let ref = reminderKey(item) else { return }
        dismiss()
        ChatLinks.shared.pending = (chat: ref.chat, message: ref.key)
    }

    private func cancel(_ item: LaterItem) async {
        if item.kind == .remind, let ref = reminderKey(item), let found = library.find(messageKey: ref.key, hint: ref.chat) {
            _ = await library.remind(found.thread, entry: found.index, at: nil, preset: nil, how: "list")
        } else {
            for source in LaterCenter.shared.sources { await source.cancel(item.id) }
        }
        await reload()
    }

    /// The message a reminder's row is on.
    private func reminderEntry(_ item: LaterItem) -> ChatEntry? {
        guard let ref = reminderKey(item), let found = library.find(messageKey: ref.key, hint: ref.chat),
              found.thread.entries.indices.contains(found.index) else { return nil }
        return found.thread.entries[found.index]
    }

    private func change(_ item: LaterItem, at: Date, preset: String, words: String? = nil) async {
        guard let ref = reminderKey(item), let found = library.find(messageKey: ref.key, hint: ref.chat) else { return }
        if await library.remind(found.thread, entry: found.index, at: at, preset: preset, how: "list", words: words) {
            note = nil
            changing = nil
            await reload()
        } else {
            note = String(localized: "Notifications are off for ContextFlow. Turn them on in Settings → Notifications → ContextFlow.")
        }
    }

    /// "remind:<chat>:<message key>" → the chat and the message.
    private func reminderKey(_ item: LaterItem) -> (chat: String, key: String)? {
        let parts = item.id.split(separator: ":", maxSplits: 2).map(String.init)
        return parts.count == 3 && parts[0] == "remind" ? (parts[1], parts[2]) : nil
    }
}

// MARK: - The chats list's rows (build 94)

/// A chat's row in the chats list, build 94 (the owner, on TestFlight 93: «на полоске чата хочется видеть глаз и число
/// там где установлены наблюдения за изменениями и колокольчик, если напоминалка стоит»): the eye with how many of the
/// chat's pages are watched, the bell while one of its reminders is still to ring, and a spinner while its last question
/// is being answered in Safari (an answer or Find similar, on this device or another one). And the chats an "Ask your
/// chats" answer names, as links that open them. The same rules as src/shared/chatMarks.ts and, for the spinner,
/// pendingQuestion in src/shared/jobs.ts (tests/chatMarks.test.mts reads this file).
enum RowMarks {
    /// src/shared/jobs.ts ORPHAN_MS: by then a question without an answer isn't being answered any more.
    static let orphan: TimeInterval = 120
    /// A name shorter than this isn't looked for in an answer's text ("AI" or "Notes" would link ordinary words).
    static let minName = 6
    /// `[name](chat:<id>)`, as the server asks the model to write a chat it names.
    static let chatLink = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\(chat:([A-Za-z0-9_-]{1,64})\)"#)
    private static let guarded = try! NSRegularExpression(pattern: #"```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)"#)

    #if DEBUG
    /// -CFDebugSeedRows YES (Chats.swift): the seeded mug chat's pages count as watched.
    static var debugWatched: [String] {
        UserDefaults.standard.bool(forKey: "CFDebugSeedRows") ? ["https://shop.example/mug", "https://shop.example/mug/reviews"] : []
    }
    #endif

    /// Whether a reminder in the chat is still to ring: the bell.
    static func remindsAhead(_ entries: [ChatEntry], now: Date = Date()) -> Bool {
        let ms = now.timeIntervalSince1970 * 1000
        return entries.contains { ($0.remind?.at ?? 0) > ms }
    }

    /// How many of `watched` (the watched pages' addresses) are pages of the chat: the eye's number.
    static func watches(_ entries: [ChatEntry], watched: [String]) -> Int {
        guard !watched.isEmpty else { return 0 }
        let pages = Set(entries.compactMap { $0.isUser ? $0.page.map { urlKey($0.url) } : nil })
        return pages.isEmpty ? 0 : watched.filter { pages.contains(urlKey($0)) }.count
    }

    /// The chat's last question still waits for its answer: asked under `orphan` ago, no answer after it yet.
    static func pending(_ entries: [ChatEntry], now: Date = Date()) -> Bool {
        guard let last = entries.last, last.isUser, !last.isNote, let at = last.t ?? last.page?.at else { return false }
        let age = now.timeIntervalSince1970 - at / 1000
        return age >= -60 && age < orphan
    }

    /// "The same page": no hash, no tracking parameters (src/shared/conversation.ts urlKey).
    static func urlKey(_ href: String) -> String {
        guard var parts = URLComponents(string: href) else { return href }
        parts.fragment = nil
        if let items = parts.queryItems {
            let kept = items.filter { $0.name.range(of: #"^(utm_|fbclid|gclid|yclid|mc_|ref$|ref_src)"#, options: [.regularExpression, .caseInsensitive]) == nil }
            parts.queryItems = kept.isEmpty ? nil : kept
        }
        if parts.path.isEmpty { parts.path = "/" }
        return parts.string ?? href
    }

    /// The answer with the chats it names as links: the model's links kept for a chat that's there (else its name
    /// alone), and a chat's name written out in full linked the first time it appears (answers from before the server
    /// asked for links). Not in code, not inside a link, not inside a longer word; the longest names first.
    static func linkChats(_ text: String, chats: [(id: String, name: String)]) -> String {
        let known = Set(chats.map(\.id))
        var out = text
        var linked = Set<String>()
        for match in chatLink.matches(in: out, range: NSRange(out.startIndex..., in: out)).reversed() {
            guard let whole = Range(match.range, in: out), let label = Range(match.range(at: 1), in: out), let id = Range(match.range(at: 2), in: out) else { continue }
            let chat = String(out[id])
            if known.contains(chat) { linked.insert(chat) } else { out.replaceSubrange(whole, with: String(out[label])) }
        }
        let names = chats
            .map { (id: $0.id, name: $0.name.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)) }
            .filter { $0.name.count >= minName && !linked.contains($0.id) }
            .sorted { $0.name.count > $1.name.count }
        for chat in names {
            let pattern = #"(^|[^\p{L}\p{N}])("# + NSRegularExpression.escapedPattern(for: chat.name).replacingOccurrences(of: " ", with: #"\s+"#) + #")(?![\p{L}\p{N}])"#
            guard let word = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { continue }
            let all = NSRange(out.startIndex..., in: out)
            let kept = guarded.matches(in: out, range: all).map(\.range)
            guard let hit = word.matches(in: out, range: all).map({ $0.range(at: 2) }).first(where: { r in !kept.contains { NSIntersectionRange($0, r).length > 0 } }),
                  let range = Range(hit, in: out) else { continue }
            out.replaceSubrange(range, with: "[\(out[range])](chat:\(chat.id))")
        }
        return out
    }

    /// A chat link's name alone (copies, shares, snippets).
    static func unlinked(_ text: String) -> String {
        chatLink.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "$1")
    }
}
