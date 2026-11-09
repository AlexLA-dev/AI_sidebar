import AVFoundation
import CloudKit
import CryptoKit
import Foundation

/// Read aloud on the user's other devices (2.6, the owner: audio made once should play on every device without being
/// made again). Each part spoken is kept in the user's private iCloud database as AAC (mono, 24 kHz, 64 kbps: no
/// difference to the ear from the voice's own PCM, a sixth of its size), with the text written for the ear, so another
/// device plays it without asking our server. Nothing is kept on our server.
///
/// Zone "Speech". `SpeechPart`: recordName = the part's key (`key(voice:lang:text:)`, the same in the app and the panel),
/// `audio` (asset, .m4a; CloudKit encrypts assets), `seconds`, `expiresAt`. `SpeechText`: recordName = the key of the
/// text before writing it for the ear, `text` (encrypted, like the chats), `expiresAt`. Everything expires after 7 days, like the device's own copy; any device deletes what's
/// expired (`sweep`, at most once a day, at launch and when listening starts); "Delete all chats" deletes the zone
/// (`deleteAll`). It follows "Sync chats with iCloud": off, nothing is looked up or kept (what's there still expires).
/// No account, no connection, or slower than the wait: as if it weren't there.
enum SpeechSync {
    static let containerIdentifier = ChatSync.containerIdentifier
    static let zoneID = CKRecordZone.ID(zoneName: "Speech", ownerName: CKCurrentUserDefaultName)
    static let partType = "SpeechPart"
    static let textType = "SpeechText"
    static let keepFor: TimeInterval = 7 * 86_400
    /// The voice's sample rate and the AAC rate (see shots/ultra-26/aac-ab: 64 kbps is the encoder's best at 24 kHz).
    static let sampleRate = 24_000.0
    static let bitRate = 64_000
    private static let zoneReadyKey = "cf.speechZoneReady"
    private static let sweptKey = "cf.speechSweptAt"

    /// The user's choice ("Sync chats with iCloud", the extension's setting through the App Group; on by default).
    static var on: Bool {
        SharedDefaults.shared.readSettings()?.settings["syncChats"] as? Bool ?? true
    }

    private static var database: CKDatabase {
        CKContainer(identifier: containerIdentifier).privateCloudDatabase
    }

