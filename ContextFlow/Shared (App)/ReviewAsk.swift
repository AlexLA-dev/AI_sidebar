import Combine
import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Every App Store rating request goes through here (2.6 (100), the owner: «Это обязательно должно работать в 2.6»).
/// A good moment asks a moment after it; the root view (ContentView) then asks Apple with SwiftUI's requestReview unless
/// something is being done on screen, and ReviewGate says whether it's the time. Counted ("use" f "rate"): "due" when
/// the app's own answers reach a milestone (Safari sends its own), "ask" each time Apple is asked. Apple doesn't say
/// whether its sheet showed (at most 3 times in 365 days, never in TestFlight): "ask" is our request, not a sheet seen.
@MainActor
final class ReviewAsk {
    static let shared = ReviewAsk()

    struct Request {
        let via: ReviewGate.Via
        /// The milestone it's for (the app's answers, or Safari's).
        let moment: Int?
    }

    /// Asked of the root view, which has Apple's request and knows what's on screen.
    let requests = PassthroughSubject<Request, Never>()

    private var waiting: (via: ReviewGate.Via, task: Task<Void, Never>)?
    /// Since this launch, the app was left (Safari, the Home Screen, another app on a Mac): not its first session any more.
    private var left = false
    private var taskLinkAt: Date?
    private let lastAskKey = "cf_review_last_ask"

    private init() {
        #if os(iOS)
        let away = UIApplication.didEnterBackgroundNotification
        #else
        let away = NSApplication.didResignActiveNotification
        #endif
        NotificationCenter.default.addObserver(forName: away, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ReviewAsk.shared.left = true }
        }
        #if DEBUG
        // `-CFDebugReviewMoment 3`: Safari's 3rd good answer, written as the extension's side writes it
        // (SafariWebExtensionHandler "reviewMoment"), for checking the chain in the simulator.
        let moment = UserDefaults.standard.integer(forKey: "CFDebugReviewMoment")
        if moment > 0 { SharedDefaults.shared.recordReviewMoment(moment) }
        #endif
    }

    #if DEBUG
    /// `-CFDebugReview YES`: every time the app comes to the front, whatever was asked before (Debug builds show
    /// Apple's sheet every time).
    private var debugAlways: Bool { UserDefaults.standard.bool(forKey: "CFDebugReview") }
    #else
    private var debugAlways: Bool { false }
    #endif

    /// An answer the app gave in a chat: on the 3rd, 10th, 30th, 100th and 300th, it's due, and asked a moment after.
    func appAnswered() {
        guard let moment = SharedDefaults.shared.countAppAnswer() else { return }
        ChatAI.reportUse("rate", "due", ["via": ReviewGate.Via.appAnswer.rawValue, "moment": String(moment)])
        ask(.appAnswer, moment: moment)
    }

    /// The app came to the front (launched, or back from Safari): Safari's answers reached a milestone since the last
    /// ask (the extension wrote it in the App Group, SafariWebExtensionHandler "reviewMoment").
    func cameToFront() {
        if debugAlways { return ask(.extMoment, moment: SharedDefaults.shared.pendingReviewMoment()) }
        guard let moment = SharedDefaults.shared.pendingReviewMoment() else { return }
        ask(.extMoment, moment: moment)
    }

    /// A link from Safari opened the app to do something (buy, listen, the notifications question): no ask over it.
    func taskLink() {
        taskLinkAt = Date()
    }

    /// A good moment: asked `delay` seconds after it (one at a time; a newer one doesn't replace it).
    func ask(_ via: ReviewGate.Via, moment: Int? = nil, after delay: Double = 1.5) {
        guard waiting == nil else { return }
        let task = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            ReviewAsk.shared.waiting = nil
            ReviewAsk.shared.requests.send(Request(via: via, moment: moment))
        }
        waiting = (via, task)
    }

    /// The moment was taken back (a suggestion undone): its ask, if still waiting, goes.
    func cancel(_ via: ReviewGate.Via) {
        guard let waiting, waiting.via == via else { return }
        waiting.task.cancel()
        self.waiting = nil
    }

    /// The root view's turn: whether Apple is asked now. Then it's counted, and Safari's waiting moment is taken with it
    /// (not asked twice in a row). Not now: Safari's moment stays for the next time.
    func take(_ request: Request, busy: Bool) -> Bool {
        let now = Date().timeIntervalSince1970
        let state = ReviewGate.State(
            firstSession: ReviewGate.firstSession(firstLaunch: SharedDefaults.shared.appFirstLaunch(), now: now, left: left),
            goodAnswers: SharedDefaults.shared.goodAnswers(),
            lastAsk: UserDefaults.standard.object(forKey: lastAskKey) as? Double,
            sinceTaskLink: taskLinkAt.map { Date().timeIntervalSince($0) },
            busy: busy,
            now: now
        )
        guard (debugAlways && !busy) || ReviewGate.goesNow(request.via, state) else { return false }
        let pending = SharedDefaults.shared.pendingReviewMoment()
        if let pending { SharedDefaults.shared.markReviewAsked(pending) }
        UserDefaults.standard.set(now, forKey: lastAskKey)
        var fields = ["via": request.via.rawValue]
        if let moment = request.moment ?? pending { fields["moment"] = String(moment) }
        ChatAI.reportUse("rate", "ask", fields)
        return true
    }
}
