import CloudKit
import Foundation

/// One entry of «Мои данные» (2.7.1): a value the agent fills into forms on sites (a name, an e-mail, a phone, an address,
/// a company, a birth date, or a fact of the person's own: «Размер обуви: 43»). `key` is what the model sees
/// ("email", "address.city", "fact"); the value never leaves the device but for the person's own iCloud, when they
/// said yes to syncing. Passwords, cards, bank and document numbers, codes and health data are refused before they're
/// kept (the panel and the app check; src/shared/agent/formdata.ts). A deleted entry stays as a tombstone (no value),
/// so an older copy on another device can't bring it back.
struct FormDataEntry: Codable, Equatable {
    var id: String
    var key: String
    var label: String
    var value: String
    var updatedAt: Double
    var deleted: Bool?

    var isDeleted: Bool { deleted == true }

    var json: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    static func decode(_ json: String?) -> FormDataEntry? {
        guard let data = json?.data(using: .utf8), let e = try? JSONDecoder().decode(FormDataEntry.self, from: data) else { return nil }
        guard !e.id.isEmpty, e.id.count <= 64, e.key.count <= 40, e.label.count <= 80, e.value.count <= 500, e.updatedAt.isFinite else { return nil }
        return e
    }

    static func newer(_ a: FormDataEntry?, _ b: FormDataEntry) -> FormDataEntry {
        guard let a else { return b }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        return b.isDeleted ? b : a
    }
}

/// «Мои данные» on this device, shared by the app and the Safari extension (App Group), one key per entry. Whether they
/// sync through iCloud is asked once, when the person first saves something; until they answer, nothing syncs.
enum FormDataStore {
    private static let prefix = "cf_fd_"
    static let tokenKey = "cf_fd_sync_token"
    static let cloudKey = "cf_fd_cloud"
    static let syncKey = "cf_fd_icloud"

    static var defaults: UserDefaults { UserDefaults(suiteName: SharedDefaults.suiteName) ?? .standard }

    /// The iCloud choice: true (yes), false (no), nil (not asked yet: no sync).
    static var syncChoice: Bool? {
        get { defaults.object(forKey: syncKey) as? Bool }
        set {
            if let newValue { defaults.set(newValue, forKey: syncKey) } else { defaults.removeObject(forKey: syncKey) }
        }
    }

    private static func isEntryKey(_ k: String) -> Bool {
        k.hasPrefix(prefix) && k != tokenKey && k != cloudKey && k != syncKey
    }

    static func all() -> [FormDataEntry] {
        defaults.dictionaryRepresentation().filter { isEntryKey($0.key) }.compactMap { FormDataEntry.decode($0.value as? String) }
    }

    static func live() -> [FormDataEntry] {
        all().filter { !$0.isDeleted }.sorted { $0.updatedAt < $1.updatedAt }
    }

    static func get(_ id: String) -> FormDataEntry? {
        FormDataEntry.decode(defaults.string(forKey: prefix + id))
    }

    @discardableResult
    static func merge(_ incoming: [FormDataEntry]) -> Bool {
        var changed = false
        for e in incoming {
            let current = get(e.id)
            let win = FormDataEntry.newer(current, e)
            if win != current {
                defaults.set(win.isDeleted ? FormDataEntry(id: win.id, key: win.key, label: "", value: "", updatedAt: win.updatedAt, deleted: true).json : win.json, forKey: prefix + win.id)
                changed = true
            }
        }
        return changed
    }

    /// Changed in the app: its time moves on, so this copy wins everywhere.
    static func save(_ e: FormDataEntry) {
        var next = e
        next.updatedAt = max(Date().timeIntervalSince1970 * 1000, (get(e.id)?.updatedAt ?? 0) + 1)
        defaults.set(next.json, forKey: prefix + next.id)
    }

    static func delete(_ id: String) {
        guard let e = get(id) else { return }
        let gone = FormDataEntry(id: e.id, key: e.key, label: "", value: "", updatedAt: max(Date().timeIntervalSince1970 * 1000, e.updatedAt + 1), deleted: true)
        defaults.set(gone.json, forKey: prefix + id)
    }

    /// «Удалить все»: every entry goes (tombstones, so other devices take it too).
    static func deleteAll() {
        for e in all() where !e.isDeleted { delete(e.id) }
    }

