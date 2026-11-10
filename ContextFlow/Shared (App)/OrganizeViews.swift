import Combine
import SwiftUI

// Organizing the chats (2.5), what the app shows: the row of suggestions under a message, the undo bar, the cards
// about it and its short loop. The Safari panel has the same (src/content/Organize.tsx, UndoBar.tsx).

/// "4 messages", in the app's language.
func messagesCount(_ n: Int) -> String {
    String(localized: "\(n) messages")
}

/// Under an answer or a note: one of the user's tags (a tap adds it) and, under a block's last message, a better
/// chat or a new one (a tap moves the block), dashed; ✕ turns either down.
struct SuggestionRow: View {
    var tag: String?
    var move: OrganizeModel.Move?
    /// 2.6 (91): a better name for the chat (under its last message).
    var name: String?
    let onTag: () -> Void
    let onTagNo: () -> Void
    let onMove: () -> Void
    let onMoveNo: () -> Void
    var onName: () -> Void = {}
    var onNameNo: () -> Void = {}

    var body: some View {
        OrganizeFlow(spacing: 6) {
            Text("Suggested").font(.caption).foregroundColor(.secondary).frame(height: 28)
            if let tag {
                SuggestionChip(tint: Tags.color(tag), takeLabel: Text("Suggested tag “\(tag)”. Add it"), take: onTag, refuse: onTagNo) {
                    Text("#\(tag)").font(.footnote.weight(.semibold))
                }
            }
            if let move {
                SuggestionChip(tint: .secondary, takeLabel: move.from != nil ? Text("Merge the older chat “\(move.toName)” into this one") : move.why == .merge ? Text("Merge this chat into “\(move.toName)”") : move.to == nil ? Text("Move these messages to a new chat, “\(move.toName)”") : Text("Move \(messagesCount(move.count)) to the chat “\(move.toName)”"), take: onMove, refuse: onMoveNo) {
                    HStack(spacing: 0) {
                        (Text(Image(systemName: "arrow.turn.down.right")) + Text(" ") + moveText(move))
                            .lineLimit(1)
                        // 2.6 (93): how well it fits there (the owner: «этот уровень показывал бы пользователю рядом с
                        // рекомендацией»); a long name is cut, never this.
                        if move.to != nil, let match = move.match {
                            (Text(" · ").foregroundColor(.secondary) + Text("\(Int(match))% match").fontWeight(.semibold).foregroundColor(.accentColor))
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .font(.footnote)
                }
            }
            if let name {
                SuggestionChip(tint: .secondary, takeLabel: Text("Name it “\(name)”"), take: onName, refuse: onNameNo) {
                    (Text(Image(systemName: "pencil")) + Text(" ") + Text("Name it “\(Text(name).fontWeight(.semibold).foregroundColor(.primary))”"))
                        .font(.footnote)
                        .lineLimit(1)
                }
            }
        }
        // 2.6 (94): a light tint, so the suggestions stand out from the chat (the owner: «подсвечивать… Очень лайтово»).
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.accentColor.opacity(0.07)))
        .padding(.top, 2)
        .transition(.opacity)
    }

    private func moveText(_ move: OrganizeModel.Move) -> Text {
        let name = Text(move.toName).fontWeight(.semibold).foregroundColor(.primary)
        if move.from != nil { return Text("Bring “\(name)” here") }
        if move.why == .merge { return Text("Merge into “\(name)”") }
        return move.to == nil ? Text("To a new chat: “\(name)”") : Text("\(messagesCount(move.count)) to “\(name)”")
    }
}

