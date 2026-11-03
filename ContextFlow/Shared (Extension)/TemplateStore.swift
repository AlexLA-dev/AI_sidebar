import CloudKit
import Foundation

/// A quick insert template, as the extension keeps it (src/shared/templates.ts) and iCloud stores it.
/// Blanks are written in the text as {label}. A deleted template stays as a tombstone (no text), so an
/// older copy on another device can't bring it back.
struct TemplateRecord: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var text: String
    var keywords: [String]
    var site: String?
    var createdAt: Double
    /// When it last changed (ms): the newest copy wins, template by template.
    var updatedAt: Double
    var deleted: Bool?

    var isDeleted: Bool { deleted == true }

    /// The blanks' labels, each once, in the order they first appear.
    var blanks: [String] {
        var seen: [String] = []
        for label in TemplateRecord.blankLabels(in: text) where !seen.contains(label) { seen.append(label) }
        return seen
    }

    /// The text with its blanks filled in (an unfilled blank becomes empty).
    func filled(_ values: [String: String]) -> String {
        var out = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            let label = rest[rest.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
            out += rest[..<open]
            if label.isEmpty || label.count > 40 || label.contains("\n") || label.contains("{") {
                out += rest[open...close]
            } else {
                out += (values[label] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            }
            rest = rest[rest.index(after: close)...]
        }
        return out + rest
    }

    static func blankLabels(in text: String) -> [String] {
        var labels: [String] = []
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            let label = rest[rest.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
            if !label.isEmpty, label.count <= 40, !label.contains("\n"), !label.contains("{") { labels.append(label) }
            rest = rest[rest.index(after: close)...]
        }
        return labels
    }

    /// A title from the first words, as the extension makes it.
    static func title(from text: String) -> String {
        var words = text.replacingOccurrences(of: "{", with: "").replacingOccurrences(of: "}", with: "")
            .split(whereSeparator: { $0.isWhitespace }).prefix(6).map(String.init)
        while words.count > 1, (words.last?.count ?? 0) <= 2 { words.removeLast() }
        let joined = words.joined(separator: " ")
        return joined.count > 40 ? String(joined.prefix(40)) + "…" : (joined.isEmpty ? "…" : joined)
    }

    static func newId() -> String {
        "t_\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))_\(UUID().uuidString.prefix(8).lowercased())"
    }

    var json: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    static func decode(_ json: String?) -> TemplateRecord? {
        guard let data = json?.data(using: .utf8), let t = try? JSONDecoder().decode(TemplateRecord.self, from: data) else { return nil }
        guard !t.id.isEmpty, t.id.count <= 64, t.updatedAt.isFinite else { return nil }
        if !t.isDeleted && t.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        return t
    }

    /// The copy that wins: the newer one; on a tie the tombstone.
    static func newer(_ a: TemplateRecord?, _ b: TemplateRecord) -> TemplateRecord {
        guard let a else { return b }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        return b.isDeleted ? b : a
    }
}

/// The templates on this device, shared by the app and the Safari extension (App Group). Each template
/// is its own key, so the app and the extension writing at once never overwrite each other's templates.
enum TemplateStore {
    private static let prefix = "cf_tpl_"
    static let tokenKey = "cf_tpl_sync_token"
    static let cloudKey = "cf_tpl_cloud"

    static var defaults: UserDefaults { UserDefaults(suiteName: SharedDefaults.suiteName) ?? .standard }

    /// Every template, tombstones too.
    static func all() -> [TemplateRecord] {
        defaults.dictionaryRepresentation()
            .filter { $0.key.hasPrefix(prefix) && $0.key != tokenKey && $0.key != cloudKey }
            .compactMap { TemplateRecord.decode($0.value as? String) }
    }

    /// The templates to show, newest change first.
    static func live() -> [TemplateRecord] {
        all().filter { !$0.isDeleted }.sorted { $0.updatedAt > $1.updatedAt }
    }

    static func get(_ id: String) -> TemplateRecord? {
        TemplateRecord.decode(defaults.string(forKey: prefix + id))
    }

    /// Takes copies from the extension or iCloud: each one only where it's newer. Returns whether any changed.
    @discardableResult
    static func merge(_ incoming: [TemplateRecord]) -> Bool {
        var changed = false
        for t in incoming {
            let current = get(t.id)
            let win = TemplateRecord.newer(current, t)
            if win != current {
                defaults.set(win.json, forKey: prefix + win.id)
                changed = true
            }
        }
        return changed
    }

    /// Changed in the app now: its time moves on, so this copy wins everywhere.
    static func save(_ t: TemplateRecord) {
        var next = t
        let now = Date().timeIntervalSince1970 * 1000
        next.updatedAt = max(now, (get(t.id)?.updatedAt ?? 0) + 1)
        if next.title.trimmingCharacters(in: .whitespaces).isEmpty { next.title = TemplateRecord.title(from: next.text) }
        defaults.set(next.json, forKey: prefix + next.id)
    }

