import CloudKit
import Foundation

/// The running conversation in the user's private iCloud database, so a chat started on one
/// device continues on their others (same Apple Account). One record; the newest `updatedAt`
/// (ms, set by the extension when the conversation changes) wins. The chat itself is an
/// encrypted field: only the user's devices can read it, not Apple and not us.
enum ChatSync {
    static let containerIdentifier = "iCloud.com.contextflow.app"
    private static let recordType = "Conversation"
    private static let recordID = CKRecord.ID(recordName: "current")

    struct Snapshot {
        let updatedAt: Int64
        let data: String
    }

    enum Failure: Error {
        case noAccount
    }

    private static var database: CKDatabase {
        CKContainer(identifier: containerIdentifier).privateCloudDatabase
    }

    /// What iCloud has, or nil when nothing was stored yet.
    static func fetch() async throws -> Snapshot? {
        try await requireAccount()
        return try await currentRecord().flatMap(snapshot)
    }

    /// Stores the conversation unless iCloud already has a newer one; returns what iCloud has afterwards.
    static func store(_ incoming: Snapshot) async throws -> Snapshot {
        try await requireAccount()
        // A second try covers another device saving between our read and write.
        for attempt in 0..<2 {
            let record = try await currentRecord() ?? CKRecord(recordType: recordType, recordID: recordID)
            if let current = snapshot(record), current.updatedAt >= incoming.updatedAt { return current }
            record["updatedAt"] = incoming.updatedAt as NSNumber
            record.encryptedValues["data"] = incoming.data
            do {
                let (saved, _) = try await database.modifyRecords(saving: [record], deleting: [])
                if case .failure(let error) = saved[recordID] { throw error }
                return incoming
            } catch let error as CKError where error.code == .serverRecordChanged && attempt == 0 {
                continue
            }
        }
        return incoming
    }

    private static func requireAccount() async throws {
        let status = try await CKContainer(identifier: containerIdentifier).accountStatus()
        guard status == .available else { throw Failure.noAccount }
    }

    private static func currentRecord() async throws -> CKRecord? {
        do {
            return try await database.record(for: recordID)
        } catch let error as CKError where error.code == .unknownItem {
            return nil
        }
    }

    private static func snapshot(_ record: CKRecord) -> Snapshot? {
        guard let updatedAt = (record["updatedAt"] as? NSNumber)?.int64Value,
              let data = record.encryptedValues["data"] as? String else { return nil }
        return Snapshot(updatedAt: updatedAt, data: data)
    }
}