private struct SuggestionChip<Label: View>: View {
    let tint: Color
    // What VoiceOver reads for taking it; the ✕ reads "Dismiss".
    let takeLabel: Text
    let take: () -> Void
    let refuse: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        HStack(spacing: 0) {
            Button(action: take) { label().foregroundColor(tint).padding(.leading, 10).padding(.trailing, 2) }
                .buttonStyle(.plain)
                .accessibilityLabel(takeLabel)
            Button(action: refuse) {
                Image(systemName: "xmark").font(.caption2.weight(.semibold)).foregroundColor(.secondary).frame(width: 26, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Dismiss"))
        }
        .frame(height: 28)
        .background(Capsule().fill(tint.opacity(0.06)))
        .overlay(Capsule().strokeBorder(tint.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 2.5])))
        .opacity(0.92)
    }
}

/// Lays its children out in rows, wrapping when a row is full.
struct OrganizeFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
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
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

/// How long the bar after a move stays, in seconds, as in the panel (src/content/undoClock.ts): `move` (shorter than
/// the 8 after a delete: the chat stays open and people read on), and earlier once the person scrolls on or swipes,
/// though not in its first `grace` (the Undo is never gone before there was time to tap it). A pointer resting on it
/// holds it, and it goes `afterHold` after the pointer leaves.
enum UndoClock {
    static let move: TimeInterval = 5
    static let grace: TimeInterval = 2
    static let afterHold: TimeInterval = 1.5
}

/// That bar's times. A class: where the chat is scrolled to changes on every frame of a scroll, and that redraws nothing.
final class MovedBarClock {
    private(set) var tick = 0
    private(set) var shownAt = Date.distantPast
    var until = Date.distantPast
    var y: CGFloat?

    func start() {
        tick += 1
        shownAt = Date()
        until = shownAt.addingTimeInterval(UndoClock.move)
        y = nil
    }
}

/// Where the chat's messages start in its scroll view ("chat"): it changes as the chat scrolls.
struct ChatScrollTop: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The bar over the question field after something that can be taken back ("Moved to “Trips” · Undo · Open"), in the
/// one look of bars (SnackBar). It only draws: whoever shows it takes it away after its seconds (UndoClock) or on the
/// next action.
struct UndoBar: View {
    let text: String
    let actions: [(label: LocalizedStringKey, run: () -> Void)]

    var body: some View {
        HStack(spacing: 4) {
            Text(text).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
            ForEach(actions.indices, id: \.self) { i in
                Button(actions[i].label, action: actions[i].run).font(.subheadline.weight(.semibold)).padding(.horizontal, 6)
            }
        }
        .modifier(SnackBar())
        .frame(maxWidth: 560)
        .accessibilityElement(children: .contain)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// What organizing does, drawn with its real pieces (2.6, the owner: the abstract bars read as placeholder art): a
/// question, the answer under it and the row the app really shows there, a suggested tag and "3 messages to “Trips”".
/// In a gentle loop the move is taken and the bar after a move shows, then it starts again; with Reduce Motion (or
/// `-CFStillPictures YES`, for screenshots) it stays on the suggestions. `compact`: the row alone, for small cards.
struct OrganizePreview: View {
    var compact = false
    @State private var moved = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var tag: String { String(localized: "vacation", comment: "A sample tag in the picture of what organizing does") }
    private var chat: String { String(localized: "Trips", comment: "A sample chat name in the picture of what organizing does") }
    private var still: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "CFStillPictures") { return true }
        #endif
        return reduceMotion
    }

    var body: some View {
        Group {
            if compact {
                row
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Spacer(minLength: 48)
                        Text("Cheap flights to Lisbon in May?")
                            .font(.footnote)
                            .foregroundColor(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 16).fill(brandBlue))
                    }
                    Text("In May, return flights from Berlin to Lisbon start at about 90 euros. It's best to book six to eight weeks ahead.")
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                    ZStack(alignment: .leading) {
                        row.opacity(moved ? 0 : 1)
                        UndoBar(text: String(localized: "Moved to “\(chat)”"), actions: [("Undo", {}), ("Open", {})])
                            .opacity(moved ? 1 : 0)
                            .scaleEffect(moved ? 1 : 0.96)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.cardFill))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.primary.opacity(0.06)))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task {
            guard !compact, !still else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_800_000_000)
                withAnimation(.easeInOut(duration: 0.35)) { moved = true }
                try? await Task.sleep(nanoseconds: 2_200_000_000)
                withAnimation(.easeInOut(duration: 0.35)) { moved = false }
            }
        }
    }

    private var row: some View {
        SuggestionRow(
            tag: tag,
            move: OrganizeModel.Move(start: 0, end: 2, to: "sample", toName: chat, why: .topic),
            onTag: {}, onTagNo: {}, onMove: {}, onMoveNo: {}
        )
    }
}

