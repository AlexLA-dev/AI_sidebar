import CloudKit
import Foundation

/// Pictures of pages kept with notes (2.7, «Снимок страницы в заметке», src/shared/shots.ts): one JPEG per note, in the
/// App Group (`Shots/<id>.jpg`) and, when chats sync with iCloud, in the person's private database in a zone of its own,
/// "Shots" (the chats' record type and fields: no schema change; the picture's base64 in parts of 192K characters, one
/// record each, `<id>.<i>`). Apart from the chats on purpose: the app reads every chat record, and a picture is opened
/// only when someone taps it. The panel sends a picture in parts and asks for it in parts (as Tips clips): the bridge
/// takes small messages. Only the person's own devices can read it (an encrypted field); nothing goes to our server.
nonisolated enum ShotStore {
    /// The chats' container (ChatSync.containerIdentifier).
    private static let container = "iCloud.com.contextflow.app"
    private static let zoneID = CKRecordZone.ID(zoneName: "Shots", ownerName: CKCurrentUserDefaultName)
    private static let recordType = "Conversation"
    private static let zoneReadyKey = "cf.shotsZoneReady"
    /// Pictures saved here whose upload didn't go through (offline): tried again with the next call.
    private static let pendingKey = "cf.shotsPending"
    /// Bytes per part going back to the panel: a multiple of 3, so the parts' base64 joins as is.
    static let readLength = 262_143

    private static var database: CKDatabase {
        CKContainer(identifier: container).privateCloudDatabase
    }

    static func validId(_ id: String?) -> String? {
        guard let id, id.range(of: "^[A-Za-z0-9_-]{6,64}$", options: .regularExpression) != nil else { return nil }
        return id
    }

    private static var folder: URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName) else { return nil }
        let folder = base.appendingPathComponent("Shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private static func file(_ id: String) -> URL? { folder?.appendingPathComponent("\(id).jpg") }
    private static func partsFile(_ id: String) -> URL? { folder?.appendingPathComponent("\(id).incoming") }
    private static func recordID(_ id: String, _ i: Int) -> CKRecord.ID { CKRecord.ID(recordName: "\(id).\(i)", zoneID: zoneID) }

    // MARK: From the panel

    /// A part of a picture (base64 text, in order). The last one writes the picture here and, with `cloud`, keeps it in
    /// iCloud (waiting for the next call when that fails). False when the parts don't add up to a JPEG.
    static func put(id: String, part: Int, of count: Int, data: String, cloud: Bool) async -> Bool {
        guard let incoming = partsFile(id), count > 0, part >= 0, part < count else { return false }
        if part == 0 { try? FileManager.default.removeItem(at: incoming) }
        guard let bytes = data.data(using: .utf8) else { return false }
        if FileManager.default.fileExists(atPath: incoming.path), let handle = try? FileHandle(forWritingTo: incoming) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: bytes)
        } else {
            guard (try? bytes.write(to: incoming)) != nil else { return false }
        }
        guard part == count - 1 else { return true }
        defer { try? FileManager.default.removeItem(at: incoming) }
        guard let text = try? String(contentsOf: incoming, encoding: .utf8), let jpeg = Data(base64Encoded: text),
              jpeg.starts(with: [0xFF, 0xD8]), let dest = file(id), (try? jpeg.write(to: dest, options: .atomic)) != nil else { return false }
        guard cloud else { return true }
        if !(await upload(id, text)) { markPending(id, true) }
        await flushPending(except: id)
        return true
    }

    /// The picture's bytes from `offset` (at most `readLength`) and its whole size: from here, else from iCloud (made on
    /// another device), kept here then.
    static func read(id: String, parts: Int, offset: Int) async -> (data: Data, total: Int)? {
        guard let path = file(id) else { return nil }
        if !FileManager.default.fileExists(atPath: path.path) {
            guard parts > 0, parts <= 400, let jpeg = await download(id, parts) else { return nil }
            try? jpeg.write(to: path, options: .atomic)
        }
        guard let handle = try? FileHandle(forReadingFrom: path) else { return nil }
        defer { try? handle.close() }
        let total = Int((try? handle.seekToEnd()) ?? 0)
        guard offset >= 0, offset < total else { return nil }
        try? handle.seek(toOffset: UInt64(offset))
        guard let data = try? handle.read(upToCount: readLength) else { return nil }
        return (data, total)
    }

    /// The picture gone, here and in iCloud (a week after no note had it: the panel's sweep).
    static func delete(id: String, parts: Int) async {
        if let path = file(id) { try? FileManager.default.removeItem(at: path) }
        markPending(id, false)
        guard parts > 0, parts <= 400, await accountReady() else { return }
        _ = try? await database.modifyRecords(saving: [], deleting: (0..<parts).map { recordID(id, $0) })
    }

    // MARK: iCloud

    private static func accountReady() async -> Bool {
        guard (try? await CKContainer(identifier: container).accountStatus()) == .available else { return false }
        if UserDefaults.standard.bool(forKey: zoneReadyKey) { return true }
        guard (try? await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])) != nil else { return false }
        UserDefaults.standard.set(true, forKey: zoneReadyKey)
        return true
    }

    private static func upload(_ id: String, _ base64: String) async -> Bool {
        guard await accountReady() else { return false }
        let size = 192 * 1024
        var records: [CKRecord] = []
        var start = base64.startIndex
        var i = 0
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        while start < base64.endIndex {
            let end = base64.index(start, offsetBy: size, limitedBy: base64.endIndex) ?? base64.endIndex
            let record = CKRecord(recordType: recordType, recordID: recordID(id, i))
            record["updatedAt"] = now as NSNumber
            record.encryptedValues["data"] = String(base64[start..<end])
            records.append(record)
            start = end
            i += 1
        }
        do {
            let (saved, _) = try await database.modifyRecords(saving: records, deleting: [], savePolicy: .allKeys)
            return saved.values.allSatisfy { if case .success = $0 { return true } else { return false } }
        } catch {
            return false
        }
    }

    private static func download(_ id: String, _ parts: Int) async -> Data? {
        guard await accountReady() else { return nil }
        let ids = (0..<parts).map { recordID(id, $0) }
        guard let found = try? await database.records(for: ids) else { return nil }
        var text = ""
        for rid in ids {
            guard case .success(let record)? = found[rid], let part = record.encryptedValues["data"] as? String else { return nil }
            text += part
        }
        return Data(base64Encoded: text)
    }

    private static func markPending(_ id: String, _ on: Bool) {
        var list = Set(UserDefaults.standard.stringArray(forKey: pendingKey) ?? [])
        if on { list.insert(id) } else { list.remove(id) }
        UserDefaults.standard.set(Array(list.prefix(200)), forKey: pendingKey)
    }

    /// Uploads that waited (offline before), from the pictures kept here.
    private static func flushPending(except: String) async {
        for id in (UserDefaults.standard.stringArray(forKey: pendingKey) ?? []).prefix(3) where id != except {
            guard let path = file(id), let jpeg = try? Data(contentsOf: path) else {
                markPending(id, false)
                continue
            }
            if await upload(id, jpeg.base64EncodedString()) { markPending(id, false) }
        }
    }
}