    /// A part's key, the same on every device: sha256 of "speech|v1|<voice>|<language>|<text>" (src/shared/speech.ts
    /// syncKey). The voice is the server's (X-CF-Voice), so a new voice never plays an old recording.
    static func key(voice: String, lang: String, text: String) -> String {
        let primary = lang.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? ""
        return SHA256.hash(data: Data("speech|v1|\(voice)|\(primary)|\(text)".utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Parts

    /// A part's 24 kHz 16-bit PCM from iCloud, or nil (not there, no account, no connection, or not within `wait`).
    static func fetchPart(_ key: String, wait: TimeInterval = 2) async -> Data? {
        guard let record = await fetch(CKRecord.ID(recordName: key, zoneID: zoneID), wait: wait),
              (record["expiresAt"] as? Date ?? .distantPast) > Date(),
              let url = (record["audio"] as? CKAsset)?.fileURL else { return nil }
        return try? pcm(fromAAC: url)
    }

    /// The part as AAC (for the panel, which decodes it itself), or nil.
    static func fetchPartAAC(_ key: String, wait: TimeInterval = 2) async -> Data? {
        guard let record = await fetch(CKRecord.ID(recordName: key, zoneID: zoneID), wait: wait),
              (record["expiresAt"] as? Date ?? .distantPast) > Date(),
              let url = (record["audio"] as? CKAsset)?.fileURL else { return nil }
        return try? Data(contentsOf: url)
    }

    /// Keeps a part (its PCM, encoded here) for the user's other devices. Quietly does nothing without an account.
    static func savePart(_ key: String, pcm: Data) async {
        guard pcm.count > 4_800, on, await available() else { return }
        guard let file = try? aac(fromPCM: pcm) else { return }
        defer { try? FileManager.default.removeItem(at: file) }
        let record = CKRecord(recordType: partType, recordID: CKRecord.ID(recordName: key, zoneID: zoneID))
        record["audio"] = CKAsset(fileURL: file)
        record["seconds"] = Double(pcm.count / 2) / sampleRate
        record["expiresAt"] = Date().addingTimeInterval(keepFor)
        await save(record)
    }

    // MARK: Parts waiting to go up (the panel's, build 92)

    private static var pendingFolder: URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName) else { return nil }
        let folder = base.appendingPathComponent("SpeechUp/pending", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// A part the panel made, waiting to be encoded and kept in iCloud (moved, not copied: no time on the reply's path).
    static func queueUpload(_ key: String, from file: URL) {
        guard key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, let folder = pendingFolder else { return }
        let target = folder.appendingPathComponent("\(key).pcm")
        try? FileManager.default.removeItem(at: target)
        try? FileManager.default.moveItem(at: file, to: target)
    }

    /// Encodes and keeps the waiting parts (at most `limit` a time), oldest first; with sync off they're dropped, and
    /// nothing waits more than 7 days. The extension after a reply, the app when it runs.
    static func uploadPending(limit: Int = 10) async {
        guard let folder = pendingFolder,
              let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast) }
            .sorted { $0.1 < $1.1 }
        guard !dated.isEmpty else { return }
        let ready = on ? await available() : false
        for (file, at) in dated.prefix(limit) {
            if Date().timeIntervalSince(at) > keepFor || !on {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            guard ready, let pcm = try? Data(contentsOf: file) else { continue }
            await savePart(file.deletingPathExtension().lastPathComponent, pcm: pcm)
            try? FileManager.default.removeItem(at: file)
        }
    }

    // MARK: Texts written for the ear

    /// The text written for the ear for this input, if a device of the user's wrote it in the last 7 days.
    static func fetchText(_ key: String, wait: TimeInterval = 1.5) async -> String? {
        guard let record = await fetch(CKRecord.ID(recordName: key, zoneID: zoneID), wait: wait),
              (record["expiresAt"] as? Date ?? .distantPast) > Date() else { return nil }
        return record.encryptedValues["text"] as? String
    }

    static func saveText(_ key: String, text: String) async {
        guard !text.isEmpty, on, await available() else { return }
        let record = CKRecord(recordType: textType, recordID: CKRecord.ID(recordName: key, zoneID: zoneID))
        // Encrypted like the chats (ChatSync): only the user's devices can read what a page or an answer said.
        record.encryptedValues["text"] = text
        record["expiresAt"] = Date().addingTimeInterval(keepFor)
        await save(record)
    }

    // MARK: Expiry

    /// Deletes this account's expired parts and texts (at most once a day, from any device).
    static func sweep() async {
        let last = UserDefaults.standard.double(forKey: sweptKey)
        guard Date().timeIntervalSince1970 - last > 86_400, await available() else { return }
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: sweptKey)
        for type in [partType, textType] {
            let query = CKQuery(recordType: type, predicate: NSPredicate(format: "expiresAt < %@", Date() as NSDate))
            guard let found = try? await database.records(matching: query, inZoneWith: zoneID, desiredKeys: [], resultsLimit: 200) else { continue }
            let ids = found.matchResults.map(\.0)
            if !ids.isEmpty { _ = try? await database.modifyRecords(saving: [], deleting: ids) }
        }
    }

    /// "Delete all chats": everything read aloud goes from iCloud too (the zone, on every device), whatever the setting.
    static func deleteAll() async {
        guard await available() else { return }
        _ = try? await database.modifyRecordZones(saving: [], deleting: [zoneID])
        UserDefaults.standard.set(false, forKey: zoneReadyKey)
        if let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName)?.appendingPathComponent("SpeechUp", isDirectory: true) {
            try? FileManager.default.removeItem(at: folder)
        }
    }

    // MARK: iCloud

    /// Asked of iCloud at most every two minutes (build 92: each part asked again, and a first sound waited on it).
    nonisolated(unsafe) private static var known: (available: Bool, at: Date)?