/// Cards about organizing, under a chat's last message: turning suggestions on (Pro, off; turning them on is the
/// consent, so it says where the text goes), "Everything in one chat?" and after the third tag (without Pro). Each is
/// shown once; ✕ (or Not now) closes it for good.
struct OrganizeCard: View {
    enum Kind { case consent, mess, tags }
    let kind: Kind
    let primary: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.subheadline.weight(.semibold))
                    Text(text).font(.footnote).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if kind != .consent {
                    Spacer(minLength: 0)
                    Button(action: close) { Image(systemName: "xmark").foregroundColor(.secondary).frame(width: 28, height: 28) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("Close"))
                }
            }
            if kind != .consent { OrganizePreview(compact: true) }
            HStack(spacing: 12) {
                Button(action: primary) { Text(kind == .consent ? "Turn on" : "Try Pro") }
                    .buttonStyle(.borderedProminent)
                    .tint(brandBlue)
                    .controlSize(.small)
                if kind == .consent {
                    Button("Not now", action: close).font(.footnote).foregroundColor(.secondary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(brandBlue.opacity(0.08)))
        .transition(.opacity)
    }

    private var title: LocalizedStringKey {
        switch kind {
        case .consent: return "Sort your chats by topic?"
        case .mess: return "Everything in one chat?"
        case .tags: return "I can tag the way you do"
        }
    }

    private var text: LocalizedStringKey {
        switch kind {
        case .consent: return "I'll suggest a fitting chat and one of your tags under new answers and notes. For this, the text of your messages goes to our server and to OpenAI and Anthropic. We don't keep it. OpenAI and Anthropic don't use it for training."
        case .mess: return "In Pro, I suggest what goes where and put on tags the way you do."
        case .tags: return "In Pro I suggest one of your tags under new answers and notes, from where you put it yourself."
        }
    }
}

// MARK: - The suggestions for a chat

/// Organizing in the app (Pro, with suggestions on), as the extension's background does (src/background/organize.ts):
/// every message gets a vector once (its text goes to /api/v2/organize, which keeps nothing), kept in the app's own
/// caches on this device and never in iCloud; the rules are Organize.swift's. Also what the cards about it remember.
@MainActor
final class OrganizeModel: ObservableObject {
    static let shared = OrganizeModel()

    struct Move: Equatable {
        let start: Int
        let end: Int
        /// The chat to move to; nil: a new one.
        let to: String?
        let toName: String
        let why: Organize.MoveReason
        /// How well it fits there, in % (2.6 (93)): shown with a move to another chat by topic or site.
        var match: Double? = nil
        /// 2.6 (95): an older chat joins this one whole (`toName` is its name).
        var from: String? = nil
        var count: Int { end - start + 1 }
    }

    struct Suggestions: Equatable {
        let chat: String
        /// The chat's length when they were worked out: they go when it changes.
        let length: Int
        var move: Move?
        /// A tag per message index (and the message's key, to check it's still that message).
        var tags: [Int: (key: String, tag: String)]
        /// 2.6: the chat's name no longer fits its topic (and the user didn't type it): this one does.
        var name: String?
        /// 2.6 (93): what to keep with the chat after a run (ChatLibrary.keepOrg), so other devices show it at once.
        var org: OrgState? = nil

        static func == (a: Suggestions, b: Suggestions) -> Bool {
            a.chat == b.chat && a.length == b.length && a.move == b.move && a.tags.mapValues(\.tag) == b.tags.mapValues(\.tag) && a.name == b.name
        }
    }

