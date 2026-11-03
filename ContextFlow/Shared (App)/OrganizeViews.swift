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
    let onTag: () -> Void
    let onTagNo: () -> Void
    let onMove: () -> Void
    let onMoveNo: () -> Void

    var body: some View {
        OrganizeFlow(spacing: 6) {
            Text("Suggested").font(.caption).foregroundColor(.secondary).frame(height: 28)
            if let tag {
                SuggestionChip(tint: Tags.color(tag), take: onTag, refuse: onTagNo) {
                    Text("#\(tag)").font(.footnote.weight(.semibold))
                }
                .accessibilityLabel(Text("Suggested tag “\(tag)”. Add it"))
            }
            if let move {
                SuggestionChip(tint: .secondary, take: onMove, refuse: onMoveNo) {
                    (Text(Image(systemName: "arrow.turn.down.right")) + Text(" ") + moveText(move))
                        .font(.footnote)
                        .lineLimit(1)
                }
                .accessibilityLabel(move.to == nil ? Text("Move these messages to a new chat, “\(move.toName)”") : Text("Move \(messagesCount(move.count)) to the chat “\(move.toName)”"))
            }
        }
        .padding(.top, 2)
        .transition(.opacity)
    }

    private func moveText(_ move: OrganizeModel.Move) -> Text {
        let name = Text(move.toName).fontWeight(.semibold).foregroundColor(.primary)
        return move.to == nil ? Text("To a new chat: “\(name)”") : Text("\(messagesCount(move.count)) to “\(name)”")
    }
}

