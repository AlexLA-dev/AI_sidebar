import AVFoundation
import Combine
import MediaPlayer
import NaturalLanguage
import SwiftUI
import UserNotifications
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
    /// Carried on from the panel (iPhone, iPad; 2.6): the index of the first part here (the ones before were heard in
    /// Safari), the seconds of audio before it, and how far into it to start.
    var firstIndex = 0
    var base: Double = 0
    var skip: Double = 0
    /// Build 94: the text's id for "already voiced" (src/shared/voiced.ts), and whether part of it was skipped ahead in
    /// Safari before the app carried it on.
    var voiced: String?
    var skippedBefore = false
}

/// "Already voiced" by Listen (build 94, the owner: a mark that shows replaying costs no minutes). It goes on a text
/// heard to its end, with nothing skipped, in the app or the panel on this device. The two share the list through the
/// App Group. The week's minutes count each part of a text once per subscription, on any device, so hearing it again
/// adds nothing.
@MainActor
final class VoicedList: ObservableObject {
    static let shared = VoicedList()
    @Published private(set) var ids: Set<String>

    private init() {
        ids = Set(SharedDefaults.shared.voicedIds())
    }

    func reload() {
        let now = Set(SharedDefaults.shared.voicedIds())
        if now != ids { ids = now }
    }

    func has(_ what: String, _ text: String) -> Bool {
        !ids.isEmpty && ids.contains(Self.id(what: what, text: text))
    }

    /// False when it was marked already.
    @discardableResult
    func mark(_ id: String) -> Bool {
        let added = SharedDefaults.shared.markVoiced([id])
        reload()
        return added
    }

    /// Voiced as the server counts it (build 95): kept with this device's list (the panel's too, through the App Group).
    func markAll(_ list: [String]) {
        guard !list.isEmpty, SharedDefaults.shared.markVoiced(list) else { return }
        reload()
    }

    /// When each text was last asked about: a chat opened again soon after asks nothing.
    private var asked: [String: Date] = [:]

    /// Build 95 (the owner on 94: no mark anywhere; it was set only by a listen heard to its very end, on that device):
    /// a chat's answers as the server counts them, heard on any device in any number of listens. Each is asked about at
    /// most every 10 minutes, with its parts' keys when they're known here (as Listen makes them), else by its id.
    /// Called as a chat opens: the ids and keys (hashing, splitting, regular expressions, kept scripts read from disk)
    /// are worked out off the main thread, and only what's known and asked about is touched here, on the main actor.
    func ask(answers: [String]) {
        guard StoreKitManager.shared.isUltra, !answers.isEmpty else { return }
        let recent = Array(answers.suffix(30))
        Task {
            let all = await Task.detached(priority: .utility) { VoicedQuery.answers(recent) }.value
            // Back on the main actor: what's voiced here already or was asked about lately is left out. Two chats opened
            // one after the other can't both ask about the same text: this runs on the main actor, one at a time.
            let now = Date()
            let todo = all.filter { !ids.contains($0.id) && now.timeIntervalSince(asked[$0.id] ?? .distantPast) > 600 }
            guard !todo.isEmpty else { return }
            for answer in todo { asked[answer.id] = now }
            let found = await Task.detached(priority: .utility) {
                todo.map { VoicedQuery.Text(id: $0.id, keys: VoicedQuery.keys(answer: $0.text, kept: SpeechCache.read)) }
            }.value
            let texts: [[String: Any]] = found.map { ["id": $0.id, "keys": $0.keys] }
            guard let request = try? ChatAI.heardRequest([], texts: texts),
                  let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            self.markAll((body["voiced"] as? [String]) ?? [])
        }
    }

    /// The text's id (src/shared/voiced.ts voicedId).
    nonisolated static func id(what: String, text: String) -> String {
        VoicedQuery.id(what: what, text: text)
    }
}

/// Whether the player's sheet is up, and nothing else (build 92): the app's root watches this instead of the player,
/// whose clock changes four times a second while it plays.
@MainActor
final class ListenShown: ObservableObject {
    @Published private(set) var visible = false
    /// Build 93: the player's bar at the bottom of the app, while a text plays on with its sheet closed ("Done"); gone
    /// once it has ended or stopped.
    @Published private(set) var mini = false
    private var watching: AnyCancellable?
    private var watchingMini: AnyCancellable?

    init() {
        let player = ListenPlayer.shared
        visible = player.visible
        mini = Self.mini(player.visible, player.state)
        watching = player.$visible.removeDuplicates().receive(on: RunLoop.main).sink { [weak self] shown in
            self?.visible = shown
        }
        watchingMini = Publishers.CombineLatest(player.$visible, player.$state)
            .map { Self.mini($0, $1) }
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] shown in self?.mini = shown }
    }

    nonisolated static func mini(_ visible: Bool, _ state: ListenPlayer.State) -> Bool {
        if visible { return false }
        switch state {
        case .idle, .ended: return false
        default: return true
        }
    }
}

/// Build 93 (the owner: "after Done, while it still plays, show the player's bar at the bottom, as in the extension"):
/// what plays and how far, Play or Pause, and close (it stops); tapping it opens the player again. It watches the player
/// itself, so only this bar follows its clock.
struct ListenMiniBar: View {
    @ObservedObject var player: ListenPlayer

    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "speaker.wave.2.fill").foregroundStyle(ultraGradient)
                VStack(alignment: .leading, spacing: 0) {
                    // Tapped: the player again. Its position is dragged on the line under it (build 94).
                    Button { player.visible = true } label: {
                        Text(player.request?.title ?? "")
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Opens the player"))
                    .accessibilityIdentifier("listen.mini")
                    ListenScrubber(player: player, thin: true)
                }
            }
            Button { player.togglePause() } label: {
                Image(systemName: player.state == .playing ? "pause.fill" : "play.fill").font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(player.state == .loading)
            .accessibilityLabel(player.state == .playing ? Text("Pause") : Text("Play"))
            .accessibilityIdentifier("listen.mini.play")
            Button { player.stop() } label: {
                Image(systemName: "xmark").font(.body.weight(.semibold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Stop and close"))
            .accessibilityIdentifier("listen.mini.close")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
    }
}

/// The position, dragged or tapped (build 94, the owner: in the app it moved only by 15 s, in the panel it's dragged):
/// within what has come (a shade lighter than the rest); while dragging it shows where it would go, and letting go moves
/// there once. VoiceOver moves it by 15 s. It follows the player's clock only while that runs.
struct ListenScrubber: View {
    @ObservedObject var player: ListenPlayer
    /// The mini bar's: a thin line in a short hit area, no times.
    var thin = false
    @State private var dragging: Double?

    var body: some View {
        VStack(spacing: 6) {
            track
            if !thin {
                HStack {
                    Text(Self.clock(dragging ?? player.elapsed)).accessibilityIdentifier("listen.elapsed")
                    Spacer()
                    Text(Self.clock(player.duration)).accessibilityIdentifier("listen.total")
                }
                .font(.caption.monospacedDigit())
                .foregroundColor(.secondary)
            }
        }
    }

    private var track: some View {
        let total = max(player.duration, 1)
        let received = min(max(player.received, 0), total)
        let shown = min(max(dragging ?? player.elapsed, 0), total)
        let line: CGFloat = thin ? 3 : 4
        let knob: CGFloat = thin ? (dragging == nil ? 0 : 11) : (dragging == nil ? 13 : 17)
        return GeometryReader { g in
            let width = max(g.size.width, 1)
            let x = { (seconds: Double) in width * CGFloat(seconds / total) }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.22)).frame(height: line)
                Capsule().fill(brandBlue.opacity(0.32)).frame(width: x(received), height: line)
                Capsule().fill(brandBlue).frame(width: x(shown), height: line)
                Circle().fill(brandBlue).frame(width: knob, height: knob).offset(x: x(shown) - knob / 2)
            }
            .frame(width: width, height: g.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in dragging = at(value.location.x, width: width, total: total) }
                    .onEnded { value in
                        let to = at(value.location.x, width: width, total: total)
                        dragging = nil
                        player.seek(to: to)
                    }
            )
            .disabled(player.state == .loading || player.received <= 0)
        }
        .frame(height: thin ? 14 : 26)
        .accessibilityElement()
        .accessibilityLabel(Text("Playback position"))
        .accessibilityValue(Text("\(Self.clock(player.elapsed)) of \(Self.clock(player.duration))"))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: player.skip(15)
            case .decrement: player.skip(-15)
            @unknown default: break
            }
        }
        .accessibilityIdentifier(thin ? "listen.mini.position" : "listen.position")
    }

    /// The second under the finger, within what has come.
    private func at(_ x: CGFloat, width: CGFloat, total: Double) -> Double {
        let seconds = Double(max(0, min(x, width)) / width) * total
        return min(seconds, max(0, player.received - 0.25))
    }

    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Where the bar goes: iPhone and iPad on iOS 26.1 and later, the tab bar's own place for it (as Music's player);
