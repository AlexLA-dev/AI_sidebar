import Foundation
#if os(iOS)
import UIKit
#endif

/// The consent to send questions and chat excerpts to the AI, asked before the app's first AI
/// request. Version 2 names Anthropic (Claude) with OpenAI as the backup (2.4); asked again when
/// the text changes.
enum AIConsent {
    static let version = 2
    private static let key = "cf_ai_consent"

    static var given: Bool { UserDefaults.standard.integer(forKey: key) >= version }

    static func give() {
        UserDefaults.standard.set(version, forKey: key)
    }
}

/// AI from the app (the Safari panel has the same): questions about one chat (/api/v2/chat with
/// context "chat"), and the Pro features over all the chats, AI search (/api/v2/find) and "Ask your
/// chats" (context "history"). The server checks the plan from the App Store transaction and charges
/// the same allowance as the panel's answers.
enum ChatAI {
    enum Failure: Error, Equatable {
        /// Not Pro (the server's word, whatever the app thinks).
        case proOnly
        /// Pro: this week's answers are used up.
        case limitReached
        /// Free: today's answers are used up.
        case dailyLimit
        case busy
        case network
        /// No consent to the current text yet: nothing was sent.
        case consent
    }

    struct Found: Hashable {
        let id: String
        let why: String
    }

    /// Apple's promotional offer for one purchase, signed by the server (Own key → Pro at a discount).
    struct PromoSignature {
        let offerId: String
        let keyId: String
        let nonce: UUID
        let signature: Data
        let timestamp: Int
    }

    /// Production; a debug build can point at a local stand: `-CFApiBase http://localhost:8788`.
    static var base: URL {
        #if DEBUG
        if let custom = UserDefaults.standard.string(forKey: "CFApiBase"), let url = URL(string: custom) { return url }
        #endif
        return URL(string: "https://aisidebar.netlify.app")!
    }

    @MainActor
    private static func identity() -> [String: Any] {
        var body: [String: Any] = [
            "installId": (Activation.shared.accountToken ?? UUID()).uuidString.lowercased(),
            // "build" tells the server this build's consent names Anthropic (build 67 and later).
            "client": [
                "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                "platform": platform,
                "locale": Locale.current.identifier
            ]
        ]
        if let jws = StoreKitManager.shared.entitlement.jws, StoreKitManager.shared.entitlement.active { body["entitlement"] = jws }
        return body
    }

    private static var platform: String {
        #if os(macOS)
        return "macos"
        #else
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        #endif
    }

    private static func request(_ path: String, _ body: [String: Any]) throws -> URLRequest {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 60
        return request
    }

    private static func failure(_ status: Int, _ data: Data?) -> Failure {
        let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        switch object?["code"] as? String {
        case "PRO_ONLY": return .proOnly
        case "LIMIT_REACHED": return ["pro", "ultra"].contains(object?["plan"] as? String ?? "") ? .limitReached : .dailyLimit
        case "BUSY", "UPSTREAM": return .busy
        default: return status == 403 ? .proOnly : .network
        }
    }

    // MARK: Digests