private struct SuggestionChip<Label: View>: View {
    let tint: Color
    let take: () -> Void
    let refuse: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        HStack(spacing: 0) {
            Button(action: take) { label().foregroundColor(tint).padding(.leading, 10).padding(.trailing, 2) }
                .buttonStyle(.plain)
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

/// The dark bar over the question field after something that can be taken back ("Moved to “Trips” · Undo · Open").
/// It only draws: whoever shows it takes it away on the next action.
struct UndoBar: View {
    let text: String
    let actions: [(label: LocalizedStringKey, run: () -> Void)]

    var body: some View {
        HStack(spacing: 4) {
            Text(text).font(.subheadline).foregroundColor(.white).frame(maxWidth: .infinity, alignment: .leading)
            ForEach(actions.indices, id: \.self) { i in
                Button(actions[i].label, action: actions[i].run).font(.subheadline.weight(.semibold)).padding(.horizontal, 6)
            }
        }
        .tint(Color(red: 0.58, green: 0.77, blue: 0.99))
        .padding(.vertical, 11).padding(.leading, 14).padding(.trailing, 6)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 0.14, green: 0.13, blue: 0.17)))
        .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
        .frame(maxWidth: 560)
        .accessibilityElement(children: .contain)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// What organizing does, in a loop: messages of one chat slide into the chats and tags they belong to. With Reduce
/// Motion it stands still.
struct OrganizeAnimation: View {
    var big = false
    @State private var sorted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let s: CGFloat = big ? 1.8 : 1
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 12 * s).fill(Color.cardFill)
                .overlay(RoundedRectangle(cornerRadius: 12 * s).stroke(Color.primary.opacity(0.08)))
            bar(.blue, y: 12, s: s)
            bar(.green, y: 26, s: s).modifier(Slide(on: sorted, dx: 30 * s, dy: 0))
            bar(.blue, y: 40, s: s)
            bar(.orange, y: 54, s: s).modifier(Slide(on: sorted, dx: 30 * s, dy: 6 * s))
            folder(.green, y: 22, s: s)
            folder(.orange, y: 56, s: s)
        }
        .frame(width: 76 * s, height: 88 * s)
        .clipShape(RoundedRectangle(cornerRadius: 12 * s))
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.4).delay(0.6).repeatForever(autoreverses: true)) { sorted = true }
        }
    }

    private func bar(_ color: Color, y: CGFloat, s: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4 * s).fill(color.opacity(0.6)).frame(width: 36 * s, height: 8 * s).offset(x: 8 * s, y: y * s)
    }

    private func folder(_ color: Color, y: CGFloat, s: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 3 * s).fill(color.opacity(0.25)).frame(width: 22 * s, height: 16 * s).offset(x: 47 * s, y: y * s)
    }

    private struct Slide: ViewModifier {
        let on: Bool
        let dx: CGFloat
        let dy: CGFloat
        func body(content: Content) -> some View {
            content.scaleEffect(on ? 0.45 : 1).offset(x: on ? dx : 0, y: on ? dy : 0).opacity(on ? 0.15 : 1)
        }
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
                if kind != .consent { OrganizeAnimation() }
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
        case .tags: return "ContextFlow can tag the way you do"
        }
    }

    private var text: LocalizedStringKey {
        switch kind {
        case .consent: return "ContextFlow will suggest a fitting chat and one of your tags under new answers and notes. For this, the text of your messages goes to our server and to OpenAI and Anthropic. We don't keep it. OpenAI and Anthropic don't use it for training."
        case .mess: return "In Pro, ContextFlow suggests what goes where and puts on tags the way you do."
        case .tags: return "In Pro it suggests one of your tags under new answers and notes, from where you put it yourself."
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
        var count: Int { end - start + 1 }
    }

    struct Suggestions: Equatable {
        let chat: String
        /// The chat's length when they were worked out: they go when it changes.
        let length: Int
        var move: Move?
        /// A tag per message index (and the message's key, to check it's still that message).
        var tags: [Int: (key: String, tag: String)]

        static func == (a: Suggestions, b: Suggestions) -> Bool {
            a.chat == b.chat && a.length == b.length && a.move == b.move && a.tags.mapValues(\.tag) == b.tags.mapValues(\.tag)
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

    private struct VectorStore: Codable {
        var space: String
        /// entryKey → "textKey:packed vector".
        var v: [String: String]
    }

    private struct Verdicts: Codable {
        struct Item: Codable { var tag: String; var fits: Bool; var confidence: Double; }
        var items: [String: [Item]] = [:]
        var at: [String: Double] = [:]
    }

    private var vectors = VectorStore(space: "", v: [:])
    private var verdicts = Verdicts()
    private var unpacked: [String: [Float]] = [:]
    private var running: Task<Suggestions?, Never>?

    private init() {
        vectors = Self.load("organize-vectors.json") ?? VectorStore(space: "", v: [:])
        verdicts = Self.load("organize-verdicts.json") ?? Verdicts()
    }

    // MARK: Files (the app's caches: not synced, not in the App Group)

    private static func file(_ name: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent(name)
    }

    private static func load<T: Decodable>(_ name: String) -> T? {
        guard let url = file(name), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func save<T: Encodable>(_ value: T, _ name: String) {
        guard let url = file(name), let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// The vectors go with the chats ("Delete all chats" in Safari, or the chats gone).
    func forget() {
        guard !vectors.v.isEmpty || !verdicts.items.isEmpty else { return }
        vectors = VectorStore(space: space, v: [:])
        verdicts = Verdicts()
        unpacked = [:]
        Self.save(vectors, "organize-vectors.json")
        Self.save(verdicts, "organize-verdicts.json")
    }

    // MARK: When

    /// Pro, the user turned them on, and the server has them on.
    func enabled(pro: Bool) -> Bool {
        pro && serverOn && (SharedDefaults.shared.readSettings()?.settings["organize"] as? Bool ?? false)
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

    private func run(_ thread: ChatThread, _ threads: [ChatThread]) async -> Suggestions? {
        await refreshStatus()
        guard serverOn, !thread.isHistory, let chat = thread.organized else { return nil }
        let live = threads.filter { !$0.isHistory }.compactMap(\.organized)
        if vectors.space != space && !space.isEmpty { vectors = VectorStore(space: space, v: [:]); unpacked = [:] }

        // Vectors for what lacks them: this chat first, then the others (the list's order, latest first).
        let order = [chat] + live.filter { $0.id != chat.id }
        let todo = Organize.missingVectors(order, has: { key, text in self.vectors.v[key]?.hasPrefix(Organize.textKey(text) + ":") == true }, limit: maxEmbedPerRun)
        var start = 0
        while start < todo.count {
            let part = Array(todo[start..<min(start + batch, todo.count)])
            guard let result = try? await ChatAI.organizeEmbed(part.map(\.text)) else {
                if start == 0 && !chat.entries.contains(where: { vectors.v[Organize.entryKey($0)] != nil }) { return nil }
                break
            }
            if result.space != vectors.space { vectors = VectorStore(space: result.space, v: [:]); unpacked = [:] }
            for (i, item) in part.enumerated() { vectors.v[item.key] = "\(Organize.textKey(item.text)):\(result.vectors[i])" }
            start += batch
        }
        // Vectors of messages no chat has any more go.
        let keys = Set(live.flatMap { $0.entries.map(Organize.entryKey) })
        vectors.v = vectors.v.filter { keys.contains($0.key) }
        Self.save(vectors, "organize-vectors.json")

        let vectorOf: Organize.VectorOf = { entry in
            let text = Organize.embedText(entry)
            guard !text.isEmpty, let hit = self.vectors.v[Organize.entryKey(entry)], let colon = hit.firstIndex(of: ":"),
                  hit[..<colon] == Organize.textKey(text) else { return nil }
            if let v = self.unpacked[hit] { return v }
            let v = Organize.unpackVector(String(hit[hit.index(after: colon)...]))
            self.unpacked[hit] = v
            return v
        }

        var out = Suggestions(chat: thread.id, length: thread.entries.count, move: nil, tags: [:])
        if let s = Organize.suggestMove(chat, live, vectorOf, config) {
            let name = s.to.flatMap { id in threads.first { $0.id == id }?.name } ?? ChatThread.title(of: Array(thread.entries[s.start...s.end]))
            out.move = Move(start: s.start, end: s.end, to: s.to, toName: name, why: s.why)
        }
        for index in Organize.tagTargets(chat, config) {
            let candidates = Organize.tagCandidates(chat, index, live, vectorOf, config)
            guard !candidates.isEmpty else { continue }
            let message = Organize.judgeText(chat.entries, index)
            let hash = Organize.textKey(String(data: (try? JSONSerialization.data(withJSONObject: [message, candidates.map { [$0.tag, $0.examples] }])) ?? Data(), encoding: .utf8) ?? message)
            if verdicts.items[hash] == nil {
                guard let answer = try? await ChatAI.organizeTags(message: message, candidates: candidates.map { ($0.tag, $0.examples) }) else { break }
                verdicts.items[hash] = answer.map { .init(tag: $0.tag, fits: $0.fits, confidence: $0.confidence) }
                verdicts.at[hash] = Date().timeIntervalSince1970
            }
            let said = (verdicts.items[hash] ?? []).map { Organize.TagVerdict(tag: $0.tag, fits: $0.fits, confidence: $0.confidence) }
            if let tag = Organize.judgedTags(candidates, said, config).first {
                out.tags[index] = (Organize.entryKey(chat.entries[index]), tag)
            }
        }
        if verdicts.items.count > maxVerdicts {
            let keep = Set(verdicts.at.sorted { $0.value > $1.value }.prefix(maxVerdicts).map(\.key))
            verdicts.items = verdicts.items.filter { keep.contains($0.key) }
            verdicts.at = verdicts.at.filter { keep.contains($0.key) }
        }
        Self.save(verdicts, "organize-verdicts.json")
        return out
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
            OrganizeAnimation(big: true)
            Text("Everything in one chat?").font(.title2.weight(.bold)).multilineTextAlignment(.center)
            Text("Under a new answer or note, ContextFlow suggests the chat it belongs in, or a new one, and one of your own tags. One tap, and it's there.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
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
}
