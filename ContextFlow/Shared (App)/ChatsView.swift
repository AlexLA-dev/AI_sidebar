import StoreKit
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
import SafariServices
#endif

// MARK: - The list

/// A chat opened from the list, by value: its screen stays when its row moves or goes (a move to another chat
/// reorders the list), which a link holding the screen itself didn't survive on iPhone.
struct ChatRoute: Hashable {
    let id: String
    var history = false
    var scrollTo: Int?
}

/// The chats from Safari: each with its pages, which open in Safari.
struct ChatsView: View {
    @ObservedObject var library: ChatLibrary
    @ObservedObject var activation: Activation
    @ObservedObject var store = StoreKitManager.shared
    /// iOS: the setup guide (the Get Started tab is gone once there are chats).
    var openSetup: () -> Void = {}
    /// The Pro screen (from the AI features, without Pro).
    var openPro: () -> Void = {}
    /// Build 94: the "…" on the Chats screen opens Settings and Tips (their tabs).
    var openTab: (AppTab) -> Void = { _ in }

    /// The search field's two ways (2.6 (98), the owner on TestFlight 97: «Не понятно, что это в приложении и зачем», of
    /// the ✦ button and the "Describe what you remember…" row that looked like a second field): one field, its two
    /// ways named under it, "By words" and "By meaning" (Pro, AI search). "Ask your chats" stays its own named row.
    enum SearchWay: Hashable { case words, meaning }
    @State private var way: SearchWay = .words
    // AI search (Pro): on, the query it ran, and its answer.
    private var aiSearch: Bool { way == .meaning }
    @State private var finding = false
    @State private var found: (query: String, results: Result<[ChatAI.Found], ChatAI.Failure>)?
    /// The search waiting for the AI consent.
    @State private var consentAsk: (() -> Void)?

    private var isPro: Bool { store.isPro }

    @State private var renaming: ChatThread?
    @State private var newName = ""
    @State private var deleting: ChatThread?
    @State private var query = ""
    /// The "first time here" hint about the Chats screen (the advanced level of the onboarding).
    @AppStorage("cf_hint_chats_seen") private var hintSeen = false
    /// Only the chats with this tag.
    @State private var tagFilter: String?
    /// The chat whose tags are being picked.
    @State private var tagging: ChatThread?

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// A reminder's notification was tapped: the chat the message is in now, at the message (2.5).
    @ObservedObject private var links = ChatLinks.shared
    @ObservedObject private var organize = OrganizeModel.shared
    // 2.6: open organizing suggestions per chat, and the chats whose badge was counted as shown.
    @State private var recs: [String: Int] = [:]
    @State private var recsSeen = Set<String>()
    @State private var listShown = false
    @State private var linked: (threadId: String, index: Int)?
    // "Reminders" or "Watching" (2.5 (77): two lists, never one), from the Chats toolbar's "…" (build 94).
    @State private var showingList: LaterItem.Kind?
    // Build 94: Recently Deleted from the "…"; the watched pages' addresses (the rows' eyes); a tick every 30 s while the
    // list shows, so a reminder that rang loses its bell and an answered or abandoned question its spinner.
    @State private var showingTrash = false
    @State private var watched: [String] = []
    @State private var tick = Date()

    #if DEBUG
    private func showListAtLaunch() {
        if UserDefaults.standard.bool(forKey: "CFShowReminders") { showingList = .remind }
        else if UserDefaults.standard.bool(forKey: "CFShowWatching") { showingList = .watch }
    }
    #endif

    private func openLinked() {
        guard let request = links.pending, let found = library.find(messageKey: request.message, hint: request.chat) else { return }
        links.pending = nil
        linked = (found.thread.id, found.index)
    }

