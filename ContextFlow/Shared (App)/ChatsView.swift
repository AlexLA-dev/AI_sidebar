import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
import SafariServices
#endif

// MARK: - The list

/// The chats from Safari: each with its pages, which open in Safari.
struct ChatsView: View {
    @ObservedObject var library: ChatLibrary
    @ObservedObject var activation: Activation
    @ObservedObject var store = StoreKitManager.shared
    /// iOS: the setup guide (the Get Started tab is gone once there are chats).
    var openSetup: () -> Void = {}
    /// The Pro screen (from the AI features, without Pro).
    var openPro: () -> Void = {}

    // AI search (Pro): on, the query it ran, and its answer.
    @State private var aiSearch = false
    @State private var finding = false
    @State private var found: (query: String, results: Result<[ChatAI.Found], ChatAI.Failure>)?

    private var isPro: Bool {
        #if DEBUG
        // Local checks against the Pro stand (tools/preview, PREVIEW_PLAN=pro): -CFDebugPro YES.
        if UserDefaults.standard.bool(forKey: "CFDebugPro") { return true }
        #endif
        return store.entitlement.active && store.entitlement.productId != StoreKitManager.ProductID.byok
    }

    @State private var renaming: ChatThread?
    @State private var newName = ""
    @State private var deleting: ChatThread?
    @State private var query = ""

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        List {
            if aiSearch {
                aiResults
            } else if searching {
                searchResults
            } else {
                chatList
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .refreshable { await library.refreshNow() }
        #endif
        .searchable(text: $query, prompt: aiSearch ? Text("Describe the chat you're looking for…") : Text("Search chats"))
        .onSubmit(of: .search) { runFind() }
        .onChange(of: query) { value in
            if value.isEmpty { found = nil }
        }
        .toolbar {
            ToolbarItem {
                Button {
                    if isPro {
                        aiSearch.toggle()
                        found = nil
                    } else {
                        openPro()
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "sparkles")
                        if !isPro { Image(systemName: "lock.fill").font(.caption2) }
                    }
                    .foregroundColor(aiSearch ? .white : brandBlue)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(aiSearch ? AnyShapeStyle(brandGradient) : AnyShapeStyle(Color.clear)))
                }
                .accessibilityLabel(Text(isPro ? "AI search" : "AI search — Pro"))
            }
        }
        .overlay {
            if library.loaded && library.threads.isEmpty && !searching {
                EmptyChats()
            }
        }
        .navigationTitle("Chats")
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
                if let deleting { library.delete(deleting) }
                deleting = nil
            }
        } message: {
            Text(library.syncOn ? "It's deleted on all your devices." : "It's deleted on this device.")
        }
        .onAppear { library.refresh() }
    }

    private func runFind() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard aiSearch, !q.isEmpty, !finding else { return }
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
                Text(failureText(failure)).foregroundColor(.secondary)
            case .success(let results) where results.isEmpty:
                Text("No chats found for “\(found.query)”").foregroundColor(.secondary)
            case .success(let results):
                ForEach(results, id: \.self) { result in
                    if let thread = library.threads.first(where: { $0.id == result.id }) {
                        NavigationLink(destination: destination(for: thread)) {
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
            Label("Describe what you remember, in any words, and press Search: “the article about sleep and coffee from last week”.", systemImage: "sparkles")
                .foregroundColor(.secondary)
        }
    }

    private func failureText(_ failure: ChatAI.Failure) -> String {
        switch failure {
        case .proOnly: return String(localized: "This is part of Pro.")
        case .limitReached: return String(localized: "You've used this week's Pro answers. They come back on Monday.")
        case .busy: return String(localized: "The AI service is busy. Please try again in a moment.")
        case .network: return String(localized: "No connection. Check the internet and try again.")
        }
    }

    @ViewBuilder
    private func destination(for thread: ChatThread) -> some View {
        if thread.isHistory {
            HistoryChatView(library: library, threadId: thread.id, openPro: openPro)
        } else {
            ChatDetailView(library: library, threadId: thread.id)
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
            NavigationLink(destination: result.thread.isHistory ? AnyView(HistoryChatView(library: library, threadId: result.thread.id, openPro: openPro)) : AnyView(ChatDetailView(library: library, threadId: result.thread.id, scrollTo: result.hits.first?.index))) {
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
            if activation.state == .off {
                Section { ExtensionOffBanner(openSetup: openSetup) }
            }
            if library.cloud == .off {
                Section { SyncOffBanner(library: library) }
            }
            if library.threads.contains(where: { !$0.isHistory }) {
                Section {
                    if isPro {
                        NavigationLink(destination: HistoryChatView(library: library, threadId: nil, openPro: openPro)) { AskHistoryRow(pro: true) }
                    } else {
                        Button(action: openPro) { AskHistoryRow(pro: false) }
                            .buttonStyle(.plain)
                    }
                }
            }
            Section(footer: footer) {
                ForEach(library.threads) { thread in
                    NavigationLink(destination: destination(for: thread)) {
                        ChatRow(thread: thread)
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
                        .tint(.orange)
                    }
                    #endif
                }
            }
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
    @FocusState private var focused: Bool

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
                        ForEach(Array(messages.enumerated()), id: \.offset) { _, m in
                            if m["role"] == "user" {
                                Text(m["content"] ?? "")
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 14).padding(.vertical, 10)
                                    .background(RoundedRectangle(cornerRadius: 18).fill(brandBlue))
                                    .frame(maxWidth: .infinity, alignment: .trailing)
                                    .padding(.leading, 40)
                            } else {
                                MarkdownView(text: m["content"] ?? "")
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
                                Text(text(for: failure)).foregroundColor(.secondary)
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
        .onAppear(perform: load)
    }

    private func load() {
        let now = Date()
        let chosen = threadId.flatMap { id in library.threads.first { $0.id == id } }
            ?? library.threads.first { $0.isHistory && now.timeIntervalSince($0.lastActivity) < 24 * 3600 }
        guard let chosen else { return }
        id = chosen.id
        messages = chosen.entries.filter { !$0.isNote }.map { ["role": $0.role, "content": $0.content] }
    }

    private func text(for failure: ChatAI.Failure) -> String {
        switch failure {
        case .proOnly: return String(localized: "This is part of Pro.")
        case .limitReached: return String(localized: "You've used this week's Pro answers. They come back on Monday.")
        case .busy: return String(localized: "The AI service is busy. Please try again in a moment.")
        case .network: return String(localized: "No connection. Check the internet and try again.")
        }
    }

    private func send(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, streaming == nil else { return }
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

struct ChatRow: View {
    let thread: ChatThread

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if thread.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.caption)
                        .foregroundColor(.orange)
                        .accessibilityLabel("Pinned")
                }
                if thread.isHistory {
                    Image(systemName: "sparkles").font(.caption).foregroundColor(brandBlue)
                }
                Text(thread.name)
                    .font(.headline)
                    .lineLimit(1)
            }
            if !thread.snippet.isEmpty {
                Text(thread.snippet)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
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

struct ChatDetailView: View {
    @ObservedObject var library: ChatLibrary
    let threadId: String
    /// The message to show first (a search result).
    var scrollTo: Int? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var renaming = false
    @State private var newName = ""
    @State private var deleting = false

    private var thread: ChatThread? { library.threads.first { $0.id == threadId } }

    var body: some View {
        Group {
            if let thread {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            ForEach(Array(thread.entries.enumerated()), id: \.offset) { index, entry in
                                if let page = newPage(thread.entries, index) {
                                    PageDivider(page: page) { library.open(page.url) }
                                }
                                MessageView(entry: entry)
                                    .id(index)
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: 760)
                        .frame(maxWidth: .infinity)
                    }
                    .onAppear {
                        guard let scrollTo else { return }
                        DispatchQueue.main.async { proxy.scrollTo(scrollTo, anchor: .center) }
                    }
                }
                .navigationTitle(thread.name)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem {
                        Menu {
                            if thread.lastPage != nil {
                                Button { library.continueInSafari(thread) } label: { Label("Continue in Safari", systemImage: "safari") }
                            }
                            Button {
                                newName = thread.title ?? ""
                                renaming = true
                            } label: { Label("Rename", systemImage: "pencil") }
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
                .confirmationDialog("Delete this chat?", isPresented: $deleting, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) {
                        library.delete(thread)
                        dismiss()
                    }
                } message: {
                    Text(library.syncOn ? "It's deleted on all your devices." : "It's deleted on this device.")
                }
            } else {
                Text("This chat was deleted.")
                    .foregroundColor(.secondary)
            }
        }
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
            HStack(spacing: 6) {
                Image(systemName: "safari")
                Text(page.title.isEmpty ? host(of: page.url) : page.title)
                    .lineLimit(1)
                    .underline()
                Text("· \(host(of: page.url))")
                    .lineLimit(1)
                    .foregroundColor(.secondary)
            }
            .font(.footnote.weight(.semibold))
            .foregroundColor(brandBlue)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Opens the page in Safari"))
    }
}

private struct MessageView: View {
    let entry: ChatEntry

    var body: some View {
        if entry.isNote {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "pencil")
                    .foregroundColor(.orange)
                Text(entry.content)
                    .textSelection(.enabled)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.orange.opacity(0.12)))
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
                MarkdownView(text: entry.content)
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
