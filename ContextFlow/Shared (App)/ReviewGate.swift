import Foundation

// Asking for an App Store rating (2.6 (100), the owner: «почему я в аналитике вижу, что никому не предлагалось оценить
// приложение? … Оно вообще работает?»). Only Apple's own request (App Review guideline 5.6.1), never a "rate us" of ours.
// When it's asked is decided here, Foundation only (tests/review-gate.test.mts builds this file alone); ReviewAsk.swift
// asks and counts it.
nonisolated enum ReviewGate {
    /// What made it a good moment: the "via" of "rate" "due" and "ask" (src/shared/usage.ts).
    enum Via: String, CaseIterable, Sendable {
        /// The app's own answers in a chat: the 3rd, 10th, 30th, 100th and 300th.
        case appAnswer = "app_answer"
        /// Safari's answers, the same counts (src/background/sync.ts): asked when the app next comes to the front.
        case extMoment = "ext_moment"
        /// A plan's tour closed after a purchase or an upgrade; "You're all set" after a purchase.
        case tour, purchase
        /// 2.6 (100): Find similar's answer opened in the app, a text heard to its end in Listen, What's new left after an
        /// update, a suggestion taken (a chat moved, named or tagged).
        case similar, listen, whatsNew = "whatsnew", organize
    }

    /// The answers after which it's a good moment, in the app and in Safari.
    static let milestones: Set<Int> = [3, 10, 30, 100, 300]
    /// Between two asks at the other good moments. Apple shows its sheet at most 3 times in 365 days anyway.
    static let extraGap: TimeInterval = 7 * 86_400
    /// A link from Safari that opened the app to do something (buy, listen, the notifications question): no ask over it.
    static let linkQuiet: TimeInterval = 10
    /// The app's first launch, this long: its first session (Apple's advice: never then).
    static let firstSessionLength: TimeInterval = 3600

    struct State: Sendable {
        /// The app's first session: launched for the first time less than an hour ago, and not left since.
        var firstSession: Bool
        /// Good answers so far: the app's own, and Safari's latest milestone.
        var goodAnswers: Int
        /// The last ask, seconds since 1970.
        var lastAsk: Double?
        /// Seconds since a link from Safari opened the app to do something.
        var sinceTaskLink: Double?
        /// Something is on screen being done: the plan's tour, the notifications question, the setup guide, the player.
        var busy: Bool
        var now: Double
    }

    /// Whether Apple is asked now. Not now: Safari's moment waits for the next time the app comes to the front; the
    /// others are let go.
    static func goesNow(_ via: Via, _ s: State) -> Bool {
        if s.busy { return false }
        let linked = s.sinceTaskLink.map { $0 < linkQuiet } ?? false
        switch via {
        case .appAnswer, .tour, .purchase:
            return true
        case .extMoment:
            return !s.firstSession && !linked
        case .similar, .listen, .whatsNew, .organize:
            guard !s.firstSession, !linked, s.goodAnswers >= 3 else { return false }
            if let last = s.lastAsk, s.now - last < extraGap { return false }
            return true
        }
    }

    /// Whether this is still the app's first session.
    static func firstSession(firstLaunch: Double?, now: Double, left: Bool) -> Bool {
        guard !left else { return false }
        guard let firstLaunch else { return true }
        return now - firstLaunch < firstSessionLength
    }
}
