import AVFoundation
import Combine
import CryptoKit
import MediaPlayer
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Read aloud (2.6, Ultra), handed over by the Safari panel on iPhone and iPad: WebKit stops a page's audio when the
/// screen locks, so the panel puts the text in the App Group and opens contextflow://listen?id=…. The app asks our
/// server for the speech part by part (/api/v2/speak: 24 kHz 16-bit PCM), plays it with the screen locked (background
/// audio), shows it on the lock screen (Now Playing, play/pause, 15 s back and ahead) and keeps each part on the
/// device, so playing it again costs nothing. Out of the week's minutes, or offline, the best Apple voice installed for
/// the language reads the rest.
struct ListenRequest: Equatable {
    let id: String
    /// The panel's parts (its own rules): what's read when the text can't be written for the ear.
    let parts: [String]
    let lang: String
    let what: String
    let title: String
    let url: URL?
    /// The raw text, and whether to write it for the ear first (/api/v2/speak-script: tables, lists, a page…).
    var text: String = ""
    var script: Bool = false
}

@MainActor
final class ListenPlayer: NSObject, ObservableObject {
    static let shared = ListenPlayer()

    enum State: Equatable {
        case idle, loading, playing, paused, ended
        /// Not Ultra (the server said so): what Ultra adds.
        case ultraOnly
        /// The week's minutes are used up (minutes, the day they come back); Apple's voice reads the rest.
        case limit(minutes: Int, resets: String)
        /// No connection or the server failed: Apple's voice reads the rest.
        case appleVoice
        case failed(String)
    }

    @Published private(set) var request: ListenRequest?
    @Published private(set) var state: State = .idle
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var visible = false