    var body: some View {
        List {
            if aiSearch && (searching || finding || found != nil) {
                aiResults
            } else if searching {
                searchResults
            } else {
                // "By meaning" with nothing typed yet: what it does, over the chats.
                if aiSearch { meaningHint }
                chatList
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .refreshable { await library.refreshNow() }
        #endif
        // In the stack with the rows' ChatRoute links; a fresh screen for each link (a tap while one is open).
        .navigationDestination(isPresented: Binding(get: { linked != nil }, set: { if !$0 { linked = nil } })) {
            if let linked {
                ChatDetailView(library: library, threadId: linked.threadId, scrollTo: linked.index, openPro: openPro)
                    .id("\(linked.threadId)#\(linked.index)")
            }
        }
        .onReceive(links.$pending) { _ in openLinked() }
        .onChange(of: library.threads.count) { _ in openLinked() }
        .searchable(text: $query, prompt: aiSearch ? Text("Describe the chat you're looking for…") : Text("Search chats"))
        .searchScopes($way) {
            Text("By words").tag(SearchWay.words)
            Text(isPro ? "By meaning" : "By meaning · Pro").tag(SearchWay.meaning)
        }
        .onChange(of: way) { next in
            found = nil
            // Without Pro, "By meaning" opens Pro and the field stays on words.
            if next == .meaning && !isPro {
                way = .words
                openPro()
            }
        }
        .onSubmit(of: .search) { runFind() }
        .onChange(of: query) { value in
            if value.isEmpty { found = nil }
        }
        .toolbar {
            // Build 94, the owner: «в меню чатов тоже нужно добавить кнопку <…> где будут подходящие функции, хотя бы
            // watch list, settings, tips, все про онбординг». The Safari panel's chats list has the same "…"
            // (src/content/ux/PageMenu.tsx): the lists (the bell, the eye; 2.5 (77): two words, two icons), Recently
            // Deleted, and the rest under "Other…". The bell and the eye were toolbar buttons of their own until 93.
            ToolbarItem { listMenu }
        }
        .overlay {
            // With chats in Recently Deleted, its row is the list.
            if library.loaded && library.threads.isEmpty && library.trashed.isEmpty && !searching {
                EmptyChats()
            }
        }
        .navigationTitle("Chats")
        .navigationDestination(for: ChatRoute.self) { route in
            destination(for: route)
                .onAppear {
                    if recs[route.id] != nil { ChatAI.reportOrganize("organize", ["action": "tap", "what": "badge"]) }
                }
        }
        .sheet(item: $showingList) { kind in RemindersView(library: library, kind: kind) }
        .navigationDestination(isPresented: $showingTrash) { RecentlyDeletedView(library: library) }
        // The rows' eyes and the tick (build 94).
        .task(id: listShown) {
            while listShown && !Task.isCancelled {
                watched = LaterCenter.shared.lists(.watch) ? WatchStore.entries().map(\.url) : []
                #if DEBUG
                watched += RowMarks.debugWatched
                #endif
                tick = Date()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        #if DEBUG
        // Local checks without taps: -CFShowReminders YES opens "Reminders", -CFShowWatching YES "Watching", once the
        // chats are in.
        .onAppear { if library.loaded { showListAtLaunch() } }
        .onChange(of: library.loaded) { loaded in
            if loaded { showListAtLaunch() }
        }
        #endif
        .aiConsent($consentAsk)
        .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") {
                if let renaming { library.rename(renaming, to: newName) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        } message: {
            Text("Leave it empty to name the chat after its first question.")
        }
        .confirmationDialog("Delete this chat?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let deleting { library.trash(deleting) }
                deleting = nil
            }
        } message: {
            Text("You can restore it from Recently Deleted for 30 days.")
        }
        .onAppear {
            library.refresh()
            listShown = true
        }
        // A chat opened over the list (iPhone): the list's counts wait until it shows again.
        .onDisappear { listShown = false }
        // 2.6 (Pro, suggestions on): how many open suggestions each chat has, again when chats or their messages
        // change (not a pin, a mark or a sync of the same messages: 2.6 (91), that recounted all the time while a
        // chat was open, on the main thread); each chat's "N recommendations" counted once as shown.
        // 2.6 (93): and when a chat's record changes (its name or tags, from any device).
        .task(id: listShown ? library.threads.map { "\($0.id):\($0.entries.count):\($0.org?.nm?.t ?? ""):\($0.org?.nm?.no.count ?? 0):\($0.org?.tg.count ?? 0)" }.joined(separator: ",") : "") {
            guard listShown else { return }
            // A moment first: a burst of changes (iCloud) counts once.
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await organize.refreshStatus()
            guard organize.enabled(pro: store.isPro) else { recs = [:]; return }
            let found = await organize.counts(in: library.threads)
            guard !Task.isCancelled else { return }
            recs = found
            for id in found.keys where !recsSeen.contains(id) {
                recsSeen.insert(id)
                ChatAI.reportOrganize("organize", ["action": "shown", "what": "badge"])
            }
        }
        // An Own key subscriber: whether Pro at a discount is set up, and if it's due, the card above, once a period.
        .task {
            await store.refreshUpgradeOffer()
            store.showByokOfferIfDue()
        }
        .sheet(item: $tagging) { thread in
            TagsSheet(tags: thread.ownTags, known: library.allTags) { library.setTags(thread, $0) }
        }
    }

    private var filteredThreads: [ChatThread] {
        guard let tagFilter, library.allTags.contains(where: { $0.caseInsensitiveCompare(tagFilter) == .orderedSame }) else { return library.threads }
        return library.threads.filter { $0.has(tag: tagFilter) }
    }

    /// The tags in use (tap one: only its chats) and the switch to show the list as folders by tag.
    @ViewBuilder
    private var tagBar: some View {
        let tags = library.allTags
        if !tags.isEmpty {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button {
                            library.groupByTags.toggle()
                        } label: {
                            Label("Folders", systemImage: "folder")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .foregroundColor(library.groupByTags ? .white : .secondary)
                                .background(Capsule().fill(library.groupByTags ? AnyShapeStyle(brandBlue) : AnyShapeStyle(Color.secondary.opacity(0.12))))
                        }
                        .buttonStyle(.plain)
                        ForEach(tags, id: \.self) { tag in
                            let on = tagFilter?.caseInsensitiveCompare(tag) == .orderedSame
                            Button { tagFilter = on ? nil : tag } label: { TagChipView(tag: tag, active: on) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    @ViewBuilder
    private func chatRows(_ threads: [ChatThread]) -> some View {
        ForEach(threads) { thread in
            // No gesture of our own on the row: a simultaneous tap gesture here took the tap from the link on iPhone and
            // iPad (2.6 (91–92): "I tap a chat and nothing happens"). A tap on a chat with recommendations is counted
            // when the chat shows (navigationDestination below).
            NavigationLink(value: ChatRoute(id: thread.id, history: thread.isHistory)) {
                ChatRow(thread: thread, recs: recs[thread.id] ?? 0, watches: RowMarks.watches(thread.entries, watched: watched),
                        reminder: RowMarks.remindsAhead(thread.entries, now: tick), working: RowMarks.pending(thread.entries, now: tick))
            }
            .contextMenu { menu(for: thread) }
            #if os(iOS)
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { deleting = thread } label: { Label("Delete", systemImage: "trash") }
                    .tint(.red)
                Button { startRename(thread) } label: { Label("Rename", systemImage: "pencil") }
                    .tint(.gray)
            }
            .swipeActions(edge: .leading) {
                Button { library.setPinned(thread, !thread.isPinned) } label: {
                    Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash" : "pin")
                }
                .tint(.purple)
                Button { tagging = thread } label: { Label("Tags", systemImage: "tag") }
                    .tint(brandBlue)
            }
            #endif
        }
    }

    private func runFind() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard aiSearch, !q.isEmpty, !finding else { return }
        guard AIConsent.given else {
            consentAsk = { runFind() }
            return
        }
        finding = true
        Task {
            do {
                found = (q, .success(try await ChatAI.find(q, in: library.threads)))
            } catch let failure as ChatAI.Failure {
                found = (q, .failure(failure))
                if failure == .proOnly { openPro() }
            } catch {
                found = (q, .failure(.network))
            }
            finding = false
        }
    }

    /// AI search: what to type, then the chats the AI found, each with why.
    @ViewBuilder
    private var aiResults: some View {
        if finding {
            HStack(spacing: 8) {
                ProgressView()
                Text("Searching your chats…").foregroundColor(.secondary)
            }
        } else if let found {
            switch found.results {
            case .failure(let failure):
                Text(failure.message).foregroundColor(.secondary)
            case .success(let results) where results.isEmpty:
                Text("No chats found for “\(found.query)”").foregroundColor(.secondary)
            case .success(let results):
                ForEach(results, id: \.self) { result in
                    if let thread = library.threads.first(where: { $0.id == result.id }) {
                        NavigationLink(value: ChatRoute(id: thread.id, history: thread.isHistory)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(thread.name).font(.headline).lineLimit(1)
                                if !result.why.isEmpty {
                                    Label(result.why, systemImage: "sparkles")
                                        .font(.subheadline)
                                        .foregroundColor(brandBlue)
                                        .lineLimit(2)
                                }
                                Text(thread.lastActivity, style: .relative).font(.caption).foregroundColor(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
        } else {
            meaningHint
        }
    }

    /// What "By meaning" does, as words under the field, not a row that looks like another field (2.6 (98)).
    private var meaningHint: some View {
        Section {
        } footer: {
            Text("Describe what you remember, in any words, and press Search: “the article about sleep and coffee from last week”.")
        }
    }

    @ViewBuilder
    private func destination(for route: ChatRoute) -> some View {
        if route.history {
            HistoryChatView(library: library, threadId: route.id, openPro: openPro)
        } else {
            ChatDetailView(library: library, threadId: route.id, scrollTo: route.scrollTo, openPro: openPro)
        }
    }

    /// Chats with every word of the query, and where they matched (each opens the chat there).
    @ViewBuilder
    private var searchResults: some View {
        let results = ChatSearch.search(library.threads, query)
        if results.isEmpty {
            Text("No chats found for “\(query.trimmingCharacters(in: .whitespaces))”")
                .foregroundColor(.secondary)
        }
        ForEach(results) { result in
            NavigationLink(value: ChatRoute(id: result.thread.id, history: result.thread.isHistory, scrollTo: result.thread.isHistory ? nil : result.hits.first?.index)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(result.thread.name)
                        .font(.headline)
                        .lineLimit(1)
                    ForEach(result.hits, id: \.self) { hit in
                        Text(hit.excerpt)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .lineLimit(2)
                    }
                    Text(result.thread.lastActivity, style: .relative)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder
    private var chatList: some View {
            if store.renewalOff != nil {
                Section { RenewalQuestionCard() }
            }
            if store.byokOfferVisible {
                Section { ByokOfferCard(openPro: openPro) { store.byokOfferVisible = false } }
            }
            if !hintSeen && !library.threads.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Your chats from Safari", systemImage: "sparkles")
                            .font(.headline)
                            .foregroundColor(brandBlue)
                        Text("Tap a chat to read it, swipe it to pin, tag or delete it, or long-press it for more. Search by words or #tag, and turn on Folders to group by tag. In Pro, “By meaning” finds a chat from a description.")
                            .font(.callout)
                            .foregroundColor(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Got it") { hintSeen = true }
                            .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 4)
                }
            }
            if activation.state == .off {
                Section { ExtensionOffBanner(openSetup: openSetup) }
            }
            if library.cloud == .off {
                Section { SyncOffBanner(library: library) }
            }
            tagBar
            if tagFilter == nil, library.threads.contains(where: { !$0.isHistory }) {
                Section {
                    if isPro {
                        NavigationLink(destination: HistoryChatView(library: library, threadId: nil, openPro: openPro)) { AskHistoryRow(pro: true) }
                    } else {
                        Button(action: openPro) { AskHistoryRow(pro: false) }
                            .buttonStyle(.plain)
                    }
                }
            }
            if library.groupByTags && !library.allTags.isEmpty {
                // Like folders: a section per tag (a chat with two tags is in both), then the chats without tags.
                let shown = filteredThreads
                ForEach(library.allTags.filter { tag in shown.contains { $0.has(tag: tag) } }, id: \.self) { tag in
                    Section(header: Label("#\(tag)", systemImage: "folder")) {
                        chatRows(shown.filter { $0.has(tag: tag) })
                    }
                }
                let untagged = shown.filter { $0.tags.isEmpty }
                if !untagged.isEmpty {
                    Section(header: Label("No tag", systemImage: "folder"), footer: footer) { chatRows(untagged) }
                }
            } else {
                Section(footer: footer) { chatRows(filteredThreads) }
            }
            // Recently Deleted (2.5 (83)): at the end of the list, while it has chats.
            if tagFilter == nil && !library.trashed.isEmpty {
                Section {
                    NavigationLink(destination: RecentlyDeletedView(library: library)) {
                        HStack {
                            Label("Recently Deleted", systemImage: "trash")
                            Spacer(minLength: 8)
                            Text(verbatim: String(library.trashed.count)).foregroundColor(.secondary).monospacedDigit()
                        }
                    }
                }
            }
    }

    /// The Chats screen's "…" (build 94).
    private var listMenu: some View {
        let now = Date().timeIntervalSince1970 * 1000
        let reminders = library.threads.reduce(0) { sum, thread in sum + thread.entries.filter { ($0.remind?.at ?? 0) > now }.count }
        return Menu {
            Button { showingList = .remind } label: {
                Label(reminders > 0 ? "Reminders · \(reminders)" : "Reminders", systemImage: "bell")
            }
            if LaterCenter.shared.lists(.watch) {
                Button { showingList = .watch } label: {
                    Label(watched.isEmpty ? "Watching" : "Watching · \(watched.count)", systemImage: "eye")
                }
            }
            if !library.trashed.isEmpty {
                Button { showingTrash = true } label: { Label("Recently Deleted · \(library.trashed.count)", systemImage: "trash") }
            }
            Menu {
                Button { openTab(.settings) } label: { Label("Settings", systemImage: "gearshape") }
                Button { openTab(.tips) } label: { Label("Tips", systemImage: "lightbulb") }
                if let tier = store.tier, tier != .byok {
                    Button { PlanTour.shared.show(tier) } label: { Label("What's in \(tier.name)", systemImage: "sparkles") }
                }
                Button(action: openSetup) { Label("How to turn on ContextFlow", systemImage: "safari") }
            } label: {
                Label("Other…", systemImage: "ellipsis")
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("cf-list-menu")
    }

    @ViewBuilder
    private var footer: some View {
        if library.cloud == .unavailable && !library.threads.isEmpty {
            Text("Chats from your other devices show up when iCloud is available. Check that you're signed in to iCloud.")
        }
    }

    @ViewBuilder
    private func menu(for thread: ChatThread) -> some View {
        if thread.lastPage != nil {
            Button { library.continueInSafari(thread) } label: { Label("Continue in Safari", systemImage: "safari") }
        }
        Button { startRename(thread) } label: { Label("Rename", systemImage: "pencil") }
        Button { tagging = thread } label: { Label("Tags", systemImage: "tag") }
        Button { library.setPinned(thread, !thread.isPinned) } label: {
            Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash" : "pin")
        }
        Button(role: .destructive) { deleting = thread } label: { Label("Delete", systemImage: "trash") }
    }

    private func startRename(_ thread: ChatThread) {
        newName = thread.title ?? ""
        renaming = thread
    }
}

/// Recently Deleted (2.5 (83), the owner: «надо сделать … Trash, где до 30 дней пусть хранятся удаленные чаты»): the
/// chats deleted here, in Safari or on another device, kept 30 days, the last one deleted first. Each can be restored
/// (to its old place in the list) or deleted now; Delete All asks first. As in Apple's apps, they aren't opened here.
struct RecentlyDeletedView: View {
    @ObservedObject var library: ChatLibrary
    @State private var confirmAll = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                ForEach(library.trashed) { thread in
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(thread.name).font(.headline).lineLimit(1)
                            Text("\(thread.daysLeft()) days").font(.caption).foregroundColor(.secondary)
                        }
                        HStack(spacing: 10) {
                            Button("Restore") { library.restore(thread) }
                            Button("Delete Now", role: .destructive) { library.deleteNow([thread]) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    .padding(.vertical, 4)
                    .contextMenu {
                        Button { library.restore(thread) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                        Button(role: .destructive) { library.deleteNow([thread]) } label: { Label("Delete Now", systemImage: "trash") }
                    }
                    #if os(iOS)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { library.deleteNow([thread]) } label: { Label("Delete Now", systemImage: "trash") }
                    }
                    .swipeActions(edge: .leading) {
                        Button { library.restore(thread) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                            .tint(brandBlue)
                    }
                    #endif
                }
            } footer: {
                Text("Chats are available here for 30 days. After that time, they will be permanently deleted.")
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
        .navigationTitle("Recently Deleted")
        .toolbar {
            ToolbarItem {
                Button("Delete All", role: .destructive) { confirmAll = true }
                    .disabled(library.trashed.isEmpty)
            }
        }
        .confirmationDialog("Delete all chats in Recently Deleted?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Delete All", role: .destructive) { library.deleteNow(library.trashed) }
        } message: {
            Text("This action can't be undone.")
        }
        // Emptied (everything restored or deleted, here or elsewhere): back to the list, where its row goes too.
        .onChange(of: library.trashed.isEmpty) { empty in
            if empty { dismiss() }
        }
    }
}

/// On top of the list: questions about all the chats (Pro).
private struct AskHistoryRow: View {
    let pro: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "sparkles")
                .font(.title3)
                .foregroundColor(.white)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 10).fill(brandGradient))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Ask your chats").font(.headline).foregroundColor(brandBlue)
                    if !pro { ProBadge() }
                }
                Text("Questions about everything you've read and asked")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

struct ProBadge: View {
    var body: some View {
        Text("Pro")
            .font(.caption2.weight(.bold))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(brandGradient))
    }
}

// MARK: - Ask your chats

/// "Ask your chats" (Pro): questions answered from all the other chats. Continues today's chat, or
/// starts a new one; it's stored like any chat (and reaches Safari and the other devices).
struct HistoryChatView: View {
    @ObservedObject var library: ChatLibrary
    /// The chat to continue; nil: today's, else a new one.
    let threadId: String?
    var openPro: () -> Void

    @State private var id = UUID().uuidString.lowercased()
    @State private var messages: [[String: String]] = []
    @State private var draft = ""
    @State private var streaming: String?
    @State private var failure: ChatAI.Failure?
    /// The question waiting for the AI consent.
    @State private var consentAsk: (() -> Void)?
    @FocusState private var focused: Bool
    /// The answer just copied: "Copied" for a moment.
    @State private var copied: Int?
    @Environment(\.requestReview) private var requestReview
    /// A chat opened from a link in an answer (build 94).
    @State private var openedChat: String?

    private static let examples = ["What did I read this week?", "Summarize my notes", "What have I learned about AI?"]

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if messages.isEmpty && streaming == nil {
                            VStack(alignment: .leading, spacing: 12) {
                                Label("Ask your chats", systemImage: "sparkles").font(.title3.weight(.bold)).foregroundColor(brandBlue)
                                Text("Ask about everything you've read and asked with ContextFlow, across all your chats.")
                                    .foregroundColor(.secondary)
                                ForEach(Self.examples, id: \.self) { example in
                                    Button { send(String(localized: String.LocalizationValue(example))) } label: {
                                        Text(LocalizedStringKey(example)).padding(.horizontal, 12).padding(.vertical, 7)
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                        }
                        let entries = messages.map { ChatEntry(role: $0["role"] ?? "", content: $0["content"] ?? "") }
                        let labels = ShareText.labels(for: entries)
                        ForEach(Array(messages.enumerated()), id: \.offset) { index, m in
                            if m["role"] == "user" {
                                Text(m["content"] ?? "")
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 14).padding(.vertical, 10)
                                    .background(RoundedRectangle(cornerRadius: 18).fill(brandBlue))
                                    .frame(maxWidth: .infinity, alignment: .trailing)
                                    .padding(.leading, 40)
                            } else {
                                VStack(alignment: .leading, spacing: 8) {
                                    MarkdownView(text: RowMarks.linkChats(m["content"] ?? "", chats: chatNames))
                                    MessageTools(tags: [], copied: copied == index, shareText: ShareText.answer(entries, index, labels), copy: {
                                        Clipboard.copy(ShareText.plain(m["content"] ?? ""))
                                        copied = index
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == index { copied = nil } }
                                    }, listen: {
                                        ListenPlayer.shared.listen(answer: m["content"] ?? "", id: "history-\(index)-\((m["content"] ?? "").hashValue)", title: String(localized: "Ask your chats"))
                                    })
                                }
                            }
                        }
                        if let streaming {
                            if streaming.isEmpty {
                                HStack(spacing: 8) { ProgressView(); Text("Reading your chats…").foregroundColor(.secondary) }
                            } else {
                                MarkdownView(text: streaming)
                            }
                        }
                        if let failure {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(failure.message).foregroundColor(.secondary)
                                if failure == .proOnly { Button("Get Pro", action: openPro).buttonStyle(.borderedProminent) }
                            }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(16)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: streaming) { _ in proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: messages.count) { _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            Divider()
            HStack(spacing: 8) {
                TextField("Ask about your chats…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .onSubmit { send(draft) }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color.cardFill))
                Button { send(draft) } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || streaming != nil)
                .accessibilityLabel(Text("Send"))
            }
            .padding(10)
        }
        .navigationTitle("Ask your chats")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .aiConsent($consentAsk)
        .onAppear(perform: load)
        // Build 94, the owner: «в чате про чаты нужно делать ссылки на чаты, на которые ссылается ответ»: a chat's
        // name in an answer opens that chat over this one (Back comes back to the answer).
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "chat" else { return .systemAction }
            let id = url.absoluteString.dropFirst("chat:".count).lowercased()
            guard let chat = library.threads.first(where: { $0.id.lowercased() == id }) else { return .handled }
            ChatAI.reportOrganize("use", ["f": "ask_chats", "a": "link"])
            openedChat = chat.id
            return .handled
        })
        .navigationDestination(isPresented: Binding(get: { openedChat != nil }, set: { if !$0 { openedChat = nil } })) {
            if let openedChat {
                ChatDetailView(library: library, threadId: openedChat, openPro: openPro)
            }
        }
    }

    /// The chats an answer may name (links to them, RowMarks.linkChats).
    private var chatNames: [(id: String, name: String)] {
        library.threads.filter { !$0.isHistory && $0.id != id }.map { (id: $0.id, name: $0.name) }
    }

    private func load() {
        let now = Date()
        let chosen = threadId.flatMap { id in library.threads.first { $0.id == id } }
            ?? library.threads.first { $0.isHistory && now.timeIntervalSince($0.lastActivity) < 24 * 3600 }
        guard let chosen else { return }
        id = chosen.id
        messages = chosen.entries.filter { !$0.isNote }.map { ["role": $0.role, "content": $0.content] }
    }

    private func send(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, streaming == nil else { return }
        guard AIConsent.given else {
            // Nothing is sent before the consent; the question stays in the box.
            consentAsk = { send(question) }
            return
        }
        draft = ""
        failure = nil
        messages.append(["role": "user", "content": question])
        streaming = ""
        let others = library.threads.filter { $0.id != id }
        let history = Array(messages.suffix(12))
        Task {
            do {
                try await ChatAI.askHistory(history, chats: others) { piece in streaming = (streaming ?? "") + piece }
                messages.append(["role": "assistant", "content": streaming ?? ""])
                library.saveHistory(id: id, messages: messages)
                askForReviewAfterAnswer(requestReview)
            } catch let error as ChatAI.Failure {
                failure = error
                if let partial = streaming, !partial.isEmpty { messages.append(["role": "assistant", "content": partial]) }
            } catch {
                failure = .network
            }
            streaming = nil
        }
    }
}

extension ChatAI.Failure {
    var message: String {
        switch self {
        case .proOnly: return String(localized: "This is part of Pro.")
        case .limitReached: return String(localized: "You've used this week's Pro answers. They come back on Monday.")
        case .dailyLimit: return String(localized: "You've used today's 5 free answers. Pro gives you up to 375 answers a week.")
        case .busy: return String(localized: "The AI service is busy. Please try again in a moment.")
        case .network: return String(localized: "No connection. Check the internet and try again.")
        case .consent: return String(localized: "Nothing was sent: AI answers need your consent first.")
        }
    }
}

// MARK: - Auto-renew off

/// A Pro user who turned auto-renew off: when Pro ends, and one question, what was missing (src/shared/
/// renewal.ts). Once per subscription period, here or in the Safari panel (they share the mark). The
/// answer goes to the server as "renewal_off"; nothing is offered.
struct RenewalQuestionCard: View {
    @ObservedObject var store = StoreKitManager.shared
    @State private var asked = false
    @State private var thanks = false

    private static let reasons: [(key: String, label: LocalizedStringKey)] = [
        ("price", "Too expensive"), ("rarely", "I don't use it enough"), ("answers", "Answers weren't good enough"),
        ("features", "A feature I need is missing"), ("free_enough", "The free plan is enough"), ("other", "Something else")
    ]

    var body: some View {
        if let entitlement = store.renewalOff, !asked || thanks, thanks || !SharedDefaults.shared.renewalAsked(entitlement.period) {
            VStack(alignment: .leading, spacing: 10) {
                if thanks {
                    Text("Thanks — that helps us improve ContextFlow.")
                } else {
                    if let date = entitlement.expiresAt {
                        Text("Pro ends on \(date, style: .date)").font(.headline)
                    }
                    Text("Auto-renewal is off. What was missing?")
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    ReasonFlow(reasons: Self.reasons) { answer($0, entitlement) }
                    Button("Not now") { answer("later", entitlement) }
                        .buttonStyle(.borderless)
                        .font(.callout)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func answer(_ reason: String, _ entitlement: SharedEntitlement) {
        SharedDefaults.shared.markRenewalAsked(entitlement.period)
        asked = true
        if reason != "later" {
            thanks = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { thanks = false }
        }
        Task { await ChatAI.reportRenewal(reason, entitlement) }
    }
}

// MARK: - Own key → Pro

/// A day after an Own key subscriber was first refused something this period (here or in the Safari panel): Pro
/// at the discount the server has set up. Once per period, here or in the panel (Chats decides and marks it).
/// "See the offer" opens Pro.
struct ByokOfferCard: View {
    @ObservedObject var store = StoreKitManager.shared
    var openPro: () -> Void
    var close: () -> Void

    var body: some View {
        if let discount = store.upgradeDiscount {
            VStack(alignment: .leading, spacing: 10) {
                Text("Move to Pro at \(discount)% off").font(.headline)
                Text("Pro answers without your key: up to \(375) a week, Google search, “Ask your chats” and AI search. Pro starts at once; Apple refunds the unused part of Own key.")
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Button("See the offer") {
                        close()
                        openPro()
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Not now", action: close)
                        .buttonStyle(.borderless)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

/// The answers as buttons that wrap onto the next line.
private struct ReasonFlow: View {
    let reasons: [(key: String, label: LocalizedStringKey)]
    let pick: (String) -> Void

    var body: some View {
        WrapLayout(spacing: 8) {
            ForEach(reasons, id: \.key) { reason in
                Button { pick(reason.key) } label: { Text(reason.label).font(.callout) }
                    .buttonStyle(.bordered)
            }
        }
    }
}

/// Lays its children out in rows, wrapping when a row is full.
private struct WrapLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

/// Before the app's first AI request: where questions and chat excerpts go. "Agree" runs the
/// waiting request; "Not now" sends nothing.
private struct AIConsentAlert: ViewModifier {
    @Binding var ask: (() -> Void)?
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content.alert("Before your first answer", isPresented: Binding(get: { ask != nil }, set: { if !$0 { ask = nil } })) {
            Button("Agree and continue") {
                AIConsent.give()
                let run = ask
                ask = nil
                run?()
            }
            Button("Privacy Policy") {
                ask = nil
                openURL(Links.privacy)
            }
            Button("Not now", role: .cancel) { ask = nil }
        } message: {
            // With suggestions on (2.5), the text of new messages and notes goes too: said here as well.
            if SharedDefaults.shared.readSettings()?.settings["organize"] as? Bool ?? false {
                Text("To answer, ContextFlow sends your question and excerpts of your chats via our server to Anthropic (Claude) or, if it's unavailable, OpenAI. With suggestions on, the text of new messages and notes also goes there to find where they belong. Chats are not stored on our servers: they stay on your devices and, if you sync them, in your iCloud.")
            } else {
                Text("To answer, ContextFlow sends your question and excerpts of your chats via our server to Anthropic (Claude) or, if it's unavailable, OpenAI. Chats are not stored on our servers: they stay on your devices and, if you sync them, in your iCloud.")
            }
        }
    }
}

extension View {
    func aiConsent(_ ask: Binding<(() -> Void)?>) -> some View {
        modifier(AIConsentAlert(ask: ask))
    }
}

struct ChatRow: View {
    let thread: ChatThread
    /// Open organizing suggestions in it (2.6, Pro): "N recommendations" on its last line.
    var recs = 0
    /// Build 94 (RowMarks): how many of its pages are watched (the eye), a reminder still to ring (the bell), its last
    /// question still being answered in Safari (a spinner by the name, as the panel's list has).
    var watches = 0
    var reminder = false
    var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if thread.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.caption)
                        .foregroundColor(.purple)
                        .accessibilityLabel("Pinned")
                }
                if thread.isHistory {
                    Image(systemName: "sparkles").font(.caption).foregroundColor(brandBlue)
                }
                Text(thread.name)
                    .font(.headline)
                    .lineLimit(1)
                if working {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityLabel(Text("Working on it…"))
                }
            }
            if !thread.snippet.isEmpty {
                Text(thread.snippet)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
            if !thread.tags.isEmpty {
                TagChips(tags: thread.tags)
            }
            HStack(spacing: 10) {
                if thread.pages.count > 1 {
                    Label("\(thread.pages.count) pages", systemImage: "doc.on.doc")
                } else if let page = thread.lastPage {
                    Label(host(of: page.url), systemImage: "globe")
                        .lineLimit(1)
                }
                if thread.notes > 0 {
                    Label("\(thread.notes)", systemImage: "pencil")
                        .accessibilityLabel(Text("\(thread.notes) notes"))
                }
                if watches > 0 {
                    Label("\(watches)", systemImage: "eye")
                        .accessibilityLabel(Text("Pages watched in this chat: \(watches)"))
                }
                if reminder {
                    Image(systemName: "bell")
                        .accessibilityLabel(Text("A reminder is set in this chat"))
                }
                if recs > 0 {
                    Label("\(recs) recommendations", systemImage: "sparkles")
                        .foregroundColor(brandBlue)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(thread.lastActivity, style: .relative)
                    .monospacedDigit()
            }
            .font(.caption)
            .foregroundColor(.secondary)
            .labelStyle(CompactLabelStyle())
        }
        .padding(.vertical, 4)
    }
}

/// An icon and its text, tight together.
struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon
            configuration.title
        }
    }
}

private struct EmptyChats: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40))
                .foregroundColor(.secondary)
            Text("No chats yet")
                .font(.title3.weight(.semibold))
            Text("Ask ContextFlow about a page in Safari: your chats show up here.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
    }
}

/// Sync is off: why chats from the user's other devices aren't here.
struct SyncOffBanner: View {
    @ObservedObject var library: ChatLibrary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("iCloud sync is off", systemImage: "icloud.slash")
                .font(.headline)
            Text("Only the chats from this device are here. Turn on sync to see your chats from iPhone, iPad and Mac in one place.")
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Turn on iCloud sync") {
                ExtensionSettings.setSyncChats(true)
                library.refresh()
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}

/// The extension isn't switched on: new chats can't happen until it is.
struct ExtensionOffBanner: View {
    var openSetup: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("ContextFlow is turned off in Safari", systemImage: "exclamationmark.circle.fill")
                .font(.headline)
                .foregroundColor(.orange)
            #if os(iOS)
            Text("Turn it on to ask about pages and add to your chats.")
                .font(.callout)
                .foregroundColor(.secondary)
            Button("How to turn it on", action: openSetup)
                .buttonStyle(.bordered)
            #else
            Text("Open Safari Settings → Extensions, tick ContextFlow and allow it on all websites.")
                .font(.callout)
                .foregroundColor(.secondary)
            Button("Open Safari Settings") {
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
            }
            .buttonStyle(.bordered)
            #endif
        }
        .padding(.vertical, 4)
    }
}

// MARK: - A chat

/// "Named “…” · Undo" (2.6), or why the chat couldn't be named (no Undo), or (2.6 (95)) that suggestions now come by
/// themselves, after the first one taken.
private struct NameBar {
    let id = UUID()
    let chat: String
    let text: String
    let undo: (() -> Void)?
}

struct ChatDetailView: View {
    @ObservedObject var library: ChatLibrary
    let threadId: String
    /// The message to show first (a search result).
    var scrollTo: Int? = nil
    /// The Pro screen (out of free answers).
    var openPro: () -> Void = {}
    // A question about the chat (answered from what's in it), or a note.
    @State private var draft = ""
    @State private var noteMode = false
    /// The question being answered, and the answer so far (saved to the chat once it's done).
    @State private var asking: String?
    @State private var streaming = ""
    @State private var failure: ChatAI.Failure?
    /// The question waiting for the AI consent.
    @State private var consentAsk: (() -> Void)?
    @FocusState private var focused: Bool
    /// The answer or note whose tag picker is open (under it, as in the Safari panel).
    @State private var tagging: Int?
    @State private var taggingChat = false
    /// The answer or note just copied: "Copied" for a moment.
    @State private var copied: Int?
    /// Sharing the chat: the messages picked (all at first); nil when not picking.
    @State private var picked: Set<Int>?
    @State private var chatCopied = false
    @Environment(\.requestReview) private var requestReview
    @Environment(\.dismiss) private var dismiss
    @State private var renaming = false
    @State private var newName = ""
    @State private var deleting = false
    // Organizing (2.5): the chat shown ("Open" after a move switches to the other one), the suggestions for it,
    // the bar after a move, and the cards about it.
    @State private var shownId: String?
    @ObservedObject private var organize = OrganizeModel.shared
    @ObservedObject private var store = StoreKitManager.shared
    // Build 94: texts heard to their end on this device (here or in the panel): Listen shows replaying them is free.
    @ObservedObject private var voiced = VoicedList.shared
    @State private var suggestions: OrganizeModel.Suggestions?
    @State private var undoBar: (text: String, undo: Organize.MoveUndo)?
    /// 2.6 (95): the older chat just merged into this one (its Undo keeps this chat shown).
    @State private var mergedHere: String?
    // When that bar came, when it goes and where the chat was scrolled to (a class: scrolling doesn't redraw), and
    // whether a pointer holds it.
    @State private var undoBarClock = MovedBarClock()
    // 2.6: "Named “…” · Undo" after the AI named the chat (or why it couldn't), and "Name by topic" working.
    @State private var nameBar: NameBar?
    @State private var naming = false
    @State private var undoBarHeld = false
    @State private var messShown = false
    @State private var tagsCard = false
    // The chat the first suggestion was taken in: its line stays there until the next question or note.
    @State private var firstWin: String?
    @State private var organizeTick = 0
    @State private var seen = Set<String>()
    // Chat UX (2.5): which pinned message the bar shows (and until when scrolling doesn't move it), the message whose
    // reminder is being set (and why it wasn't), a deleted message's Undo, the message flashing after a tap on the
    // bar, and whether text is being selected (no swiping then).
    @State private var pinAt = Int.max
    @State private var pinLock = Date.distantPast
    // 2.6 (97): the bar of open suggestions: the one it shows, the chip flashing after a tap, the sets counted as shown.
    @State private var sugAt = 0
    @State private var sugLit: BarSuggestion?
    @State private var sugSeen = Set<String>()
    @State private var reminding: Int?
    @State private var remindNote: String?
    // `whole`: they were the chat's last messages, still kept until the bar goes (see deleteMessage).
    @State private var deleted: (text: LocalizedStringKey, thread: ChatThread, at: Int, entries: [[String: Any]], whole: Bool)?
    @State private var flash: Int?
    @State private var selecting = false

    private var currentId: String { shownId ?? threadId }
    private var thread: ChatThread? { library.threads.first { $0.id == currentId } }

    /// The chat's answers, asked about whether they're voiced (build 95); not while one is still being written.
    private func askVoiced(_ thread: ChatThread) {
        guard streaming.isEmpty else { return }
        voiced.ask(answers: thread.entries.filter { !$0.isUser && !$0.isNote }.map(\.content))
    }

    var body: some View {
        Group {
            if let thread, deleted?.whole != true {
                let labels = ShareText.labels(for: thread.entries)
                let raw = thread.organized?.entries ?? []
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            ForEach(Array(thread.entries.enumerated()), id: \.offset) { index, entry in
                                if let page = newPage(thread.entries, index) {
                                    PageDivider(page: page) { library.open(page.url) }
                                }
                                pickRow(index) {
                                    VStack(alignment: entry.isUser ? .trailing : .leading, spacing: 8) {
                                        MessageView(entry: entry, onMarks: picked == nil ? { marks in setMarks(thread, index, marks) } : nil, onSelecting: { selecting = $0 })
                                        if let remind = entry.remind, !entry.isUser || entry.isNote {
                                            RemindChip(at: Date(timeIntervalSince1970: remind.at / 1000)) { remindNote = nil; reminding = index }
                                        }
                                        // Under an answer and under a note: its tags, then Copy, Share and Tag
                                        // (not while picking messages to share).
                                        if !entry.isUser || entry.isNote, picked == nil {
                                            MessageTools(
                                                tags: entry.tags ?? [],
                                                copied: copied == index,
                                                tagging: tagging == index,
                                                shareText: entry.isNote ? ShareText.note(thread.entries, index, labels) : ShareText.answer(thread.entries, index, labels),
                                                copy: {
                                                    if !entry.isNote, let marks = entry.marks, !marks.isEmpty {
                                                        // Highlights go as bold to apps that take rich text.
                                                        RichAnswer.copy(RichAnswer.bold(entry.content, marks: marks), plain: ShareText.plain(entry.content))
                                                        ChatAI.reportUx("ux_mark", ["action": "copied"])
                                                    } else {
                                                        Clipboard.copy(entry.isNote ? ShareText.noteCopy(entry) : ShareText.plain(entry.content))
                                                    }
                                                    copied = index
                                                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == index { copied = nil } }
                                                },
                                                tag: { withAnimation(.easeOut(duration: 0.15)) { tagging = tagging == index ? nil : index } },
                                                shareRich: !entry.isNote && !(entry.marks ?? []).isEmpty ? {
                                                    RichAnswer.share(RichAnswer.bold(entry.content, marks: entry.marks ?? []), plain: ShareText.plain(entry.content))
                                                    ChatAI.reportUx("ux_mark", ["action": "shared"])
                                                } : nil,
                                                actions: MessageActions(
                                                    pinned: entry.pinned != nil,
                                                    reminded: entry.remind != nil,
                                                    pin: { togglePin(thread, index, how: "menu") },
                                                    remind: { remindNote = nil; reminding = index },
                                                    delete: { deleteMessage(thread, index, how: "menu") }
                                                ),
                                                listen: entry.isNote ? nil : {
                                                    // Titled by the page the answer is about (build 94, the owner: it had the
                                                    // chat's name): the one its question was asked on, as in the panel.
                                                    ListenPlayer.shared.listen(answer: entry.content, id: "chat-\(thread.id)-\(index)", title: answerTitle(thread, index))
                                                },
                                                voiced: !entry.isNote && store.isUltra && voiced.has("answer", entry.content)
                                            )
                                            .frame(maxWidth: .infinity, alignment: entry.isUser ? .trailing : .leading)
                                            if tagging == index {
                                                InlineTagEditor(tags: entry.tags ?? [], known: library.allTags) {
                                                    userTags(thread, index, $0)
                                                } close: {
                                                    tagging = nil
                                                }
                                                .id("tags")
                                            }
                                            organizeRow(thread, raw, index)
                                                .frame(maxWidth: .infinity, alignment: entry.isUser ? .trailing : .leading)
                                        }
                                    }
                                }
                                .background(RoundedRectangle(cornerRadius: 12).fill(Color.purple.opacity(flash == index ? 0.18 : 0)).padding(-6))
                                .modifier(MessageSwipe(
                                    enabled: picked == nil && !selecting && (!entry.isUser || entry.isNote),
                                    pinned: entry.pinned != nil,
                                    delete: { deleteMessage(thread, index, how: "swipe") },
                                    pin: { togglePin(thread, index, how: "swipe") }
                                ))
                                .background(entry.pinned == nil ? nil : GeometryReader { g in
                                    Color.clear.preference(key: PinnedTops.self, value: [index: g.frame(in: .named("chat")).minY])
                                })
                                #if os(macOS)
                                .contextMenu {
                                    if !entry.isUser || entry.isNote, picked == nil {
                                        Button { togglePin(thread, index, how: "menu") } label: { Label(entry.pinned != nil ? "Unpin" : "Pin", systemImage: entry.pinned != nil ? "pin.slash" : "pin") }
                                        Button { remindNote = nil; reminding = index } label: { Label(entry.remind != nil ? "Change reminder" : "Remind me", systemImage: "bell") }
                                        Button(role: .destructive) { deleteMessage(thread, index, how: "menu") } label: { Label("Delete", systemImage: "trash") }
                                    }
                                }
                                #endif
                                .id(index)
                            }
                            if picked == nil, asking == nil, failure == nil {
                                organizeCards(thread, raw)
                            }
                            if let asking {
                                MessageView(entry: ChatEntry(role: "user", content: asking))
                                if streaming.isEmpty {
                                    HStack(spacing: 8) { ProgressView(); Text("Reading this chat…").foregroundColor(.secondary) }
                                } else {
                                    MarkdownView(text: streaming)
                                }
                            }
                            if let failure {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(failure.message).foregroundColor(.secondary)
                                    if failure == .dailyLimit || failure == .proOnly { Button("Get Pro", action: openPro).buttonStyle(.borderedProminent) }
                                }
                            }
                            Color.clear.frame(height: 1).id("end")
                        }
                        .padding(16)
                        .frame(maxWidth: 760)
                        .frame(maxWidth: .infinity)
                        // Where the chat is scrolled to: the bar after a move goes once the person scrolls on.
                        .background(GeometryReader { g in
                            Color.clear.preference(key: ChatScrollTop.self, value: g.frame(in: .named("chat")).minY)
                        })
                    }
                    .coordinateSpace(name: "chat")
                    .onPreferenceChange(ChatScrollTop.self) { y in chatScrolled(y) }
                    .onPreferenceChange(PinnedTops.self) { tops in
                        guard Date() > pinLock else { return }
                        let pinned = pinnedItems(thread)
                        // The nearest pinned above what's on screen (the oldest when all are below).
                        let above = pinned.indices.last { (tops[pinned[$0].index] ?? .infinity) < 0 }
                        let next = above ?? 0
                        if next != pinAt { pinAt = next }
                    }
                    .safeAreaInset(edge: .top, spacing: 0) {
                        let pinned = pinnedItems(thread)
                        let sugs = barSuggestions(thread, raw)
                        if picked == nil, !pinned.isEmpty || !sugs.isEmpty {
                            // 2.6 (97): with both, one line each.
                            VStack(spacing: 0) {
                                if !pinned.isEmpty {
                                    PinnedBar(items: pinned, at: Binding(get: { min(pinAt, pinned.count - 1) }, set: { pinAt = $0 }), open: { index in
                                        pinLock = Date().addingTimeInterval(1)
                                        withAnimation { proxy.scrollTo(index, anchor: .center) }
                                        flashMessage(index)
                                        ChatAI.reportUx("ux_pin", ["action": "bar_tap", "how": "bar"])
                                    }, unpin: { index in
                                        togglePin(thread, index, how: "list")
                                    }, unpinAll: {
                                        library.unpinAll(thread)
                                        ChatAI.reportUx("ux_pin", ["action": "unpinned_all", "how": "list"])
                                    }, compact: !sugs.isEmpty)
                                }
                                if !sugs.isEmpty {
                                    SuggestionsBar(items: sugs, at: Binding(get: { min(sugAt, sugs.count - 1) }, set: { sugAt = $0 }), compact: !pinned.isEmpty, open: { item in
                                        pinLock = Date().addingTimeInterval(1)
                                        ChatAI.reportUse("org", "bar_tap")
                                        // The suggestion is under its message: the message's end on screen.
                                        withAnimation { proxy.scrollTo(item.index, anchor: .bottom) }
                                        withAnimation(.easeOut(duration: 0.2)) { sugLit = item }
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { withAnimation(.easeIn(duration: 0.4)) { if sugLit == item { sugLit = nil } } }
                                    }, shown: {
                                        let key = "\(thread.id)|" + sugs.map { "\($0.kind.rawValue)\($0.index):\($0.text)" }.joined(separator: ",")
                                        if sugSeen.insert(key).inserted { ChatAI.reportUse("org", "bar_shown") }
                                    })
                                }
                            }
                        }
                    }
                    .onAppear {
                        #if DEBUG
                        DebugHangLog.mark("open \(threadId)")
                        #endif
                        // Build 95: which answers are already voiced, as the server counts them (any device, any listens).
                        askVoiced(thread)
                        guard let scrollTo else { return }
                        DispatchQueue.main.async { proxy.scrollTo(scrollTo, anchor: .center) }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { flashMessage(scrollTo) }
                    }
                    .onChange(of: streaming) { _ in proxy.scrollTo("end", anchor: .bottom) }
                    .onChange(of: asking) { _ in proxy.scrollTo("end", anchor: .bottom) }
                    .onChange(of: thread.entries.count) { _ in
                        proxy.scrollTo("end", anchor: .bottom)
                        // Another message came: start picking again.
                        picked = nil
                        askVoiced(thread)
                    }
                    // The tag picker opened: all of it in view (above the keyboard).
                    .onChange(of: tagging) { index in
                        guard index != nil else { return }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { withAnimation { proxy.scrollTo("tags", anchor: .bottom) } }
                    }
                    .onChange(of: failure) { _ in proxy.scrollTo("end", anchor: .bottom) }
                    // Typing a question or a note: the end of the chat, where it goes.
                    .onChange(of: focused) { on in if on { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } }
                }
                .overlay(alignment: .bottom) {
                    if let bar = undoBar {
                        movedBar(bar)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                        // A pointer resting on it (Mac, iPad) holds it; it goes a moment after the pointer leaves.
                        .onHover { on in
                            if !on { undoBarClock.until = max(undoBarClock.until, Date().addingTimeInterval(UndoClock.afterHold)) }
                            undoBarHeld = on
                        }
                        // Its seconds (UndoClock), then it goes.
                        .task(id: "\(undoBarClock.tick):\(undoBarHeld)") {
                            guard !undoBarHeld else { return }
                            let left = undoBarClock.until.timeIntervalSinceNow
                            if left > 0 { try? await Task.sleep(nanoseconds: UInt64(left * 1_000_000_000)) }
                            guard !Task.isCancelled else { return }
                            withAnimation { undoBar = nil }
                        }
                    } else if let bar = nameBar, bar.chat == currentId {
                        UndoBar(text: bar.text, actions: bar.undo.map { undo in [(label: LocalizedStringKey("Undo"), run: undo)] } ?? [])
                            .padding(.horizontal, 12)
                            .padding(.bottom, 8)
                            .task(id: bar.id) {
                                try? await Task.sleep(nanoseconds: UInt64(UndoClock.move * 1_000_000_000))
                                guard !Task.isCancelled else { return }
                                withAnimation { if nameBar?.id == bar.id { nameBar = nil } }
                            }
                    }
                }
                .sheet(isPresented: Binding(get: { reminding != nil }, set: { if !$0 { reminding = nil } })) {
                    if let index = reminding, thread.entries.indices.contains(index) {
                        let current = thread.entries[index].remind.map { Date(timeIntervalSince1970: $0.at / 1000) }
                        RemindSheet(current: current, note: remindNote, quote: thread.entries[index].cited?.cite,
                                    words: thread.entries[index].remindWords, pick: { at, preset, words in
                            Task { await setReminder(thread, index, at: at, preset: preset, words: words) }
                        }, cancel: {
                            Task { await setReminder(thread, index, at: nil, preset: nil) }
                        })
                    }
                }
                .task(id: "\(thread.id):\(thread.entries.count):\(asking == nil):\(organizeTick)") { await suggest(thread) }
                // 2.6 (94): what iCloud has for it now (another device may have renamed it or settled a suggestion).
                .task(id: thread.id) { await library.pull() }
                // 2.6 (93): the chat's record came from another device while it's open: shown at once too. 2.6 (95): read
                // afresh by its id (this closure's `thread` is the chat as it was before the change: a name taken on another
                // device stayed offered), and on a rename too.
                .onChange(of: thread.org) { _ in showKept(thread.id) }
                .onChange(of: thread.name) { _ in showKept(thread.id) }
                // The bar after a move goes on the next action: a question, a note, another suggestion, leaving the chat.
                .onDisappear { undoBar = nil }
                // 2.6 (95): the first suggestion's bar waits for the bar of its move.
                .onChange(of: undoBar == nil) { gone in if gone { showFirstWin() } }
                .onChange(of: nameBar == nil) { gone in if gone { showFirstWin() } }
                .safeAreaInset(edge: .bottom) {
                    if let picked {
                        pickBar(thread, picked, labels)
                    } else if !thread.isHistory {
                        composer(thread)
                    }
                }
                .aiConsent($consentAsk)
                .navigationTitle(thread.name)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    // Share the chat: every message picked; untick what shouldn't go, then share or copy.
                    ToolbarItem {
                        if !thread.entries.isEmpty, asking == nil {
                            Button {
                                tagging = nil
                                picked = picked == nil ? Set(thread.entries.indices) : nil
                            } label: {
                                Label(chatCopied ? "Copied" : "Share chat", systemImage: chatCopied ? "checkmark" : "square.and.arrow.up")
                            }
                        }
                    }
                    ToolbarItem {
                        Menu {
                            if thread.lastPage != nil {
                                Button { library.continueInSafari(thread) } label: { Label("Continue in Safari", systemImage: "safari") }
                            }
                            Button {
                                newName = thread.title ?? ""
                                renaming = true
                            } label: { Label("Rename", systemImage: "pencil") }
                            if organize.enabled(pro: store.isPro), !thread.isHistory, !thread.entries.isEmpty {
                                Button { nameByTopic(thread) } label: { Label("Name by topic", systemImage: "sparkles") }
                                    .disabled(naming)
                            }
                            Button { taggingChat = true } label: { Label("Tags", systemImage: "tag") }
                            Button { library.setPinned(thread, !thread.isPinned) } label: {
                                Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash" : "pin")
                            }
                            Button(role: .destructive) { deleting = true } label: { Label("Delete", systemImage: "trash") }
                        } label: {
                            Label("Chat actions", systemImage: "ellipsis.circle")
                        }
                    }
                }
                .alert("Rename chat", isPresented: $renaming) {
                    TextField("Name", text: $newName)
                    Button("Save") { library.rename(thread, to: newName) }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Leave it empty to name the chat after its first question.")
                }
                .sheet(isPresented: $taggingChat) {
                    TagsSheet(tags: thread.ownTags, known: library.allTags) { library.setTags(thread, $0) }
                }
                .confirmationDialog("Delete this chat?", isPresented: $deleting, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) {
                        library.trash(thread)
                        dismiss()
                    }
                } message: {
                    Text("You can restore it from Recently Deleted for 30 days.")
                }
            } else {
                Text("This chat was deleted.")
                    .foregroundColor(.secondary)
            }
        }
        // "Answer deleted · Undo" (2.5): also when that was the chat's last answer and the chat is gone with it.
        .overlay(alignment: .bottom) {
            if let gone = deleted, undoBar == nil {
                DeletedBar(text: gone.text) {
                    withAnimation { deleted = nil }
                    let thread = library.threads.first { $0.id == gone.thread.id } ?? gone.thread
                    if !gone.whole { library.restoreEntries(thread, at: gone.at, gone.entries) }
                    rescheduleReminders(thread, gone.entries)
                    ChatAI.reportUx("ux_delete", ["action": "undone"])
                }
                .padding(.horizontal, 12)
                .padding(.bottom, thread == nil || gone.whole ? 24 : 70)
            }
        }
        // Leaving the chat: the bar goes (its Undo with it).
        .onDisappear {
            finishDeleting()
            deleted = nil
        }
    }

    /// The field under the chat: a question about it (sent to the AI), or a note (kept in the chat, no
    /// AI). The button left of the field switches between them, as the panel's send button does.
    private func composer(_ thread: ChatThread) -> some View {
        VStack(spacing: 0) {
            Divider()
            // The buttons stay level with the middle of the field's last line (one line: its middle).
            HStack(alignment: .fieldLine, spacing: 8) {
                Button {
                    noteMode.toggle()
                } label: {
                    Image(systemName: noteMode ? "pencil.circle.fill" : "pencil.circle")
                        .font(.system(size: 26))
                        .foregroundColor(noteMode ? .orange : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(noteMode ? "Ask a question" : "Write a note"))
                TextField(noteMode ? "Write a note — it stays in this chat" : "Ask about this chat…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .onSubmit { submit(thread) }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 18).fill(noteMode ? Color.orange.opacity(0.12) : Color.cardFill))
                    .alignmentGuide(.fieldLine) { $0[.bottom] - VerticalAlignment.oneLineFieldHeight / 2 }
                Button { submit(thread) } label: {
                    Image(systemName: noteMode ? "checkmark.circle.fill" : "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundColor(noteMode ? .orange : brandBlue)
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || asking != nil)
                .accessibilityLabel(Text(noteMode ? "Save note" : "Send"))
            }
            .padding(10)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(.bar)
    }

    private func submit(_ thread: ChatThread) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, asking == nil else { return }
        failure = nil
        undoBar = nil
        nameBar = nil
        firstWin = nil
        if noteMode {
            // A note: kept with the chat, never sent to the AI, uses no answers.
            library.append(thread, [Organize.stamped(["role": "user", "content": text, "note": true])])
            draft = ""
            noteMode = false
            return
        }
        guard AIConsent.given else {
            // Nothing is sent before the consent; the question stays in the field.
            consentAsk = { submit(thread) }
            return
        }
        draft = ""
        asking = text
        streaming = ""
        // A chat without page texts (before 2.4, or Private Browsing) says so once, under its first answer here.
        let noPages = thread.savedPages.isEmpty && !thread.entries.contains { $0.noPages == true }
        let question = Organize.stamped(["role": "user", "content": text])
        let save = { (answer: String) in
            var entry: [String: Any] = Organize.stamped(["role": "assistant", "content": answer])
            if noPages { entry["noPages"] = true }
            library.append(thread, [question, entry])
        }
        Task {
            do {
                try await ChatAI.ask(text, in: thread) { piece in streaming += piece }
                save(streaming)
                askForReviewAfterAnswer(requestReview)
            } catch {
                failure = error as? ChatAI.Failure ?? .network
                if streaming.isEmpty {
                    // Nothing came back: the question goes back to the field to try again.
                    if draft.isEmpty { draft = text }
                } else {
                    save(streaming)
                }
            }
            asking = nil
            streaming = ""
        }
    }

    // MARK: Organizing (2.5)

    /// After an answer or a note (and when the chat opens): what to suggest, if suggestions are on (Pro).
    private func suggest(_ thread: ChatThread) async {
        guard asking == nil, !thread.isHistory else { return }
        await organize.refreshStatus()
        guard organize.enabled(pro: store.isPro) else { suggestions = nil; return }
        showKept(thread.id)
        try? await Task.sleep(nanoseconds: 900_000_000)
        guard !Task.isCancelled, let found = await organize.suggestions(for: thread, in: library.threads) else { return }
        // Kept with the chat even if it's no longer shown: the list counts it, other devices show it at once.
        if let org = found.org { library.keepOrg(found.chat, org) }
        guard found.chat == currentId, found.length == self.thread?.entries.count else { return }
        withAnimation(.easeOut(duration: 0.4)) { suggestions = found }
        // Each suggestion counted once as shown.
        if let move = found.move, !seen.contains("m\(found.chat)\(move.start)") {
            seen.insert("m\(found.chat)\(move.start)")
            ChatAI.reportOrganize("organize", ["action": "shown", "what": move.to == nil ? "new" : "move", "why": move.why.rawValue])
        }
        for (index, tag) in found.tags where !seen.contains("t\(tag.key)\(tag.tag)") {
            seen.insert("t\(tag.key)\(tag.tag)")
            _ = index
            ChatAI.reportOrganize("organize", ["action": "shown", "what": "tag"])
        }
    }

    /// What the chat's own record suggests (worked out here or on another device, 2.6 (93)), at once: the run that
    /// follows has the last word.
    private func showKept(_ id: String) {
        guard asking == nil, organize.enabled(pro: store.isPro), let thread = library.threads.first(where: { $0.id == id }) else { return }
        guard let kept = organize.kept(thread, in: library.threads) else {
            // Nothing open in the record (2.6 (94)): what was settled meanwhile goes from what's shown.
            if let s = suggestions, s.chat == thread.id {
                let left = organize.settled(s, thread, in: library.threads)
                if left != s { withAnimation(.easeOut(duration: 0.25)) { suggestions = left } }
            }
            return
        }
        guard kept.chat == currentId, kept.length == self.thread?.entries.count, kept != suggestions else { return }
        withAnimation(.easeOut(duration: 0.25)) { suggestions = kept }
    }

    /// 2.6: the AI's name on the chat, with "Named “…” · Undo": a suggested name taken (never over a name the user
    /// typed), or "Name by topic" (over any). Never by itself (2.6 (91)).
    private func putName(_ thread: ChatThread, _ name: String, why: String) {
        guard let before = library.nameByAI(thread, name, asked: why == "asked") else { return }
        ChatAI.reportOrganize("organize", ["action": "accepted", "what": "name", "why": why])
        let id = thread.id
        withAnimation {
            nameBar = NameBar(chat: id, text: String(localized: "Named “\(name)”"), undo: {
                withAnimation { nameBar = nil }
                library.unname(id, name, before: before)
                ChatAI.reportOrganize("organize", ["action": "undone", "what": "name", "why": why])
            })
        }
    }

    /// "Name by topic" in the chat's menu.
    private func nameByTopic(_ thread: ChatThread) {
        naming = true
        Task {
            let name = await organize.nameNow(thread)
            naming = false
            if let name, let current = library.threads.first(where: { $0.id == thread.id }) {
                putName(current, name, why: "asked")
            } else {
                withAnimation { nameBar = NameBar(chat: thread.id, text: String(localized: "I couldn't name this chat just now. Try again later."), undo: nil) }
            }
        }
    }

    /// The suggestions as they are now for this chat (gone once it changed, or while sharing or asking).
    private func current(_ thread: ChatThread) -> OrganizeModel.Suggestions? {
        guard var s = suggestions, s.chat == thread.id, s.length == thread.entries.count, picked == nil, asking == nil else { return nil }
        // 2.6 (95): a name that is the chat's by now (taken on another device), turned down or typed meanwhile isn't offered.
        if let name = s.name, name.lowercased() == thread.name.lowercased() || thread.namedByUser || (thread.org?.nm?.no ?? []).contains(where: { $0.lowercased() == name.lowercased() }) {
            s.name = nil
        }
        return s
    }

    /// 2.6 (97): the open suggestions for the bar at the top: the ones the rows under the messages show.
    private func barSuggestions(_ thread: ChatThread, _ raw: [[String: Any]]) -> [BarSuggestion] {
        guard let s = current(thread) else { return [] }
        var items: [BarSuggestion] = []
        for (index, item) in s.tags where raw.indices.contains(index) && Organize.entryKey(raw[index]) == item.key {
            items.append(BarSuggestion(kind: .tag, index: index, text: "#\(item.tag) · \(ReminderTimes.text(thread.entries[index].content, max: 80))"))
        }
        if let move = s.move, thread.entries.indices.contains(move.end) { items.append(BarSuggestion(kind: .move, index: move.end, text: SuggestionRow.moveLine(move))) }
        if let name = s.name, !thread.entries.isEmpty { items.append(BarSuggestion(kind: .name, index: thread.entries.count - 1, text: String(localized: "Name it “\(name)”"))) }
        return BarSuggestion.ordered(items)
    }

    @ViewBuilder
    private func organizeRow(_ thread: ChatThread, _ raw: [[String: Any]], _ index: Int) -> some View {
        if let s = current(thread) {
            let tag = s.tags[index].flatMap { raw.indices.contains(index) && Organize.entryKey(raw[index]) == $0.key ? $0.tag : nil }
            let move = s.move?.end == index ? s.move : nil
            // 2.6 (91): a better name is a suggestion under the last message, like a tag or a move.
            let name = index == raw.count - 1 ? s.name : nil
            if tag != nil || move != nil || name != nil {
                SuggestionRow(
                    tag: tag, move: move, name: name,
                    lit: sugLit?.index == index ? sugLit?.kind : nil,
                    onTag: { if let tag { takeTag(thread, index, tag) } },
                    onTagNo: { if let tag { refuseTag(thread, index, tag) } },
                    onMove: { if let move { takeMove(thread, move) } },
                    onMoveNo: { if let move { refuseMove(thread, move) } },
                    onName: {
                        guard let name else { return }
                        suggestions?.name = nil
                        library.settleName(thread.id, taken: true)
                        putName(thread, name, why: "drift")
                    },
                    onNameNo: {
                        suggestions?.name = nil
                        library.settleName(thread.id, taken: false)
                        ChatAI.reportOrganize("organize", ["action": "dismissed", "what": "name", "why": "drift"])
                    }
                )
            }
        }
    }

    /// The first suggestion taken: that from now on they come by themselves (once). 2.6 (95): a bar that goes by itself,
    /// not a line left at the end of the chat; after the bar of the move (its Undo comes first), if there is one.
    private func won() {
        if organize.takeFirstWin() { firstWin = currentId; showFirstWin() }
    }

    private func showFirstWin() {
        guard let chat = firstWin, undoBar == nil, nameBar == nil else { return }
        firstWin = nil
        guard chat == currentId, organize.enabled(pro: store.isPro) else { return }
        withAnimation { nameBar = NameBar(chat: chat, text: String(localized: "Done. From now on I'll suggest on my own."), undo: nil) }
    }

    private func takeTag(_ thread: ChatThread, _ index: Int, _ tag: String) {
        undoBar = nil
        library.editEntries(thread) { entries in
            guard entries.indices.contains(index) else { return }
            entries[index]["tags"] = Tags.clean((entries[index]["tags"] as? [String] ?? []) + [tag])
            var accepted = entries[index]["accepted"] as? [String: Any] ?? [:]
            accepted["tags"] = Tags.clean((accepted["tags"] as? [String] ?? []) + [tag])
            entries[index]["accepted"] = accepted
        }
        suggestions?.tags[index] = nil
        ChatAI.reportOrganize("organize", ["action": "accepted", "what": "tag"])
        won()
    }

    private func refuseTag(_ thread: ChatThread, _ index: Int, _ tag: String) {
        undoBar = nil
        library.editEntries(thread) { entries in
            guard entries.indices.contains(index) else { return }
            var dismissed = entries[index]["dismissed"] as? [String: Any] ?? [:]
            dismissed["tags"] = Tags.clean((dismissed["tags"] as? [String] ?? []) + [tag])
            entries[index]["dismissed"] = dismissed
        }
        suggestions?.tags[index] = nil
        ChatAI.reportOrganize("organize", ["action": "dismissed", "what": "tag"])
    }

    private func takeMove(_ thread: ChatThread, _ move: OrganizeModel.Move) {
        if let from = move.from { return takeMergeHere(thread, move, from) }
        suggestions = nil
        guard let undo = library.move(thread, move.start, move.end, to: move.to) else { return }
        ChatAI.reportOrganize("organize", ["action": "accepted", "what": move.to == nil ? "new" : "move", "why": move.why.rawValue])
        // The chat stays shown ("Open" goes to the other one), unless nothing is left in it.
        if !library.threads.contains(where: { $0.id == thread.id }) { shownId = undo.target }
        undoBarClock.start()
        undoBarHeld = false
        withAnimation { undoBar = (move.why == .merge ? String(localized: "Merged into “\(move.toName)”") : String(localized: "Moved to “\(move.toName)”"), undo) }
        won()
    }

    /// 2.6 (95): the older chat joins this one (the merge shown in the newer chat, where the person is): its messages come
    /// in by time, this chat stays shown; Undo puts it back and the merge isn't suggested again.
    private func takeMergeHere(_ thread: ChatThread, _ move: OrganizeModel.Move, _ from: String) {
        suggestions = nil
        guard let older = library.threads.first(where: { $0.id == from }), !older.entries.isEmpty,
              let undo = library.move(older, 0, older.entries.count - 1, to: thread.id) else { return }
        ChatAI.reportOrganize("organize", ["action": "accepted", "what": "move", "why": move.why.rawValue])
        mergedHere = from
        undoBarClock.start()
        undoBarHeld = false
        withAnimation { undoBar = (String(localized: "Brought “\(move.toName)” here"), undo) }
        won()
    }

    /// The chat scrolled (its top at `y`): the bar after a move goes once the person scrolls on, though not in its
    /// first seconds (that's also when the chat scrolls to its end by itself after the move).
    private func chatScrolled(_ y: CGFloat) {
        guard undoBar != nil, !undoBarHeld else { return }
        guard Date().timeIntervalSince(undoBarClock.shownAt) >= UndoClock.grace, let from = undoBarClock.y else {
            undoBarClock.y = y
            return
        }
        if abs(y - from) > 40 { withAnimation { undoBar = nil } }
    }

    /// The bar after a move: Undo, and Open unless nothing was left here (the other chat is shown already).
    private func movedBar(_ bar: (text: String, undo: Organize.MoveUndo)) -> some View {
        var actions: [(label: LocalizedStringKey, run: () -> Void)] = [("Undo", { undoMove(bar.undo) })]
        if currentId != bar.undo.target {
            actions.append(("Open", { withAnimation { undoBar = nil; shownId = bar.undo.target } }))
        }
        return UndoBar(text: bar.text, actions: actions)
    }

    private func undoMove(_ undo: Organize.MoveUndo) {
        withAnimation { undoBar = nil }
        library.undo(undo)
        // A merge into this chat taken back (2.6 (95)): this chat stays shown, and that merge isn't suggested again.
        if mergedHere == undo.source, undo.target == currentId {
            mergedHere = nil
            library.refuseMerge(undo.source, into: undo.target)
            ChatAI.reportOrganize("organize", ["action": "undone", "what": "move"])
            return
        }
        shownId = undo.source == threadId ? nil : undo.source
        // Taken back: the same move isn't suggested again.
        let keys = Set(undo.keys)
        if let source = library.threads.first(where: { $0.id == undo.source }) {
            library.editEntries(source) { entries in
                for i in entries.indices where keys.contains(Organize.entryKey(entries[i])) {
                    var dismissed = entries[i]["dismissed"] as? [String: Any] ?? [:]
                    dismissed["move"] = true
                    entries[i]["dismissed"] = dismissed
                }
            }
        }
        ChatAI.reportOrganize("organize", ["action": "undone", "what": undo.beforeTarget == nil ? "new" : "move"])
    }

    private func refuseMove(_ thread: ChatThread, _ move: OrganizeModel.Move) {
        undoBar = nil
        // A merge turned down (2.6 (94)) is kept with the chat, not on its messages: they may still go elsewhere. 2.6
        // (95): turned down in the newer chat, it's kept with the older one, so neither shows it again.
        if move.why == .merge, let to = move.to {
            if let from = move.from { library.refuseMerge(from, into: thread.id) } else { library.refuseMerge(thread.id, into: to) }
            suggestions?.move = nil
            ChatAI.reportOrganize("organize", ["action": "dismissed", "what": "move", "why": move.why.rawValue])
            organizeTick += 1
            return
        }
        library.editEntries(thread) { entries in
            for i in move.start...move.end where entries.indices.contains(i) {
                var dismissed = entries[i]["dismissed"] as? [String: Any] ?? [:]
                dismissed["move"] = true
                entries[i]["dismissed"] = dismissed
            }
        }
        suggestions?.move = nil
        ChatAI.reportOrganize("organize", ["action": "dismissed", "what": move.to == nil ? "new" : "move", "why": move.why.rawValue])
        // 2.6 (95): the run looks again (the name comes once nothing is left to move).
        organizeTick += 1
    }

    /// Tags the user set on a message: after their third tag in all, what organizing does (without Pro, once).
    // MARK: Chat UX (2.5)

    private func pinnedItems(_ thread: ChatThread) -> [(index: Int, entry: ChatEntry)] {
        thread.entries.enumerated().filter { $0.element.pinned != nil && (!$0.element.isUser || $0.element.isNote) }.map { ($0.offset, $0.element) }
    }

    private func flashMessage(_ index: Int) {
        withAnimation(.easeOut(duration: 0.2)) { flash = index }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { withAnimation(.easeIn(duration: 0.4)) { if flash == index { flash = nil } } }
    }

    private func setMarks(_ thread: ChatThread, _ index: Int, _ marks: [ChatMark]) {
        let before = thread.entries.indices.contains(index) ? (thread.entries[index].marks ?? []).count : 0
        library.setMarks(thread, entry: index, marks)
        ChatAI.reportUx("ux_mark", ["action": marks.count >= before ? "added" : "removed"])
    }

    private func togglePin(_ thread: ChatThread, _ index: Int, how: String) {
        guard thread.entries.indices.contains(index) else { return }
        let entry = thread.entries[index]
        let on = entry.pinned == nil
        undoBar = nil
        library.setEntryPinned(thread, entry: index, on)
        pinAt = .max
        ChatAI.reportUx("ux_pin", ["action": on ? "pinned" : "unpinned", "what": entry.isNote ? "note" : "answer", "how": how])
    }

    /// A note alone; an answer with its question. "Undo" on the bar brings them back.
    private func deleteMessage(_ thread: ChatThread, _ index: Int, how: String) {
        guard thread.entries.indices.contains(index) else { return }
        let entry = thread.entries[index]
        let withQuestion = !entry.isUser && index > 0 && thread.entries[index - 1].isUser && !thread.entries[index - 1].isNote
        let range = (withQuestion ? index - 1 : index)...index
        // The chat's last messages: deleted now, the chat would go with them, Undo and all. So they're hidden here
        // and deleted once the bar goes (then back to the list, as after "Delete chat") or the chat is left.
        let whole = range.lowerBound == 0 && range.upperBound == thread.entries.count - 1
        let gone: (at: Int, entries: [[String: Any]])
        if whole, let raw = thread.organized?.entries, raw.indices.contains(range.upperBound) {
            gone = (range.lowerBound, Array(raw[range]))
        } else if let done = library.deleteEntries(thread, range) {
            gone = done
        } else { return }
        for raw in gone.entries where raw["remind"] != nil {
            MessageReminders.cancel(chat: thread.id, message: Organize.entryKey(raw))
        }
        // The bar after a move gives way: its own bar shows only without it.
        undoBar = nil
        withAnimation { deleted = (entry.isNote ? "Note deleted" : "Answer deleted", thread, gone.at, gone.entries, whole) }
        ChatAI.reportUx("ux_delete", ["action": "deleted", "what": entry.isNote ? "note" : "answer", "how": how])
        let shown = gone.at
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            guard let gone = deleted, gone.at == shown else { return }
            finishDeleting()
            withAnimation { deleted = nil }
            if gone.whole { dismiss() }
        }
    }

    /// A chat's last messages, kept while their Undo was up: deleted now (by key, in case the chat changed since).
    private func finishDeleting() {
        guard let gone = deleted, gone.whole else { return }
        let keys = Set(gone.entries.map { Organize.entryKey($0) })
        let thread = library.threads.first { $0.id == gone.thread.id } ?? gone.thread
        library.editEntries(thread) { entries in entries.removeAll { keys.contains(Organize.entryKey($0)) } }
    }

    /// Undo brought messages back: their reminders ring again (those still ahead).
    private func rescheduleReminders(_ thread: ChatThread, _ entries: [[String: Any]]) {
        for raw in entries {
            guard let remind = raw["remind"] as? [String: Any], let at = (remind["at"] as? NSNumber)?.doubleValue, at > Date().timeIntervalSince1970 * 1000 else { continue }
            let content = raw["content"] as? String ?? ""
            let page = raw["note"] as? Bool == true ? raw["page"] as? [String: Any] : nil
            let title = page.flatMap { ($0["title"] as? String).flatMap(\.nilIfEmpty) ?? $0["url"] as? String } ?? thread.name
            let open = remind["page"] as? Bool == true ? (page?["url"] as? String).flatMap(URL.init(string:)) : nil
            Task { _ = await MessageReminders.schedule(chat: thread.id, message: Organize.entryKey(raw), at: Date(timeIntervalSince1970: at / 1000), title: title, body: ReminderTimes.asked(content), open: open, ask: false) }
        }
    }

    /// Sets (or with nil cancels) a message's reminder on this device; the chat keeps the bell (ChatLibrary.remind).
    private func setReminder(_ thread: ChatThread, _ index: Int, at: Date?, preset: String?, words: String? = nil) async {
        if await library.remind(thread, entry: index, at: at, preset: preset, words: words) {
            reminding = nil
        } else {
            remindNote = String(localized: "Notifications are off for ContextFlow. Turn them on in Settings → Notifications → ContextFlow.")
        }
    }

    private func userTags(_ thread: ChatThread, _ index: Int, _ tags: [String]) {
        let known = Set(library.allTags.map { $0.lowercased() })
        let added = Tags.clean(tags).filter { !known.contains($0.lowercased()) }.count
        library.setTags(thread, entry: index, tags)
        if known.count < 3, known.count + added >= 3, !store.isPro, organize.takeTagsCard() { withAnimation { tagsCard = true } }
    }

    /// Cards under the chat: turn suggestions on (Pro, off, the chat looks like it needs them), "Everything in one
    /// chat?" (without Pro), after the third tag (without Pro), and the line after the first suggestion taken.
    @ViewBuilder
    private func organizeCards(_ thread: ChatThread, _ raw: [[String: Any]]) -> some View {
        let chat = thread.organized
        let mixed = !thread.isHistory && chat.map { Organize.looksMixed($0, organize.config) } == true
        let blocks = Organize.pageBlocks(raw)
        let elsewhere = blocks.count >= 2 && blocks.contains { b in
            guard let url = b.url else { return false }
            return library.threads.contains { other in other.id != thread.id && other.entries.contains { $0.page?.url == url } }
        }
        let settingOn = SharedDefaults.shared.readSettings()?.settings["organize"] as? Bool ?? false
        if store.isPro, organize.serverOn, !settingOn, !organize.consentAnswered, mixed || elsewhere {
            OrganizeCard(kind: .consent, primary: {
                organize.answerConsent(true, from: "card")
                organizeTick += 1
            }, close: { organize.answerConsent(false, from: "card") })
        }
        if !store.isPro, !thread.isHistory, messShown || (mixed && organize.messCardDue(chat: thread.id)) {
            OrganizeCard(kind: .mess, primary: {
                ChatAI.reportOrganize("organize_promo", ["action": "tap", "where": "inchat_mess"])
                openPro()
            }, close: {
                organize.closeMessCard()
                withAnimation { messShown = false }
            })
            .onAppear {
                if !messShown { messShown = true; organize.messCardShown(chat: thread.id) }
            }
        }
        if tagsCard, !store.isPro {
            OrganizeCard(kind: .tags, primary: {
                ChatAI.reportOrganize("organize_promo", ["action": "tap", "where": "third_tag"])
                openPro()
            }, close: { withAnimation { tagsCard = false } })
        }
    }

    /// While sharing the chat, a message is a row to tick: a tap anywhere on it picks or unpicks it.
    @ViewBuilder
    private func pickRow<Content: View>(_ index: Int, @ViewBuilder _ content: () -> Content) -> some View {
        if let picked {
            let on = picked.contains(index)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundColor(on ? brandBlue : .secondary)
                content()
                    .opacity(on ? 1 : 0.5)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                var next = picked
                if next.remove(index) == nil { next.insert(index) }
                self.picked = next
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        } else {
            content()
        }
    }

    /// In place of the field while sharing the chat: cancel, how many are picked (a tap: all or none),
    /// Copy and Share (Copy as an icon when the words don't fit).
    private func pickBar(_ thread: ChatThread, _ picked: Set<Int>, _ labels: ShareText.Labels) -> some View {
        VStack(spacing: 0) {
            Divider()
            ViewThatFits(in: .horizontal) {
                pickControls(thread, picked, labels, compact: false)
                pickControls(thread, picked, labels, compact: true)
            }
            .padding(10)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(.bar)
    }

    private func pickControls(_ thread: ChatThread, _ picked: Set<Int>, _ labels: ShareText.Labels, compact: Bool) -> some View {
        let all = picked.count == thread.entries.count
        let text = { ShareText.picked(thread.entries, picked, name: thread.name, labels) }
        return HStack(spacing: 10) {
            Button { self.picked = nil } label: {
                Image(systemName: "xmark").font(.body.weight(.semibold)).padding(6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Cancel"))
            Button { self.picked = all ? [] : Set(thread.entries.indices) } label: {
                Group {
                    if picked.isEmpty { Text("Tap messages to share") } else { Text("\(picked.count) of \(thread.entries.count)") }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .fixedSize(horizontal: !compact, vertical: false)
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text(all ? "Deselect all" : "Select all"))
            Spacer(minLength: 0)
            Button {
                Clipboard.copy(text())
                self.picked = nil
                flashChatCopied()
            } label: {
                if compact {
                    Image(systemName: "doc.on.doc").accessibilityLabel(Text("Copy"))
                } else {
                    Label("Copy", systemImage: "doc.on.doc").lineLimit(1).fixedSize()
                }
            }
            .buttonStyle(.bordered)
            .disabled(picked.isEmpty)
            #if os(iOS)
            Button {
                ShareSheet.present(text()) { self.picked = nil }
            } label: { Label("Share", systemImage: "square.and.arrow.up").lineLimit(1).fixedSize() }
            .buttonStyle(.borderedProminent)
            .disabled(picked.isEmpty)
            #else
            ShareLink(item: text()) { Label("Share", systemImage: "square.and.arrow.up").lineLimit(1).fixedSize() }
                .buttonStyle(.borderedProminent)
                .disabled(picked.isEmpty)
            #endif
        }
    }

    private func flashChatCopied() {
        chatCopied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { chatCopied = false }
    }

    /// An answer's title for Listen: the page its question was asked on (the last page up to it), else the chat's name.
    private func answerTitle(_ thread: ChatThread, _ index: Int) -> String {
        guard let page = thread.entries[...min(index, thread.entries.count - 1)].last(where: { $0.isUser && $0.page != nil })?.page else { return thread.name }
        return page.title.isEmpty ? host(of: page.url) : page.title
    }

    /// The page a question or note moved the chat to (the first one, and every change after it).
    private func newPage(_ entries: [ChatEntry], _ index: Int) -> ChatEntry.Page? {
        let entry = entries[index]
        guard entry.isUser, let page = entry.page else { return nil }
        let previous = entries[..<index].last(where: { $0.isUser && $0.page != nil })?.page
        return previous?.url == page.url ? nil : page
    }
}

private struct PageDivider: View {
    let page: ChatEntry.Page
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            // The site goes first when there's no room: the title, then the day it came there (2.4 on).
            ViewThatFits(in: .horizontal) {
                line(site: true)
                line(site: false)
            }
            .font(.footnote.weight(.semibold))
            .foregroundColor(brandBlue)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Opens the page in Safari"))
    }

    private func line(site: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "safari")
            Text(page.title.isEmpty ? host(of: page.url) : page.title)
                .lineLimit(1)
                .underline()
            if site {
                Text("· \(host(of: page.url))")
                    .lineLimit(1)
                    .foregroundColor(.secondary)
            }
            // The day the chat came to this page, and how long ago.
            if let when = page.when() {
                Text(verbatim: "· \(when)")
                    .foregroundColor(.secondary)
                    .fixedSize()
            }
        }
    }
}

/// A note's text (2.6 (97), the owner: «то, что выделено, было оформлено как цитата, и … можно было написать свою
/// заметку к ней»): a note made on a selection shows what was selected as a quote and the person's own words under it;
/// any other note (and one on a selection made before) its text, as before. The panel draws the same
/// (src/content/ux/NoteText.tsx).
struct NoteBody: View {
    let entry: ChatEntry

    var body: some View {
        if let cited = entry.cited {
            VStack(alignment: .leading, spacing: 6) {
                QuoteBlock(text: cited.cite)
                if !cited.note.isEmpty {
                    Text(cited.note).textSelection(.enabled)
                }
            }
        } else {
            Text(entry.content).textSelection(.enabled)
        }
    }
}

/// A quote: a bar at the leading edge and the text in the secondary color, as the panel's (.cf-note-cite).
struct QuoteBlock: View {
    let text: String
    var lines: Int? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5).fill(Color.orange.opacity(0.75)).frame(width: 3)
            Text(text)
                .font(.callout)
                .foregroundColor(.secondary)
                .lineLimit(lines)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct MessageView: View {
    let entry: ChatEntry
    /// Answers in a chat: selectable, with "Highlight" (2.5); nil: as plain Markdown (an answer coming in).
    var onMarks: (([ChatMark]) -> Void)? = nil
    var onSelecting: (Bool) -> Void = { _ in }

    var body: some View {
        if entry.isNote {
            VStack(alignment: .trailing, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "pencil")
                        .foregroundColor(.orange)
                    VStack(alignment: .leading, spacing: 6) {
                        NoteBody(entry: entry)
                        // The page the note was made on (2.5): what a reminder on it brings you back to.
                        if let page = entry.page, let url = URL(string: page.url) {
                            Link(destination: url) {
                                Label(page.title.isEmpty ? host(of: page.url) : page.title, systemImage: "link")
                                    .font(.footnote)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.orange.opacity(0.12)))
            }
        } else if entry.isUser {
            VStack(alignment: .trailing, spacing: 6) {
                HStack(spacing: 6) {
                    if entry.mode == "google" { Image(systemName: "magnifyingglass") }
                    Text(entry.label ?? entry.content)
                        .textSelection(.enabled)
                }
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 18).fill(brandBlue))
                ForEach(entry.sources ?? [], id: \.self) { read in
                    ReadChip(read: read)
                }
                // Find similar: where it looked, as in the panel (build 95).
                if entry.similarAsk != nil, let region = entry.similarRegion {
                    SimilarWhereLine(region: region, country: entry.similarCountry)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 40)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if entry.grounding != nil {
                    Label("Answer from Google Search", systemImage: "magnifyingglass")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.secondary)
                }
                if let similar = entry.similar, !similar.items.isEmpty {
                    // Find similar's list as the panel shows it (build 95), not its Markdown copy.
                    SimilarCardsView(answer: similar)
                } else if let onMarks {
                    AnswerText(text: entry.content, marks: entry.marks ?? [], onChange: onMarks, onSelecting: onSelecting)
                } else {
                    MarkdownView(text: entry.content)
                }
                if entry.noPages == true {
                    Label("This chat doesn't keep its pages' text, so answers here use what's said in it.", systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                if let sources = entry.grounding?.sources, !sources.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sources")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.secondary)
                        ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                            if let url = URL(string: source.url) {
                                Link(destination: url) {
                                    Text("\(index + 1). \(source.title)")
                                        .font(.footnote)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Under a question: the video transcript or PDF it went with, or why one couldn't be read.
private struct ReadChip: View {
    let read: ChatEntry.Read

    var body: some View {
        Label {
            Text(text)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        } icon: {
            Image(systemName: read.ok ? (read.kind == "video" ? "play.rectangle" : "doc.text") : "exclamationmark.circle")
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(read.ok ? Color.secondary.opacity(0.12) : Color.orange.opacity(0.15)))
        .foregroundColor(read.ok ? .secondary : .orange)
    }

    private var text: String {
        switch (read.kind, read.ok) {
        case ("video", true): return String(localized: "Video transcript · \(read.detail ?? "")")
        case (_, true): return String(localized: "\(read.name) · \(read.detail ?? "") pp.")
        case ("video", false): return read.reason == "none" ? String(localized: "No captions: answered from the title and description") : String(localized: "Couldn't read the transcript")
        default: return read.reason == "none" ? String(localized: "“\(read.name)” has no text (scanned)") : String(localized: "Couldn't read “\(read.name)”")
        }
    }
}

// MARK: - Markdown

/// The answers' Markdown: headings, lists, tables, code blocks and inline styles.
struct MarkdownView: View {
    let text: String

    private enum Block: Hashable {
        case heading(String, Int)
        case paragraph(String)
        case bullet(String, String)
        case table([[String]])
        case code(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(for block: Block) -> some View {
        switch block {
        case .heading(let text, let level):
            inline(text).font(level <= 2 ? .title3.weight(.bold) : .headline)
        case .paragraph(let text):
            inline(text)
        case .bullet(let mark, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(mark).foregroundColor(.secondary)
                inline(text)
            }
            .padding(.leading, 4)
        case .table(let rows):
            TableBlock(rows: rows, inline: inline)
        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(.footnote, design: .monospaced))
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.1)))
        }
    }

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: text, options: options) { return Text(attributed) }
        return Text(text)
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var table: [[String]] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
            if !table.isEmpty { out.append(.table(table)) }
            table = []
        }
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let lines = code {
                    out.append(.code(lines.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }
            if code != nil {
                code?.append(raw)
                continue
            }
            if line.isEmpty {
                flush()
            } else if line.hasPrefix("|") {
                if !paragraph.isEmpty { flush() }
                let cells = line.trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                // The |---|---| line under the header.
                if !cells.allSatisfy({ $0.range(of: #"^:?-{2,}:?$"#, options: .regularExpression) != nil }) { table.append(cells) }
            } else if let match = line.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
                flush()
                out.append(.heading(String(line[match.upperBound...]), line.prefix(while: { $0 == "#" }).count))
            } else if let match = line.range(of: #"^([-*+]|\d{1,3}[.)])\s+"#, options: .regularExpression) {
                flush()
                let mark = line[match].trimmingCharacters(in: .whitespaces)
                out.append(.bullet(mark.first.map { "-*+".contains($0) } == true ? "•" : mark, String(line[match.upperBound...])))
            } else {
                if !table.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return out
    }
}

private struct TableBlock: View {
    let rows: [[String]]
    let inline: (String) -> Text

    var body: some View {
        let columns = rows.map(\.count).max() ?? 0
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(0..<columns, id: \.self) { column in
                            inline(column < row.count ? row[column] : "")
                                .font(index == 0 ? .footnote.weight(.semibold) : .footnote)
                        }
                    }
                    if index == 0 { Divider() }
                }
            }
            .padding(10)
        }
        .background(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
    }
}


// MARK: - Tags

/// Under an answer and under a note, as in the Safari panel: its tags (a tap opens the picker), then
/// Copy, Share and Tag.
private struct MessageTools: View {
    let tags: [String]
    let copied: Bool
    var tagging = false
    let shareText: String
    let copy: () -> Void
    /// Opens or closes the tag picker; nil: no tags here ("Ask your chats").
    var tag: (() -> Void)?
    /// An answer with highlights: shared as rich text, the highlights in bold (2.5).
    var shareRich: (() -> Void)? = nil
    /// Pin, remind and delete in "…" (2.5); nil: none ("Ask your chats").
    var actions: MessageActions? = nil
    /// Listen (build 90, answers): Ultra's, in Ultra's tint; without Ultra with a tiny "Ultra" mark.
    var listen: (() -> Void)? = nil
    /// Build 94: heard to its end on this device, so replaying it costs no minutes: a quiet check by Listen.
    var voiced = false
    @ObservedObject var store = StoreKitManager.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let tag, !tags.isEmpty {
                Button(action: tag) { TagChips(tags: tags) }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Tags"))
            }
            // With their names while they fit on one line; icons alone when they don't (a long language, a narrow
            // screen): never a name broken over two lines.
            ViewThatFits(in: .horizontal) {
                tools(titles: true)
                tools(titles: false)
            }
            .buttonStyle(MessageToolStyle())
            .padding(.leading, -8)
        }
    }

    /// The tools with their names, or icons alone (VoiceOver still reads the names).
    @ViewBuilder
    private func tools(titles: Bool) -> some View {
        if titles {
            row(titles: true).labelStyle(ToolLabelStyle())
        } else {
            row(titles: false).labelStyle(.iconOnly)
        }
    }

    @ViewBuilder
    private func row(titles: Bool) -> some View {
        HStack(spacing: 2) {
            Button(action: copy) {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            if let shareRich {
                Button(action: shareRich) { Label("Share", systemImage: "square.and.arrow.up") }
            } else {
                ShareLink(item: shareText) { Label("Share", systemImage: "square.and.arrow.up") }
            }
            if let listen {
                Button(action: listen) {
                    HStack(spacing: 3) {
                        Image(systemName: store.isUltra ? "speaker.wave.2.fill" : "speaker.wave.2")
                        if titles { Text("Listen").lineLimit(1) }
                        if !store.isUltra { UltraMark() }
                        if voiced {
                            Image(systemName: "checkmark.circle")
                                .font(.caption2.weight(.semibold))
                                .opacity(0.8)
                                .accessibilityIdentifier("chat.listen.voiced")
                        }
                    }
                    .foregroundColor(ultraTint)
                    .fixedSize()
                }
                .help(voiced ? Text("Already voiced: replay is free") : Text("Listen"))
                .accessibilityLabel(Text("Listen"))
                .accessibilityValue(voiced ? Text("Already voiced: replay is free") : Text(""))
                .accessibilityIdentifier("chat.listen")
            }
            if let tag {
                Button(action: tag) { Label("Tag", systemImage: "tag") }
                    .background(Capsule().fill(tagging ? Color.secondary.opacity(0.14) : .clear))
                    .accessibilityAddTraits(tagging ? .isSelected : [])
            }
            if let actions {
                Menu {
                    Button(action: actions.pin) { Label(actions.pinned ? "Unpin" : "Pin", systemImage: actions.pinned ? "pin.slash" : "pin") }
                    Button(action: actions.remind) { Label(actions.reminded ? "Change reminder" : "Remind me", systemImage: "bell") }
                    Button(role: .destructive, action: actions.delete) { Label("Delete", systemImage: "trash") }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
                .menuIndicator(.hidden)
            }
        }
    }
}

/// A footer tool's label: its icon and its name, on one line.
private struct ToolLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon
            configuration.title.lineLimit(1)
        }
        .fixedSize()
    }
}

private struct MessageToolStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote)
            .foregroundColor(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.5 : 1)
    }
}

