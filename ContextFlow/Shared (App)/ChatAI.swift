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
        case "LIMIT_REACHED": return object?["plan"] as? String == "free" ? .dailyLimit : .limitReached
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
                else { lines.append("A: " + text.prefix(perAnswer) + (text.count > perAnswer ? "…" : "")) }
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
              let results = object["results"] as? [[String: Any]] else { throw failure(status, data) }
        return results.compactMap { r in (r["id"] as? String).map { Found(id: $0, why: r["why"] as? String ?? "") } }
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
            let text = entry.content.replacingOccurrences(of: #"[ \t]*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
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
    /// notes) and its last page. Charged like an answer in the panel (Free: 5 a day, Pro: the week's).
    @MainActor
    static func ask(_ question: String, in thread: ChatThread, onText: @escaping (String) -> Void) async throws {
        guard AIConsent.given else { throw Failure.consent }
        var body = identity()
        body["context"] = "chat"
        body["messages"] = messages(thread.entries, currentUrl: thread.lastPage?.url) + [["role": "user", "content": question]]
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
            throw failure(status, data)
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
                throw (event["code"] as? String) == "LIMIT_REACHED" ? (event["plan"] as? String == "free" ? Failure.dailyLimit : Failure.limitReached) : Failure.busy
            default:
                break
            }
        }
        if !got { throw Failure.busy }
    }
}

