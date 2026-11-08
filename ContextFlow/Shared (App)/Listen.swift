import AVFoundation
import Combine
import CryptoKit
import MediaPlayer
import NaturalLanguage
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
/// device, so playing it again costs nothing. Out of the week's minutes, or offline, at a text's start, the best Apple
/// voice installed for the language (of the same gender as ours) reads it; a text never changes voice in the middle
/// (build 90): a part that fails is asked for again, and if it still can't come, playing stops with "Try again".
/// Speeds 1×, 1.2×, 1.5×, 2× keep the pitch (AVAudioUnitTimePitch); the minutes count the audio, not the time heard.
/// Nothing runs while it's paused or done: no timer, no audio engine, and the audio session is let go at the end.
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
        /// No connection or the server failed before anything played: Apple's voice reads it.
        case appleVoice
        /// The rest couldn't come (no connection, the minutes ran out) after ours had played: what was heard stays
        /// heard, and "Try again" asks for the rest in the same voice.
        case interrupted(limit: Bool)
        case failed(String)
    }

    /// The speeds offered (the panel's too); the last one chosen is kept.
    nonisolated static let speeds: [Double] = [1, 1.2, 1.5, 2]
    @Published private(set) var speed: Double = {
        let kept = UserDefaults.standard.double(forKey: "cf_listen_speed")
        return ListenPlayer.speeds.contains(kept) ? kept : 1
    }()

    @Published private(set) var request: ListenRequest?
    @Published private(set) var state: State = .idle
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var visible = false

    private static let rate = 24_000.0
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    /// Faster or slower at the same pitch.
    private let pitch = AVAudioUnitTimePitch()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: ListenPlayer.rate, channels: 1, interleaved: false)!
    private var samples: [Float] = []
    private var scheduledUpTo = 0
    private var startSample = 0
    /// The player's own clock (samples since play from startSample): where the scheduled audio ends on it, and the
    /// silence it ran through while waiting for the next part. Without it a wait counted as heard: the clock ran
    /// ahead and playing stopped early, cutting the end off (2.6, seen with the text written for the ear).
    private var playerEnd: AVAudioFramePosition = 0
    private var gapFrames: AVAudioFramePosition = 0
    /// The player's clock when it was paused (a pause keeps it; parts arriving meanwhile still count from there).
    private var pausedAt: AVAudioFramePosition?
    private var fetchedAll = false
    private var fetchTask: Task<Void, Never>?
    private var timer: Timer?
    private var wired = false
    private let synth = AVSpeechSynthesizer()
    /// What Apple's voice reads when the server can't at a text's start (out of minutes, or offline).
    private var appleText: String?
    private var appleStarted = false
    /// The parts not yet spoken when the rest couldn't come ("Try again" asks for them), and the first one's index.
    private var rest: [String] = []
    private var restIndex = 0
    /// Why the rest couldn't come: the week's minutes (true), or the connection (false).
    private var restLimited = false

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

    /// Listen under an answer in the app's own chats (build 90): Ultra plays it here; without Ultra the sheet says
    /// what Ultra adds (and opens the plans on it).
    func listen(answer markdown: String, id: String, title: String) {
        if let request, request.id == id, state != .idle {
            visible = true
            return
        }
        let plain = Self.plainText(markdown)
        guard StoreKitManager.shared.isUltra else {
            stop()
            self.request = ListenRequest(id: id, parts: [], lang: "", what: "answer", title: title, url: nil)
            state = .ultraOnly
            visible = true
            return
        }
        let parts = Self.sentenceParts(plain)
        guard !parts.isEmpty else { return }
        ChatAI.reportUse("listen", "start", ["what": "answer"])
        start(ListenRequest(id: id, parts: parts, lang: Self.language(of: plain), what: "answer", title: title, url: nil,
                            text: markdown, script: Self.needsScript(markdown)))
    }

    /// An answer's Markdown as plain sentences (no marks, links' words only).
    nonisolated static func plainText(_ markdown: String) -> String {
        var text = markdown.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[*_`~|]+"#, with: " ", options: .regularExpression)
        return text.replacingOccurrences(of: #"[ \t]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Tables, lists, headings or code: written for the ear first (src/shared/speech.ts needsScript, roughly).
    nonisolated static func needsScript(_ markdown: String) -> Bool {
        markdown.range(of: #"(?m)^\s*(\|.*\||#{1,6}\s|[-*+]\s|\d+[.)]\s|```)"#, options: .regularExpression) != nil
    }

    /// The text's language ("en", "ru"…), for the voice.
    nonisolated static func language(of text: String) -> String {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(String(text.prefix(1000)))
        return recognizer.dominantLanguage?.rawValue ?? (Locale.current.language.languageCode?.identifier ?? "en")
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
        fetchTask = Task { await fetchAll(request) }
        updateNowPlaying()
    }

    func dismiss() {
        visible = false
        // Closing the sheet doesn't stop it: it plays on, with the lock screen's controls. Stopped or done, it goes.
        if state == .ended || state == .ultraOnly || state == .idle { stop() }
        if case .failed = state { stop() }
        if case .interrupted = state { stop() }
    }

    func stop() {
        fetchTask?.cancel()
        fetchTask = nil
        stopClock()
        node.stop()
        if engine.isRunning { engine.stop() }
        synth.stopSpeaking(at: .immediate)
        rest = []
        restIndex = 0
        samples.removeAll()
        scheduledUpTo = 0
        startSample = 0
        playerEnd = 0
        gapFrames = 0
        pausedAt = nil
        fetchedAll = false
        appleText = nil
        pendingReason = nil
        appleStarted = false
        elapsed = 0
        state = .idle
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        releaseSession()
    }

    // MARK: Controls

    func togglePause() {
        switch state {
        case .playing: pause()
        case .paused: play()
        case .ended: seek(to: 0)
        // Stopped short: play is "Try again" (what was heard can be heard again with ‹15).
        case .interrupted: rest.isEmpty ? seek(to: 0) : retryRest()
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
        pausedAt = nil
        state = .playing
        startClock()
        updateNowPlaying()
    }

    func pause() {
        pausedAt = playerNow() ?? pausedAt
        node.pause()
        // Paused, nothing runs: the engine stops pulling silence (the phone stays cool and the app can sleep).
        engine.pause()
        stopClock()
        if state == .playing { state = .paused }
        updateNowPlaying()
    }

    func setSpeed(_ value: Double) {
        guard Self.speeds.contains(value) else { return }
        speed = value
        UserDefaults.standard.set(value, forKey: "cf_listen_speed")
        pitch.rate = Float(value)
        updateNowPlaying()
    }

    /// "Try again" after the rest couldn't come: the same voice carries on from where it stopped.
    func retryRest() {
        guard let request, !rest.isEmpty else { return }
        ChatAI.reportUse("listen", "retry", ["what": request.what == "page" ? "page" : "answer"])
        let parts = rest
        let first = restIndex
        rest = []
        pendingReason = nil
        // What's left to hear plays on; otherwise it waits for the rest (and plays as soon as it's here).
        if samples.count > scheduledUpTo || node.isPlaying {
            play()
        } else {
            state = .loading
        }
        fetchTask = Task { await self.speakParts(parts, from: first, request: request) }
    }

    private func startClock() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let player = self else { return }
            MainActor.assumeIsolated { player.tick() }
        }
    }

    private func stopClock() {
        timer?.invalidate()
        timer = nil
    }

    func skip(_ seconds: Double) {
        seek(to: elapsed + seconds)
    }

    func seek(to seconds: Double) {
        guard !samples.isEmpty else { return }
        let wasPlaying = state == .playing || state == .ended || state == .interrupted(limit: false) || state == .interrupted(limit: true)
        node.stop()
        startSample = max(0, min(samples.count - 1, Int(seconds * Self.rate)))
        scheduledUpTo = startSample
        // A stopped player starts its clock again from zero.
        playerEnd = 0
        gapFrames = 0
        pausedAt = nil
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
        await speakParts(request.parts, from: 0, request: request)
    }

    /// Parts in order; one that can't come stops the rest (Apple's voice only if nothing of ours played yet).
    private func speakParts(_ parts: [String], from first: Int, request: ListenRequest) async {
        for (offset, part) in parts.enumerated() {
            if Task.isCancelled { return }
            switch await speakPart(part, index: first + offset, request: request) {
            case .ok: continue
            case .stop: return
            case .fallBack(let reason): return fallBack(parts: Array(parts[offset...]), index: first + offset, reason)
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
                // The rest of what was written waits for "Try again" (or Apple's voice, if nothing played yet).
                var rest = [part]
                while let more = await iterator.next() { rest.append(more) }
                return fallBack(parts: rest, index: index, reason)
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

    /// One part to speech, from the device's copy when there is one. A part is held back as it comes and played as soon
    /// as it's needed (the text's first sound at once, later ones when what's ahead runs short), so a download that
    /// breaks off can be asked for again without repeating what was heard (receive). A passing failure is asked
    /// again twice before it counts.
    private func speakPart(_ part: String, index: Int, request: ListenRequest) async -> Spoken {
        let key = Self.cacheKey(part, request.lang)
        if let cached = SpeechCache.read(key) {
            append(cached)
            return .ok
        }
        // Nothing a voice can say (a dash, an emoji): skipped.
        guard part.rangeOfCharacter(from: .alphanumerics) != nil else { return .ok }
        guard let urlRequest = try? ChatAI.speechRequest(text: part, lang: request.lang, what: request.what, part: index, parts: max(request.parts.count, index + 1)) else {
            return .fallBack(.appleVoice)
        }
        var outcome: Download = .failed
        // "Try again" on a part that had begun to play carries on from where it stopped.
        partLive = resumeSkip > 0
        partGiven = resumeSkip
        resumeSkip = 0
        defer { partHeld = Data() }
        for attempt in 0..<3 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: attempt == 1 ? 1_000_000_000 : 3_000_000_000)
                if Task.isCancelled { return .stop }
            }
            // A new attempt: what was held goes (nobody heard it); what was played is skipped in the new audio.
            partHeld = Data()
            partSkip = partGiven
            outcome = await Self.download(urlRequest) { [weak self] chunk in
                await self?.receive(chunk)
            }
            if Task.isCancelled { return .stop }
            switch outcome {
            case .done(let all):
                if !partHeld.isEmpty {
                    append(partHeld)
                    partHeld = Data()
                }
                if let gender = Self.lastGender { UserDefaults.standard.set(gender, forKey: "cf_voice_gender") }
                SpeechCache.write(key, all)
                // The lock screen learns the new length once a part (not every piece).
                updateNowPlaying()
                return .ok
            case .failed, .refused(500..., _), .refused(429, _):
                continue
            case .refused:
                break
            }
            break
        }
        switch outcome {
        case .done:
            return .ok
        case .refused(let status, let body):
            let code = body["code"] as? String
            if status == 403 || code == "ULTRA_ONLY" {
                if samples.isEmpty {
                    state = .ultraOnly
                    return .stop
                }
                return .fallBack(.interrupted(limit: false))
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

    /// The voice's gender the server last named (X-CF-Voice-Gender).
    nonisolated(unsafe) private static var lastGender: String?

    /// The part coming in: whether it's playing as it comes, what's held back, how much of it was played (bytes), and
    /// how much of a new attempt to skip (what an earlier one already played).
    private var partLive = false
    private var partHeld = Data()
    private var partGiven = 0
    private var partSkip = 0
    /// Bytes of the first part of `rest` that were heard before it broke off ("Try again" skips them).
    private var resumeSkip = 0

    private func receive(_ chunk: Data) {
        var piece = chunk
        if partSkip > 0 {
            let drop = min(partSkip, piece.count)
            partSkip -= drop
            piece = Data(piece.dropFirst(drop))
            if piece.isEmpty { return }
        }
        // Needed now: the text's first sound, or less than 3 s left to play.
        if !partLive, samples.isEmpty || aheadSeconds() < 3 {
            partLive = true
            if !partHeld.isEmpty {
                append(partHeld)
                partGiven += partHeld.count
                partHeld = Data()
            }
        }
        if partLive {
            append(piece)
            partGiven += piece.count
        } else {
            partHeld.append(piece)
        }
    }

    /// Seconds of audio in hand ahead of what's being heard (none known while paused: plenty).
    private func aheadSeconds() -> Double {
        guard let now = playerNow() else { return state == .playing ? 0 : .infinity }
        let heard = startSample + Int(max(0, min(now, playerEnd) - gapFrames))
        return Double(samples.count - heard) / Self.rate
    }

    /// One part, passed on in pieces of whole samples as it comes (off the main thread).
    nonisolated private static func download(_ request: URLRequest, onChunk: @escaping @Sendable (Data) async -> Void) async -> Download {
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if let gender = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-CF-Voice-Gender") { lastGender = gender }
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
        let longer = Double(samples.count) / Self.rate > duration
        duration = max(duration, Double(samples.count) / Self.rate)
        scheduleMore()
        // The first sound: start (a quarter second in hand, so it doesn't stutter); after "Try again", carry on.
        if state == .loading, samples.count > Int(Self.rate * 0.25) {
            play()
        } else if state == .playing, !node.isPlaying {
            play()
        } else if longer, state == .paused {
            updateNowPlaying()
        }
    }

    /// The player's clock now, in samples (nil before it plays).
    private func playerNow() -> AVAudioFramePosition? {
        guard node.isPlaying, let nodeTime = node.lastRenderTime, let playerTime = node.playerTime(forNodeTime: nodeTime) else { return nil }
        return playerTime.sampleTime
    }

    private func scheduleMore() {
        // The player ran dry (waiting for the next part): what comes now starts now; the silence isn't audio.
        if scheduledUpTo < samples.count, let now = playerNow() ?? pausedAt, now > playerEnd {
            gapFrames += now - playerEnd
            playerEnd = now
        }
        while scheduledUpTo < samples.count {
            let end = min(samples.count, scheduledUpTo + Int(Self.rate))
            let frames = AVAudioFrameCount(end - scheduledUpTo)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let channel = buffer.floatChannelData?[0] else { return }
            buffer.frameLength = frames
            samples.withUnsafeBufferPointer { source in
                channel.update(from: source.baseAddress!.advanced(by: scheduledUpTo), count: Int(frames))
            }
            node.scheduleBuffer(buffer, completionHandler: nil)
            playerEnd += AVAudioFramePosition(frames)
            scheduledUpTo = end
        }
    }

    /// The rest can't come. Nothing of ours played yet: Apple's voice reads the text (out of minutes, offline). Ours
    /// has played: no other voice takes over mid-text; what came plays to its end, then "Try again".
    private func fallBack(parts: [String], index: Int, _ reason: State) {
        ChatAI.reportUse("listen", samples.isEmpty ? "apple" : "interrupted", ["what": request?.what == "page" ? "page" : "answer"])
        if samples.isEmpty {
            appleText = parts.joined(separator: " ")
            state = reason
            speakWithApple()
            return
        }
        rest = parts
        restIndex = index
        resumeSkip = partGiven
        let limited: Bool
        if case .limit = reason { limited = true } else { limited = false }
        restLimited = limited
        pendingReason = .interrupted(limit: limited)
        if state != .playing { state = .interrupted(limit: limited) }
    }

    private var pendingReason: State?

    private func tick() {
        guard request != nil else { return }
        var drained = false
        if !samples.isEmpty, let now = playerNow() {
            // Heard: up to the end of what's scheduled, less the silences while waiting.
            let heard = max(0, min(now, playerEnd) - gapFrames)
            elapsed = min(Double(samples.count) / Self.rate, Double(startSample + Int(heard)) / Self.rate)
            drained = now >= playerEnd
        }
        if drained, state == .playing {
            if fetchedAll {
                finish(.ended)
                return
            } else if let reason = pendingReason {
                pendingReason = nil
                finish(reason)
                return
            } else if !rest.isEmpty {
                // Heard again (‹15) after it stopped short: back to "Try again".
                finish(.interrupted(limit: restLimited))
                return
            }
        }
        // While playing, the lock screen keeps its own clock (rate and elapsed): it's told only of changes.
    }

    /// Done, or stopped short: nothing keeps running and the audio session is let go (the phone can rest).
    private func finish(_ next: State) {
        stopClock()
        // Where the clock stopped: audio that comes later ("Try again") doesn't count the wait as heard.
        pausedAt = playerNow() ?? pausedAt
        node.pause()
        if engine.isRunning { engine.pause() }
        state = next
        updateNowPlaying()
        releaseSession()
    }

    // MARK: Apple's voice (out of minutes, offline)

    private func speakWithApple() {
        guard let request, let text = appleText, !text.isEmpty, !appleStarted else { return }
        appleStarted = true
        activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestVoice(request.lang, gender: UserDefaults.standard.string(forKey: "cf_voice_gender") ?? "female")
        utterance.rate = Self.appleRate(speed)
        synth.speak(utterance)
    }

    /// Apple's rate for our speeds (its scale isn't linear: 0.5 is normal speech).
    nonisolated static func appleRate(_ speed: Double) -> Float {
        switch speed {
        case 2...: return 0.66
        case 1.5...: return 0.6
        case 1.2...: return 0.54
        default: return AVSpeechUtteranceDefaultSpeechRate
        }
    }

    /// The best voice installed for the language, of the same gender as ours (so it sounds like the same kind of
    /// voice): premium, then enhanced, then the default one; the device's language variant first.
    static func bestVoice(_ lang: String, gender: String = "female") -> AVSpeechSynthesisVoice? {
        let code = lang.isEmpty ? Locale.current.identifier : lang
        let primary = code.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? code
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(primary) }
        let wanted: AVSpeechSynthesisVoiceGender = gender == "male" ? .male : .female
        let region = Locale.current.region?.identifier
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            var score = 0
            if v.gender == wanted { score += 100 }
            switch v.quality {
            case .premium: score += 30
            case .enhanced: score += 20
            default: score += 10
            }
            if let region, v.language.hasSuffix(region) { score += 1 }
            return score
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

    /// At the end (or stop): other apps' audio may carry on, and the app is free to sleep.
    private func releaseSession() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func wire() {
        guard !wired else { return }
        wired = true
        engine.attach(node)
        engine.attach(pitch)
        pitch.rate = Float(speed)
        engine.connect(node, to: pitch, format: format)
        engine.connect(pitch, to: engine.mainMixerNode, format: format)
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
        // The speed on the lock screen and in Control Center, where the system offers it.
        center.changePlaybackRateCommand.supportedPlaybackRates = Self.speeds.map { NSNumber(value: $0) }
        center.changePlaybackRateCommand.addTarget { [weak self] event in
            guard let rate = (event as? MPChangePlaybackRateCommandEvent)?.playbackRate else { return .commandFailed }
            let nearest = ListenPlayer.speeds.min { abs($0 - Double(rate)) < abs($1 - Double(rate)) } ?? 1
            Task { @MainActor in self?.setSpeed(nearest) }
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
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? speed : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: speed
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
                speedMenu
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
        case .loading, .playing, .paused, .ended, .interrupted: return true
        default: return false
        }
    }

    /// 1×, 1.2×, 1.5×, 2× (the last one chosen stays).
    private var speedMenu: some View {
        Menu {
            Picker(selection: Binding(get: { player.speed }, set: { player.setSpeed($0) })) {
                ForEach(ListenPlayer.speeds, id: \.self) { value in
                    Text(speedLabel(value)).tag(value)
                }
            } label: {
                Text("Playback speed")
            }
        } label: {
            Text(speedLabel(player.speed))
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(brandBlue.opacity(0.12)))
        }
        .foregroundColor(brandBlue)
        .accessibilityLabel(Text("Playback speed"))
        .accessibilityValue(Text(speedLabel(player.speed)))
        .accessibilityIdentifier("listen.speed")
    }

    private func speedLabel(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1))) + "×"
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
        case .interrupted(let limit):
            VStack(spacing: 10) {
                (limit ? Text("This week's listening minutes are used up, so the rest can't be read in this voice.") : Text("The rest didn't come through: no connection to ContextFlow."))
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                if limit {
                    Button("See Ultra", action: openPlans).buttonStyle(.bordered)
                } else {
                    Button("Try again") { player.retryRest() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("listen.retry")
                }
            }
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