    static func newId() -> String {
        "fd_\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))_\(UUID().uuidString.prefix(8).lowercased())"
    }
}

/// «Мои данные» in the person's private iCloud database, one record per entry in the "FormData" zone, the entry in an
/// encrypted field (as the templates and chats). Only after they said yes. Turned off later: the zone is deleted, the
/// entries stay on this device.
enum FormDataSync {
    private static let recordType = "Conversation"
    private static let zoneID = CKRecordZone.ID(zoneName: "FormData", ownerName: CKCurrentUserDefaultName)
    private static let zoneReadyKey = "cf.formDataZoneReady"

    private static var database: CKDatabase {
        CKContainer(identifier: ChatSync.containerIdentifier).privateCloudDatabase
    }

    @discardableResult
    static func sync() async throws -> Bool {
        guard FormDataStore.syncChoice == true else { return false }
        let status = try await CKContainer(identifier: ChatSync.containerIdentifier).accountStatus()
        guard status == .available else { throw ChatSync.Failure.noAccount }
        do {
            return try await syncOnce()
        } catch let error as CKError where [.zoneNotFound, .userDeletedZone].contains(error.code) {
            UserDefaults.standard.set(false, forKey: zoneReadyKey)
            FormDataStore.defaults.removeObject(forKey: FormDataStore.tokenKey)
            FormDataStore.defaults.removeObject(forKey: FormDataStore.cloudKey)
            return try await syncOnce()
        }
    }

    /// The iCloud copy removed (sync turned off): the zone goes; this device keeps its entries.
    static func removeCloud() async {
        UserDefaults.standard.set(false, forKey: zoneReadyKey)
        FormDataStore.defaults.removeObject(forKey: FormDataStore.tokenKey)
        FormDataStore.defaults.removeObject(forKey: FormDataStore.cloudKey)
        _ = try? await database.modifyRecordZones(saving: [], deleting: [zoneID])
    }

    private static func syncOnce() async throws -> Bool {
        if !UserDefaults.standard.bool(forKey: zoneReadyKey) {
            _ = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])
            UserDefaults.standard.set(true, forKey: zoneReadyKey)
        }
        var cloud = FormDataStore.defaults.dictionary(forKey: FormDataStore.cloudKey) as? [String: Double] ?? [:]
        let pending = FormDataStore.all().filter { (cloud[$0.id] ?? 0) < $0.updatedAt }
        if !pending.isEmpty {
            let ids = pending.map { CKRecord.ID(recordName: $0.id, zoneID: zoneID) }
            let existing = try await database.records(for: ids)
            var records: [CKRecord] = []
            for e in pending {
                let id = CKRecord.ID(recordName: e.id, zoneID: zoneID)
                let record: CKRecord
                if case .success(let current)? = existing[id] {
                    if let at = (current["updatedAt"] as? NSNumber)?.doubleValue, at >= e.updatedAt { continue }
                    record = current
                } else {
                    record = CKRecord(recordType: recordType, recordID: id)
                }
                record["updatedAt"] = Int64(e.updatedAt) as NSNumber
                record.encryptedValues["data"] = e.json
                records.append(record)
            }
            if !records.isEmpty {
                let (saved, _) = try await database.modifyRecords(saving: records, deleting: [], savePolicy: .changedKeys)
                for (_, result) in saved { if case .failure(let error) = result { throw error } }
            }
            for e in pending { cloud[e.id] = e.updatedAt }
        }
        var token = FormDataStore.defaults.data(forKey: FormDataStore.tokenKey).flatMap {
            try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: $0)
        }
        var incoming: [FormDataEntry] = []
        while true {
            let batch = try await changes(since: token)
            for record in batch.records {
                guard let e = FormDataEntry.decode(record.encryptedValues["data"] as? String) else { continue }
                incoming.append(e)
                cloud[e.id] = max(cloud[e.id] ?? 0, e.updatedAt)
            }
            token = batch.token
            if !batch.more { break }
        }
        let changed = FormDataStore.merge(incoming)
        FormDataStore.defaults.set(cloud, forKey: FormDataStore.cloudKey)
        if let token, let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) {
            FormDataStore.defaults.set(data, forKey: FormDataStore.tokenKey)
        }
        return changed
    }

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