    /// The server's switch, thresholds and vector space (from /api/v2/status).
    @Published private(set) var serverOn = false
    @Published private(set) var config = OrganizeConfig()
    private var space = ""
    private var statusAt: Date?

    // Messages that get vectors in one run, sent in batches; tag checks remembered.
    private let maxEmbedPerRun = 640
    private let batch = 128
    private let maxVerdicts = 400

    // The caches as files: nonisolated, so they're written off the main thread.
    nonisolated private struct VectorStore: Codable {
        var space: String
        /// entryKey → "textKey:packed vector".
        var v: [String: String]
    }

    nonisolated private struct Verdicts: Codable {
        struct Item: Codable { var tag: String; var fits: Bool; var confidence: Double; }
        var items: [String: [Item]] = [:]
        var at: [String: Double] = [:]
    }

    // 2.6 (93): the name checks and the tags a chat showed are kept with the chat ("org"), no longer in files here.
    private var vectors = VectorStore(space: "", v: [:])
    private var verdicts = Verdicts()
    private var running: Task<Suggestions?, Never>?

    private init() {
        vectors = Self.load("organize-vectors.json") ?? VectorStore(space: "", v: [:])
        verdicts = Self.load("organize-verdicts.json") ?? Verdicts()
    }

    // MARK: Files (the app's caches: not synced, not in the App Group)

    private nonisolated static func file(_ name: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent(name)
    }