    private static func available() async -> Bool {
        if let known, Date().timeIntervalSince(known.at) < 120 { return known.available }
        let available = (try? await CKContainer(identifier: containerIdentifier).accountStatus()) == .available
        known = (available, Date())
        return available
    }

    private static func ensureZone() async throws {
        if UserDefaults.standard.bool(forKey: zoneReadyKey) { return }
        _ = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])
        UserDefaults.standard.set(true, forKey: zoneReadyKey)
    }

    /// One record by id, within `wait` seconds (the voice shouldn't wait on iCloud), else nil.
    private static func fetch(_ id: CKRecord.ID, wait: TimeInterval) async -> CKRecord? {
        await withTaskGroup(of: CKRecord?.self) { group in
            group.addTask {
                guard on, await available() else { return nil }
                return try? await database.record(for: id)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private static func save(_ record: CKRecord) async {
        do {
            try await ensureZone()
            // Another device may have kept the same part a moment ago: either copy is the same audio.
            _ = try await database.modifyRecords(saving: [record], deleting: [], savePolicy: .allKeys, atomically: false)
        } catch let error as CKError where [.zoneNotFound, .userDeletedZone].contains(error.code) {
            UserDefaults.standard.set(false, forKey: zoneReadyKey)
            try? await ensureZone()
            _ = try? await database.modifyRecords(saving: [record], deleting: [], savePolicy: .allKeys, atomically: false)
        } catch {
            // Offline or over the quota: the device keeps its own copy; nothing else to do.
        }
    }

    // MARK: AAC

    /// 24 kHz 16-bit mono PCM → an .m4a file (AAC-LC, 64 kbps) in the temporary folder.
    static func aac(fromPCM pcm: Data) throws -> URL {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { throw CocoaError(.fileWriteUnknown) }
        buffer.frameLength = frames
        pcm.withUnsafeBytes { raw in
            buffer.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: Int(frames))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: bitRate
        ]
        do {
            let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true)
            try file.write(from: buffer)
        }
        return url
    }

    /// An .m4a file → 24 kHz 16-bit mono PCM (little-endian), as the server sends it.
    static func pcm(fromAAC url: URL) throws -> Data {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true)
        guard file.processingFormat.sampleRate == sampleRate, file.processingFormat.channelCount == 1,
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        try file.read(into: buffer)
        return Data(bytes: buffer.int16ChannelData![0], count: Int(buffer.frameLength) * 2)
    }

    #if DEBUG
    /// Debug builds (-CFDebugSpeechSync YES): the key for a known input (src tests expect 113db5a0…), an AAC round
    /// trip of a tone, and how quickly a part that isn't there gives up. In the log as "[cf-sync]".
    static func debugSelfCheck() async {
        NSLog("[cf-sync] key %@", key(voice: "Kore", lang: "en-US", text: "Hello there."))
        var pcm = Data(capacity: 96_000)
        for i in 0..<48_000 {
            let v = Int16(sin(Double(i) / sampleRate * 2 * .pi * 330) * 8_000).littleEndian
            withUnsafeBytes(of: v) { pcm.append(contentsOf: $0) }
        }
        do {
            let file = try aac(fromPCM: pcm)
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? -1
            let back = try self.pcm(fromAAC: file)
            try? FileManager.default.removeItem(at: file)
            var peak = 0
            back.withUnsafeBytes { raw in
                for v in raw.bindMemory(to: Int16.self) { peak = max(peak, abs(Int(Int16(littleEndian: v)))) }
            }
            NSLog("[cf-sync] aac %d bytes for %d bytes of pcm (2 s); back %d bytes, peak %d (in 8000)", size, pcm.count, back.count, peak)
        } catch {
            NSLog("[cf-sync] aac failed: %@", String(describing: error))
        }
        let started = Date()
        let status = (try? await CKContainer(identifier: containerIdentifier).accountStatus()).map { String(describing: $0.rawValue) } ?? "error"
        let miss = await fetchPart(String(repeating: "0", count: 64), wait: 2)
        NSLog("[cf-sync] account %@, a missing part: %@ after %d ms", status, miss == nil ? "nil" : "data", Int(Date().timeIntervalSince(started) * 1000))
    }
    #endif
}
