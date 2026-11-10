import CloudKit
import Foundation

/// The chats (threads) in the user's private iCloud database, so they continue on the user's other
/// devices (same Apple Account). One record per thread in the "Threads" zone; the newest `updatedAt`
/// (ms, set by the extension when a thread changes) wins. The chat itself is an encrypted field:
/// only the user's devices can read it, not Apple and not us.
enum ChatSync {
    static let containerIdentifier = "iCloud.com.contextflow.app"
    private static let recordType = "Conversation"
    private static let zoneID = CKRecordZone.ID(zoneName: "Threads", ownerName: CKCurrentUserDefaultName)
    private static let zoneReadyKey = "cf.threadsZoneReady"

    struct Snapshot {
        let id: String
        let updatedAt: Int64
        let data: String
        /// 2.6 (94): set for a change to organizing's record only ("org": what it suggests, names and merges turned
        /// down): the time of the copy it was made on. Such a change never replaces a copy another device wrote since
        /// (build 93: a stale device's suggestions record put back the old name of a chat renamed on another device).
        var base: Int64? = nil
    }

    enum Change {
        case save(Snapshot)
        case delete(String)
    }

    struct SyncResult {
        let token: String?
        let changed: [Snapshot]
        let deleted: [String]
    }

    enum Failure: Error {
        case noAccount
    }

    private static var database: CKDatabase {
        CKContainer(identifier: containerIdentifier).privateCloudDatabase
    }

    /// Sends `changes` (a save only replaces an older copy), then returns what changed in iCloud since
    /// `token` (everything when it is nil), including this device's own saves.
    static func sync(token: String?, changes: [Change]) async throws -> SyncResult {
        let status = try await CKContainer(identifier: containerIdentifier).accountStatus()
        guard status == .available else { throw Failure.noAccount }
        do {
            try await ensureZone()
            try await send(changes)
            return try await fetchChanges(since: token)
        } catch let error as CKError where [.zoneNotFound, .userDeletedZone].contains(error.code) {
            // The zone is gone (e.g. the user cleared iCloud data): start over.
            UserDefaults.standard.set(false, forKey: zoneReadyKey)
            try await ensureZone()
            try await send(changes)
            return try await fetchChanges(since: nil)
        }
    }

