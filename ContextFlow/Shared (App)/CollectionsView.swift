import SwiftUI
import UniformTypeIdentifiers

// Подборки in the app (2.7, plan section 2; the approved prototype ~/ContextFlow-work/collections-27/spec/mock1-*.png):
// on iPad and Mac the collections down the side and the open one as section columns with cards (drag a card within or
// between sections; «+ Новый раздел» after the last column; a section's menu renames, moves and deletes it); on iPhone the
// same collection as a list of sections. «Сравнить N» on picked cards, «Сводка» and «Разложить» are Pro (the server's
// /api/v2/collect); Free has one collection of up to ten cards.

private func now() -> Double { Double(Date().timeIntervalSince1970 * 1000) }

/// The text the AI gets for a card, and the language its answers come in (the app's).
private var appLanguage: String { String(Locale.current.identifier.prefix(2)) }

struct CollectionsView: View {
    @ObservedObject var library: ChatLibrary
    @ObservedObject var store = StoreKitManager.shared
    var openPro: () -> Void = {}
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selected: String?
    @State private var naming = false
    @State private var newName = ""

    private var columns: Bool {
        #if os(macOS)
        return true
        #else
        return sizeClass == .regular
        #endif
    }

    var body: some View {
        Group {
            if library.liveBoards.isEmpty {
                empty
            } else if columns {
                HStack(spacing: 0) {
                    sidebar.frame(width: 230)
                    Divider()
                    if let id = selected ?? library.liveBoards.first?.id {
                        BoardView(library: library, boardId: id, columns: true, openPro: openPro).id(id)
                    }
                }
            } else {
                List {
                    ForEach(library.liveBoards) { b in
                        NavigationLink {
                            BoardView(library: library, boardId: b.id, columns: false, openPro: openPro)
                        } label: {
                            HStack {
                                Text(verbatim: b.name).font(.headline).lineLimit(1)
                                Spacer()
                                Text(verbatim: "\(b.countedCards)").foregroundColor(.secondary).monospacedDigit()
                            }
                        }
                    }
                    Button(action: startNew) { Label("New collection", systemImage: "plus") }
                        .accessibilityIdentifier("cf-board-new")
                }
            }
        }
        .navigationTitle("Collections")
        .onAppear { ChatAI.reportUse("collect", "open", ["via": columns ? "sidebar" : "list"]) }
        .alert("New collection", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Create") { create() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("For example, Trip to Japan")
        }
    }

