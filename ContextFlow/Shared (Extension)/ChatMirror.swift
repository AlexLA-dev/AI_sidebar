import Foundation

/// The chats as the ContextFlow app sees them, in the App Group: the Safari extension keeps this copy
/// of all its chats (iCloud's included), whether iCloud sync is on or not, and the app reads it for its
/// Chats screen. Changes made in the app (a chat renamed, pinned or deleted) go to an inbox the extension
/// empties on its next call; "Open in Safari" leaves the chat to continue there.
///
/// Files in the group container, written whole and atomically under a file coordinator, since the app
/// and the extension run in different processes:
/// - `Chats/chats.json`   {id: {updatedAt, data}} — `data` is the thread's JSON as iCloud stores it
/// - `Chats/inbox.json`   [{id, updatedAt?, data?, deleted?, at}] — the app's changes, oldest first
/// - `Chats/open.json`    {id, at} — the chat to continue in Safari
///
/// Compiled into the app and the extension targets.
enum ChatMirror {
    struct Item: Codable, Equatable {
        var updatedAt: Int64
        var data: String
    }

    /// A change made in the app, for the extension (and iCloud through it).
    struct AppChange: Codable, Equatable {
        var id: String
        var updatedAt: Int64?
        var data: String?
        var deleted: Bool?
        /// When it was made (ms): the extension confirms everything up to the latest it applied.
        var at: Double

        var dictionary: [String: Any] {
            if deleted == true { return ["id": id, "deleted": true] }
            return ["id": id, "updatedAt": updatedAt ?? 0, "data": data ?? ""]
        }
    }

    private struct OpenRequest: Codable {
        var id: String
        var at: Double
    }

    /// How long an "Open in Safari" waits for the panel to open.
    private static let openWindow: TimeInterval = 15 * 60

    private static var directory: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName)?
            .appendingPathComponent("Chats", isDirectory: true)
    }

    private static func file(_ name: String) -> URL? {
        guard let directory else { return nil }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(name)
    }

    // MARK: Coordinated files

    private static func read<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        guard let url = file(name) else { return nil }
        var result: T?
        var error: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { url in
            guard let data = try? Data(contentsOf: url) else { return }
            result = try? JSONDecoder().decode(T.self, from: data)
        }
        return result
    }

    /// Reads, changes and writes a file as one step (another process may write it at the same time).
    private static func update<T: Codable>(_ name: String, empty: T, _ change: (inout T) -> Void) {
        guard let url = file(name) else { return }
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forMerging, error: &error) { url in
            var value = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(T.self, from: $0) } ?? empty
            change(&value)
            if let data = try? JSONEncoder().encode(value) { try? data.write(to: url, options: .atomic) }
        }
    }

    // MARK: Chats

    /// Every chat the app knows, by id.
    static func chats() -> [String: Item] {
        read("chats.json", as: [String: Item].self) ?? [:]
    }

    /// Stores newer copies and drops deleted chats. Returns whether anything changed.
    @discardableResult
    static func apply(saves: [String: Item], deletes: [String] = []) -> Bool {
        var changed = false
        update("chats.json", empty: [String: Item]()) { chats in
            for (id, item) in saves where (chats[id]?.updatedAt ?? -1) < item.updatedAt {
                chats[id] = item
                changed = true
            }
            for id in deletes where chats.removeValue(forKey: id) != nil {
                changed = true
            }
        }
        return changed
    }

    // MARK: The app's changes, for the extension

    static func queue(_ change: AppChange) {
        update("inbox.json", empty: [AppChange]()) { inbox in
            // Only the latest change of a chat matters.
            inbox.removeAll { $0.id == change.id }
            inbox.append(change)
        }
    }

    /// The app's changes the extension hasn't applied yet, and the time of the latest.
    static func pendingAppChanges() -> (changes: [AppChange], at: Double?) {
        let inbox = read("inbox.json", as: [AppChange].self) ?? []
        return (inbox, inbox.map(\.at).max())
    }

    /// The extension applied the app's changes made up to `at`.
    static func confirmAppChanges(upTo at: Double) {
        update("inbox.json", empty: [AppChange]()) { inbox in
            inbox.removeAll { $0.at <= at }
        }
    }

    // MARK: Open in Safari

    /// Continue this chat the next time the panel opens in Safari.
    static func requestOpen(_ id: String) {
        update("open.json", empty: OpenRequest(id: "", at: 0)) { request in
            request = OpenRequest(id: id, at: Date().timeIntervalSince1970)
        }
    }

    /// The chat the app asked to continue, if recent; asked once.
    static func takeOpenRequest() -> String? {
        guard let stored = read("open.json", as: OpenRequest.self), !stored.id.isEmpty else { return nil }
        var id: String?
        update("open.json", empty: OpenRequest(id: "", at: 0)) { request in
            if !request.id.isEmpty, Date().timeIntervalSince1970 - request.at < openWindow { id = request.id }
            request = OpenRequest(id: "", at: 0)
        }
        return id
    }
}