/// before that and on the Mac, along the bottom of the window.
struct ListenMiniPlacement: ViewModifier {
    let shown: Bool
    let player: ListenPlayer

    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 26.1, *) {
            content.tabViewBottomAccessory(isEnabled: shown) { ListenMiniBar(player: player) }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) { bar }
        }
        #else
        content.safeAreaInset(edge: .bottom, spacing: 0) { bar }
        #endif
    }

    @ViewBuilder private var bar: some View {
        if shown {
            VStack(spacing: 0) {
                Divider()
                ListenMiniBar(player: player)
            }
            .background(.bar)
        }
    }
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
        /// Fewer minutes left this week than the text takes (build 91): said before it starts; "Listen anyway".
        case lowMinutes(left: Int, needed: Int)
        case failed(String)
    }

    /// The size of a part after the first (src/shared/speech.ts PART_CHARS): about 35 s of speech, so each one is
    /// made quickly and the next is ready before the one playing ends (build 91: a 95 s part came 20 s late).
    nonisolated static let partChars = 500

    /// The speeds offered (the panel's too); the last one chosen is kept.
    nonisolated static let speeds: [Double] = [1, 1.2, 1.5, 2]
    @Published private(set) var speed: Double = {
        let kept = UserDefaults.standard.double(forKey: "cf_listen_speed")
        return ListenPlayer.speeds.contains(kept) ? kept : 1
    }()

    @Published private(set) var request: ListenRequest?
    @Published private(set) var state: State = .idle
    @Published private(set) var elapsed: Double = 0
    /// Seconds of this week's listening left (each part's X-CF-Usage; the plan's facts before the first one).
    @Published private(set) var secondsLeft: Int?
    @Published private(set) var duration: Double = 0
    @Published var visible = false
    /// The seconds of audio in hand (the whole text's clock): the position moves within it (build 94).
    var received: Double { base + Double(samples.count) / Self.rate }

    private static let rate = 24_000.0
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    /// Faster or slower at the same pitch.
    private let pitch = AVAudioUnitTimePitch()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: ListenPlayer.rate, channels: 1, interleaved: false)!
    private var samples: [Float] = []
    private var scheduledUpTo = 0
    private var startSample = 0
    /// Carried on from Safari (2.6): the seconds heard there before the first part here (the clock shows the whole
    /// text's time), and how far into the first part to start once enough of it is in.
    private var base: Double = 0
    private var pendingSkip: Double?
    /// Where this text's audio came from (seconds of audio: this device's copy, iCloud, the server), what the server
    /// charged up front, and how far it was heard: reported when it stops (build 92, minutes charged against heard).
    private var counts = (cache: 0.0, icloud: 0.0, server: 0.0, charged: 0.0)
    private var heardTo: Double = 0
    /// Build 94: how far it has been heard as it played, and whether a part was skipped ahead (a seek or 15 s ahead past
    /// what was heard). Heard to its end with nothing skipped, the text is "already voiced".
    private var reached: Double = 0
    private var skippedAhead = false
    /// Each part's samples here (its key on the devices and the server), and the seconds heard of each (build 92: the
    /// week's minutes count what's heard; HeardStore keeps them until the server has).
    private var partRanges: [(key: String, start: Int, end: Int)] = []
    /// The keys of the text's parts that can be said, in order (build 95: the server says from them whether it's voiced).
    private var textKeys: [String] = []
    /// The stretches heard of each part (by its key, in its own seconds; build 98: a stretch heard twice counts once, one
    /// skipped over not at all, and listens in pieces add up on the server).
    private var heardByKey: [String: HeardCoverage.Ranges] = [:]
    /// Build 98, the text's length shown from the start: its parts as known here (from the first one here), each whole
    /// part's seconds of audio, and the source written for the ear so far and still to be.
    private var knownParts: [String] = []
    private var partAudio: [Double?] = []
    private var sourceWritten = ""
    private var sourceLeft = ""
    private var lastHeardSample: Int?
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
    private lazy var appleEnd = AppleVoiceEnd { [weak self] in
        Task { @MainActor in self?.appleFinished() }
    }
    /// What Apple's voice reads when the server can't at a text's start (out of minutes, or offline), and why.
    private var appleReason: State?
    private var appleText: String?
    private var appleStarted = false
    /// The parts not yet spoken when the rest couldn't come ("Try again" asks for them), and the first one's index.
    private var rest: [String] = []
    private var restIndex = 0
    /// Why the rest couldn't come: the week's minutes (true), or the connection (false).
    private var restLimited = false

    // MARK: Opening

    /// Debug builds: `-CFDebugListen "<text>"` plays that text as if Safari had handed it over (simulator checks).
    #if DEBUG
    /// The App Group as the panel leaves it while playing on an iPhone (2.6): four parts as spoken and where each starts.
    static func debugSeedHandoff(id given: String) {
        let spoken = [
            "Electric trains draw power from overhead lines or a third rail.",
            "Modern ones return energy to the grid when they brake, so a busy line uses less than its timetable suggests.",
            "Regenerative braking alone saves between a tenth and a third of the energy, depending on how often trains stop.",
            "Lighter cars and smoother driving save the rest."
        ]
        var starts: [Double] = []
        var at = 0.0
        for part in spoken {
            starts.append(at)
            at += Self.estimate(part)
        }
        let id = SharedDefaults.shared.writeListenRequest([
            "parts": spoken, "text": spoken.joined(separator: " "), "script": false, "lang": "en", "what": "answer",
            "title": "How electric trains save energy", "url": "https://example.com/trains"
        ], id: given)
        SharedDefaults.shared.updateListenRequest(id, ["spoken": spoken, "spokenComplete": true, "handoff": ["starts": starts, "position": 0.0, "speed": 1.0]])
        NSLog("[cf-handoff] seeded %@ starts %@", id, starts.map { String(format: "%.1f", $0) }.joined(separator: ","))
    }
    #endif

    func debugStartIfAsked() {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "CFDebugSpeechSync") { Task { await SpeechSync.debugSelfCheck() } }
        // -CFDebugSeedHandoff YES: the App Group holds what the panel would have stored while playing on an iPhone
        // (2.6): four parts as spoken and where each starts, id 0000aaaa-…-eeeeffff0001. A test then opens
        // contextflow://listen?id=…&at=N as the notification would.
        // -CFDebugSeedHandoffAfter N (build 93): N seconds after launch, the same text again under id …0002, as the panel
        // would store it when the person listens to it in Safari after listening here.
        let again = UserDefaults.standard.double(forKey: "CFDebugSeedHandoffAfter")
        if again > 0 {
            Task {
                try? await Task.sleep(nanoseconds: UInt64(again * 1_000_000_000))
                Self.debugSeedHandoff(id: "0000aaaa-bbbb-cccc-dddd-eeeeffff0002")
            }
        }
        if UserDefaults.standard.bool(forKey: "CFDebugSeedHandoff") { Self.debugSeedHandoff(id: "0000aaaa-bbbb-cccc-dddd-eeeeffff0001") }
        // -CFDebugNotifyAt N: the notification the extension posts when Safari goes away, from second N, in 4 s (the
        // app needs notifications allowed). A test then leaves the app and taps it.
        let notifyAt = UserDefaults.standard.double(forKey: "CFDebugNotifyAt")
        if notifyAt > 0 {
            let content = UNMutableNotificationContent()
            content.title = "How electric trains save energy"
            content.body = "Keep listening in ContextFlow — from 0:\(String(format: "%02d", Int(notifyAt)))"
            content.threadIdentifier = "cf.listen"
            let id = "0000aaaa-bbbb-cccc-dddd-eeeeffff0001"
            content.userInfo = ["listen": id, "link": "contextflow://listen?id=\(id)&at=\(Int(notifyAt))"]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "cf.listen.away", content: content,
                                                                         trigger: UNTimeIntervalNotificationTrigger(timeInterval: 4, repeats: false)))
        }
        // The environment keeps line breaks (a Markdown table); a launch argument stops at the first one.
        let given = ProcessInfo.processInfo.environment["CF_DEBUG_LISTEN"] ?? UserDefaults.standard.string(forKey: "CFDebugListen")
        guard request == nil, let text = given, !text.isEmpty else { return }
        let lang = UserDefaults.standard.string(forKey: "CFDebugListenLang") ?? "en"
        // -CFDebugListenScript YES: written for the ear first, as a page or an answer with a table would be.
        start(ListenRequest(id: "debug", parts: SpeechText.parts(text), lang: lang, what: "page", title: "How electric trains save energy", url: URL(string: "https://example.com/trains"),
                            text: text, script: UserDefaults.standard.bool(forKey: "CFDebugListenScript")))
        // -CFDebugListenMini YES (build 93): as after Done, the bar at the bottom (frames of it on the Mac).
        if UserDefaults.standard.bool(forKey: "CFDebugListenMini") { visible = false }
        #endif
    }

    /// A long text for /api/v2/speak-script in pieces of at most 5000 characters, cut between paragraphs (the panel's).
    nonisolated static func scriptChunks(_ text: String, size: Int = 5000) -> [String] {
        SpeechText.scriptChunks(text, size: size)
    }

    /// Listen under an answer in the app's own chats (build 90): Ultra plays it here; without Ultra the sheet says
    /// what Ultra adds (and opens the plans on it).
    func listen(answer markdown: String, id: String, title: String) {
        if let request, request.id == id, state != .idle {
            visible = true
            return
        }
        guard StoreKitManager.shared.isUltra else {
            stop()
            self.request = ListenRequest(id: id, parts: [], lang: "", what: "answer", title: title, url: nil)
            state = .ultraOnly
            visible = true
            return
        }
        // As the panel makes them (build 95): the same parts, language and text for the ear, so a text heard in Safari
        // plays here from what's kept and isn't counted again (and the other way round).
        let text = (markdown as NSString).length > SpeechText.maxChars ? (markdown as NSString).substring(to: SpeechText.maxChars) : markdown
        let parts = Array(SpeechText.parts(SpeechText.text(text)).prefix(80))
        guard !parts.isEmpty else { return }
        ChatAI.reportUse("listen", "start", ["what": "answer"])
        start(ListenRequest(id: id, parts: parts, lang: SpeechText.language(markdown) ?? SpeechText.uiLanguage, what: "answer", title: title, url: nil,
                            text: text, script: SpeechText.needsScript(text), voiced: VoicedList.id(what: "answer", text: markdown)))
    }

    func open(_ url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let id = (items.first { $0.name == "id" }?.value ?? "").lowercased()
        // From the panel's notification (2.6): the second it had reached in Safari.
        let from = items.first { $0.name == "at" }?.value.flatMap(Double.init)
        if let request, request.id == id, state != .idle {
            visible = true
            return
        }
        // The panel follows the link during the tap and sends the text meanwhile (build 91): it may land a moment
        // after the app opens, so wait for it a few seconds before saying it isn't here.
        guard let stored = SharedDefaults.shared.readListenRequest(id) else {
            stop()
            state = .loading
            visible = true
            waitTask?.cancel()
            waitTask = Task { [weak self] in
                for _ in 0..<24 {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    if Task.isCancelled { return }
                    if SharedDefaults.shared.readListenRequest(id) != nil { break }
                }
                guard let self, !Task.isCancelled else { return }
                if let stored = SharedDefaults.shared.readListenRequest(id) {
                    self.open(stored: stored, id: id, from: from)
                } else {
                    self.state = .failed(String(localized: "This text is no longer here. Tap Listen in Safari again."))
                }
            }
            return
        }
        open(stored: stored, id: id, from: from)
    }

    private var waitTask: Task<Void, Never>?

    private func open(stored: [String: Any], id: String, from: Double? = nil) {
        guard let parts = stored["parts"] as? [String], !parts.isEmpty else {
            state = .failed(String(localized: "This text is no longer here. Tap Listen in Safari again."))
            visible = true
            return
        }
        // The same text again (Listen tapped twice in Safari) while it plays: it carries on, never starts over (build 91:
        // starting over cut off a part still downloading, and it was asked for again). Not when carried on from Safari
        // (`from`): then it goes on from the second Safari reached, not from where this app last was with it (build 93).
        if from == nil, let request, request.parts == parts, request.text == (stored["text"] as? String ?? ""), state != .idle {
            visible = true
            return
        }
        var request = ListenRequest(
            id: id,
            parts: parts,
            lang: stored["lang"] as? String ?? "",
            what: stored["what"] as? String ?? "answer",
            title: (stored["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "ContextFlow"),
            url: (stored["url"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) },
            text: stored["text"] as? String ?? "",
            script: stored["script"] as? Bool ?? false
        )
        let what = request.what == "page" ? "page" : "answer"
        request.voiced = request.text.isEmpty ? nil : VoicedList.id(what: what, text: request.text)
        request.skippedBefore = (stored["handoff"] as? [String: Any])?["skipped"] as? Bool ?? false
        if let from {
            // Carried on from Safari: the panel won't play it again, and the speed it had goes on.
            SharedDefaults.shared.markListenTaken(id)
            let handoff = stored["handoff"] as? [String: Any] ?? [:]
            if let speed = (handoff["speed"] as? NSNumber)?.doubleValue { setSpeed(speed) }
            request = Self.carriedOn(request, stored: stored, from: from)
        }
        start(request)
    }

    /// The panel's text from second `from` on: its parts as it spoke them (the same words, so their audio comes from
    /// this device, iCloud, or the server as a repeat: nothing made or charged twice), from the part playing at that
    /// second. Parts still being written when Safari stopped: the whole text again, and the player seeks there.
    nonisolated static func carriedOn(_ request: ListenRequest, stored: [String: Any], from: Double) -> ListenRequest {
        var out = request
        let starts = ((stored["handoff"] as? [String: Any])?["starts"] as? [NSNumber] ?? []).map(\.doubleValue)
        guard let spoken = stored["spoken"] as? [String], !spoken.isEmpty, stored["spokenComplete"] as? Bool == true, !starts.isEmpty else {
            out.skip = max(0, from)
            return out
        }
        let first = min(spoken.count - 1, starts.lastIndex { $0 <= from + 0.05 } ?? 0)
        out = ListenRequest(id: request.id, parts: Array(spoken[first...]), lang: request.lang, what: request.what, title: request.title,
                            url: request.url, text: "", script: false, voiced: request.voiced, skippedBefore: request.skippedBefore)
        out.firstIndex = first
        out.base = starts[min(first, starts.count - 1)]
        out.skip = max(0, from - out.base)
        return out
    }

    func start(_ request: ListenRequest, anyway: Bool = false) {
        // What's expired in iCloud goes (at most once a day).
        Task.detached(priority: .background) { await SpeechSync.sweep() }
        stop()
        textModel = ""
        self.request = request
        visible = true
        base = request.base
        pendingSkip = request.skip > 0 ? request.skip : nil
        elapsed = base + request.skip
        // Carried on from Safari: heard there up to this second (build 94: only a skip past what was heard counts).
        reached = base + request.skip
        skippedAhead = false
        knownParts = request.script ? [] : request.parts
        partAudio = []
        sourceWritten = ""
        sourceLeft = request.script ? Self.scriptChunks(request.text).joined(separator: "\n") : ""
        duration = 0
        updateDuration()
        if secondsLeft == nil { secondsLeft = StoreKitManager.shared.planFacts.speakLeftSeconds }
        // The week's minutes not known yet (the app just opened, Settings not visited): asked first, for at most 2 s,
        // so the few-minutes note can come before it starts rather than the limit after.
        // Only when it could matter (more than a minute of audio): a short answer starts at once, and the facts come in
        // meanwhile (build 92: every Listen waited up to 2 s for them, an 18 s answer felt slow on iPad).
        if secondsLeft == nil, StoreKitManager.shared.isUltra, duration - base <= 60 {
            Task { await StoreKitManager.shared.refreshPlanFacts() }
        }
        if !anyway, secondsLeft == nil, StoreKitManager.shared.isUltra, duration - base > 60 {
            state = .loading
            waitTask = Task { [weak self] in
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { @MainActor in await StoreKitManager.shared.refreshPlanFacts() }
                    group.addTask { try? await Task.sleep(nanoseconds: 2_000_000_000) }
                    _ = await group.next()
                    group.cancelAll()
                }
                guard let self, !Task.isCancelled, self.request?.id == request.id else { return }
                self.secondsLeft = StoreKitManager.shared.planFacts.speakLeftSeconds
                self.begin(request, anyway: false)
            }
            return
        }
        begin(request, anyway: anyway)
    }

    private func begin(_ request: ListenRequest, anyway: Bool) {
        // Fewer minutes left than the text takes: said first (none left at all: the server says so, Apple's voice reads).
        if !anyway, let left = secondsLeft, left > 0, Double(left) < duration - base {
            state = .lowMinutes(left: max(1, left / 60), needed: max(1, Int(((duration - base) / 60).rounded(.up))))
            return
        }
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
        if case .lowMinutes = state { stop() }
    }

    func stop() {
        keepHeard()
        Task { await Self.sendHeard() }
        reportHeard()
        partRanges = []
        textKeys = []
        heardByKey = [:]
        lastHeardSample = nil
        waitTask?.cancel()
        waitTask = nil
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
        base = 0
        pendingSkip = nil
        playerEnd = 0
        gapFrames = 0
        pausedAt = nil
        fetchedAll = false
        appleText = nil
        appleReason = nil
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
        case .ended:
            if samples.isEmpty, appleText != nil, let reason = appleReason {
                state = reason
                speakWithApple()
            } else {
                seek(to: 0)
            }
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
        keepHeard()
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

    /// "Listen anyway" after the few-minutes-left note.
    func listenAnyway() {
        guard let request else { return }
        start(request, anyway: true)
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
        // The clock shows the whole text's time; what was heard in Safari before this part isn't here (2.6).
        startSample = max(0, min(samples.count - 1, Int((seconds - base) * Self.rate)))
        scheduledUpTo = startSample
        // A stopped player starts its clock again from zero.
        playerEnd = 0
        gapFrames = 0
        pausedAt = nil
        elapsed = base + Double(startSample) / Self.rate
        if elapsed > reached + 1 { skippedAhead = true }
        // A seek isn't heard (build 98: a jump of up to a second and a half counted as heard, so a short skip still
        // made the text whole): what's heard counts again from here.
        lastHeardSample = nil
        scheduleMore()
        if wasPlaying { play() } else { updateNowPlaying() }
    }

    /// Back to the page in Safari ("◀ Safari" in the status bar does the same while it's there).
    func backToSafari() {
        guard let url = request?.url else { return }
        // The panel opens again if it was open (build 93: it came back closed).
        if let id = request?.id { SharedDefaults.shared.markListenReturn(id, play: false) }
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    // MARK: Speech from the server

    private func fetchAll(_ request: ListenRequest) async {
        if request.script, !request.text.isEmpty { return await speakWritten(request) }
        await speakParts(request.parts, from: request.firstIndex, request: request)
    }

    /// Parts in order; one that can't come stops the rest (Apple's voice only if nothing of ours played yet).
    private func speakParts(_ parts: [String], from first: Int, request: ListenRequest) async {
        for (offset, part) in parts.enumerated() {
            if Task.isCancelled { return }
            await untilNeeded()
            if Task.isCancelled { return }
            switch await speakPart(part, index: first + offset, request: request) {
            case .ok:
                // Carried on from Safari: the first part is all here, and shorter than the second it was at (its clock
                // and this audio differ a little): from just before its end.
                if offset == 0 { startSkippedIfShort() }
                continue
            case .stop: return
            case .fallBack(let reason): return fallBack(parts: Array(parts[offset...]), index: first + offset, reason)
            }
        }
        fetchedAll = true
        noteText(request)
        startSkippedIfShort()
    }

    /// What's heard, part by part: the stretch the position moved over by about a tick's worth while it plays (a seek or a
    /// wait isn't), laid on the parts it crossed (build 98).
    private func noteHeard(at sample: Int) {
        defer { lastHeardSample = sample }
        guard state == .playing, let last = lastHeardSample else { return }
        let moved = sample - last
        guard moved > 0, Double(moved) <= Self.rate * 1.5 else { return }
        guard let part = partRanges.last(where: { $0.start <= sample - 1 && sample - 1 < $0.end }) else { return }
        let before = HeardCoverage.covered(heardByKey[part.key] ?? [])
        for range in partRanges where range.start < sample && last < min(range.end, samples.count) {
            let end = min(range.end, samples.count)
            let from = Double(max(last, range.start) - range.start) / Self.rate
            let to = Double(min(sample, end) - range.start) / Self.rate
            heardByKey[range.key] = HeardCoverage.add(heardByKey[range.key] ?? [], from: from, to: to)
        }
        let after = HeardCoverage.covered(heardByKey[part.key] ?? [])
        // A part heard to its end, or every 10 s of one: kept now, so it counts even if the app is closed while it plays.
        if let previous = partRanges.last(where: { $0.start <= last && last < $0.end }), previous.key != part.key { keepHeard() }
        else if Int(after / 10) != Int(before / 10) { keepHeard() }
    }

    /// A part's length (seconds of its audio) once all of it is in.
    private func partLength(_ key: String) -> Double? {
        guard let range = partRanges.last(where: { $0.key == key }), range.end != Int.max else { return nil }
        return Double(range.end - range.start) / Self.rate
    }

    /// Every part of the text heard here, from its first, all of its tenths (build 98: seeking back and forth on the way
    /// is fine). Carried on from Safari, the parts heard there aren't here: the server says (it adds the listens up).
    private func wholeHeard() -> Bool {
        guard request?.firstIndex == 0, !partRanges.isEmpty else { return false }
        for range in partRanges {
            guard range.end != Int.max else { return false }
            let length = Double(range.end - range.start) / Self.rate
            // A part with nothing to say has no audio.
            if length < 0.3 { continue }
            if HeardCoverage.mask(heardByKey[range.key] ?? [], length: length) != HeardCoverage.full { return false }
        }
        return true
    }

    /// The text's length as it's known now (build 98): never less than the audio in hand. Before any of its audio is in,
    /// at the pace the voice had last time in this language; the pace this text has is kept for the next one.
    private func updateDuration() {
        let lang = request?.lang ?? ""
        var paces = UserDefaults.standard.dictionary(forKey: "cf_listen_pace") as? [String: Double] ?? [:]
        let total = HeardCoverage.total(parts: knownParts, audio: partAudio, unwritten: sourceLeft, written: sourceWritten, pace: paces[lang] ?? 1)
        duration = max(base + total, received)
        if let seen = HeardCoverage.pace(parts: knownParts, audio: partAudio), abs(seen - (paces[lang] ?? 0)) >= 0.02 {
            paces[lang] = (seen * 100).rounded() / 100
            UserDefaults.standard.set(paces, forKey: "cf_listen_pace")
        }
    }

    /// All of the text's parts known here (from its first): the text goes with the next heard report, and the server
    /// says whether it's voiced now (build 95). Carried on from a later part, the panel tells it.
    private func noteText(_ request: ListenRequest) {
        guard request.firstIndex == 0, let id = request.voiced, !textKeys.isEmpty else { return }
        HeardStore.noteText(id, textKeys)
    }

    /// Into the store the server is told from (by part key; it counts a part once, up to its length): the seconds
    /// covered, and once the whole part is in, its tenths heard and its length (build 98).
    private func keepHeard() {
        for (key, ranges) in heardByKey {
            let length = partLength(key)
            HeardCover.keep(key, ranges)
            HeardStore.note(key, HeardCoverage.covered(ranges), slots: length.map { HeardCoverage.mask(ranges, length: $0) } ?? 0, length: length)
        }
    }

    /// What's waiting goes to the server (when a text stops, and at launch for what didn't go); the minutes shown follow.
    static func sendHeard() async {
        let items = HeardStore.items()
        let texts = HeardStore.texts()
        guard !items.isEmpty || !texts.isEmpty, let request = try? ChatAI.heardRequest(items, texts: texts),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        HeardStore.counted(items)
        HeardStore.textsSent(texts.compactMap { $0["id"] as? String })
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let usage = body?["usage"] as? [String: Any], let used = usage["used"] as? Int, let limit = usage["limit"] as? Int {
            lastUsage = (used, limit)
            shared.secondsLeft = max(0, limit - used)
        }
        // Voiced now, as the server counts it (build 95).
        VoicedList.shared.markAll((body?["voiced"] as? [String]) ?? [])
    }

    /// Where the minutes went for this text, once, when it stops: heard, from where, and charged up front.
    private func reportHeard() {
        guard let request, counts.cache + counts.icloud + counts.server > 0 else { return }
        let whole = { (value: Double) in String(min(9999, max(0, Int(value.rounded())))) }
        ChatAI.reportUse("listen", "heard", [
            "what": request.what == "page" ? "page" : "answer",
            "heard_s": whole(heardTo - request.base - request.skip),
            "cache_s": whole(counts.cache), "icloud_s": whole(counts.icloud), "server_s": whole(counts.server), "charged_s": whole(counts.charged)
        ])
        counts = (0, 0, 0, 0)
        heardTo = 0
    }

    /// The next part is asked for only when what's in hand ahead runs short (about 8 s of listening, at any speed), and
    /// not at all while it's paused: a text stopped early never costs minutes for parts nobody heard. Build 92: every
    /// part was asked for at once, so a minute heard of a long page had cost most of the page.
    private func untilNeeded() async {
        while !Task.isCancelled {
            // Nothing in hand yet, still filling up to the second carried on from, or waiting to start: needed now.
            if samples.isEmpty || pendingSkip != nil || state == .loading { return }
            if state == .playing, aheadSeconds() < 8 * speed + 4 { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    /// The second to carry on from is past what's here: it starts just before the end of what is.
    private func startSkippedIfShort() {
        guard let skip = pendingSkip, state == .loading, !samples.isEmpty else { return }
        pendingSkip = nil
        seek(to: base + min(skip, max(0, Double(samples.count) / Self.rate - 0.5)))
        play()
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
            await untilNeeded()
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
        noteText(request)
        startSkippedIfShort()
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
                // The text's length shown follows what's written (build 98).
                self.knownParts += parts
                if !parts.isEmpty { self.updateDuration() }
            }
            // Counted as written once all of the chunk is (until then its source is still to come).
            defer {
                self.sourceWritten = chunks.prefix(index + 1).joined(separator: "\n")
                self.sourceLeft = chunks.dropFirst(index + 1).joined(separator: "\n")
                self.updateDuration()
            }
            let key = "script|\(request.what)|" + Self.cacheKey(chunk, request.lang)
            if let kept = SpeechCache.read(key), let script = String(data: kept, encoding: .utf8) {
                give(splitter.push(script))
                give(splitter.end())
                continue
            }
            // Written on another of the user's devices (iCloud): the same words, so the same parts and their audio.
            let textKey = SpeechSync.key(voice: "script|\(request.what)", lang: request.lang, text: chunk)
            if let synced = await SpeechSync.fetchText(textKey, wait: first ? 1 : 1.5) {
                SpeechCache.write(key, Data(synced.utf8))
                give(splitter.push(synced))
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
                if !script.isEmpty {
                    SpeechCache.write(key, Data(script.utf8))
                    let written = script
                    Task.detached(priority: .utility) { await SpeechSync.saveText(textKey, text: written) }
                }
            } catch {
                if Task.isCancelled { return }
                if !script.isEmpty {
                    give(splitter.end())
                } else if index == 0 && chunks.count == 1 {
                    // Nothing written: the panel's own parts (its rules), as before this was written for the ear.
                    give(request.parts)
                } else {
                    give(SpeechText.parts(SpeechText.text(chunk)))
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
        if Self.speakable(part) { textKeys.append(key) }
        // Where this part starts here (what's heard of it counts by its key).
        partRanges.append((key: key, start: samples.count, end: Int.max))
        // What this device heard of this part on earlier listens (build 98): pieces add up.
        if heardByKey[key] == nil, let earlier = HeardCover.ranges(key) { heardByKey[key] = earlier }
        defer {
            if let last = partRanges.indices.last, partRanges[last].key == key {
                partRanges[last].end = samples.count
                // Its length known: the text's length shown follows (build 98).
                let at = index - request.firstIndex
                if at >= 0 {
                    while partAudio.count <= at { partAudio.append(nil) }
                    partAudio[at] = Double(partRanges[last].end - partRanges[last].start) / Self.rate
                    updateDuration()
                }
            }
        }
        if let cached = SpeechCache.read(key) {
            counts.cache += Double(cached.count / 2) / Self.rate
            append(cached)
            return .ok
        }
        // Nothing a voice can say (a dash, an emoji): skipped.
        guard part.rangeOfCharacter(from: .alphanumerics) != nil else { return .ok }
        // Made on another of the user's devices (iCloud): played from there, nothing asked of the server. The first
        // sound waits for iCloud at most a second; later parts come well ahead of being heard.
        let syncKey = SpeechSync.key(voice: Self.voiceName, lang: request.lang, text: part)
        if let synced = await SpeechSync.fetchPart(syncKey, wait: samples.isEmpty ? 1 : 2), !synced.isEmpty {
            if Task.isCancelled { return .stop }
            counts.icloud += Double(synced.count / 2) / Self.rate
            append(synced)
            SpeechCache.write(key, synced)
            updateNowPlaying()
            return .ok
        }
        if Task.isCancelled { return .stop }
        let heardNow = HeardStore.items()
        guard let urlRequest = try? ChatAI.speechRequest(text: part, lang: request.lang, what: request.what, part: index, parts: max(request.parts.count, index + 1), model: textModel, heard: heardNow) else {
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
            // The server counted what went with it (on a part or a refusal for the week's minutes).
            if !heardNow.isEmpty {
                switch outcome {
                case .done, .refused(402, _): HeardStore.counted(heardNow)
                default: break
                }
            }
            if Task.isCancelled { return .stop }
            switch outcome {
            case .done(let all):
                if !partHeld.isEmpty {
                    append(partHeld)
                    partHeld = Data()
                }
                counts.server += Double(all.count / 2) / Self.rate
                counts.charged += Self.lastCharged
                if let gender = Self.lastGender { UserDefaults.standard.set(gender, forKey: "cf_voice_gender") }
                if textModel.isEmpty, let model = Self.lastModel { textModel = model }
                // For the user's other devices (iCloud, AAC): in the background, never in the voice's way.
                Task.detached(priority: .utility) { await SpeechSync.savePart(syncKey, pcm: all) }
                if let usage = Self.lastUsage { secondsLeft = max(0, usage.limit - usage.used) }
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
                secondsLeft = 0
                let minutes = (usage?["limit"] as? Int ?? 0) / 60
                // The server's time has milliseconds ("2026-11-09T00:00:00.000Z"), which the plain formatter refuses
                // (build 91 showed "They come back on ."). Missing anyway: the week starts on Monday (UTC).
                let fractional = ISO8601DateFormatter()
                fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let resetsAt = (usage?["resetsAt"] as? String).flatMap { fractional.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
                    ?? Self.nextMondayUTC()
                let resets = resetsAt.formatted(.dateTime.weekday(.wide))
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

    /// The voice the server speaks with (X-CF-Voice; part of a part's key on the user's devices and in iCloud).
    static var voiceName: String { UserDefaults.standard.string(forKey: "cf_voice_name") ?? "Kore" }

    /// The voice's gender the server last named (X-CF-Voice-Gender), and the model it last spoke with (X-CF-Model).
    nonisolated(unsafe) private static var lastGender: String?
    nonisolated(unsafe) private static var lastModel: String?
    /// The seconds the server charged up front for the last part (X-CF-Charged: 0 for a repeat).
    nonisolated(unsafe) private static var lastCharged: Double = 0
    /// The week's listening as the server last counted it (X-CF-Usage: seconds used of the limit).
    nonisolated(unsafe) private static var lastUsage: (used: Int, limit: Int)?
    /// The model this text's first part came from: every later part asks for it (one voice per text, build 91).
    private var textModel = ""

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
        if !partLive, samples.isEmpty || pendingSkip != nil || aheadSeconds() < 3 {
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
            if status == 200, let voice = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-CF-Voice"), !voice.isEmpty {
                UserDefaults.standard.set(voice, forKey: "cf_voice_name")
            }
            if status == 200, let model = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-CF-Model") { lastModel = model }
            lastCharged = status == 200 ? Double((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-CF-Charged") ?? "") ?? 0 : 0
            if let raw = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-CF-Usage"),
               let usage = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
               let used = usage["used"] as? Int, let limit = usage["limit"] as? Int {
                lastUsage = (used, limit)
            }
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
        let longer = base + Double(samples.count) / Self.rate > duration
        duration = max(duration, base + Double(samples.count) / Self.rate)
        // Carried on from Safari: it starts at that second of the first part, once that much of it is in.
        if let skip = pendingSkip {
            guard state == .loading, samples.count > Int(Self.rate * (skip + 0.25)) else { return }
            pendingSkip = nil
            seek(to: base + skip)
            play()
            return
        }
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
        // Carried on from Safari (build 95): our voice has played there, so Apple's doesn't take over mid-text either.
        let carriedOn = (request?.base ?? 0) + (request?.skip ?? 0) > 0
        let apple = samples.isEmpty && !carriedOn
        ChatAI.reportUse("listen", apple ? "apple" : "interrupted", ["what": request?.what == "page" ? "page" : "answer"])
        if apple {
            appleText = parts.joined(separator: " ")
            appleReason = reason
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
        if samples.isEmpty {
            // Nothing of it here yet (carried on from Safari): "Try again" at once, nothing left running.
            pendingReason = nil
            finish(.interrupted(limit: limited))
        } else if state != .playing {
            state = .interrupted(limit: limited)
        }
    }

    private var pendingReason: State?

    private func tick() {
        guard request != nil else { return }
        var drained = false
        if !samples.isEmpty, let now = playerNow() {
            // Heard: up to the end of what's scheduled, less the silences while waiting.
            let heard = max(0, min(now, playerEnd) - gapFrames)
            elapsed = base + min(Double(samples.count) / Self.rate, Double(startSample + Int(heard)) / Self.rate)
            heardTo = max(heardTo, elapsed)
            // Every jump goes through seek(), which says whether it skipped ahead: here it's only playing on.
            if state == .playing { reached = max(reached, elapsed) }
            noteHeard(at: startSample + Int(heard))
            drained = now >= playerEnd
        }
        if drained, state == .playing {
            if fetchedAll {
                noteVoiced()
                finish(.ended)
                // Heard to its end: the server is told now, so the minutes under the player are this listen's while it
                // shows the end, and a replay shows the same (the 2.6 gate: they followed only once the player was
                // closed, so the replay looked like it had cost a minute). Sent again on closing, it adds nothing.
                keepHeard()
                Task { await Self.sendHeard() }
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

    /// Heard to its end with nothing skipped, here and in Safari before (build 94): Listen marks it "already voiced", in
    /// the app and in the panel on this device.
    private func noteVoiced() {
        guard let request, let id = request.voiced else { return }
        let gap = max(0, base + Double(samples.count) / Self.rate - reached)
        // Build 98: every part heard here, all of it, whatever was skipped and gone back to. Heard in pieces (other
        // listens, Safari, another device), the server says so with the report sent at the end.
        guard wholeHeard() else {
            // Not marked here: why, for the record (build 95: the owner saw no mark on 94).
            let why = skippedAhead ? "skipped" : request.firstIndex > 0 || request.skippedBefore ? "before" : "short"
            ChatAI.reportUse("listen", "unvoiced", ["what": request.what == "page" ? "page" : "answer", "why": why, "gap_s": String(Int(gap.rounded()))])
            return
        }
        if VoicedList.shared.mark(id) { ChatAI.reportUse("listen", "voiced", ["what": request.what == "page" ? "page" : "answer"]) }
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
        synth.delegate = appleEnd
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestVoice(request.lang, gender: UserDefaults.standard.string(forKey: "cf_voice_gender") ?? "female")
        utterance.rate = Self.appleRate(speed)
        synth.speak(utterance)
    }

    /// Apple's voice read it to its end: the text has ended (the bar goes, the audio session is let go); Play reads it
    /// again.
    private func appleFinished() {
        guard appleStarted, request != nil else { return }
        switch state {
        case .appleVoice, .limit: break
        default: return
        }
        appleStarted = false
        finish(.ended)
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
        // The position dragged on the lock screen and in Control Center (build 94), within what has come.
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime else { return .commandFailed }
            Task { @MainActor in self?.seek(to: position) }
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
        // The app's icon in the Dynamic Island, on the lock screen and in Control Center (build 91: a black square).
        if let artwork = Self.artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        #if os(macOS)
        MPNowPlayingInfoCenter.default().playbackState = state == .playing ? .playing : .paused
        #endif
    }

    /// Now Playing's picture: the app icon (made once).
    private static let artwork: MPMediaItemArtwork? = {
        #if os(iOS)
        guard let image = UIImage(named: "LargeIcon") else { return nil }
        #else
        guard let image = NSImage(named: "LargeIcon") else { return nil }
        #endif
        return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }()

    // MARK: Helpers

    /// When the week's listening comes back (netlify/shared/plan.mts nextReset: Monday 00:00 UTC).
    static func nextMondayUTC(from now: Date = Date()) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!
        let weekday = calendar.component(.weekday, from: tomorrow)  // 1 = Sunday, 2 = Monday
        return calendar.date(byAdding: .day, value: (9 - weekday) % 7, to: tomorrow)!
    }

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

    nonisolated static func cacheKey(_ text: String, _ lang: String) -> String {
        VoicedQuery.key(text, lang)
    }

    /// Something a voice can say (a part without is skipped: never made, never heard).
    nonisolated static func speakable(_ part: String) -> Bool {
        VoicedQuery.speakable(part)
    }
}

/// What this device heard of each part over its listens (build 98): the stretches, by part key, kept as long as the
/// parts' audio (7 days), so pieces heard on different listens here add up exactly before they go to the server.
nonisolated enum HeardCover {
    private static let key = "cf_listen_cover"
    private static let limit = 400
    private static let maxAge: TimeInterval = 7 * 86_400

    static func ranges(_ part: String) -> HeardCoverage.Ranges? {
        guard let entry = (UserDefaults.standard.dictionary(forKey: key) as? [String: [Double]])?[part], entry.count >= 3,
              Date().timeIntervalSince1970 - entry[0] < maxAge else { return nil }
        var out: HeardCoverage.Ranges = []
        var i = 1
        while i + 1 < entry.count {
            if entry[i + 1] > entry[i] { out.append(entry[i]...entry[i + 1]) }
            i += 2
        }
        return out.isEmpty ? nil : out
    }

    static func keep(_ part: String, _ ranges: HeardCoverage.Ranges) {
        var map = UserDefaults.standard.dictionary(forKey: key) as? [String: [Double]] ?? [:]
        let now = Date().timeIntervalSince1970
        let joined = HeardCoverage.merge(Self.ranges(part) ?? [], ranges)
        map[part] = [now] + joined.flatMap { [($0.lowerBound * 100).rounded() / 100, ($0.upperBound * 100).rounded() / 100] }
        if map.count > limit {
            for old in map.sorted(by: { ($0.value.first ?? 0) < ($1.value.first ?? 0) }).prefix(map.count - limit) { map.removeValue(forKey: old.key) }
        }
        UserDefaults.standard.set(map, forKey: key)
    }

    /// "Delete all chats": gone with what was spoken.
    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// Read aloud's seconds heard, by part key, until the server has counted them (build 92: the week's minutes count what's
/// heard). They go with the next part asked for, on their own when a text stops, and again at the next launch if they
/// didn't; the server counts a part once, up to its length, so sending again never charges twice.
enum HeardStore {
    private static let key = "cf_listen_heard"

    /// Build 98: the part's tenths heard (bits, joined over listens until counted) and its length, beside the seconds.
    private static let slotsKey = "cf_listen_heard_slots"
    private static let lengthKey = "cf_listen_heard_length"

    static func note(_ part: String, _ seconds: Double, slots: Int = 0, length: Double? = nil) {
        let defaults = UserDefaults.standard
        var map = defaults.dictionary(forKey: key) as? [String: Double] ?? [:]
        var slotMap = defaults.dictionary(forKey: slotsKey) as? [String: Int] ?? [:]
        var lengthMap = defaults.dictionary(forKey: lengthKey) as? [String: Double] ?? [:]
        let joined = (slotMap[part] ?? 0) | slots
        guard seconds > (map[part] ?? 0) || joined != (slotMap[part] ?? 0) || (length != nil && lengthMap[part] == nil) else { return }
        map[part] = max(map[part] ?? 0, (seconds * 10).rounded() / 10)
        if joined != 0 { slotMap[part] = joined }
        if let length { lengthMap[part] = (length * 10).rounded() / 10 }
        defaults.set(map, forKey: key)
        defaults.set(slotMap, forKey: slotsKey)
        defaults.set(lengthMap, forKey: lengthKey)
    }

    static func items() -> [[String: Any]] {
        let map = UserDefaults.standard.dictionary(forKey: key) as? [String: Double] ?? [:]
        let slotMap = UserDefaults.standard.dictionary(forKey: slotsKey) as? [String: Int] ?? [:]
        let lengthMap = UserDefaults.standard.dictionary(forKey: lengthKey) as? [String: Double] ?? [:]
        return map.prefix(80).map { entry in
            var item: [String: Any] = ["key": entry.key, "s": entry.value]
            if let slots = slotMap[entry.key], slots != 0 { item["c"] = slots }
            if let length = lengthMap[entry.key] { item["d"] = length }
            return item
        }
    }

    private static let textsKey = "cf_listen_heard_texts"

    /// A text heard from, with all its parts' keys (build 95): told with the next report, the server says if it's voiced.
    static func noteText(_ id: String, _ keys: [String]) {
        var map = UserDefaults.standard.dictionary(forKey: textsKey) as? [String: [String]] ?? [:]
        map[id] = Array(keys.prefix(80))
        if map.count > 20 { map = Dictionary(uniqueKeysWithValues: map.prefix(20).map { ($0.key, $0.value) }) }
        UserDefaults.standard.set(map, forKey: textsKey)
    }

    static func texts() -> [[String: Any]] {
        let map = UserDefaults.standard.dictionary(forKey: textsKey) as? [String: [String]] ?? [:]
        return map.prefix(20).map { ["id": $0.key, "keys": $0.value] }
    }

    static func textsSent(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        var map = UserDefaults.standard.dictionary(forKey: textsKey) as? [String: [String]] ?? [:]
        for id in ids { map.removeValue(forKey: id) }
        UserDefaults.standard.set(map, forKey: textsKey)
    }

    /// Takes out what the server counted (only where nothing more was heard meanwhile).
    static func counted(_ sent: [[String: Any]]) {
        var map = UserDefaults.standard.dictionary(forKey: key) as? [String: Double] ?? [:]
        var slotMap = UserDefaults.standard.dictionary(forKey: slotsKey) as? [String: Int] ?? [:]
        var lengthMap = UserDefaults.standard.dictionary(forKey: lengthKey) as? [String: Double] ?? [:]
        for item in sent {
            guard let part = item["key"] as? String, let seconds = item["s"] as? Double else { continue }
            let sentSlots = item["c"] as? Int ?? 0
            if (map[part] ?? 0) <= seconds && (slotMap[part] ?? 0) & ~sentSlots == 0 {
                map.removeValue(forKey: part)
                slotMap.removeValue(forKey: part)
                lengthMap.removeValue(forKey: part)
            }
        }
        UserDefaults.standard.set(slotMap, forKey: slotsKey)
        UserDefaults.standard.set(lengthMap, forKey: lengthKey)
        UserDefaults.standard.set(map, forKey: key)
    }
}

/// The parts already spoken and the texts written for the ear, in Caches (the system may clear them; then they're asked
/// for again): about 25 minutes of audio, nothing older than 7 days; gone with the chats ("Delete all chats").
/// Nonisolated (build 95): a chat being opened reads kept scripts off the main thread (VoicedList.ask).
nonisolated enum SpeechCache {
    private static let limit = 75 * 1024 * 1024
    private static let maxAge: TimeInterval = 7 * 86_400

    private static var folder: URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let folder = caches.appendingPathComponent("Listen", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    static func read(_ key: String) -> Data? {
        // Made by the panel on this device (build 92): from the App Group, as if it were here.
        guard let file = folder?.appendingPathComponent("\(name(key)).pcm"), let data = try? Data(contentsOf: file), !data.isEmpty else {
            return SharedListenCache.read(key)
        }
        let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        guard Date().timeIntervalSince(written) < maxAge else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        return data
    }

    /// "Delete all chats": everything read aloud goes.
    static func clear() {
        SharedListenCache.clear()
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
                    .accessibilityIdentifier("listen.title")
                (player.request?.what == "page" ? Text("The page, read aloud") : Text("The answer, read aloud"))
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }

            status

            if showsControls {
                VStack(spacing: 6) {
                    // Dragged or tapped (build 94), as in the panel.
                    ListenScrubber(player: player)
                    // The week's listening left (build 91: the owner wanted to see it somewhere).
                    if let left = player.secondsLeft {
                        Text("\(left / 60) min of listening left this week")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .accessibilityIdentifier("listen.left")
                    }
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
        case .lowMinutes(let left, let needed):
            VStack(spacing: 10) {
                Text("About \(left) min of listening left this week, and this takes about \(needed) min. It stops where they run out.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                HStack(spacing: 12) {
                    Button("Listen anyway") { player.listenAnyway() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("listen.anyway")
                    Button("Cancel") { player.dismiss() }.buttonStyle(.bordered)
                }
            }
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
}

/// Tells the player when Apple's voice has read its text to the end (build 95).
nonisolated final class AppleVoiceEnd: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let done: @Sendable () -> Void

    init(_ done: @escaping @Sendable () -> Void) {
        self.done = done
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        done()
    }
}
