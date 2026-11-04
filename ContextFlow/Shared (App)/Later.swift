import SwiftUI

// "Come back later" in the app (2.5, the owner's "remind or watch"): the bell is about time ("I know when"), the
// eye about a change ("I don't know when"), never mixed. "Reminders" lists both: the reminders in the chats (here)
// and what's watched (watching's branch registers its source with LaterCenter, one line in its AppDelegate).
// The same shape as src/content/ux/later.ts.

/// A row in "Reminders": a reminder (the bell) or something watched (the eye).
struct LaterItem: Identifiable, Hashable {
    enum Kind: String { case remind, watch }
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

/// Rows that aren't reminders in the chats (watching): listed, and stopped from the list.
protocol LaterSource {
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
        // A note made on a page says that page's title; a page reminder ("Come back later") opens the page
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

/// "Reminders": the bells and the eyes together, the soonest first, each with its status; a tap opens what it's
/// about, a swipe cancels it, and a reminder's time can be changed.
struct RemindersView: View {
    @ObservedObject var library: ChatLibrary
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
                                Label(item.kind == .remind ? "Don't remind" : "Stop", systemImage: item.kind == .remind ? "bell.slash" : "eye.slash")
                            }
                        }
                        .contextMenu {
                            if item.kind == .remind { Button("Change time") { changing = item } }
                            Button(item.kind == .remind ? "Don't remind" : "Stop", role: .destructive) { Task { await cancel(item) } }
                        }
                }
            }
            .overlay {
                if loaded && items.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "bell").font(.largeTitle).foregroundColor(.secondary)
                        Text("No reminders").font(.headline)
                        Text("Set one on an answer or a note, or on a page in Safari: … → Come back later.")
                            .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                    }
                    .padding(32)
                }
            }
            .navigationTitle("Reminders")
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
                ChatAI.reportUx("ux_later", ["action": "opened", "n_remind": String(items.filter { $0.kind == .remind }.count), "n_watch": String(items.filter { $0.kind == .watch }.count)])
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
                // Two lines: "Today 15:41 · on another device" doesn't fit one at 375 pt in every language.
                Text(item.status).font(.subheadline).foregroundColor(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func reload() async {
        let pending = await MessageReminders.pending()
        var all = library.reminderItems(pending: pending)
        for source in LaterCenter.shared.sources { all += await source.items() }
        // Reminders the soonest first; watches after them, the latest checked first.
        items = all.filter { $0.kind == .remind }.sorted { $0.sortAt < $1.sortAt } + all.filter { $0.kind == .watch }.sorted { $0.sortAt > $1.sortAt }
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