/// Picks the tags of an answer or a note, under it (as in the Safari panel): the tags in use as chips
/// to switch on and off, and a field for a new one (Return adds it). Each change is saved at once.
private struct InlineTagEditor: View {
    let tags: [String]
    let known: [String]
    let onChange: ([String]) -> Void
    let close: () -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    init(tags: [String], known: [String], onChange: @escaping ([String]) -> Void, close: @escaping () -> Void) {
        self.tags = tags
        self.known = known
        self.onChange = onChange
        self.close = close
    }

    private func has(_ tag: String) -> Bool { tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tags")
                .font(.footnote.weight(.semibold))
                .foregroundColor(.secondary)
            let all = tags + known.filter { !has($0) }
            if !all.isEmpty {
                WrapLayout(spacing: 6) {
                    ForEach(all, id: \.self) { tag in
                        Button {
                            onChange(has(tag) ? tags.filter { $0.caseInsensitiveCompare(tag) != .orderedSame } : tags + [tag])
                        } label: {
                            TagChipView(tag: tag, active: has(tag))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(has(tag) ? .isSelected : [])
                    }
                }
            }
            HStack(spacing: 8) {
                TextField("New tag…", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit(add)
                    .submitLabel(.done)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                Button(action: add) {
                    Image(systemName: "plus").font(.body.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundColor(Tags.clean(draft).isEmpty ? .secondary : brandBlue)
                .disabled(Tags.clean(draft).isEmpty)
                .accessibilityLabel(Text("Add"))
            }
            HStack {
                Spacer()
                Button("Done") {
                    add()
                    close()
                }
                .font(.body.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundColor(brandBlue)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.cardFill))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.secondary.opacity(0.18)))
        .onAppear { focused = true }
    }

    private func add() {
        let tag = Tags.clean(draft)
        if !tag.isEmpty, !has(tag) { onChange(tags + [tag]) }
        draft = ""
    }
}

extension VerticalAlignment {
    private enum FieldLine: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[VerticalAlignment.center] }
    }