    private static func ensureZone() async throws {
        if UserDefaults.standard.bool(forKey: zoneReadyKey) { return }
        _ = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])
        UserDefaults.standard.set(true, forKey: zoneReadyKey)
    }

    private static func send(_ changes: [Change]) async throws {
        var saves: [Snapshot] = []
        var deletes: [CKRecord.ID] = []
        for change in changes {
            switch change {
            case .save(let snapshot): saves.append(snapshot)
            case .delete(let id): deletes.append(CKRecord.ID(recordName: id, zoneID: zoneID))
            }
        }
        var records: [CKRecord] = []
        if !saves.isEmpty {
            let existing = try await database.records(for: saves.map { CKRecord.ID(recordName: $0.id, zoneID: zoneID) })
            for snapshot in saves {
                let id = CKRecord.ID(recordName: snapshot.id, zoneID: zoneID)
                let record: CKRecord
                var updatedAt = snapshot.updatedAt
                var data = snapshot.data
                if case .success(let current)? = existing[id] {
                    let at = (current["updatedAt"] as? NSNumber)?.int64Value
                    let theirs = current.encryptedValues["data"] as? String
                    // Already there (the app and the extension both send the app's changes).
                    if let at, at == snapshot.updatedAt, theirs == snapshot.data { continue }
                    if let base = snapshot.base, let at, at > base, let theirs {
                        // Organizing's record made on a copy another device has changed since: that device's copy, with
                        // the names and merges turned down here added, newer than both (so it replaces this device's
                        // too); nothing to add to a newer copy, it just comes back with the changes.
                        let merged = rebased(theirs, snapshot.data) ?? theirs
                        if at > snapshot.updatedAt, merged == theirs { continue }
                        data = merged
                        updatedAt = max(at, snapshot.updatedAt) + 1
                    } else if let at, at >= snapshot.updatedAt {
                        // Another device already stored a newer copy: keep it, it comes back with the changes.
                        continue
                    }
                    record = current
                } else {
                    record = CKRecord(recordType: recordType, recordID: id)
                }
                record["updatedAt"] = updatedAt as NSNumber
                record.encryptedValues["data"] = data
                records.append(record)
            }
        }
        guard !records.isEmpty || !deletes.isEmpty else { return }
        // Newest-wins was checked above, so a save racing another device's doesn't need to fail.
        let (saved, deleted) = try await database.modifyRecords(saving: records, deleting: deletes, savePolicy: .changedKeys)
        for (_, result) in saved {
            if case .failure(let error) = result { throw error }
        }
        for (_, result) in deleted {
            if case .failure(let error) = result, (error as? CKError)?.code != .unknownItem { throw error }
        }
    }

    /// Another device's copy of a chat (`theirs`, its JSON) with what organizing's record in `ours` turned down: the
    /// names (`org.nm.no`, and the open name if it's one of them) and the merges (`org.mx`), at most 20 of each; nil
    /// when either isn't a chat, `theirs` itself when it has them all. The rest of the record is theirs: worked out on
    /// their copy (src/shared/threads.ts `withRefusals`).
    static func rebased(_ theirs: String, _ ours: String) -> String? {
        guard var their = (try? JSONSerialization.jsonObject(with: Data(theirs.utf8))) as? [String: Any],
              let our = (try? JSONSerialization.jsonObject(with: Data(ours.utf8))) as? [String: Any] else { return nil }
        let mine = our["org"] as? [String: Any]
        let myNo = ((mine?["nm"] as? [String: Any])?["no"] as? [Any] ?? []).compactMap { $0 as? String }
        let myMx = (mine?["mx"] as? [Any] ?? []).compactMap { $0 as? String }
        var added = false
        func union(_ a: [String], _ b: [String], caseless: Bool) -> [String] {
            var out = a
            for x in b where !out.contains(where: { caseless ? $0.lowercased() == x.lowercased() : $0 == x }) {
                out.append(x)
                added = true
            }
            return Array(out.suffix(20))
        }
        var org = their["org"] as? [String: Any] ?? ["n": 0, "k": ""]
        if !myNo.isEmpty {
            var nm = org["nm"] as? [String: Any] ?? ["k": ""]
            let no = union((nm["no"] as? [Any] ?? []).compactMap { $0 as? String }, myNo, caseless: true)
            nm["no"] = no
            if let t = nm["t"] as? String, no.contains(where: { $0.lowercased() == t.lowercased() }) { nm["t"] = nil }
            org["nm"] = nm
        }
        if !myMx.isEmpty { org["mx"] = union((org["mx"] as? [Any] ?? []).compactMap { $0 as? String }, myMx, caseless: false) }
        guard added else { return theirs }
        their["org"] = org
        guard let data = try? JSONSerialization.data(withJSONObject: their), let text = String(data: data, encoding: .utf8) else { return nil }
        return text
    }

    private static func fetchChanges(since encoded: String?) async throws -> SyncResult {
        do {
            return try await collectChanges(since: decode(encoded))
        } catch let error as CKError where error.code == .changeTokenExpired {
            return try await collectChanges(since: nil)
        }
    }

    private static func collectChanges(since start: CKServerChangeToken?) async throws -> SyncResult {
        var token = start
        var changed: [String: Snapshot] = [:]
        var deleted: Set<String> = []
        while true {
            let batch = try await database.recordZoneChanges(inZoneWith: zoneID, since: token)
            for (id, result) in batch.modificationResultsByID {
                guard case .success(let modification) = result, let snapshot = snapshot(modification.record) else { continue }
                changed[id.recordName] = snapshot
                deleted.remove(id.recordName)
            }
            for deletion in batch.deletions {
                deleted.insert(deletion.recordID.recordName)
                changed[deletion.recordID.recordName] = nil
            }
            token = batch.changeToken
            if !batch.moreComing { break }
        }
        return SyncResult(token: encode(token), changed: Array(changed.values), deleted: Array(deleted))
    }

    private static func snapshot(_ record: CKRecord) -> Snapshot? {
        guard let updatedAt = (record["updatedAt"] as? NSNumber)?.int64Value,
              let data = record.encryptedValues["data"] as? String else { return nil }
        return Snapshot(id: record.recordID.recordName, updatedAt: updatedAt, data: data)
    }

    private static func encode(_ token: CKServerChangeToken?) -> String? {
        guard let token, let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) else { return nil }
        return data.base64EncodedString()
    }

    private static func decode(_ string: String?) -> CKServerChangeToken? {
        guard let string, let data = Data(base64Encoded: string) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
    }
}
