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
    let parts: [String]
    let lang: String
    let what: String
    let title: String
    let url: URL?
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
    /// From this part on, Apple's voice reads (the week's minutes ran out, or the connection did).
    private var appleFrom: Int?
    private var appleStarted = false

    // MARK: Opening

    /// Debug builds: `-CFDebugListen "<text>"` plays that text as if Safari had handed it over (simulator checks).
    func debugStartIfAsked() {
        #if DEBUG
        guard request == nil, let text = UserDefaults.standard.string(forKey: "CFDebugListen"), !text.isEmpty else { return }
        let lang = UserDefaults.standard.string(forKey: "CFDebugListenLang") ?? "en"
        start(ListenRequest(id: "debug", parts: Self.parts(text), lang: lang, what: "page", title: "How electric trains save energy", url: URL(string: "https://example.com/trains")))
        #endif
    }

    #if DEBUG
    /// Sentences gathered into parts like the panel's (src/shared/speech.ts): a short first one, then up to 1400.
    static func parts(_ text: String) -> [String] {
        var parts: [String] = []
        var current = ""
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { sentence, _, _, _ in
            guard let sentence else { return }
            let limit = parts.isEmpty ? 240 : 1400
            if !current.isEmpty, current.count + sentence.count > limit {
                parts.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            }
            current += sentence
        }
        if !current.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(current.trimmingCharacters(in: .whitespaces)) }
        return parts
    }
    #endif

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
            url: (stored["url"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
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
        appleFrom = nil
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
        for (index, part) in request.parts.enumerated() {
            if Task.isCancelled { return }
            let key = Self.cacheKey(part, request.lang)
            if let cached = SpeechCache.read(key) {
                append(cached)
                continue
            }
            let urlRequest: URLRequest
            do {
                urlRequest = try ChatAI.speechRequest(text: part, lang: request.lang, what: request.what, part: index, parts: request.parts.count)
            } catch {
                return fallBack(from: index, .appleVoice)
            }
            let outcome = await Self.download(urlRequest) { [weak self] chunk in
                await self?.append(chunk)
            }
            if Task.isCancelled { return }
            switch outcome {
            case .done(let all):
                SpeechCache.write(key, all)
            case .refused(let status, let body):
                let code = body["code"] as? String
                if status == 403 || code == "ULTRA_ONLY" {
                    if samples.isEmpty { state = .ultraOnly } else { fallBack(from: index, .appleVoice) }
                    return
                }
                if code == "LIMIT_REACHED" {
                    let usage = body["usage"] as? [String: Any]
                    let minutes = (usage?["limit"] as? Int ?? 0) / 60
                    let resets = (usage?["resetsAt"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
                        .map { $0.formatted(.dateTime.weekday(.wide)) } ?? ""
                    return fallBack(from: index, .limit(minutes: minutes, resets: resets))
                }
                return fallBack(from: index, .appleVoice)
            case .failed:
                return fallBack(from: index, .appleVoice)
            }
        }
        fetchedAll = true
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

    private func fallBack(from part: Int, _ reason: State) {
        appleFrom = part
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
            } else if let reason = pendingReason, appleFrom != nil {
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
        guard let request, let from = appleFrom, from < request.parts.count, !appleStarted else { return }
        appleStarted = true
        activateSession()
        let utterance = AVSpeechUtterance(string: request.parts[from...].joined(separator: " "))
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

/// The parts already spoken, in Caches (the system may clear them; then they're asked for again): about 25 minutes.
enum SpeechCache {
    private static let limit = 75 * 1024 * 1024

    private static var folder: URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let folder = caches.appendingPathComponent("Listen", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    static func read(_ key: String) -> Data? {
        guard let file = folder?.appendingPathComponent("\(key).pcm"), let data = try? Data(contentsOf: file), !data.isEmpty else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return data
    }

    static func write(_ key: String, _ data: Data) {
        guard let folder, !data.isEmpty else { return }
        try? data.write(to: folder.appendingPathComponent("\(key).pcm"), options: .atomic)
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
            if total > limit { try? FileManager.default.removeItem(at: row.0) }
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