    private nonisolated static func load<T: Decodable>(_ name: String) -> T? {
        guard let url = file(name), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private nonisolated static func save<T: Encodable>(_ value: T, _ name: String) {
        guard let url = file(name), let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// The vectors go with the chats ("Delete all chats" in Safari, or the chats gone).
    func forget() {
        guard !vectors.v.isEmpty || !verdicts.items.isEmpty else { return }
        vectors = VectorStore(space: space, v: [:])
        verdicts = Verdicts()
        Self.save(vectors, "organize-vectors.json")
        Self.save(verdicts, "organize-verdicts.json")
    }

    // MARK: When

    /// Pro, the user turned them on, and the server has them on.
    func enabled(pro: Bool) -> Bool {
        #if DEBUG
        // Checks with a seeded library against a stand: -CFDebugOrganize YES.
        if UserDefaults.standard.bool(forKey: "CFDebugOrganize") { return pro && serverOn }
        #endif
        return pro && serverOn && (SharedDefaults.shared.readSettings()?.settings["organize"] as? Bool ?? false)
    }

    /// The switch and thresholds, asked again after half an hour.
    func refreshStatus() async {
        if let at = statusAt, Date().timeIntervalSince(at) < 1800 { return }
        guard let status = await ChatAI.organizeStatus() else { return }
        statusAt = Date()
        serverOn = status.on
        space = status.space
        config = OrganizeConfig(status.config)
    }

    // MARK: Suggestions

    /// What to suggest in `thread` now (nil: nothing, or it couldn't be worked out). One run at a time.
    func suggestions(for thread: ChatThread, in threads: [ChatThread]) async -> Suggestions? {
        let previous = running
        let task = Task { () -> Suggestions? in
            _ = await previous?.value
            return await run(thread, threads)
        }
        running = task
        return await task.value
    }

    // MARK: The work, off the main thread (2.6 (91): with hundreds of chats it hung the app for seconds)

    private typealias Carry = OrganizeWork.Carry

    /// The chats organizing reads, read off the main thread.
    private func read(_ threads: [ChatThread]) async -> Carry<[OrganizeThread]> {
        let sources = threads.filter { !$0.isHistory }.map { OrganizeWork.Source(id: $0.id, u: $0.updatedAt, data: $0.data) }
        return await Task.detached(priority: .userInitiated) { Carry(value: OrganizeWork.read(sources)) }.value
    }

    /// Vectors for the messages of `live` that lack them, asked for in batches; false when chat `first` has none and
    /// none could be had. What's missing and what's gone is worked out off the main thread.
    private func embedMissing(_ first: String?, _ live: Carry<[OrganizeThread]>) async -> Bool {
        if vectors.space != space && !space.isEmpty { vectors = VectorStore(space: space, v: [:]) }
        let known = vectors.v
        let limit = maxEmbedPerRun
        let todo = await Task.detached(priority: .userInitiated) { Carry(value: OrganizeWork.missing(live.value, known: known, limit: limit)) }.value.value
        var start = 0
        while start < todo.count {
            let part = Array(todo[start..<min(start + batch, todo.count)])
            guard let result = try? await ChatAI.organizeEmbed(part.map(\.text)) else {
                let chat = first.flatMap { id in live.value.first { $0.id == id } }
                if start == 0, let chat, !chat.entries.contains(where: { vectors.v[Organize.entryKey($0)] != nil }) { return false }
                break
            }
            if result.space != vectors.space { vectors = VectorStore(space: result.space, v: [:]) }
            for (i, item) in part.enumerated() { vectors.v[item.key] = "\(Organize.textKey(item.text)):\(result.vectors[i])" }
            start += batch
        }
        // Vectors of messages no chat has any more go.
        let current = vectors.v
        vectors.v = await Task.detached(priority: .utility) { OrganizeWork.keep(current, live.value) }.value
        let snapshot = vectors
        Task.detached(priority: .utility) { Self.save(snapshot, "organize-vectors.json") }
        return true
    }

    /// The hash a tag check is remembered by.
    private func verdictHash(_ message: String, _ candidates: [Organize.TagCandidate]) -> String {
        Organize.textKey(String(data: (try? JSONSerialization.data(withJSONObject: [message, candidates.map { [$0.tag, $0.examples] }])) ?? Data(), encoding: .utf8) ?? message)
    }

    private func run(_ thread: ChatThread, _ threads: [ChatThread]) async -> Suggestions? {
        await refreshStatus()
        guard serverOn, !thread.isHistory else { return nil }
        let chatId = thread.id
        let live = await read(threads)
        guard let chat = live.value.first(where: { $0.id == chatId }), await embedMissing(chatId, live) else { return nil }
        let known = vectors.v
        let cfg = config
        guard let work = await Task.detached(priority: .userInitiated, operation: { Carry(value: OrganizeWork.suggest(chatId, live.value, known: known, cfg)) }).value.value else { return nil }

        var out = Suggestions(chat: thread.id, length: thread.entries.count, move: nil, tags: [:])
        if let s = work.move {
            // A merge into this chat names the older chat (2.6 (95)).
            let named = (s.from ?? s.to).flatMap { id in threads.first { $0.id == id }?.name }
            let name = named ?? ChatThread.title(of: Array(thread.entries[s.start...s.end]))
            out.move = Move(start: s.start, end: s.end, to: s.to, toName: name, why: s.why, match: s.match, from: s.from)
        }
        for tagging in work.tags {
            let hash = verdictHash(tagging.message, tagging.candidates)
            if verdicts.items[hash] == nil {
                guard let answer = try? await ChatAI.organizeTags(message: tagging.message, candidates: tagging.candidates.map { ($0.tag, $0.examples) }) else { break }
                verdicts.items[hash] = answer.map { .init(tag: $0.tag, fits: $0.fits, confidence: $0.confidence) }
                verdicts.at[hash] = Date().timeIntervalSince1970
            }
            let said = (verdicts.items[hash] ?? []).map { Organize.TagVerdict(tag: $0.tag, fits: $0.fits, confidence: $0.confidence) }
            if let tag = Organize.judgedTags(tagging.candidates, said, config).first {
                out.tags[tagging.index] = (Organize.entryKey(chat.entries[tagging.index]), tag)
            }
        }
        if verdicts.items.count > maxVerdicts {
            let keep = Set(verdicts.at.sorted { $0.value > $1.value }.prefix(maxVerdicts).map(\.key))
            verdicts.items = verdicts.items.filter { keep.contains($0.key) }
            verdicts.at = verdicts.at.filter { keep.contains($0.key) }
        }
        let kept = verdicts
        Task.detached(priority: .utility) { Self.save(kept, "organize-verdicts.json") }

        // 2.6: the chat's name, unless the user typed it: checked once the chat has a second question or note, and
        // again when it gets another page or a move changes it. A better one is a suggestion until taken or turned down
        // (2.6 (91): never renamed by itself). 2.6 (93): the check is kept with the chat, so no device asks again what
        // another did, and a name turned down on one never comes back on another.
        var nm = chat.org?.nm
        // 2.6 (95): first what moves out of the chat (or merges), then its name, once nothing is left to move (the owner:
        // renamed again and again, with odd names for a chat on two topics). A name it had stays hidden meanwhile.
        if work.move == nil, Organize.wantsNameCheck(chat) {
            let key = Organize.nameCheckKey(chat)
            if nm?.k != key, let answer = try? await ChatAI.organizeName(chat: Organize.nameText(chat.entries), current: thread.name) {
                nm = Organize.nameState(after: nm, key: key, fits: answer.fits, title: answer.title, current: thread.name)
            }
        }
        // What this chat shows, kept with it: the list counts it, other devices show it at once.
        let shown = out.tags.sorted { $0.key < $1.key }.map { (key: $0.value.key, tag: $0.value.tag) }
        let state = Organize.orgState(for: chat, move: work.move, tags: shown, nm: nm)
        out.org = state
        out.name = Organize.openName(chat, name: thread.name, org: state)
        return out
    }

    /// What the chat's own record suggests (worked out here or on another device, 2.6 (93)), shown at once while the
    /// chat is still as it was then; this device's run follows. Nil without a record.
    func kept(_ thread: ChatThread, in threads: [ChatThread]) -> Suggestions? {
        guard !thread.isHistory, let org = thread.org, let chat = thread.organized else { return nil }
        // The move's chats, if they're still here (openMove asks no more of the others): where it goes, and (2.6 (95))
        // the older chat that joins this one.
        let named = [org.mv?.to, org.mv?.fr].compactMap { $0 }.compactMap { id in threads.first { $0.id == id }?.organized }
        var out = Suggestions(chat: thread.id, length: thread.entries.count, move: nil, tags: [:])
        if let mv = Organize.openMove(chat, named) {
            let name = (mv.fr ?? mv.to).flatMap { id in threads.first { $0.id == id }?.name } ?? ChatThread.title(of: Array(thread.entries[mv.s...mv.e]))
            out.move = Move(start: mv.s, end: mv.e, to: mv.to, toName: name, why: mv.why, match: mv.mt, from: mv.fr)
        }
        for tag in Organize.openTags(chat) { out.tags[tag.index] = (tag.key, tag.tag) }
        out.name = Organize.openName(chat, name: thread.name)
        return out.move == nil && out.tags.isEmpty && out.name == nil ? nil : out
    }

    /// `s` without what was settled since, here or on another device (2.6 (94): a name taken on the iPhone stayed
    /// suggested on the iPad, where nothing was left open in the chat's record to show instead): the name once it's
    /// the chat's or turned down, a tag the message has or had turned down, a move whose messages were moved or turned
    /// down (or, for a merge, turned down for that chat).
    func settled(_ s: Suggestions, _ thread: ChatThread, in threads: [ChatThread] = []) -> Suggestions {
        guard let chat = thread.organized else { return s }
        var out = s
        if let name = s.name, name.lowercased() == thread.name.lowercased() || thread.namedByUser || (thread.org?.nm?.no ?? []).contains(where: { $0.lowercased() == name.lowercased() }) { out.name = nil }
        for (index, item) in s.tags {
            guard chat.entries.indices.contains(index), Organize.entryKey(chat.entries[index]) == item.key else { out.tags[index] = nil; continue }
            let e = thread.entries[index]
            let has = { (list: [String]?) in (list ?? []).contains { $0.lowercased() == item.tag.lowercased() } }
            if has(e.tags) || has((chat.entries[index]["dismissed"] as? [String: Any])?["tags"] as? [String]) { out.tags[index] = nil }
        }
        if let mv = s.move, let from = mv.from {
            // 2.6 (95): a merge into this chat turned down (kept with the older chat) or that chat gone.
            let older = threads.first { $0.id == from }
            if older == nil || (older?.org?.mx ?? []).contains(thread.id) { out.move = nil }
        } else if let mv = s.move {
            let gone = mv.end >= chat.entries.count || chat.entries[mv.start...mv.end].contains {
                Organize.truthy(($0["dismissed"] as? [String: Any])?["move"]) || Organize.truthy($0["from"])
            }
            if gone || (mv.why == .merge && mv.to.map { (thread.org?.mx ?? []).contains($0) } == true) { out.move = nil }
        }
        return out
    }

    /// The open suggestions of every chat, for the chats list (2.6, "N recommendations"): its move, and the name and
    /// tags its record (2.6 (93): kept with the chat, from any device) still suggests (2.6 (91): working out every
    /// chat's tag candidates again, on the main thread, hung the app). Nothing is asked of the AI here but missing
    /// vectors. Only chats with some.
    func counts(in threads: [ChatThread]) async -> [String: Int] {
        await refreshStatus()
        _ = await running?.value
        guard serverOn else { return [:] }
        let live = await read(threads)
        guard !live.value.isEmpty, await embedMissing(nil, live) else { return [:] }
        let known = vectors.v
        let cfg = config
        let names = Dictionary(threads.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        return await Task.detached(priority: .utility) { OrganizeWork.counts(live.value, known: known, cfg, names: names) }.value
    }

    /// "Name by topic": a name for the chat by its topic now (nil: it couldn't be had).
    func nameNow(_ thread: ChatThread) async -> String? {
        await refreshStatus()
        guard serverOn, !thread.isHistory, !thread.entries.isEmpty, let chat = thread.organized,
              let answer = try? await ChatAI.organizeName(chat: Organize.nameText(chat.entries), current: nil) else { return nil }
        return answer.title
    }

    // MARK: The cards (each once; closing is final)

    private let defaults = UserDefaults.standard

    var consentAnswered: Bool {
        get { defaults.string(forKey: "cf_org_consent") != nil }
    }

    func answerConsent(_ accepted: Bool, from: String) {
        defaults.set(accepted ? "accepted" : "declined", forKey: "cf_org_consent")
        if accepted { ExtensionSettings.setOrganize(true) }
        ChatAI.reportOrganize("organize_optin", ["action": accepted ? "accepted" : "declined", "from": from])
        objectWillChange.send()
    }

    /// "Everything in one chat?": shown in this chat already, closed for good, or too soon after the last one.
    func messCardDue(chat: String) -> Bool {
        if defaults.bool(forKey: "cf_org_mess_closed") { return false }
        let shown = defaults.stringArray(forKey: "cf_org_mess_chats") ?? []
        if shown.contains(chat) { return false }
        return Date().timeIntervalSince1970 - defaults.double(forKey: "cf_org_mess_at") > config.messHours * 3600
    }

    func messCardShown(chat: String) {
        defaults.set(Array(((defaults.stringArray(forKey: "cf_org_mess_chats") ?? []) + [chat]).suffix(50)), forKey: "cf_org_mess_chats")
        defaults.set(Date().timeIntervalSince1970, forKey: "cf_org_mess_at")
        ChatAI.reportOrganize("organize_promo", ["action": "shown", "where": "inchat_mess"])
    }

    func closeMessCard() {
        defaults.set(true, forKey: "cf_org_mess_closed")
        objectWillChange.send()
    }

    /// After the user's third tag (without Pro): once.
    func takeTagsCard() -> Bool {
        guard !defaults.bool(forKey: "cf_org_third_tag") else { return false }
        defaults.set(true, forKey: "cf_org_third_tag")
        ChatAI.reportOrganize("organize_promo", ["action": "shown", "where": "third_tag"])
        return true
    }

    /// The first suggestion taken: "from now on it suggests by itself", once.
    func takeFirstWin() -> Bool {
        guard !defaults.bool(forKey: "cf_org_first_win") else { return false }
        defaults.set(true, forKey: "cf_org_first_win")
        ChatAI.reportOrganize("organize_promo", ["action": "shown", "where": "first_win"])
        return true
    }
}

// MARK: - What's new in 2.5

/// The sheet on the first launch of 2.5 (for those with chats): what organizing does, with its loop. With Pro, Turn on
/// is the consent (the line under it says where the text goes); without, Try Pro.
struct OrganizeWhatsNew: View {
    let pro: Bool
    let openPro: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Text("New in ContextFlow").font(.footnote.weight(.semibold)).foregroundColor(.secondary).padding(.top, 24)
            OrganizePreview()
            Text("Everything in one chat?").font(.title2.weight(.bold)).multilineTextAlignment(.center)
            Text("Under a new answer or note, ContextFlow suggests the chat it belongs in, or a new one, and one of your own tags. One tap, and it's there.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // On the iPhone the buttons sit at the bottom; in the iPad's and the Mac's sheet it all stays together.
            if compact { Spacer(minLength: 0) }
            if pro {
                Text("For this, the text of your messages goes to our server and to OpenAI and Anthropic. We don't keep it. OpenAI and Anthropic don't use it for training.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    OrganizeModel.shared.answerConsent(true, from: "whatsnew")
                    close()
                } label: { Text("Turn on suggestions").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            } else {
                Button {
                    ChatAI.reportOrganize("organize_promo", ["action": "tap", "where": "whatsnew"])
                    openPro()
                } label: { Text("Try Pro").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            Button("Not now", action: close).foregroundColor(.secondary).padding(.bottom, 12)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 520)
        .onAppear { ChatAI.reportOrganize("organize_promo", ["action": "shown", "where": "whatsnew"]) }
    }

    // The iPad's sheet is compact in width too, so it goes by the device.
    private var compact: Bool {
        #if os(iOS)
        return UIDevice.current.userInterfaceIdiom == .phone
        #else
        return false
        #endif
    }
}

#if DEBUG
/// Debug builds, `-CFDebugHangLog YES` (2.6 (92): the app hung opening chats): each stall of the main thread over 250 ms,
/// and each chat opened, with the time, in Library/Caches/cf-hangs.log.
nonisolated enum DebugHangLog {
    static let on = UserDefaults.standard.bool(forKey: "CFDebugHangLog")
    static let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!.appendingPathComponent("cf-hangs.log")
    private static let queue = DispatchQueue(label: "cf.hanglog")
    nonisolated(unsafe) private static var started = false
    nonisolated(unsafe) static var openScheduled = false

    static func start() {
        guard on else { return }
        queue.async {
            guard !started else { return }
            started = true
            try? Data().write(to: url)
            Thread.detachNewThread {
                while true {
                    let sent = Date()
                    let done = DispatchSemaphore(value: 0)
                    DispatchQueue.main.async { done.signal() }
                    done.wait()
                    let ms = Date().timeIntervalSince(sent) * 1000
                    if ms > 250 { write(String(format: "stall %.0f ms", ms)) }
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
        }
    }

    static func mark(_ what: String) {
        if on { write(what) }
    }

    private static func write(_ line: String) {
        let text = String(format: "%.3f %@\n", Date().timeIntervalSince1970, line)
        queue.async {
            guard let handle = try? FileHandle(forWritingTo: url) else { return }
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
        }
    }
}
#endif