    private static let rate = 24_000.0
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: ListenPlayer.rate, channels: 1, interleaved: false)!
    private var samples: [Float] = []
    private var scheduledUpTo = 0
    private var startSample = 0
    private var fetchedAll = false
    private var fetchTask: Task<Void, Never>?
    private var timer: Timer?
    private var wired = false
    private let synth = AVSpeechSynthesizer()
    /// What Apple's voice reads when the server can't (the week's minutes ran out, or the connection did).
    private var appleText: String?
    private var appleStarted = false

    // MARK: Opening

    /// Debug builds: `-CFDebugListen "<text>"` plays that text as if Safari had handed it over (simulator checks).
    func debugStartIfAsked() {
        #if DEBUG
        // The environment keeps line breaks (a Markdown table); a launch argument stops at the first one.
        let given = ProcessInfo.processInfo.environment["CF_DEBUG_LISTEN"] ?? UserDefaults.standard.string(forKey: "CFDebugListen")
        guard request == nil, let text = given, !text.isEmpty else { return }
        let lang = UserDefaults.standard.string(forKey: "CFDebugListenLang") ?? "en"
        // -CFDebugListenScript YES: written for the ear first, as a page or an answer with a table would be.
        start(ListenRequest(id: "debug", parts: Self.sentenceParts(text), lang: lang, what: "page", title: "How electric trains save energy", url: URL(string: "https://example.com/trains"),
                            text: text, script: UserDefaults.standard.bool(forKey: "CFDebugListenScript")))
        #endif
    }

    /// Sentences gathered into parts like the panel's (src/shared/speech.ts): a short first one, then up to 1400.
    nonisolated static func sentenceParts(_ text: String, first: Bool = true) -> [String] {
        var parts: [String] = []
        var current = ""
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { sentence, _, _, _ in
            guard let sentence else { return }
            let limit = parts.isEmpty && first ? 240 : 1400
            if !current.isEmpty, current.count + sentence.count > limit {
                parts.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            }
            current += sentence
        }
        if !current.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(current.trimmingCharacters(in: .whitespaces)) }
        return parts
    }

    /// A long text for /api/v2/speak-script in pieces of at most 5000 characters, cut between paragraphs.
    nonisolated static func scriptChunks(_ text: String, size: Int = 5000) -> [String] {
        var chunks: [String] = []
        var current = ""
        for paragraph in text.components(separatedBy: "\n\n") {
            let pieces = paragraph.utf16.count > size ? sentenceParts(paragraph, first: false) : [paragraph]
            for piece in pieces {
                if !current.isEmpty, current.utf16.count + piece.utf16.count + 2 > size {
                    chunks.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
                    current = ""
                }
                current += (current.isEmpty ? "" : "\n\n") + piece
            }
        }
        if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { chunks.append(current.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return chunks
    }

    func open(_ url: URL) {
        let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value ?? ""
        if let request, request.id == id, state != .idle {
            visible = true
            return
        }
        guard let stored = SharedDefaults.shared.readListenRequest(id), let parts = stored["parts"] as? [String], !parts.isEmpty else {
            state = .failed(String(localized: "This text is no longer here. Tap Listen in Safari again."))
            visible = true
            return
        }
        start(ListenRequest(
            id: id,
            parts: parts,
            lang: stored["lang"] as? String ?? "",
            what: stored["what"] as? String ?? "answer",
            title: (stored["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "ContextFlow"),
            url: (stored["url"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) },
            text: stored["text"] as? String ?? "",
            script: stored["script"] as? Bool ?? false
        ))
    }

    func start(_ request: ListenRequest) {
        stop()
        self.request = request
        visible = true
        duration = Self.estimate(request.parts.joined(separator: " "))
        state = .loading
        wire()
        activateSession()
        if !engine.isRunning { try? engine.start() }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let player = self else { return }
            MainActor.assumeIsolated { player.tick() }
        }
        fetchTask = Task { await fetchAll(request) }
        updateNowPlaying()
    }

    func dismiss() {
        visible = false
        // Closing the sheet doesn't stop it: it plays on, with the lock screen's controls. Stopped or done, it goes.
        if state == .ended || state == .ultraOnly || state == .idle { stop() }
        if case .failed = state { stop() }
    }

    func stop() {
        fetchTask?.cancel()
        fetchTask = nil
        timer?.invalidate()
        timer = nil
        node.stop()
        synth.stopSpeaking(at: .immediate)
        samples.removeAll()
        scheduledUpTo = 0
        startSample = 0
        fetchedAll = false
        appleText = nil
        pendingReason = nil
        appleStarted = false
        elapsed = 0
        state = .idle
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: Controls

    func togglePause() {
        switch state {
        case .playing: pause()
        case .paused: play()
        case .ended: seek(to: 0)
        default:
            guard appleStarted else { return }
            if synth.isPaused { synth.continueSpeaking() } else { synth.pauseSpeaking(at: .word) }
        }
    }

    func play() {
        guard !samples.isEmpty else { return }
        activateSession()
        if !engine.isRunning { try? engine.start() }
        node.play()
        state = .playing
        updateNowPlaying()
    }

    func pause() {
        node.pause()
        if state == .playing { state = .paused }
        updateNowPlaying()
    }

    func skip(_ seconds: Double) {
        seek(to: elapsed + seconds)
    }

    func seek(to seconds: Double) {
        guard !samples.isEmpty else { return }
        let wasPlaying = state == .playing || state == .ended
        node.stop()
        startSample = max(0, min(samples.count - 1, Int(seconds * Self.rate)))
        scheduledUpTo = startSample
        elapsed = Double(startSample) / Self.rate
        scheduleMore()
        if wasPlaying { play() } else { updateNowPlaying() }
    }

    /// Back to the page in Safari ("◀ Safari" in the status bar does the same while it's there).
    func backToSafari() {
        guard let url = request?.url else { return }
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    // MARK: Speech from the server

    private func fetchAll(_ request: ListenRequest) async {
        if request.script, !request.text.isEmpty { return await speakWritten(request) }
        for (index, part) in request.parts.enumerated() {
            if Task.isCancelled { return }
            switch await speakPart(part, index: index, request: request) {
            case .ok: continue
            case .stop: return
            case .fallBack(let reason): return fallBack(text: request.parts[index...].joined(separator: " "), reason)
            }
        }
        fetchedAll = true
    }

    /// Written for the ear first: the writer streams parts in, the voice takes them in order as they come.
    private func speakWritten(_ request: ListenRequest) async {
        let (parts, continuation) = AsyncStream<String>.makeStream()
        let writer = Task { await self.write(request, into: continuation) }
        defer { writer.cancel() }
        var iterator = parts.makeAsyncIterator()
        var index = 0
        while let part = await iterator.next() {
            if Task.isCancelled { return }
            switch await speakPart(part, index: index, request: request) {
            case .ok: index += 1
            case .stop: return
            case .fallBack(let reason):
                // Apple's voice reads the rest of what was written (it's quick to finish).
                var rest = [part]
                while let more = await iterator.next() { rest.append(more) }
                return fallBack(text: rest.joined(separator: " "), reason)
            }
        }
        fetchedAll = true
    }

    /// The text for listening, chunk by chunk, each part handed on as soon as it's complete; kept for 7 days.
    private func write(_ request: ListenRequest, into out: AsyncStream<String>.Continuation) async {
        defer { out.finish() }
        let chunks = Self.scriptChunks(request.text)
        var first = true
        for (index, chunk) in chunks.enumerated() {
            if Task.isCancelled { return }
            let splitter = PartSplitter(first: first)
            let give = { (parts: [String]) in
                for part in parts { out.yield(part) }
                if !parts.isEmpty { first = false }
            }
            let key = "script|\(request.what)|" + Self.cacheKey(chunk, request.lang)
            if let kept = SpeechCache.read(key), let script = String(data: kept, encoding: .utf8) {
                give(splitter.push(script))
                give(splitter.end())
                continue
            }
            var script = ""
            do {
                let urlRequest = try ChatAI.scriptRequest(text: chunk, what: request.what, lang: request.lang)
                for try await piece in Self.textStream(urlRequest) {
                    script += piece
                    give(splitter.push(piece))
                }
                give(splitter.end())
                if !script.isEmpty { SpeechCache.write(key, Data(script.utf8)) }
            } catch {
                if Task.isCancelled { return }
                if !script.isEmpty {
                    give(splitter.end())
                } else if index == 0 && chunks.count == 1 {
                    // Nothing written: the panel's own parts (its rules), as before this was written for the ear.
                    give(request.parts)
                } else {
                    give(Self.sentenceParts(chunk, first: first))
                }
            }
        }
    }

    private enum Spoken {
        case ok, stop
        case fallBack(State)
    }

    /// One part to speech, from the device's copy when there is one.
    private func speakPart(_ part: String, index: Int, request: ListenRequest) async -> Spoken {
        let key = Self.cacheKey(part, request.lang)
        if let cached = SpeechCache.read(key) {
            append(cached)
            return .ok
        }
        guard let urlRequest = try? ChatAI.speechRequest(text: part, lang: request.lang, what: request.what, part: index, parts: max(request.parts.count, index + 1)) else {
            return .fallBack(.appleVoice)
        }
        let outcome = await Self.download(urlRequest) { [weak self] chunk in
            await self?.append(chunk)
        }
        if Task.isCancelled { return .stop }
        switch outcome {
        case .done(let all):
            SpeechCache.write(key, all)
            return .ok
        case .refused(let status, let body):
            let code = body["code"] as? String
            if status == 403 || code == "ULTRA_ONLY" {
                if samples.isEmpty {
                    state = .ultraOnly
                    return .stop
                }
                return .fallBack(.appleVoice)
            }
            if code == "LIMIT_REACHED" {
                let usage = body["usage"] as? [String: Any]
                let minutes = (usage?["limit"] as? Int ?? 0) / 60
                let resets = (usage?["resetsAt"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
                    .map { $0.formatted(.dateTime.weekday(.wide)) } ?? ""
                return .fallBack(.limit(minutes: minutes, resets: resets))
            }
            return .fallBack(.appleVoice)
        case .failed:
            return .fallBack(.appleVoice)
        }
    }

    private enum ScriptError: Error {
        case status(Int)
    }

    /// /api/v2/speak-script's text as it streams, in pieces of whole characters (off the main thread).
    nonisolated private static func textStream(_ request: URLRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else { throw ScriptError.status(status) }
                    var buffer = Data()
                    for try await byte in bytes {
                        buffer.append(byte)
                        // At a sentence's end or every few dozen bytes; a character cut in two waits for its rest.
                        if byte == 0x2E || byte == 0x0A || buffer.count >= 48, let text = String(data: buffer, encoding: .utf8) {
                            continuation.yield(text)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty, let text = String(data: buffer, encoding: .utf8) { continuation.yield(text) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private enum Download {
        case done(Data)
        case refused(Int, [String: Any])
        case failed
    }

    /// One part, passed on in pieces of whole samples as it comes (off the main thread).
    nonisolated private static func download(_ request: URLRequest, onChunk: @escaping @Sendable (Data) async -> Void) async -> Download {
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                var body = Data()
                for try await byte in bytes { body.append(byte) }
                return .refused(status, (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:])
            }
            var all = Data()
            var pending = Data()
            pending.reserveCapacity(9_600)
            for try await byte in bytes {
                pending.append(byte)
                if pending.count >= 9_600 {
                    all.append(pending)
                    await onChunk(pending)
                    pending.removeAll(keepingCapacity: true)
                }
            }
            let whole = pending.count - pending.count % 2
            if whole > 0 {
                let rest = pending.prefix(whole)
                all.append(rest)
                await onChunk(Data(rest))
            }
            return .done(all)
        } catch {
            return .failed
        }
    }

    private func append(_ pcm: Data) {
        let count = pcm.count / 2
        guard count > 0 else { return }
        pcm.withUnsafeBytes { raw in
            let values = raw.bindMemory(to: Int16.self)
            samples.reserveCapacity(samples.count + count)
            for i in 0..<count { samples.append(Float(Int16(littleEndian: values[i])) / 32_768) }
        }
        duration = max(duration, Double(samples.count) / Self.rate)
        scheduleMore()
        // The first sound: start (a quarter second in hand, so it doesn't stutter).
        if state == .loading, samples.count > Int(Self.rate * 0.25) { play() }
    }

    private func scheduleMore() {
        while scheduledUpTo < samples.count {
            let end = min(samples.count, scheduledUpTo + Int(Self.rate))
            let frames = AVAudioFrameCount(end - scheduledUpTo)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let channel = buffer.floatChannelData?[0] else { return }
            buffer.frameLength = frames
            samples.withUnsafeBufferPointer { source in
                channel.update(from: source.baseAddress!.advanced(by: scheduledUpTo), count: Int(frames))
            }
            node.scheduleBuffer(buffer, completionHandler: nil)
            scheduledUpTo = end
        }
    }

    private func fallBack(text: String, _ reason: State) {
        appleText = text
        if samples.isEmpty {
            state = reason
            speakWithApple()
        } else {
            // What came from the server plays first; Apple's voice follows (tick).
            pendingReason = reason
        }
    }

    private var pendingReason: State?

    private func tick() {
        guard request != nil else { return }
        if !samples.isEmpty, node.isPlaying, let nodeTime = node.lastRenderTime, let playerTime = node.playerTime(forNodeTime: nodeTime) {
            elapsed = min(Double(samples.count) / Self.rate, Double(startSample) / Self.rate + Double(playerTime.sampleTime) / playerTime.sampleRate)
        }
        let drained = !samples.isEmpty && elapsed >= Double(samples.count) / Self.rate - 0.05
        if drained, state == .playing {
            if fetchedAll {
                node.pause()
                state = .ended
            } else if let reason = pendingReason, appleText != nil {
                pendingReason = nil
                node.pause()
                state = reason
                speakWithApple()
            }
        }
        updateNowPlaying()
    }

    // MARK: Apple's voice (out of minutes, offline)

    private func speakWithApple() {
        guard let request, let text = appleText, !text.isEmpty, !appleStarted else { return }
        appleStarted = true
        activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestVoice(request.lang)
        synth.speak(utterance)
    }

    /// The best voice installed for the language: premium, then enhanced, then the default one.
    static func bestVoice(_ lang: String) -> AVSpeechSynthesisVoice? {
        let code = lang.isEmpty ? Locale.current.identifier : lang
        let primary = code.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? code
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(primary) }
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            switch v.quality {
            case .premium: return 3
            case .enhanced: return 2
            default: return 1
            }
        }
        return voices.max { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: code)
    }

    // MARK: Lock screen and audio session

    private func activateSession() {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [])
        try? session.setActive(true)
        #endif
    }

    private func wire() {
        guard !wired else { return }
        wired = true
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.play() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.togglePause() }
            return .success
        }
        center.skipForwardCommand.preferredIntervals = [15]
        center.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.skip(15) }
            return .success
        }
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.skip(-15) }
            return .success
        }
        #if os(iOS)
        // A call or another app's audio: pause; headphones out: pause (the usual iOS manners).
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            guard type == .began, let player = self else { return }
            MainActor.assumeIsolated { player.pause() }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            guard reason == .oldDeviceUnavailable, let player = self else { return }
            MainActor.assumeIsolated { player.pause() }
        }
        #endif
    }

    private func updateNowPlaying() {
        guard let request else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: request.title,
            MPMediaItemPropertyArtist: "ContextFlow",
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0
        ]
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        #if os(macOS)
        MPNowPlayingInfoCenter.default().playbackState = state == .playing ? .playing : .paused
        #endif
    }

    // MARK: Helpers

    /// About 14 characters a second (src/shared/speech.ts speechSeconds).
    static func estimate(_ text: String) -> Double {
        var units = 0.0
        for scalar in text.unicodeScalars {
            let c = scalar.value
            if (0x3040...0x30FF).contains(c) || (0x3400...0x9FFF).contains(c) || (0xF900...0xFAFF).contains(c) { units += 14.0 / 5 }
            else if (0xAC00...0xD7AF).contains(c) { units += 14.0 / 6 }
            else { units += 1 }
        }
        return max(1, (units / 14).rounded(.up))
    }

    static func cacheKey(_ text: String, _ lang: String) -> String {
        SHA256.hash(data: Data("v1|\(lang)|\(text)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// The parts already spoken and the texts written for the ear, in Caches (the system may clear them; then they're asked
/// for again): about 25 minutes of audio, nothing older than 7 days; gone with the chats ("Delete all chats").
enum SpeechCache {
    private static let limit = 75 * 1024 * 1024
    private static let maxAge: TimeInterval = 7 * 86_400

    private static var folder: URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let folder = caches.appendingPathComponent("Listen", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    static func read(_ key: String) -> Data? {
        guard let file = folder?.appendingPathComponent("\(name(key)).pcm"), let data = try? Data(contentsOf: file), !data.isEmpty else { return nil }
        let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        guard Date().timeIntervalSince(written) < maxAge else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        return data
    }

    /// "Delete all chats": everything read aloud goes.
    static func clear() {
        guard let folder, let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        for file in files { try? FileManager.default.removeItem(at: file) }
    }

    /// File names from keys ("script|page|<hash>" has bars).
    private static func name(_ key: String) -> String {
        key.replacingOccurrences(of: "|", with: "-")
    }

    static func write(_ key: String, _ data: Data) {
        guard let folder, !data.isEmpty else { return }
        try? data.write(to: folder.appendingPathComponent("\(name(key)).pcm"), options: .atomic)
        // Over the limit: the parts played longest ago go.
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys) else { return }
        let rows = files.compactMap { url -> (URL, Date, Int)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }.sorted { $0.1 > $1.1 }
        var total = 0
        for row in rows {
            total += row.2
            if total > limit || Date().timeIntervalSince(row.1) > maxAge { try? FileManager.default.removeItem(at: row.0) }
        }
    }
}

/// The player over the app while something handed over from Safari plays.
struct ListenView: View {
    @ObservedObject var player: ListenPlayer
    let openPlans: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            HStack {
                if player.request?.url != nil {
                    Button { player.backToSafari() } label: {
                        Label("Back to Safari", systemImage: "chevron.backward")
                    }
                    .accessibilityIdentifier("listen.safari")
                }
                Spacer()
                Button("Done") { player.dismiss() }
            }
            .font(.body.weight(.medium))

            VStack(spacing: 6) {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(ultraGradient)
                Text(player.request?.title ?? "")
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                (player.request?.what == "page" ? Text("The page, read aloud") : Text("The answer, read aloud"))
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }

            status

            if showsControls {
                VStack(spacing: 6) {
                    ProgressView(value: min(player.elapsed, player.duration), total: max(player.duration, 1))
                        .tint(brandBlue)
                    HStack {
                        Text(clock(player.elapsed)).accessibilityIdentifier("listen.elapsed")
                        Spacer()
                        Text(clock(player.duration))
                    }
                    .font(.caption.monospacedDigit())
                    .foregroundColor(.secondary)
                }
                HStack(spacing: 44) {
                    Button { player.skip(-15) } label: { Image(systemName: "gobackward.15").font(.title) }
                        .accessibilityLabel("15 seconds back")
                    Button { player.togglePause() } label: {
                        Image(systemName: player.state == .playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 62))
                    }
                    .accessibilityLabel(player.state == .playing ? Text("Pause") : Text("Play"))
                    .accessibilityIdentifier("listen.play")
                    Button { player.skip(15) } label: { Image(systemName: "goforward.15").font(.title) }
                        .accessibilityLabel("15 seconds ahead")
                }
                .foregroundColor(brandBlue)
                .disabled(player.state == .loading)
            }
            Spacer(minLength: 0)
            Text("Keeps playing with the screen locked. Controls are on the lock screen too.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: 520)
        .buttonStyle(.borderless)
    }

    private var showsControls: Bool {
        switch player.state {
        case .loading, .playing, .paused, .ended: return true
        default: return false
        }
    }

    @ViewBuilder
    private var status: some View {
        switch player.state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Getting the voice ready…").foregroundColor(.secondary)
            }
        case .ultraOnly:
            VStack(spacing: 10) {
                Text("Listening is part of Ultra").font(.headline)
                Text("Answers and whole pages read aloud in a natural voice, in 100+ languages. On iPhone it keeps playing with the screen locked.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                Button("See Ultra", action: openPlans).buttonStyle(.borderedProminent)
            }
        case .limit(let minutes, let resets):
            Text("This week's \(minutes) minutes of listening are used up. They come back on \(resets). Apple's voice reads the rest.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        case .appleVoice:
            Text("No connection to ContextFlow: Apple's voice reads the rest.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        case .failed(let message):
            Text(message)
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        default:
            EmptyView()
        }
    }

    private func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Cuts text that streams in into parts as soon as they're complete, at sentence ends: the very first part as soon as
/// a sentence of `min` characters is there, then parts of up to 1400 (src/shared/speech.ts PartSplitter).
final class PartSplitter {
    private var buffer = ""
    private var first: Bool
    private let min: Int
    private static let sentenceEnd = try! NSRegularExpression(pattern: "[.!?…。！？؟।][\"'»”)\\]]*\\s+|\\n+")

    init(first: Bool = true, min: Int = 40) {
        self.first = first
        self.min = min
    }

    func push(_ text: String) -> [String] {
        buffer += text
        var out: [String] = []
        while true {
            let limit = first ? 240 : 1400
            let ns = buffer as NSString
            var cut = -1
            var firstEnd = -1
            for match in Self.sentenceEnd.matches(in: buffer, range: NSRange(location: 0, length: ns.length)) {
                let end = match.range.location + match.range.length
                if firstEnd < 0 { firstEnd = end }
                if end <= limit { cut = end } else { break }
            }
            if cut < 0, firstEnd >= 0, ns.length > limit { cut = firstEnd }
            guard cut >= 0, ns.length >= limit || (first && cut >= min) else { break }
            let part = ns.substring(to: cut).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer = ns.substring(from: cut)
            if !part.isEmpty {
                out.append(part)
                first = false
            }
        }
        return out
    }

    func end() -> [String] {
        let rest = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        guard !rest.isEmpty else { return [] }
        let parts = ListenPlayer.sentenceParts(rest, first: first)
        if !parts.isEmpty { first = false }
        return parts
    }
}