    private var sidebar: some View {
        List(selection: Binding(get: { selected ?? library.liveBoards.first?.id }, set: { selected = $0 })) {
            ForEach(library.liveBoards) { b in
                HStack {
                    Text(verbatim: b.name).lineLimit(2)
                    Spacer()
                    Text(verbatim: "\(b.countedCards)").foregroundColor(.secondary).monospacedDigit()
                }
                .tag(b.id)
            }
            Button(action: startNew) { Label("New collection", systemImage: "plus") }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("cf-board-new")
        }
        #if os(iOS)
        .listStyle(.sidebar)
        #endif
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.grid.2x2").font(.system(size: 40)).foregroundColor(brandBlue)
            Text("Collections").font(.title2.weight(.bold))
            Text("Everything you found for one task in one place: a trip, a purchase, a course. Tap “To collection” under an answer or a note.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .frame(maxWidth: 420)
            Button(action: startNew) { Label("New collection", systemImage: "plus") }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("cf-board-new")
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func startNew() {
        guard library.canAddBoard(pro: store.isPro) else {
            ChatAI.reportUse("collect", "limit", ["what": "collection"])
            openPro()
            return
        }
        newName = ""
        naming = true
    }

    private func create() {
        let name = Board.clean(newName, 60)
        guard !name.isEmpty, let id = library.addBoard(name: name, firstSection: String(localized: "Notes", comment: "A new collection's first section (2.7 Collections)"), pro: store.isPro) else { return }
        selected = id
        ChatAI.reportUse("collect", "create", ["via": "app"])
    }
}

// MARK: - One collection

struct BoardView: View {
    @ObservedObject var library: ChatLibrary
    let boardId: String
    let columns: Bool
    var openPro: () -> Void = {}
    @ObservedObject var store = StoreKitManager.shared
    @State private var picked: Set<String> = []
    @State private var working: String?
    @State private var problem: String?
    @State private var renamingSection: BoardSection?
    @State private var renamingBoard = false
    @State private var name = ""
    @State private var addingSection = false
    @State private var deleting = false
    /// «Открыть чат»: a button, not a link (in a list row a link took the row and the card's tap picked it instead).
    @State private var opening: ChatRoute?

    private var board: Board? { library.boards.first { $0.id == boardId } }

    var body: some View {
        Group {
            if let board, !board.deleted {
                if columns { columnsBody(board) } else { listBody(board) }
            } else {
                Text("This collection was deleted.").foregroundColor(.secondary)
            }
        }
        .navigationTitle(board?.name ?? "")
        .toolbar { ToolbarItemGroup { actions } }
        .navigationDestination(isPresented: Binding(get: { opening != nil }, set: { if !$0 { opening = nil } })) {
            if let route = opening { ChatDetailView(library: library, threadId: route.id, scrollTo: route.scrollTo, openPro: openPro) }
        }
        .alert("Rename section", isPresented: Binding(get: { renamingSection != nil }, set: { if !$0 { renamingSection = nil } })) {
            TextField("Name", text: $name)
            Button("Save") {
                if let s = renamingSection { change { $0.renameSection(s.id, name, now: now()) }; ChatAI.reportUse("collect", "section_rename") }
                renamingSection = nil
            }
            Button("Cancel", role: .cancel) { renamingSection = nil }
        }
        .alert("New section", isPresented: $addingSection) {
            TextField("Name", text: $name)
            Button("Add") {
                let n = Board.clean(name, 40)
                if !n.isEmpty { change { $0.addSection(library.newItemId(), n, now: now()) }; ChatAI.reportUse("collect", "section_add") }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Rename collection", isPresented: $renamingBoard) {
            TextField("Name", text: $name)
            Button("Save") { change { $0.rename(name, now: now()) } }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete this collection?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                change { $0.delete(now: now()) }
                ChatAI.reportUse("collect", "delete", ["what": "collection"])
            }
        } message: {
            Text("Its cards go; the chats they came from stay.")
        }
    }

    private func change(_ edit: (inout Board) -> Void) {
        library.changeBoard(boardId) { b in
            guard var board = b else { return }
            edit(&board)
            b = board
        }
    }

    @ViewBuilder
    private var actions: some View {
        if picked.count >= 2 {
            Button { Task { await compare() } } label: { Label("Compare \(picked.count)", systemImage: "tablecells") }
                .disabled(working != nil)
                .accessibilityIdentifier("cf-board-compare")
        }
        Button { Task { await summarize() } } label: { Label("Summary", systemImage: "text.alignleft") }
            .disabled(working != nil || (board?.countedCards ?? 0) == 0)
            .accessibilityIdentifier("cf-board-summary")
        Menu {
            Button { Task { await layout() } } label: { Label("Sort into sections", systemImage: "rectangle.3.group") }
                .disabled((board?.countedCards ?? 0) < 2)
            Button { name = ""; addingSection = true } label: { Label("New section", systemImage: "plus") }
            Button { name = board?.name ?? ""; renamingBoard = true } label: { Label("Rename collection", systemImage: "pencil") }
            Button(role: .destructive) { deleting = true } label: { Label("Delete collection", systemImage: "trash") }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("cf-board-more")
    }

    @ViewBuilder
    private func header(_ board: Board) -> some View {
        if let working {
            HStack(spacing: 8) { ProgressView(); Text(working).foregroundColor(.secondary) }
        }
        if let problem {
            Text(problem).font(.subheadline).foregroundColor(.secondary)
        }
        if let summary = board.summary, !summary.isEmpty {
            (Text("Summary: ").bold().foregroundColor(brandBlue) + Text(verbatim: summary))
                .font(.callout)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(brandBlue.opacity(0.1)))
                .accessibilityIdentifier("cf-board-summary-text")
        }
    }

    // MARK: Columns (iPad, Mac)

    private func columnsBody(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            header(board).padding(.horizontal, 20)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(board.liveSections) { s in column(board, s) }
                    Button { name = ""; addingSection = true } label: {
                        Text("+ New section")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(brandBlue)
                            .padding(14)
                            .frame(width: 120)
                            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(brandBlue.opacity(0.5), style: StrokeStyle(lineWidth: 2, dash: [6, 4])))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("cf-board-new-section")
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
        .padding(.top, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func column(_ board: Board, _ s: BoardSection) -> some View {
        let cards = board.cards(in: s.id)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: s.name).font(.subheadline.weight(.bold)).lineLimit(1)
                Spacer()
                Text(verbatim: "\(cards.count)").font(.subheadline).foregroundColor(.secondary)
                sectionMenu(board, s)
            }
            .padding(.horizontal, 4)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(cards) { card in
                        BoardCardView(card: card, picked: picked.contains(card.id), toggle: { toggle(card) }, openChat: open(card), delete: { delete(card) })
                            .onDrag { NSItemProvider(object: card.id as NSString) }
                            .onDrop(of: [UTType.plainText], isTargeted: nil) { providers in
                                drop(providers, into: s.id, at: cards.firstIndex(of: card) ?? 0)
                            }
                    }
                    // The end of the column: a card dropped here goes last.
                    Color.clear.frame(height: 60)
                        .contentShape(Rectangle())
                        .onDrop(of: [UTType.plainText], isTargeted: nil) { providers in drop(providers, into: s.id, at: cards.count) }
                }
            }
        }
        .padding(10)
        .frame(width: 260)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.secondary.opacity(0.08)))
        .onDrop(of: [UTType.plainText], isTargeted: nil) { providers in drop(providers, into: s.id, at: cards.count) }
    }

    private func sectionMenu(_ board: Board, _ s: BoardSection) -> some View {
        let sections = board.liveSections
        let index = sections.firstIndex(of: s) ?? 0
        return Menu {
            Button { name = s.name; renamingSection = s } label: { Label("Rename", systemImage: "pencil") }
            if index > 0 { Button { change { $0.moveSection(s.id, to: index - 1, now: now()) } } label: { Label("Move left", systemImage: "arrow.left") } }
            if index < sections.count - 1 { Button { change { $0.moveSection(s.id, to: index + 1, now: now()) } } label: { Label("Move right", systemImage: "arrow.right") } }
            if sections.count > 1 || board.cards(in: s.id).isEmpty {
                Button(role: .destructive) {
                    change { $0.deleteSection(s.id, now: now()) }
                    ChatAI.reportUse("collect", "section_delete")
                } label: { Label("Delete section", systemImage: "trash") }
            }
        } label: {
            Image(systemName: "ellipsis").foregroundColor(.secondary).frame(width: 24, height: 24)
        }
        .menuIndicator(.hidden)
        .accessibilityLabel(Text("Section: \(s.name)"))
    }

    // MARK: List (iPhone)

    private func listBody(_ board: Board) -> some View {
        List {
            Section { header(board) }
            ForEach(board.liveSections) { s in
                Section {
                    ForEach(board.cards(in: s.id)) { card in
                        BoardCardView(card: card, picked: picked.contains(card.id), toggle: { toggle(card) }, openChat: open(card), delete: { delete(card) }, flat: true)
                            .contextMenu {
                                ForEach(board.liveSections.filter { $0.id != s.id }) { other in
                                    Button { move(card, to: other.id) } label: { Label("Move to \(other.name)", systemImage: "arrow.right.square") }
                                }
                                Button(role: .destructive) { delete(card) } label: { Label("Delete", systemImage: "trash") }
                            }
                    }
                } header: {
                    HStack {
                        Text(verbatim: s.name)
                        Spacer()
                        sectionMenu(board, s)
                    }
                }
            }
            Button { name = ""; addingSection = true } label: { Label("New section", systemImage: "plus") }
        }
    }

    // MARK: Steps

    private func toggle(_ card: BoardCard) {
        if picked.contains(card.id) { picked.remove(card.id) } else if card.kind != "compare" { picked.insert(card.id) }
    }

    /// «Открыть чат»: the chat, at the card's message (nil when the chat is gone).
    private func open(_ card: BoardCard) -> (() -> Void)? {
        guard let chat = card.chat, let thread = library.threads.first(where: { $0.id == chat }) else { return nil }
        let raw = thread.organized?.entries ?? []
        let index = raw.firstIndex { Organize.entryKey($0) == card.msg }
        return { opening = ChatRoute(id: chat, history: false, scrollTo: index) }
    }

    private func delete(_ card: BoardCard) {
        change { $0.deleteCard(card.id, now: now()) }
        picked.remove(card.id)
        ChatAI.reportUse("collect", "delete", ["what": "card"])
    }

    private func move(_ card: BoardCard, to sid: String) {
        change { $0.moveCard(card.id, to: sid, at: Int.max, now: now()) }
        ChatAI.reportUse("collect", "move")
    }

    private func drop(_ providers: [NSItemProvider], into sid: String, at index: Int) -> Bool {
        guard let provider = providers.first else { return false }
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let cid = object as? String else { return }
            DispatchQueue.main.async {
                change { $0.moveCard(cid, to: sid, at: index, now: now()) }
                ChatAI.reportUse("collect", "move")
            }
        }
        return true
    }

    /// Pro: the server's answer, or what went wrong (not Pro: the Pro screen).
    private func ai(_ what: String, _ run: () async throws -> Void) async {
        guard store.isPro else {
            ChatAI.reportUse("collect", "limit", ["what": what == "layout" ? "card" : "collection"])
            openPro()
            return
        }
        working = String(localized: "Working on it…", comment: "While the AI sorts, compares or sums up a collection (2.7)")
        problem = nil
        defer { working = nil }
        do {
            try await run()
            ChatAI.reportUse("collect", what, ["cards": String(board?.countedCards ?? 0)])
        } catch let failure as ChatAI.Failure {
            if failure == .proOnly { openPro() }
            problem = failure == .limitReached || failure == .dailyLimit
                ? String(localized: "That's enough for today: try again tomorrow.", comment: "The collections' AI daily limit (2.7)")
                : String(localized: "Couldn't reach the AI. Try again.", comment: "A collections' AI request failed (2.7)")
        } catch {
            problem = String(localized: "Couldn't reach the AI. Try again.", comment: "A collections' AI request failed (2.7)")
        }
    }

    private func compare() async {
        guard let board else { return }
        let chosen = board.liveCards.filter { picked.contains($0.id) }
        await ai("compare") {
            let table = try await BoardAI.compare(chosen)
            change { $0.addComparison(library.newItemId(), of: chosen.map(\.id), table: table, now: now()) }
            picked = []
        }
    }

    private func summarize() async {
        guard let board else { return }
        await ai("summary") {
            let text = try await BoardAI.summary(board)
            change { $0.setSummary(text, now: now()) }
        }
    }

    private func layout() async {
        guard let board else { return }
        await ai("layout") {
            let laid = try await BoardAI.layout(board)
            change { $0.applyLayout(sections: laid.sections, cards: laid.cards, newId: library.newItemId, now: now()) }
        }
    }
}