    /// The middle of a text field's last line: buttons beside a field that grows stay level with it.
    static let fieldLine = VerticalAlignment(FieldLine.self)

    /// A field of one line of body text with 9 pt above and below it (the chat's question field).
    static var oneLineFieldHeight: CGFloat {
        #if os(iOS)
        let font = UIFont.preferredFont(forTextStyle: .body)
        return font.lineHeight + 18
        #else
        let font = NSFont.preferredFont(forTextStyle: .body)
        return font.ascender - font.descender + font.leading + 18
        #endif
    }
}

/// Counts an answer the app gave in a chat; on a milestone (the 3rd, 10th, 30th… answer) asks for an
/// App Store rating a moment after it. Apple decides whether to show it (at most 3 times a year; never
/// in TestFlight builds).
@MainActor
func askForReviewAfterAnswer(_ requestReview: RequestReviewAction) {
    guard SharedDefaults.shared.countAppAnswer() else { return }
    // A moment from Safari waiting for the next launch counts as asked: not twice in a row.
    if let moment = SharedDefaults.shared.pendingReviewMoment() { SharedDefaults.shared.markReviewAsked(moment) }
    Task {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        requestReview()
    }
}

struct TagChipView: View {
    let tag: String
    var active = false

    var body: some View {
        let color = Tags.color(tag)
        Text("#\(tag)")
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundColor(active ? .white : color)
            .background(Capsule().fill(active ? color : color.opacity(0.14)))
    }
}