    /// The chats as the model gets them (src/shared/threads.ts `chatDigests`): newest first, without
    /// "Ask your chats" chats, pages, questions, answers and notes, each cut short.
    static func digests(_ threads: [ChatThread], perChat: Int, perAnswer: Int, total: Int) -> [[String: Any]] {
        var out: [[String: Any]] = []
        var size = 0
        let formatter = ISO8601DateFormatter()
        for thread in threads.sorted(by: { $0.lastAt > $1.lastAt }) where !thread.isHistory {
            var lines: [String] = []
            if !thread.pages.isEmpty {
                lines.append("Pages: " + thread.pages.map { "\($0.title.isEmpty ? $0.url : $0.title) (\($0.url))" }.joined(separator: "; "))
            }
            for entry in thread.entries {
                let text = entry.content.replacingOccurrences(of: #"\s*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
                    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
                if entry.isNote { lines.append("Note: " + text.prefix(perAnswer)) }
                else if entry.isUser { lines.append("Q: " + (entry.label ?? text).prefix(300)) }
                else {
                    lines.append("A: " + text.prefix(perAnswer) + (text.count > perAnswer ? "…" : ""))
                    // Chat UX (2.5): what the user highlighted in the answer.
                    if let marks = entry.marks, !marks.isEmpty { lines.append("Highlighted: " + ChatMarks.line(marks)) }
                }
            }
            var text = String(lines.joined(separator: "\n").prefix(perChat))
            if size + text.count > total { text = String(text.prefix(max(0, total - size))) }
            if text.count < 40 { break }
            size += text.count
            out.append(["id": thread.id, "title": thread.name, "date": formatter.string(from: thread.lastActivity), "text": text])
        }
        return out
    }

    // MARK: AI search

    @MainActor
    static func find(_ query: String, in threads: [ChatThread]) async throws -> [Found] {
        guard AIConsent.given else { throw Failure.consent }
        var body = identity()
        body["query"] = query
        body["chats"] = digests(threads, perChat: 450, perAnswer: 150, total: 38_000)
        let (data, response) = try await URLSession.shared.data(for: try request("api/v2/find", body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let results = object["results"] as? [[String: Any]] else { throw noted(failure(status, data)) }
        return results.compactMap { r in (r["id"] as? String).map { Found(id: $0, why: r["why"] as? String ?? "") } }
    }

    /// Sizes only (no text), as the panel sends them: the chat's messages and pages and this device's
    /// chats, for /analytics to show whether keeping 40 messages or 50 chats gets in the way.
    @MainActor
    private static func stats(turns: Int, pages: Int) -> [String: Int] {
        ["turns": turns, "pages": pages, "chats": ChatLibrary.shared.threads.count]
    }

    // MARK: Own key → Pro

    /// The discount (%) Own key subscribers can move to Pro at, when the server has the offer set up, and the
    /// Google allowances (free a day, Pro a week); nil without an answer.
    @MainActor
    static func upgradeStatus() async -> (discount: Int?, searchFreeDaily: Int?, searchProWeekly: Int?)? {
        guard let request = try? request("api/v2/status", identity()),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let limits = object["limits"] as? [String: Any]
        return ((object["upgradeOffer"] as? [String: Any])?["discount"] as? Int, limits?["searchFreeDaily"] as? Int, limits?["searchProWeekly"] as? Int)
    }

    /// What the plans say (2.6), from the server: Pro's answers a week, Ultra's listening minutes and find-similar
    /// searches a week, and the pages each plan watches; Ultra's listening left this week. nil without an answer.
    @MainActor
    static func planFacts() async -> PlanFacts? {
        guard let request = try? request("api/v2/status", identity()),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let limits = object["limits"] as? [String: Any] else { return nil }
        let watch = limits["watch"] as? [String: Int] ?? [:]
        let speak = (object["ultra"] as? [String: Any])?["speak"] as? [String: Any]
        return PlanFacts(
            proWeekly: limits["proWeekly"] as? Int ?? 375,
            speakWeeklyMinutes: (limits["speakWeeklySeconds"] as? Int ?? 1800) / 60,
            similarWeekly: limits["similarWeekly"] as? Int ?? 10,
            watchPro: watch["pro"] ?? 20,
            watchUltra: watch["ultra"] ?? 50,
            speakLeftSeconds: speak.flatMap { s in (s["limit"] as? Int).map { max(0, $0 - (s["used"] as? Int ?? 0)) } }
        )
    }

    struct PlanFacts: Equatable {
        var proWeekly = 375
        var speakWeeklyMinutes = 30
        var similarWeekly = 10
        var watchPro = 20
        var watchUltra = 50
        var speakLeftSeconds: Int?
    }

    /// Read aloud (2.6, Ultra): one part of the text, spoken by our server (/api/v2/speak), as 24 kHz 16-bit PCM.
    @MainActor
    static func speechRequest(text: String, lang: String, what: String, part: Int, parts: Int) throws -> URLRequest {
        var body = identity()
        body["text"] = text
        body["lang"] = lang
        body["what"] = what
        body["part"] = part
        body["parts"] = parts
        return try request("api/v2/speak", body)
    }

    /// The server's signature for Pro's promotional offer (only for an active Own key subscription).
    @MainActor
    static func promoSignature() async throws -> PromoSignature {
        var body = identity()
        body["bundleId"] = Bundle.main.bundleIdentifier ?? ""
        if let token = Activation.shared.accountToken { body["appAccountToken"] = token.uuidString.lowercased() }
        let (data, response) = try await URLSession.shared.data(for: try request("api/v2/promo", body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let offerId = object["offerId"] as? String, let keyId = object["keyId"] as? String,
              let nonce = (object["nonce"] as? String).flatMap(UUID.init(uuidString:)),
              let signature = (object["signature"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let timestamp = object["timestamp"] as? Int else { throw failure(status, data) }
        return PromoSignature(offerId: offerId, keyId: keyId, nonce: nonce, signature: signature, timestamp: timestamp)
    }

    /// An Own key subscriber refused something (a limit, or a Pro-only feature): a day later Pro at a discount.
    @MainActor
    private static func noted(_ failure: Failure) -> Failure {
        if failure == .proOnly || failure == .dailyLimit || failure == .limitReached { StoreKitManager.shared.noteByokRefusal() }
        return failure
    }

    // MARK: Auto-renew off

    /// The answer to "what was missing" (a Pro user turned auto-renew off), for analytics. Nothing else.
    @MainActor
    static func reportRenewal(_ reason: String, _ entitlement: SharedEntitlement) async {
        var body: [String: Any] = [
            "kind": "renewal_off",
            "appId": Activation.shared.appId,
            "reason": reason,
            "product": entitlement.productId ?? "",
            "from": "app",
            "client": ["platform": platform, "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", "locale": Locale.current.identifier]
        ]
        if let installId = SharedDefaults.shared.readExtensionStatus().installId { body["installId"] = installId }
        if let end = entitlement.expiresAt { body["days_left"] = max(0, Int(end.timeIntervalSinceNow / 86_400)) }
        guard let request = try? request("api/v2/event", body) else { return }
        _ = try? await URLSession.shared.data(for: request)
    }

    /// A tap on ContextFlow's X or Threads in the app's footer, for analytics: which network. Nothing else.
    @MainActor
    static func reportSocial(_ network: String) async {
        var body: [String: Any] = [
            "kind": "social_open",
            "appId": Activation.shared.appId,
            "network": network,
            "client": ["platform": platform, "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", "locale": Locale.current.identifier]
        ]
        if let installId = SharedDefaults.shared.readExtensionStatus().installId { body["installId"] = installId }
        guard let request = try? request("api/v2/event", body) else { return }
        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: A chat

    /// How much of a chat goes with a question (src/shared/conversation.ts `WHOLE_CHAT_CHARS`).
    static let wholeChatChars = 48_000

    /// "Whole chat" (src/shared/conversation.ts `historyForModel`): every message that fits, the newest
    /// kept first, citations stripped; notes marked as notes, and questions asked on another page than
    /// `currentUrl` marked with that page.
    static func messages(_ entries: [ChatEntry], currentUrl: String?) -> [[String: String]] {
        var out: [[String: String]] = []
        var size = 0
        for entry in entries.reversed() {
            var text = entry.content.replacingOccurrences(of: #"[ \t]*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
            // Chat UX (2.5): the user's highlights in an answer go as <mark>…</mark> (the rule is in the system prompt).
            if !entry.isUser, let marks = entry.marks, !marks.isEmpty { text = ChatMarks.markedContent(text, marks) }
            var elsewhere = ""
            if entry.isUser, let page = entry.page, page.url != currentUrl {
                elsewhere = "\"\(page.title.isEmpty ? page.url : page.title)\" — \(page.url)"
            }
            let content: String
            if entry.isNote {
                content = "[Note the user wrote\(elsewhere.isEmpty ? "" : " on another page: \(elsewhere)")]\n\(text)"
            } else {
                content = elsewhere.isEmpty ? text : "[Asked on another page: \(elsewhere)]\n\(text)"
            }
            size += content.count
            if size > wholeChatChars && !out.isEmpty { break }
            out.insert(["role": entry.role, "content": content], at: 0)
        }
        return out
    }

    /// Streams the answer to `question` about the chat: everything said in it (questions, answers and
    /// notes) and the page texts it keeps, its last page first and up to 9 others. Charged like an
    /// answer in the panel (Free: 5 a day, Pro: the week's).
    @MainActor
    static func ask(_ question: String, in thread: ChatThread, onText: @escaping (String) -> Void) async throws {
        guard AIConsent.given else { throw Failure.consent }
        var body = identity()
        body["context"] = "chat"
        body["from"] = "app"
        let saved = thread.savedPages
        let main = saved.first { $0.url == thread.lastPage?.url } ?? saved.first
        let page = { (p: ChatEntry.Page) -> [String: Any] in ["kind": "page", "title": p.title, "url": p.url, "text": p.text ?? ""] }
        if let main {
            body["page"] = page(main)
            body["pages"] = saved.filter { $0.url != main.url }.prefix(9).map(page)
        }
        body["messages"] = messages(thread.entries, currentUrl: main?.url ?? thread.lastPage?.url) + [["role": "user", "content": question]]
        body["stats"] = stats(turns: thread.entries.count + 1, pages: thread.pages.count)
        if let profile = SharedDefaults.shared.readSettings()?.settings["aboutMe"] as? String, !profile.isEmpty {
            body["profile"] = String(profile.prefix(1_000))
        }
        try await stream(try request("api/v2/chat", body), onText: onText)
    }

    // MARK: Ask your chats

    /// Streams the answer to the last question of `messages` ([{role, content}]) from the other chats.
    @MainActor
    static func askHistory(_ messages: [[String: String]], chats: [ChatThread], onText: @escaping (String) -> Void) async throws {
        guard AIConsent.given else { throw Failure.consent }
        var body = identity()
        body["context"] = "history"
        body["messages"] = messages
        body["stats"] = stats(turns: messages.count, pages: 0)
        body["history"] = digests(chats, perChat: 2_500, perAnswer: 500, total: 55_000)
        try await stream(try request("api/v2/chat", body), onText: onText)
    }

    /// Reads an answer's stream (`data: {"type": "delta" | "error" | …}` lines), passing its text on.
    @MainActor
    private static func stream(_ request: URLRequest, onText: @escaping (String) -> Void) async throws {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            throw noted(failure(status, data))
        }
        var got = false
        for try await line in bytes.lines {
            guard line.hasPrefix("data:"), let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces).data(using: .utf8),
                  let event = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { continue }
            switch event["type"] as? String {
            case "delta":
                if let text = event["text"] as? String {
                    got = true
                    onText(text)
                }
            case "error":
                throw (event["code"] as? String) == "LIMIT_REACHED" ? noted(event["plan"] as? String == "pro" ? Failure.limitReached : Failure.dailyLimit) : Failure.busy
            default:
                break
            }
        }
        if !got { throw Failure.busy }
    }
}


// MARK: - Organizing the chats (2.5)

/// What the app asks /api/v2/organize for (Pro, with suggestions on): vectors for messages' text and the check of
/// suggested tags. The server keeps nothing; the vectors stay on this device (OrganizeModel).
extension ChatAI {
    struct Verdict {
        let tag: String
        let fits: Bool
        let confidence: Double
    }

    /// Organizing as the server has it: switched on, the vector space and the thresholds; nil without an answer.
    @MainActor
    static func organizeStatus() async -> (on: Bool, space: String, config: [String: Any])? {
        guard let request = try? request("api/v2/status", identity()),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let organize = object["organize"] as? [String: Any], let space = organize["space"] as? String else { return nil }
        return (organize["on"] as? Bool ?? false, space, organize["config"] as? [String: Any] ?? [:])
    }

    /// Packed vectors (Organize.unpackVector) for `texts`, in their order, and the space they're in.
    @MainActor
    static func organizeEmbed(_ texts: [String]) async throws -> (space: String, vectors: [String]) {
        var body = identity()
        body["op"] = "embed"
        body["texts"] = texts
        let (data, response) = try await URLSession.shared.data(for: try request("api/v2/organize", body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let space = object["space"] as? String, let vectors = object["vectors"] as? [String], vectors.count == texts.count else { throw failure(status, data) }
        return (space, vectors)
    }

    /// Whether each candidate tag fits the message, as the server's check says.
    @MainActor
    static func organizeTags(message: String, candidates: [(tag: String, examples: [String])]) async throws -> [Verdict] {
        var body = identity()
        body["op"] = "tags"
        body["message"] = message
        body["candidates"] = candidates.map { ["tag": $0.tag, "examples": $0.examples] }
        let (data, response) = try await URLSession.shared.data(for: try request("api/v2/organize", body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let verdicts = object["verdicts"] as? [[String: Any]] else { throw failure(status, data) }
        return verdicts.compactMap { v in
            guard let tag = v["tag"] as? String, let fits = v["fits"] as? Bool else { return nil }
            return Verdict(tag: tag, fits: fits, confidence: (v["confidence"] as? NSNumber)?.doubleValue ?? 0)
        }
    }

    /// An organizing event (kind organize / organize_promo / organize_optin): what and where, never text.
    @MainActor
    static func reportOrganize(_ kind: String, _ fields: [String: String]) {
        var body: [String: Any] = [
            "kind": kind,
            "appId": Activation.shared.appId,
            "surface": "app",
            "client": ["platform": platform, "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", "locale": Locale.current.identifier]
        ]
        for (key, value) in fields { body[key] = value }
        if let installId = SharedDefaults.shared.readExtensionStatus().installId { body["installId"] = installId }
        guard let request = try? request("api/v2/event", body) else { return }
        Task { _ = try? await URLSession.shared.data(for: request) }
    }
}
