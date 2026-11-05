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
    func remind(_ thread: ChatThread, entry index: Int, at: Date?, preset: String?, how: String? = nil) async -> Bool {
        guard let raw = thread.organized?.entries, raw.indices.contains(index), thread.entries.indices.contains(index) else { return true }
        let entry = thread.entries[index]
        let key = Organize.entryKey(raw[index])
        var event: [String: String] = ["what": entry.remind?.page == true ? "page" : entry.isNote ? "note" : "answer"]
        if let how { event["how"] = how }
        guard let at else {
            MessageReminders.cancel(chat: thread.id, message: key)
            setRemind(thread, entry: index, nil)
            ChatAI.reportUx("ux_remind", event.merging(["action": "cancelled"]) { $1 })
            return true
        }
        // A note made on a page says that page's title; a page reminder ("Remind me about this page") opens the page
        // (src/shared/reminders.ts reminderNotice).
        let title = entry.isNote ? (entry.page.map { $0.title.isEmpty ? $0.url : $0.title } ?? thread.name) : thread.name
        let page = entry.remind?.page == true ? entry.page.flatMap { URL(string: $0.url) } : nil
        let outcome = await MessageReminders.schedule(chat: thread.id, message: key, at: at, title: title,
                                                      body: ReminderTimes.asked(entry.content), open: page, ask: true)
        guard outcome == .scheduled else {
            ChatAI.reportUx("ux_remind", event.merging(["action": "denied"]) { $1 })
            return false
        }
        setRemind(thread, entry: index, ChatRemind(at: at.timeIntervalSince1970 * 1000, dev: String(Activation.shared.appId.prefix(12)), page: entry.remind?.page))
        ChatAI.reportUx("ux_remind", event.merging(["action": "set", "preset": preset ?? "custom"]) { $1 })
        return true
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
                            Text("In Safari, select a price, stock or a date and tap the eye.")
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
                RemindSheet(current: item.sortAt, note: note, pick: { at, preset in
                    Task { await change(item, at: at, preset: preset) }
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

    private func change(_ item: LaterItem, at: Date, preset: String) async {
        guard let ref = reminderKey(item), let found = library.find(messageKey: ref.key, hint: ref.chat) else { return }
        if await library.remind(found.thread, entry: found.index, at: at, preset: preset, how: "list") {
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