    static func delete(_ id: String) {
        guard let t = get(id) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let gone = TemplateRecord(id: t.id, title: "", text: "", keywords: [], site: nil, createdAt: t.createdAt, updatedAt: max(now, t.updatedAt + 1), deleted: true)
        defaults.set(gone.json, forKey: prefix + id)
    }
}

/// The templates in the user's private iCloud database, one record per template in the "Templates" zone
/// (the text an encrypted field, as with the chats). The record type is the chats' own ("Conversation":
/// updatedAt + encrypted data): a new zone needs no change to the CloudKit schema in production.
enum TemplateSync {
    private static let recordType = "Conversation"
    private static let zoneID = CKRecordZone.ID(zoneName: "Templates", ownerName: CKCurrentUserDefaultName)
    private static let zoneReadyKey = "cf.templatesZoneReady"

    private static var database: CKDatabase {
        CKContainer(identifier: ChatSync.containerIdentifier).privateCloudDatabase
    }

    /// Sends what changed here since iCloud last had it, takes the other devices' changes into the store.
    /// Returns whether the store changed. Throws without an iCloud account or connection.
    @discardableResult
    static func sync() async throws -> Bool {
        let status = try await CKContainer(identifier: ChatSync.containerIdentifier).accountStatus()
        guard status == .available else { throw ChatSync.Failure.noAccount }
        do {
            return try await syncOnce()
        } catch let error as CKError where [.zoneNotFound, .userDeletedZone].contains(error.code) {
            UserDefaults.standard.set(false, forKey: zoneReadyKey)
            TemplateStore.defaults.removeObject(forKey: TemplateStore.tokenKey)
            TemplateStore.defaults.removeObject(forKey: TemplateStore.cloudKey)
            return try await syncOnce()
        }
    }

    private static func syncOnce() async throws -> Bool {
        if !UserDefaults.standard.bool(forKey: zoneReadyKey) {
            _ = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])
            UserDefaults.standard.set(true, forKey: zoneReadyKey)
        }
        var cloud = TemplateStore.defaults.dictionary(forKey: TemplateStore.cloudKey) as? [String: Double] ?? [:]
        let pending = TemplateStore.all().filter { (cloud[$0.id] ?? 0) < $0.updatedAt }
        if !pending.isEmpty {
            let ids = pending.map { CKRecord.ID(recordName: $0.id, zoneID: zoneID) }
            let existing = try await database.records(for: ids)
            var records: [CKRecord] = []
            for t in pending {
                let id = CKRecord.ID(recordName: t.id, zoneID: zoneID)
                let record: CKRecord
                if case .success(let current)? = existing[id] {
                    // Another device stored a newer copy: it comes back with the changes below.
                    if let at = (current["updatedAt"] as? NSNumber)?.doubleValue, at >= t.updatedAt { continue }
                    record = current
                } else {
                    record = CKRecord(recordType: recordType, recordID: id)
                }
                record["updatedAt"] = Int64(t.updatedAt) as NSNumber
                record.encryptedValues["data"] = t.json
                records.append(record)
            }
            if !records.isEmpty {
                let (saved, _) = try await database.modifyRecords(saving: records, deleting: [], savePolicy: .changedKeys)
                for (_, result) in saved { if case .failure(let error) = result { throw error } }
            }
            for t in pending { cloud[t.id] = t.updatedAt }
        }

        var token = TemplateStore.defaults.data(forKey: TemplateStore.tokenKey).flatMap {
            try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: $0)
        }
        var incoming: [TemplateRecord] = []
        while true {
            let batch = try await changes(since: token)
            for record in batch.records {
                guard let t = TemplateRecord.decode(record.encryptedValues["data"] as? String) else { continue }
                incoming.append(t)
                cloud[t.id] = max(cloud[t.id] ?? 0, t.updatedAt)
            }
            token = batch.token
            if !batch.more { break }
        }
        let changed = TemplateStore.merge(incoming)
        TemplateStore.defaults.set(cloud, forKey: TemplateStore.cloudKey)
        if let token, let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) {
            TemplateStore.defaults.set(data, forKey: TemplateStore.tokenKey)
        }
        return changed
    }

    /// A batch of the zone's changes since `token` (all of them again when the token has expired).
    private static func changes(since token: CKServerChangeToken?) async throws -> (records: [CKRecord], token: CKServerChangeToken, more: Bool) {
        do {
            let batch = try await database.recordZoneChanges(inZoneWith: zoneID, since: token)
            let records = batch.modificationResultsByID.values.compactMap { result -> CKRecord? in
                if case .success(let modification) = result { return modification.record }
                return nil
            }
            return (records, batch.changeToken, batch.moreComing)
        } catch let error as CKError where error.code == .changeTokenExpired && token != nil {
            return try await changes(since: nil)
        }
    }
}