struct TagChips: View {
    let tags: [String]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(tags, id: \.self) { TagChipView(tag: $0) }
        }
    }
}

/// Picks tags: those in use to switch on and off, and a field for a new one.
struct TagsSheet: View {
    @State var tags: [String]
    let known: [String]
    let onSave: ([String]) -> Void
    @State private var draft = ""
    @Environment(\.dismiss) private var dismiss

    init(tags: [String], known: [String], onSave: @escaping ([String]) -> Void) {
        _tags = State(initialValue: tags)
        self.known = known
        self.onSave = onSave
    }

    private func has(_ tag: String) -> Bool { tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame } }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    HStack {
                        TextField("New tag…", text: $draft)
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(Tags.clean(draft).isEmpty)
                    }
                }
                let all = tags + known.filter { !has($0) }
                if !all.isEmpty {
                    Section {
                        ForEach(all, id: \.self) { tag in
                            Button {
                                if has(tag) { tags.removeAll { $0.caseInsensitiveCompare(tag) == .orderedSame } } else { tags.append(tag) }
                            } label: {
                                HStack {
                                    TagChipView(tag: tag)
                                    Spacer()
                                    if has(tag) { Image(systemName: "checkmark").foregroundColor(brandBlue) }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Tags")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        add()
                        onSave(tags)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 360)
        #endif
    }

    private func add() {
        let tag = Tags.clean(draft)
        if !tag.isEmpty, !has(tag) { tags.append(tag) }
        draft = ""
    }
}