// MARK: - A card

struct BoardCardView: View {
    let card: BoardCard
    let picked: Bool
    let toggle: () -> Void
    let openChat: (() -> Void)?
    let delete: () -> Void
    var flat = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let table = card.table {
                Text("Comparison").font(.caption.weight(.bold)).foregroundColor(brandBlue)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(brandBlue.opacity(0.12)))
                VStack(alignment: .leading, spacing: 2) {
                    row(table.h, bold: true)
                    ForEach(Array(table.r.enumerated()), id: \.offset) { _, r in row(r, bold: false) }
                }
                if let note = table.note { Text(verbatim: note).font(.caption).foregroundColor(.secondary) }
            } else {
                Text(verbatim: card.kind == "note" ? card.gist : card.gist)
                    .font(.callout)
                    .italic(card.kind == "note")
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    if let site = card.site {
                        Button { if let url = card.srcURL.flatMap(URL.init(string:)) { openURL(url) } } label: { Text(verbatim: site).lineLimit(1) }
                            .buttonStyle(.plain)
                    } else if card.kind == "note" {
                        Text("Your note")
                    }
                    Text(verbatim: "· \(card.date.formatted(.dateTime.day().month(.abbreviated)))")
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }
            HStack(spacing: 8) {
                ForEach(card.tags.prefix(2), id: \.self) { tag in
                    Text(verbatim: "#\(tag)").font(.caption2.weight(.semibold)).foregroundColor(brandBlue)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(brandBlue.opacity(0.1)))
                }
                Spacer(minLength: 8)
                if let openChat {
                    Button(action: openChat) { Text("Open chat").font(.caption.weight(.semibold)).foregroundColor(brandBlue) }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("cf-card-open-chat")
                }
            }
        }
        .padding(flat ? 2 : 10)
        .background(flat ? nil : RoundedRectangle(cornerRadius: 11).fill(Color.platformBackground))
        .overlay(alignment: .topTrailing) {
            if picked { Image(systemName: "checkmark.circle.fill").foregroundColor(brandBlue).padding(6) }
        }
        .overlay(flat ? nil : RoundedRectangle(cornerRadius: 11).strokeBorder(picked ? brandBlue : Color.secondary.opacity(0.2), lineWidth: picked ? 2 : 1))
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
        .contextMenu {
            Button(role: .destructive, action: delete) { Label("Delete", systemImage: "trash") }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    private func row(_ cells: [String], bold: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, c in
                Text(verbatim: c).font(.caption.weight(bold ? .semibold : .regular)).foregroundColor(bold ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

extension Color {
    /// A card's ground: the system's own, light or dark.
    static var platformBackground: Color {
        #if os(macOS)
        return Color(nsColor: .textBackgroundColor)
        #else
        return Color(uiColor: .secondarySystemGroupedBackground)
        #endif
    }
}

// MARK: - «В подборку» in a chat

/// Where an answer or a note goes: the suggestion first (Pro: the AI's; Free: by words), then every collection and its
/// sections, a new section, a new collection. Free: one collection of ten cards, then Pro.
struct AddToBoardSheet: View {
    @ObservedObject var library: ChatLibrary
    let thread: ChatThread
    let index: Int
    var openPro: () -> Void = {}
    @ObservedObject var store = StoreKitManager.shared
    @Environment(\.dismiss) private var dismiss
    @State private var suggestion: (board: String?, section: String?, newSection: String?, newBoard: String?)?
    @State private var newBoardName = ""
    @State private var newSectionFor: String?
    @State private var newSectionName = ""

    private var card: BoardCard? { Board.card(from: thread, index, id: library.newItemId(), section: "", now: now()) }

    var body: some View {
        NavigationView {
            List {
                if let card {
                    Section { Text(verbatim: card.gist).font(.callout).lineLimit(4) }
                }
                if let s = suggestion, let label = suggestionLabel(s) {
                    Section("Suggested") {
                        Button { take(s) } label: {
                            HStack { Text(verbatim: label).fontWeight(.semibold); Spacer(); Image(systemName: "sparkles").foregroundColor(brandBlue) }
                        }
                        .accessibilityIdentifier("cf-add-suggested")
                    }
                }
                ForEach(library.liveBoards) { b in
                    Section(header: Text(verbatim: b.name)) {
                        ForEach(b.liveSections) { s in
                            Button { add(to: b.id, section: s.id, how: "picked") } label: { Text(verbatim: s.name) }
                        }
                        Button { newSectionName = ""; newSectionFor = b.id } label: { Label("New section", systemImage: "plus") }
                    }
                }
                Section {
                    TextField("New collection", text: $newBoardName).onSubmit(createBoard)
                    Button("Create and add", action: createBoard).disabled(Board.clean(newBoardName, 60).isEmpty)
                }
            }
            .navigationTitle("To collection")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .alert("New section", isPresented: Binding(get: { newSectionFor != nil }, set: { if !$0 { newSectionFor = nil } })) {
                TextField("Name", text: $newSectionName)
                Button("Add") {
                    if let b = newSectionFor {
                        let sid = library.newItemId()
                        library.changeBoard(b) { $0?.addSection(sid, newSectionName, now: now()) }
                        add(to: b, section: sid, how: "picked")
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
            .task { await suggest() }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 440)
        #endif
    }

    private func suggestionLabel(_ s: (board: String?, section: String?, newSection: String?, newBoard: String?)) -> String? {
        if let b = s.board, let board = library.boards.first(where: { $0.id == b }) {
            if let sec = s.section, let section = board.liveSections.first(where: { $0.id == sec }) { return "\(board.name) → \(section.name)" }
            if let n = s.newSection { return "\(board.name) → + \(n)" }
            return board.name
        }
        if let n = s.newBoard { return "+ \(n)" }
        return nil
    }

    private func suggest() async {
        guard let card else { return }
        let boards = library.liveBoards
        if let local = Board.suggest(boards, gist: card.gist, title: card.srcTitle) { suggestion = (local.board, local.section, nil, nil) }
        // Pro: the AI's place (under the AI consent the chat already has).
        guard store.isPro, AIConsent.given else { return }
        if let place = try? await BoardAI.place(card, boards: boards) { suggestion = place }
    }

    private func take(_ s: (board: String?, section: String?, newSection: String?, newBoard: String?)) {
        if let b = s.board {
            if let sec = s.section { add(to: b, section: sec, how: "suggested"); return }
            let sid = library.newItemId()
            library.changeBoard(b) { $0?.addSection(sid, s.newSection ?? String(localized: "Notes", comment: "A new collection's first section (2.7 Collections)"), now: now(), ai: true) }
            add(to: b, section: sid, how: "suggested")
        } else if let n = s.newBoard {
            newBoardName = n
            createBoard()
        }
    }

    private func createBoard() {
        let name = Board.clean(newBoardName, 60)
        guard !name.isEmpty else { return }
        guard let id = library.addBoard(name: name, firstSection: String(localized: "Notes", comment: "A new collection's first section (2.7 Collections)"), pro: store.isPro) else {
            ChatAI.reportUse("collect", "limit", ["what": "collection"])
            dismiss()
            openPro()
            return
        }
        ChatAI.reportUse("collect", "create", ["via": "app"])
        if let sec = library.boards.first(where: { $0.id == id })?.liveSections.first?.id { add(to: id, section: sec, how: "picked") }
    }

    private func add(to boardId: String, section: String, how: String) {
        guard var card, let board = library.boards.first(where: { $0.id == boardId }) else { return }
        guard board.canAddCard(pro: store.isPro) else {
            ChatAI.reportUse("collect", "limit", ["what": "card"])
            dismiss()
            openPro()
            return
        }
        card.sec = section
        library.changeBoard(boardId) { $0?.addCard(card, now: now()) }
        ChatAI.reportUse("collect", "add", ["via": how == "suggested" ? "suggested" : "app", "cards": String(board.countedCards + 1)])
        dismiss()
    }
}

// MARK: - The AI (Pro, /api/v2/collect)

enum BoardAI {
    @MainActor
    static func place(_ card: BoardCard, boards: [Board]) async throws -> (board: String?, section: String?, newSection: String?, newBoard: String?) {
        let collections: [[String: Any]] = boards.prefix(20).map { b in
            ["id": b.id, "name": b.name, "sections": b.liveSections.prefix(20).map { s in
                ["id": s.id, "name": s.name, "cards": b.cards(in: s.id).prefix(8).map { String($0.gist.prefix(160)) }] as [String: Any]
            }]
        }
        var item: [String: Any] = ["gist": String(card.gist.prefix(300)), "text": String((card.text ?? "").prefix(2_000))]
        if let t = card.srcTitle { item["title"] = String(t.prefix(200)) }
        if let s = card.site { item["site"] = String(s.prefix(100)) }
        let answer = try await ChatAI.collect("place", ["card": item, "collections": collections])
        return (answer["collection"] as? String, answer["section"] as? String, answer["newSection"] as? String, answer["newCollection"] as? String)
    }

    @MainActor
    static func layout(_ board: Board) async throws -> (sections: [(id: String?, name: String)], cards: [(id: String, section: Int)]) {
        let cards = board.liveCards.filter { $0.kind != "compare" }.prefix(120).map { ["id": $0.id, "gist": String($0.gist.prefix(300))] }
        let sections = board.liveSections.map { ["id": $0.id, "name": $0.name, "own": !$0.ai] as [String: Any] }
        let answer = try await ChatAI.collect("layout", ["cards": Array(cards), "sections": sections, "lang": appLanguage])
        let laid = (answer["sections"] as? [[String: Any]] ?? []).map { (id: $0["id"] as? String, name: $0["name"] as? String ?? "") }
        let placed = (answer["cards"] as? [[String: Any]] ?? []).compactMap { c -> (id: String, section: Int)? in
            guard let id = c["id"] as? String, let s = (c["section"] as? NSNumber)?.intValue else { return nil }
            return (id, s)
        }
        guard !laid.isEmpty else { throw ChatAI.Failure.busy }
        return (laid, placed)
    }

    @MainActor
    static func compare(_ cards: [BoardCard]) async throws -> BoardTable {
        let items = cards.prefix(8).map { c -> [String: Any] in
            var item: [String: Any] = ["id": c.id, "gist": String(c.gist.prefix(300)), "text": String((c.text ?? "").prefix(2_000))]
            if let s = c.site { item["site"] = s }
            return item
        }
        let answer = try await ChatAI.collect("compare", ["cards": Array(items), "lang": appLanguage])
        guard let h = answer["h"] as? [String], let r = answer["r"] as? [[String]], h.count >= 2 else { throw ChatAI.Failure.busy }
        return BoardTable(h: h, r: r, note: answer["note"] as? String)
    }

    @MainActor
    static func summary(_ board: Board) async throws -> String {
        var left = 40
        let sections = board.liveSections.prefix(20).map { s -> [String: Any] in
            let cards = board.cards(in: s.id).filter { $0.kind != "compare" }.prefix(max(0, left)).map { String($0.gist.prefix(160)) }
            left -= cards.count
            return ["name": s.name, "cards": Array(cards)]
        }
        let answer = try await ChatAI.collect("summary", ["sections": Array(sections), "lang": appLanguage])
        guard let text = answer["text"] as? String, !text.isEmpty else { throw ChatAI.Failure.busy }
        return text
    }
}
