import Combine
import Foundation
import StoreKit
import SwiftUI
import UserNotifications
#if os(iOS)
import AdServices
import AVKit
import SafariServices
import UIKit
#else
import AppKit
import SafariServices
#endif

// MARK: - Is ContextFlow on in Safari?

/// Whether the Safari extension is switched on and has been used. The setup guide on the home screen,
/// the reminders to finish setup and the anonymous "app opened" funnel event follow from it.
///
/// The extension tells the app itself: every message it sends to its native handler is recorded in the App
/// Group (see SharedDefaults). On the Mac, and on iOS and iPadOS 26.2 and later (2.6), Safari also answers.
@MainActor
final class Activation: ObservableObject {
    static let shared = Activation()

    enum State: String {
        /// Not heard from the extension yet (on the Mac: Safari says it is off).
        case off
        /// Switched on, but the panel hasn't been opened on a page yet.
        case on
        /// The panel has been used.
        case inUse = "in_use"
    }

    @Published private(set) var state: State
    /// The app's random id (no device or Apple ID data), used only for the funnel.
    let appId: String
    /// This is the first launch of a new install, not of an update: the moment to offer reminders.
    let newInstall: Bool

    private static let remindersOfferedKey = "cf_setup_reminders_offered"
    private static let openReportedKey = "cf_app_open_reported_day"
    /// Apple Ads attribution: tries left to send the AdServices token (0 once the server has an answer).
    private static let adsTriesKey = "cf_ads_attribution_tries"

    private init() {
        let launch = SharedDefaults.shared.appLaunch()
        appId = launch.id
        newInstall = launch.newInstall
        state = Self.recordedState()
        // 2.7: the app left for Settings. From the system itself: SwiftUI's scene phase doesn't reach the views once the
        // app is in the background (the simulator run saw only the way back).
        #if os(iOS)
        let left = UIApplication.didEnterBackgroundNotification
        #else
        let left = NSApplication.didResignActiveNotification
        #endif
        NotificationCenter.default.addObserver(forName: left, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.wentAway() }
        }
    }

    private static func recordedState() -> State {
        // «Start as a new user» (2.7, test builds): what the extension did since it began, as on a new install.
        if NewUserPreview.isOn, let preview = SharedDefaults.shared.newUserPreview() {
            return preview.used != nil ? .inUse : preview.seen != nil ? .on : .off
        }
        let status = SharedDefaults.shared.readExtensionStatus()
        return status.firstUsed != nil ? .inUse : status.firstSeen != nil ? .on : .off
    }

    /// «Start as a new user» began or ended (test builds): the state as it's recorded for that, with nothing reported.
    func previewChanged() {
        state = Self.recordedState()
        backFromSafariUnused = UserDefaults.standard.bool(forKey: "cf_setup_back_unused")
    }

    /// Re-reads the state: the extension may have been switched on while the app was in the background.
    func refresh() async {
        var next = Self.recordedState()
        #if os(macOS)
        let enabled = await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
                continuation.resume(returning: state?.isEnabled ?? false)
            }
        }
        if !enabled { next = .off } else if next == .off { next = .on }
        #else
        // Back from Settings with it switched on: the guide gives way at once (2.6, the owner: "after coming back it
        // still shows how to switch it on"). Older iOS can't ask; the extension says so once it's used.
        if #available(iOS 26.2, *), let enabled = await Self.safariSaysEnabled() {
            if !enabled { next = .off } else if next == .off { next = .on }
        }
        #endif
        let before = state
        state = next
        if next != .off { SetupReminders.cancel() }
        if before == .off, next != .off { reportEnabled() }
        checkSafariTrip()
    }

    // MARK: The way to switching it on (2.7, plan section 8 «Активация»): counts only, f "activation" in usage.ts.

    /// Leaving for Settings (still in front) or gone. Also kept on disk while it lasts: switching ContextFlow on in
    /// Settings can end the app's process, and the relaunch is still the way back.
    private enum Trip { case going, away }
    private var trip: Trip?
    private static let tripKey = "cf_activation_trip_at"
    /// When the next step may go: a second after the one before, so the server gets them in their order (the video and
    /// Settings come a moment apart), and none waits on another's answer (one in flight as the app leaves can hang).
    private var nextStepAt = Date.distantPast
    private static let enabledReportedKey = "cf_activation_enabled_reported"

    private func step(_ action: String, _ fields: [String: String] = [:], feature: String = "activation") {
        // «Start as a new user» (test builds) isn't a new install: its steps aren't counted.
        guard !NewUserPreview.isOn else { return }
        let now = Date()
        let at = max(now, nextStepAt)
        nextStepAt = at.addingTimeInterval(1)
        ChatAI.reportUse(feature, action, fields, after: at.timeIntervalSince(now))
    }

    /// The guide's video started floating over Settings (iPhone, iPad).
    func guideStarted() { step("video") }

    /// 2.8 (В1.1, names from the 2.8 event schema): the funnel's zero step, the instruction to switch it on shown
    /// (activation.shown, "via" the home card); and the «Open Safari» step shown once it's on (setup.safari_shown).
    /// Each once an install.
    func instructionShown() { once("shown", key: "cf_activation_shown_reported", fields: ["via": "card"]) }
    func safariStepShown() { once("safari_shown", key: "cf_activation_safari_shown_reported", feature: "setup") }

    /// «Open Safari» tapped on the setup card: setup.open_safari (`via`: "step", the step after switching it on; "card",
    /// the card once it's been used; "guide", the guide's own button where this iOS can't tell the app it's on).
    func openedSafari(_ via: String) {
        step("open_safari", ["via": via], feature: "setup")
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.safariTripKey)
    }

    /// 2.8 («Ask»): the person went to Safari from the «Open Safari» step and came back, and the panel still hasn't been
    /// opened. With All Websites left on Ask no ✦ shows on any page, so the step then names Safari's page menu first.
    /// Kept on disk: from the first return after a trip until the panel is used.
    @Published private(set) var backFromSafariUnused = UserDefaults.standard.bool(forKey: "cf_setup_back_unused")
    private static let safariTripKey = "cf_setup_safari_trip_at"

    private func checkSafariTrip() {
        let defaults = UserDefaults.standard
        let at = defaults.double(forKey: Self.safariTripKey)
        guard at > 0, Date().timeIntervalSince1970 - at > 5 else { return }
        defaults.removeObject(forKey: Self.safariTripKey)
        guard state == .on, !backFromSafariUnused else { return }
        backFromSafariUnused = true
        defaults.set(true, forKey: "cf_setup_back_unused")
        once("ask_shown", key: "cf_setup_ask_shown_reported", feature: "setup")
    }

    private func once(_ action: String, key: String, fields: [String: String] = [:], feature: String = "activation") {
        guard !NewUserPreview.isOn, !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        step(action, fields, feature: feature)
    }

    /// The reminders to finish setup were scheduled (setup.reminder; "perm": "quiet" provisional, "on" full permission).
    func remindersScheduled(_ perm: String) { step("reminder", ["perm": perm], feature: "setup") }

    /// Settings opened from the app to switch ContextFlow on: "card" (the home screen's), "chats" (their empty state, Mac).
    func wentToSettings(_ via: String) {
        trip = .going
        settingsHow = nil
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.tripKey)
        UserDefaults.standard.removeObject(forKey: Self.howKey)
        step("settings", ["via": via])
    }

    /// How the system took the request to open Settings (2.8, В2.1): "direct" Safari's settings for ContextFlow were
    /// asked for and the system said yes, "app" the app's own page (an older iOS, or the direct way failed). Sent with
    /// "back": it's known only after the app has started leaving.
    private var settingsHow: String?
    private static let howKey = "cf_activation_settings_how"

    func settingsOpened(_ how: String) {
        settingsHow = how
        UserDefaults.standard.set(how, forKey: Self.howKey)
    }

    /// The app is no longer in front (Settings is).
    private func wentAway() {
        if trip == .going { trip = .away }
    }

    /// In front again after the trip to Settings: once a trip, within the hour. After a relaunch nothing is in memory,
    /// and the trip on disk is the sign the app left.
    func cameBack() {
        let defaults = UserDefaults.standard
        let at = defaults.double(forKey: Self.tripKey)
        guard at > 0, trip != .going else { return }
        trip = nil
        defaults.removeObject(forKey: Self.tripKey)
        let how = settingsHow ?? defaults.string(forKey: Self.howKey)
        defaults.removeObject(forKey: Self.howKey)
        if Date().timeIntervalSince1970 - at < 3600 { step("back", how.map { ["how": $0] } ?? [:]) }
    }

    /// The app first saw it switched on, once an install (an update that had it on before never sends it).
    private func reportEnabled() {
        // Not from «Start as a new user» (test builds): there the extension was on all along.
        guard !NewUserPreview.isOn else { return }
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.enabledReportedKey) else { return }
        defaults.set(true, forKey: Self.enabledReportedKey)
        step("enabled")
    }

    #if os(iOS)
    /// Whether Safari has the extension switched on, or nil when it can't say.
    @available(iOS 26.2, *)
    private static func safariSaysEnabled() async -> Bool? {
        await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
                continuation.resume(returning: state?.isEnabled)
            }
        }
    }
    #endif

    /// On every launch: the reminders to finish setup, once on a new install that isn't set up yet, then report
    /// "app opened" (once a day).
    ///
    /// 2.8 (В2.3, В2.6, the owner's decision of 2026-11-24): nothing asks about notifications at launch any more (the
    /// question came in the middle of setup, before anything useful had happened). The reminders go with quiet
    /// (provisional) permission instead: no question, delivered to Notification Center without a sound or a banner.
    /// The question itself comes at a moment of value (NotifyAsk).
    func launched() async {
        // Back from Settings in a new process (2.7): before refresh, which may count it switched on.
        cameBack()
        await refresh()
        let defaults = UserDefaults.standard
        if newInstall || NewUserPreview.isOn, state == .off, !defaults.bool(forKey: Self.remindersOfferedKey) {
            defaults.set(true, forKey: Self.remindersOfferedKey)
            await SetupReminders.schedule()
        }
        await reportOpen()
        await reportDeliveredReminders()
    }

    /// A reminder to finish setup that reached Notification Center (2.8, В1.1): seen by the app the next time it's in
    /// front (`launched`, on every launch and every return), so it's counted then, once a reminder. Tapping one is
    /// counted where the tap arrives (AppDelegate).
    private func reportDeliveredReminders() async {
        let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
        #if DEBUG
        NSLog("[cf-setup] delivered: %@", delivered.map(\.request.identifier).joined(separator: ","))
        #endif
        let defaults = UserDefaults.standard
        for (id, what) in zip(SharedDefaults.setupReminderIds, ["15m", "24h"]) where delivered.contains(where: { $0.request.identifier == id }) {
            let key = "cf_activation_reminder_\(what)"
            guard !defaults.bool(forKey: key) else { continue }
            defaults.set(true, forKey: key)
            step("reminder_seen", ["what": what], feature: "setup")
        }
    }

    /// What StoreKit attaches to a purchase, so the server knows which install subscribed: the
    /// extension's install id once known, else the app's own id.
    var accountToken: UUID? {
        SharedDefaults.shared.readExtensionStatus().installId.flatMap(UUID.init(uuidString:)) ?? UUID(uuidString: appId)
    }

    private var reporting = false

    private func reportOpen() async {
        let day = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        // Not while «Start as a new user» is on (test builds): the extension's state there isn't the device's real one.
        guard !reporting, !NewUserPreview.isOn, UserDefaults.standard.string(forKey: Self.openReportedKey) != day else { return }
        reporting = true
        defer { reporting = false }
        var body: [String: Any] = [
            "kind": "app_open",
            "appId": appId,
            "client": AppSource.client(platform: Self.platform, locale: Bundle.main.preferredLocalizations.first ?? ""),
            "extension": state.rawValue
        ]
        body["notifications"] = await SetupReminders.permission()
        if let installId = SharedDefaults.shared.readExtensionStatus().installId { body["installId"] = installId }
        let adToken = Self.adAttributionToken()
        if let adToken { body["adToken"] = adToken }
        // Production; a debug build's local stand (-CFApiBase) too, so test runs stay out of the real counts (2.7).
        var request = URLRequest(url: ChatAI.base.appendingPathComponent("api/v2/event"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 15
        if let (data, response) = try? await URLSession.shared.data(for: request),
           (response as? HTTPURLResponse)?.statusCode == 200 {
            UserDefaults.standard.set(day, forKey: Self.openReportedKey)
            if adToken != nil {
                let answer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["ads"] as? String
                AppSource.adAnswered(answer)
                let defaults = UserDefaults.standard
                // Apple may need a while to have the record ("pending"): try again on a later launch.
                defaults.set(answer == nil || answer == "pending" ? defaults.integer(forKey: Self.adsTriesKey) - 1 : 0, forKey: Self.adsTriesKey)
            }
        }
    }

    /// The AdServices token, sent with "app opened" until the server knows whether Apple Ads brought
    /// this install (at most 5 launches). It identifies nothing by itself; Apple answers with campaign,
    /// ad group and keyword ids, which let us see which keywords bring subscribers. No ATT needed.
    private static func adAttributionToken() -> String? {
        #if os(iOS)
        let defaults = UserDefaults.standard
        if defaults.object(forKey: adsTriesKey) == nil { defaults.set(5, forKey: adsTriesKey) }
        guard defaults.integer(forKey: adsTriesKey) > 0 else { return nil }
        return try? AAAttribution.attributionToken()
        #else
        // Apple Ads doesn't run on the Mac App Store.
        return nil
        #endif
    }

    private static var platform: String {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        #else
        "macos"
        #endif
    }
}

// MARK: - Where the app's events come from (2.8, В1.6)

/// What every app event carries besides its own fields, so organic installs and ads can be compared by country and
/// builds told apart: the build (CFBundleVersion), the App Store's storefront (its three-letter country code, as
/// StoreKit gives it; not the device's region or location), and whether Apple Ads brought this install ("ad": "yes"
/// or "no", once Apple has answered; a Mac never comes from Apple Ads). Nothing else, and nothing that identifies
/// anyone.
enum AppSource {
    private static let storefrontKey = "cf_storefront"
    private static let adKey = "cf_ads_source"

    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }

    /// The storefront as last read (StoreKit answers asynchronously; read at launch).
    static var storefront: String? { UserDefaults.standard.string(forKey: storefrontKey) }

    /// "yes" Apple Ads brought it, "no" Apple said it didn't (or a Mac), nil not known yet.
    static var ad: String? {
        #if os(macOS)
        return "no"
        #else
        return UserDefaults.standard.string(forKey: adKey)
        #endif
    }

    /// Reads the storefront once a launch: before the first events where it can.
    static func refresh() async {
        guard let code = await Storefront.current?.countryCode, code.range(of: "^[A-Z]{2,3}$", options: .regularExpression) != nil else { return }
        UserDefaults.standard.set(code, forKey: storefrontKey)
    }

    /// The server's answer to the AdServices token (Activation.reportOpen): "attributed" or "organic"; "pending" waits.
    static func adAnswered(_ answer: String?) {
        if answer == "attributed" { UserDefaults.standard.set("yes", forKey: adKey) }
        if answer == "organic" { UserDefaults.standard.set("no", forKey: adKey) }
    }

    /// The event's `client` (the server keeps build, sf and ad beside platform, version and locale).
    static func client(platform: String, locale: String) -> [String: String] {
        var client = [
            "platform": platform,
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "build": build,
            "locale": locale
        ]
        if let storefront { client["sf"] = storefront }
        if let ad { client["ad"] = ad }
        // 2.8 (В1.9): a simulator or debug build is ours, never a person.
        if OurBuild.isOurs { client["audience"] = "test" }
        return client
    }
}

#if os(iOS)
// MARK: - Notifications, asked with a reason (2.6)

/// The system's question about notifications can't say what they're for, so this screen comes first: reminders, pages
/// that change, and read aloud carried on from Safari when the page goes away or the screen locks. When they're off
/// (iOS asks only once), it opens the app's notification settings instead. Shown once after an Ultra purchase, when
/// Listen in Safari needs them (the extension can't ask: then the text plays here after), and at the panel's moments
/// of value (2.8, В3.2): a reminder set, a page watched, the day's free answers used up.
///
/// 2.8 (В2.3, the owner): no longer on a new install's first launch, in the middle of setting ContextFlow up. The
/// setup reminders go quietly instead (SetupReminders), and quiet permission counts here as not asked: this question
/// still comes at the first moment of value, and a yes turns the quiet permission into the full one.
///
/// The one way in for the panel: `contextflow://notifications?why=later|watch|answers_back` (and `&page=<https address>`
/// to go back to that page in Safari once it's answered). Everything that prompts the person is meant to go through
/// one hint coordinator (plan В3.1); until it exists, this is the only place that asks about notifications.
@MainActor
final class NotifyAsk: ObservableObject {
    static let shared = NotifyAsk()

    enum Reason: String {
        case ultra, listen
        /// The panel's moments of value (2.8): a reminder set, a page watched, a reminder for when the free answers are
        /// back.
        case later, watch, answers_back
    }

    struct Ask: Identifiable {
        let id = UUID()
        let reason: Reason
        /// Turned off: iOS won't ask again, only Settings can turn them on.
        let denied: Bool
        /// From Listen in Safari: the text handed over, played here once this is answered.
        let listen: String?
        /// The page in Safari the panel asked from, opened again once this is answered (2.8).
        var page: URL? = nil
    }

    @Published var ask: Ask?
    private static let ultraKey = "cf_notify_asked_ultra"

    /// Shown when notifications aren't on (not asked yet, only quiet, or turned off); otherwise a text handed over just
    /// plays.
    func show(_ reason: Reason, listen id: String? = nil, page: URL? = nil) async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard NotifyStatus.notAsked(status) || status == .denied else {
            // Already on (the panel hadn't heard yet): back to Safari, where it plays (build 93).
            if let id, !backToSafari(id) { play(id) }
            if id == nil, let page { Self.openInSafari(page) }
            return
        }
        ask = Ask(reason: reason, denied: status == .denied, listen: id, page: page)
        ChatAI.reportUse("notify", "shown", ["why": reason.rawValue, "status": status == .denied ? "denied" : status == .provisional ? "quiet" : "not_asked"])
    }

    /// The panel's link (2.8): `why` one of its moments, `page` the page to go back to (https or http only).
    func show(link url: URL) async {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in query.first { $0.name == name }?.value }
        guard let reason = value("why").flatMap(Reason.init(rawValue:)), reason != .listen, reason != .ultra else { return }
        let page = value("page").flatMap(URL.init(string:)).flatMap { $0.scheme == "https" || $0.scheme == "http" ? $0 : nil }
        await show(reason, page: page)
    }

    /// Once, after an Ultra purchase (read aloud carries on from Safari only with notifications).
    func afterUltra() async {
        guard !UserDefaults.standard.bool(forKey: Self.ultraKey) else { return }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard NotifyStatus.notAsked(status) || status == .denied else { return }
        UserDefaults.standard.set(true, forKey: Self.ultraKey)
        await show(.ultra)
    }

    func turnOn() async {
        guard let ask else { return }
        ChatAI.reportUse("notify", "on", ["why": ask.reason.rawValue])
        if ask.denied {
            // Back from Settings, the user goes on in Safari: Listen there plays in the panel now.
            self.ask = nil
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { await UIApplication.shared.open(url) }
            return
        }
        // Asked without .provisional: from quiet permission too, this is the system's real question.
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        finish()
    }

    func notNow() {
        if let ask { ChatAI.reportUse("notify", "later", ["why": ask.reason.rawValue]) }
        // Asked at Listen (build 95): not again today, here or in the panel (it asks at most once a day).
        if ask?.listen != nil { SharedDefaults.shared.setListenNotifyLater() }
        finish()
    }

    private func finish() {
        let id = ask?.listen
        let page = ask?.page
        ask = nil
        guard let id else {
            if let page { Self.openInSafari(page) }
            return
        }
        // Build 93 (the owner: "is it necessary to move it to the app if Safari wasn't hidden?"): with notifications on,
        // back to the page in Safari, where the panel plays it; without them, it plays here (and the panel says so).
        Task {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            if NotifyStatus.on(status), backToSafari(id) { return }
            SharedDefaults.shared.markListenTaken(id)
            play(id)
        }
    }

    /// The page the text came from, opened in Safari again with word to play it in the panel; false without one.
    private func backToSafari(_ id: String) -> Bool {
        guard let stored = SharedDefaults.shared.readListenRequest(id), let link = stored["url"] as? String,
              let page = URL(string: link), page.scheme == "https" || page.scheme == "http" else { return false }
        // 2.7: the word to play it goes in the page's address too (the panel no longer waits on a native message for it).
        let url = ListenLink.marked(page, id: id)
        SharedDefaults.shared.markListenReturn(id, play: true)
        ChatAI.reportUse("listen", "back_safari", ["what": stored["what"] as? String ?? "answer"])
        Task {
            // After this screen has gone.
            try? await Task.sleep(nanoseconds: 400_000_000)
            await UIApplication.shared.open(url)
        }
        return true
    }

    /// The page the panel asked from, in Safari itself (after this screen has gone).
    private static func openInSafari(_ page: URL) {
        Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            SafariPage.open(page)
        }
    }

    /// The text Listen handed over in Safari: played here (after this screen has gone).
    private func play(_ id: String) {
        guard let url = URL(string: "contextflow://listen?id=\(id)") else { return }
        Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            ListenPlayer.shared.open(url)
        }
    }
}

struct NotifyAskView: View {
    @ObservedObject var model: NotifyAsk
    let ask: NotifyAsk.Ask

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 12)
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Turn on notifications")
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
            if let lead {
                Text(lead)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 16) {
                row("speaker.wave.2.fill", "Keep listening when you leave Safari or lock the screen: a notification carries it on in the app, from the same second.")
                row("bell.fill", "Reminders you set on answers and notes.")
                row("eye.fill", "When a page you watch changes.")
            }
            .frame(maxWidth: 440, alignment: .leading)
            if ask.denied {
                Text("Notifications are off for ContextFlow. Turn them on in Settings, then come back to Safari.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: 12)
            Button {
                Task { await model.turnOn() }
            } label: {
                Text(ask.denied ? "Open Settings" : "Turn on notifications").frame(maxWidth: 440)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("notify.on")
            Button("Not now") { model.notNow() }
                .accessibilityIdentifier("notify.later")
        }
        .padding(24)
        .interactiveDismissDisabled()
    }

    /// What this moment needs them for (2.8: the panel's moments of value).
    private var lead: LocalizedStringKey? {
        switch ask.reason {
        case .later: return "So the reminder you just set reaches you."
        case .watch: return "So you hear when the page you watch changes."
        case .answers_back: return "So you know when your free answers are back."
        case .ultra, .listen: return nil
        }
    }

    private func row(_ icon: String, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(.tint)
                .frame(width: 26)
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
#endif

// MARK: - Reminders

/// Two local notifications on a new install, 15 minutes and a day after the first launch, unless the
/// extension is switched on before (the extension's native handler or the app withdraws them).
///
/// 2.8 (В2.6, the owner's yes of 2026-11-24): with quiet (provisional) permission, granted without a question. They're
/// delivered to Notification Center, without a banner or a sound, so they reach people who were never asked. Nothing
/// else is sent with quiet permission: every other notification counts it as not asked (NotifyStatus). Where
/// notifications are fully on already, they come as usual; turned off, they don't come.
enum SetupReminders {
    static func schedule() async {
        let center = UNUserNotificationCenter.current()
        var quiet = true
        #if DEBUG
        // Comparisons on the simulator (2.8: the extension's own reminders after quiet permission): `-CFDebugNoQuiet YES`
        // takes no quiet permission, as 2.7 didn't.
        if UserDefaults.standard.bool(forKey: "CFDebugNoQuiet") { quiet = false }
        #endif
        if quiet, await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .provisional])
        }
        let status = await center.notificationSettings().authorizationStatus
        guard NotifyStatus.on(status) || status == .provisional else { return }
        await MainActor.run { Activation.shared.remindersScheduled(status == .provisional ? "quiet" : "on") }
        let ids = SharedDefaults.setupReminderIds
        center.removePendingNotificationRequests(withIdentifiers: ids)
        #if os(iOS)
        let first = String(localized: "In Settings, go to Apps → Safari → Extensions → ContextFlow and switch it on. Tap to see how.")
        #else
        let first = String(localized: "In Safari, choose Settings → Extensions and tick ContextFlow. Click to see how.")
        #endif
        let reminders: [(id: String, after: TimeInterval, title: String, body: String)] = [
            (ids[0], 15 * 60, String(localized: "One step left: turn on ContextFlow"), first),
            (ids[1], 24 * 3600, String(localized: "Your AI for Safari is waiting"),
             String(localized: "Turn on ContextFlow to summarize any page in one tap. 5 free answers every day."))
        ]
        for (index, reminder) in reminders.enumerated() {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            // Its tap is counted and opens the setup guide (AppDelegate).
            content.userInfo = ["setup": index == 0 ? "15m" : "24h"]
            var after = reminder.after
            #if DEBUG
            // Simulator checks of the quiet reminder: `-CFDebugSetupReminderSeconds 20` brings the first one forward.
            let soon = UserDefaults.standard.double(forKey: "CFDebugSetupReminderSeconds")
            if soon > 0, index == 0 { after = soon }
            #endif
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: after, repeats: false)
            try? await center.add(UNNotificationRequest(identifier: reminder.id, content: content, trigger: trigger))
        }
    }

    static func cancel() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: SharedDefaults.setupReminderIds)
        center.removeDeliveredNotifications(withIdentifiers: SharedDefaults.setupReminderIds)
    }

    /// For the funnel: whether reminders can reach the user.
    static func permission() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: return "not_asked"
        case .denied: return "denied"
        case .provisional: return "quiet"
        default: return "granted"
        }
    }
}

// MARK: - The page Safari opens on from the app

/// Where «Open Safari» leads (2.7 (110), the owner on TestFlight 109: «Плохо, что при первом открытии Safari из
/// приложения открывается Google поиск, лучше открывать наш сайт»). Until 110 it was a web search for "ContextFlow".
/// Now it's the site's page about what ContextFlow does, in the person's language: a page with text of its own, so
/// the panel's first request (Summarize, then a question about a selection) has something to work on.
///
/// Only a page that is in production: a new page gets there with a production deploy of the site, and a TestFlight
/// build must not lead to a 404. `live` are the site's languages that answered there when 110 was built; a language
/// translated since (`later`) is asked for once, before the first use, and until it answers the English page is used.
enum FirstPage {
    static let site = "https://context-flow.app"
    static let page = "features"
    /// The visit is counted apart from the people who typed the address (the site's counter reads utm_source).
    static let source = "utm_source=app"
    static let live: Set<String> = ["ar", "de", "es", "fr", "it", "ja", "ko", "pt-br", "ru", "uk", "vi", "zh-hans", "zh-hant"]
    static let later: Set<String> = ["tr"]

    /// The site's folder for one of the app's languages ("pt-BR" → "pt-br"); nil for English, whose pages are at the root.
    static func folder(_ localization: String) -> String? {
        let name = localization.lowercased().replacingOccurrences(of: "_", with: "-")
        return name == "en" || name.hasPrefix("en-") ? nil : name
    }

    /// The page for the app's language: its own where the site has it (`confirmed`: the `later` ones that answered),
    /// the English one otherwise.
    static func address(localization: String, confirmed: Set<String>) -> String {
        if let folder = folder(localization), live.contains(folder) || (later.contains(folder) && confirmed.contains(folder)) {
            return "\(site)/\(folder)/\(page)?\(source)"
        }
        return "\(site)/\(page)?\(source)"
    }

    private static let confirmedKey = "cf_first_page_confirmed"
    private static var localization: String { Bundle.main.preferredLocalizations.first ?? "en" }
    private static var confirmed: Set<String> { Set(UserDefaults.standard.stringArray(forKey: confirmedKey) ?? []) }

    /// The address to open now.
    static var url: URL? { URL(string: address(localization: localization, confirmed: confirmed)) }

    /// A `later` language's page asked for once it's needed (nothing for the others): remembered when it answers.
    static func confirm() async {
        guard let folder = folder(localization), later.contains(folder), !confirmed.contains(folder),
              let url = URL(string: "\(site)/\(folder)/\(page)") else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "HEAD"
        guard let (_, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        UserDefaults.standard.set(Array(confirmed.union([folder])), forKey: confirmedKey)
    }

    #if os(iOS)
    /// Safari itself with the page (iOS 17 and later: the x-safari- scheme opens Safari even when another browser is
    /// the default); before that, the page in the default browser.
    @MainActor
    static func open() {
        Task { @MainActor in
            await confirm()
            show()
        }
    }

    /// Not in the task itself: there `open` would be UIApplication's async one.
    @MainActor
    private static func show() {
        guard let page = url else { return }
        SafariPage.open(page)
    }
    #endif
}

#if os(iOS)
// MARK: - A page in Safari itself

/// A page opened in Safari itself, not another default browser (the panel lives in Safari): on iOS 17 and later through
/// the x-safari- scheme. 2.8 (found by the limit session): iOS handles x-safari-https only, an x-safari-http address does
/// nothing; an http page, or a failed x-safari- one, opens as it is (the default browser). One rule for every place.
@MainActor
enum SafariPage {
    /// The address that opens `page` in Safari itself, or nil where only the page's own address can.
    static func safariURL(_ page: URL) -> URL? {
        guard page.scheme?.lowercased() == "https" else { return nil }
        if #available(iOS 17, *) { return URL(string: "x-safari-\(page.absoluteString)") }
        return nil
    }

    static func open(_ page: URL) {
        if let safari = safariURL(page) {
            UIApplication.shared.open(safari) { opened in if !opened { UIApplication.shared.open(page) } }
        } else {
            UIApplication.shared.open(page)
        }
    }
}

// MARK: - Setup guide (iOS)

/// Where «Open Settings» lands, and so what the card, its footnote and the guide over Settings show (2.8, В2.1).
enum SetupPath {
    /// The iPhone on iOS 26.2 and later: Safari's settings are asked to open on ContextFlow's own page (2.6), but
    /// where they land isn't proven (2.8: the iPhone simulators land on Settings' first page, and the system reports
    /// success either way). The whole way is shown, and the footnote reads right whichever page opens.
    case maybeDirect
    /// The iPad (2.8, the owner's iPad and the iPad simulators): the same call opens Settings on Apps or on its first
    /// page, never on ContextFlow's. The whole way is shown, from Apps on the left.
    case fromApps
    /// iOS before 26.2: the app's own page in Settings, from where «Apps» at the top left leads on.
    case appPage

    static var current: SetupPath {
        if UIDevice.current.userInterfaceIdiom == .pad { return .fromApps }
        if #available(iOS 26.2, *) { return .maybeDirect }
        return .appPage
    }

    /// The walkthrough's screens the guide over Settings plays.
    var phases: [Int] { Array(0..<6) }

    /// The first written step: on iPad it starts where Settings opens.
    /// 2.8: the Apps list has ContextFlow itself in view (above Safari), and its page has no extension switch: the step
    /// says Safari, not ContextFlow.
    var firstStep: LocalizedStringKey {
        self == .fromApps ? "In Settings, tap Apps on the left, then Safari in the list (not ContextFlow), then Extensions."
            : "Open the Settings app and go to Apps → Safari (not ContextFlow) → Extensions."
    }

    /// No ✦ on any page: All Websites is still Ask. 2.8 (acceptance 2): the way that has worked every time, on iPad and
    /// iPhone, is Settings (ContextFlow's page → All Websites → Allow). Safari's own question (behind the puzzle-piece
    /// button on iPad, in the page menu on iPhone) has not been seen to grant anything yet, so it's never the fix here,
    /// only a side note.
    static var allowFirstStep: LocalizedStringKey {
        UIDevice.current.userInterfaceIdiom == .pad
            ? "Tap Open Settings, then Apps on the left → Safari (not ContextFlow) → Extensions → ContextFlow."
            : "Tap Open Settings and go to Apps → Safari (not ContextFlow) → Extensions → ContextFlow."
    }
}

/// The home screen's first card: how to switch ContextFlow on, shown as the Settings screens themselves
/// with each tap played out; then the «Open Safari» step until the panel has been opened once.
struct SetupCard: View {
    @ObservedObject var activation: Activation
    var openSafari: () -> Void

    var body: some View {
        switch activation.state {
        case .off:
            guide.onAppear {
                activation.instructionShown()
                SettingsPiP.shared.prepare(phases: path.phases, path: path)
            }
        case .on: safariStep.onAppear { activation.safariStepShown() }
        case .inUse: ready
        }
    }

    private let path = SetupPath.current

    private var guide: some View {
        Card(title: "Turn on ContextFlow", systemImage: "switch.2") {
            SettingsWalkthrough(path: path)
                // The picture-in-picture guide's source: in the window, under the walkthrough it shows.
                .background(PiPSource(layer: SettingsPiP.shared.layer))
            Button(action: openSettingsWithGuide) {
                Label("Open Settings", systemImage: "gear")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 4)
            .accessibilityIdentifier("cf-setup-settings")
            switch path {
            case .maybeDirect:
                // 2.8: true whether Settings opens on ContextFlow's page or on its first page.
                Text("If Settings opens on ContextFlow's page, start at step 2. If not, start from Apps.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case .fromApps:
                // 2.8 (В2.1): what happens, not what we'd like to happen.
                Text("On iPad, Settings doesn't open on ContextFlow's page: start from Apps on the left and follow the steps above.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case .appPage:
                Text("Settings opens on ContextFlow's page: tap “Apps” at the top left, then follow the steps above.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // This iOS can't tell the app it's on until the panel is used: the way on from here.
                Button {
                    activation.openedSafari("guide")
                    openSafari()
                } label: {
                    Label("Switched it on? Open Safari", systemImage: "safari")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    /// With the guide floating over Settings where picture in picture works (2.6, the owner: "like Chrome, a video
    /// over the windows with the steps"); else Settings alone.
    private func openSettingsWithGuide() {
        SettingsPiP.shared.start(phases: path.phases, path: path, then: openExtensionSettings)
    }

    private func openExtensionSettings() { openExtensionSettings(via: "card") }

    /// `via`: "card" the switch-it-on step, "allow" the «Open Safari» step's way to All Websites: Allow (2.8).
    private func openExtensionSettings(via: String) {
        activation.wentToSettings(via)
        let appSettings = {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            activation.settingsOpened("app")
        }
        if #available(iOS 26.2, *) {
            // Also on iPad, where it lands on Apps (the nearest to ContextFlow's page it gets there).
            SFSafariSettings.openExtensionsSettings(forIdentifiers: [extensionBundleIdentifier]) { error in
                #if DEBUG
                NSLog("[cf-setup] openExtensionsSettings: %@", error.map { String(describing: $0) } ?? "no error")
                #endif
                DispatchQueue.main.async {
                    if error != nil { appSettings() } else { activation.settingsOpened("direct") }
                }
            }
        } else {
            appSettings()
        }
    }

    /// 2.8 (В2.4): switched on, never used on a page. The next step is the app's own: one big button to Safari, and
    /// what to tap there (✦, then Safari's own question about the extension).
    private var safariStep: some View {
        Card(title: "Next: open Safari", systemImage: "safari") {
            Text("ContextFlow is on in Safari.")
                .font(.callout.weight(.semibold))
            // Above the clip: on an iPhone the button is on the first screen without scrolling.
            safariButton("step", large: true)
            // With All Websites left on Ask (the step people skip in Settings), no ✦ shows on any page. Back from Safari with
            // the panel still unused, the fix that has worked every time comes first: Settings, with its own button.
            if activation.backFromSafariUnused {
                Text("No ✦ on the page? ContextFlow isn't allowed on websites yet.")
                    .font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Step(number: 1, text: SetupPath.allowFirstStep)
                // Acceptance 3: after «Don't Allow» in Safari's own question, Settings lists the websites one by one
                // (Deny) and «Other Websites» instead of All Websites, and a denied website stays denied under Other
                // Websites: Allow. Seen working: every row of that list set to Allow, then ✦ on the page.
                Step(number: 2, text: "Under Permissions, set All Websites to Allow. If you see a list of websites there instead, set every row in it to Allow.")
                // How it really goes back: Settings' own way back (top left) leads to the app, not to Safari, and Open
                // Safari opens the page in a new tab, loaded afresh (nothing to reload).
                Step(number: 3, text: "Tap ◀ ContextFlow at the top left, then Open Safari, and tap ✦ on the page.")
                Button {
                    // Acceptance 3: on iPad the floating strip sits over Settings' Back button, and after «Don't Allow»
                    // in Safari's question this trip needs Back after every website in the list (seen: blocked under
                    // the strip). Here the iPad goes without it; the steps above are the guide.
                    if path == .fromApps {
                        openExtensionSettings(via: "allow")
                    } else {
                        SettingsPiP.shared.start(phases: path.phases, path: path) { openExtensionSettings(via: "allow") }
                    }
                } label: {
                    Label("Open Settings", systemImage: "gear")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("cf-setup-allow-settings")
                // The picture-in-picture guide's source, as on the switch-it-on step.
                .background(PiPSource(layer: SettingsPiP.shared.layer))
            } else {
                Step(number: 1, text: "Tap ✦ on the page.")
                Step(number: 2, text: "No ✦? In Settings, set All Websites to Allow for ContextFlow (Apps → Safari → Extensions → ContextFlow).")
            }
            Text("If Safari asks about a website, choose Always Allow.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let url = TipClip.url("open") {
                TipClipView(url: url)
                    .aspectRatio(TipClip.aspect, contentMode: .fit)
                    .frame(maxWidth: TipClip.width)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.08)))
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// 2.8: the iPad's page menu has no extensions; ContextFlow is behind the puzzle-piece button there (seen opening the
    /// panel on iPadOS 26.5 and 27 once allowed).
    private static var readyText: LocalizedStringKey {
        UIDevice.current.userInterfaceIdiom == .pad
            ? "Open any page and tap ✦ — or tap the puzzle-piece button next to the address and choose ContextFlow."
            : "Open any page and tap ✦ — or choose ContextFlow in the page menu of the address bar."
    }

    private var ready: some View {
        Card(title: "ContextFlow is on in Safari", systemImage: "checkmark.seal.fill") {
            Text(Self.readyText)
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            safariButton("card", large: false)
        }
    }

    private func safariButton(_ via: String, large: Bool) -> some View {
        Button {
            activation.openedSafari(via)
            openSafari()
        } label: {
            Label("Open Safari", systemImage: "safari")
                .font(large ? .title3.weight(.semibold) : .headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, large ? 10 : 6)
        }
        .buttonStyle(.borderedProminent)
        .padding(.top, 4)
        .accessibilityIdentifier("cf-setup-safari")
    }
}

/// The Settings screens on the way to switching ContextFlow on, drawn like iOS Settings and stepped
/// through on their own (tap to skip ahead). With Reduce Motion it waits for taps.
struct SettingsWalkthrough: View {
    var path: SetupPath = .current
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = 0
    private static let phases = 6

    // Which written step each screen belongs to.
    private var step: Int { phase < 2 ? 1 : phase < 4 ? 2 : 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsScreen(phase: phase)
                .frame(height: 216)
                .contentShape(Rectangle())
                .onTapGesture { advance() }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Settings, Apps, Safari, Extensions, ContextFlow: Allow Extension on, All Websites: Allow."))
            VStack(alignment: .leading, spacing: 10) {
                Step(number: 1, text: path.firstStep)
                    .opacity(step == 1 ? 1 : 0.45)
                Step(number: 2, text: "Tap ContextFlow and switch it on.")
                    .opacity(step == 2 ? 1 : 0.45)
                Step(number: 3, text: "Under Permissions, set All Websites to Allow.")
                    .opacity(step == 3 ? 1 : 0.45)
            }
            .animation(.easeInOut(duration: 0.25), value: step)
        }
        .task(id: reduceMotion) {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: phase == Self.phases - 1 ? 3_200_000_000 : 2_100_000_000)
                if Task.isCancelled { break }
                advance()
            }
        }
    }

    private func advance() {
        withAnimation(.easeInOut(duration: 0.35)) { phase = (phase + 1) % Self.phases }
    }
}

/// One screen of the walkthrough: 0 Apps → Safari, 1 Safari → Extensions, 2 Extensions → ContextFlow,
/// then ContextFlow's page: 3 tap Allow Extension, 4 it is on, tap All Websites, 5 All Websites: Allow.
private struct SettingsScreen: View {
    let phase: Int
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            navBar
            ZStack {
                content
                    .id(min(phase, 3))
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .clipped()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.primary.opacity(0.12)))
    }

    private var titles: (back: LocalizedStringKey, title: LocalizedStringKey) {
        switch phase {
        case 0: return ("Settings (the iOS app)", "Apps")
        case 1: return ("Apps", "Safari")
        case 2: return ("Safari", "Extensions")
        default: return ("Extensions", "ContextFlow")
        }
    }

    private var navBar: some View {
        ZStack {
            Text(titles.title).font(.subheadline.weight(.semibold))
            HStack(spacing: 2) {
                Image(systemName: "chevron.backward").font(.footnote.weight(.semibold))
                Text(titles.back).font(.subheadline)
                Spacer()
            }
            .foregroundColor(.accentColor)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .id(min(phase, 3))
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case 0:
            group {
                placeholderRow(color: .blue)
                placeholderRow(color: .yellow)
                row(icon: AnyView(appIcon("safari", .blue)), title: "Safari", highlighted: true)
                placeholderRow(color: .green)
            }
        case 1:
            group {
                placeholderRow(color: .gray)
                placeholderRow(color: .blue)
                row(icon: AnyView(appIcon("puzzlepiece.extension.fill", .indigo)), title: "Extensions", highlighted: true)
                placeholderRow(color: .gray)
            }
        case 2:
            group {
                row(icon: AnyView(Image("LargeIcon").resizable().frame(width: 26, height: 26).clipShape(RoundedRectangle(cornerRadius: 6))),
                    title: "ContextFlow", highlighted: true)
                placeholderRow(color: .orange)
            }
        default:
            VStack(alignment: .leading, spacing: 6) {
                group {
                    HStack {
                        Text("Allow Extension").font(.subheadline)
                        Spacer()
                        DrawnSwitch(on: phase >= 4)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .background(highlight(phase == 3, ringTrailing: 22))
                }
                Text("Permissions").textCase(.uppercase).font(.caption2).foregroundColor(.secondary).padding(.leading, 26).padding(.top, 4)
                group {
                    HStack {
                        Text("All Websites").font(.subheadline)
                        Spacer()
                        Text(phase >= 5 ? "Allow" : "Ask").font(.subheadline).foregroundColor(phase >= 5 ? .accentColor : .secondary)
                        Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).foregroundColor(Color.secondary.opacity(0.6))
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .background(highlight(phase >= 4))
                }
            }
        }
    }

    private func group<Content: View>(@ViewBuilder _ rows: () -> Content) -> some View {
        VStack(spacing: 0) { rows() }
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.horizontal, 14)
            .padding(.top, 8)
    }

    private func row(icon: AnyView, title: LocalizedStringKey, highlighted: Bool) -> some View {
        HStack(spacing: 10) {
            icon
            Text(title).font(.subheadline)
            Spacer()
            Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).foregroundColor(Color.secondary.opacity(0.6))
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(highlight(highlighted))
    }

    /// Another app's row, left blank: only the way to ContextFlow matters.
    private func placeholderRow(color: Color) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 6).fill(color.opacity(0.35)).frame(width: 26, height: 26)
            Capsule().fill(Color.secondary.opacity(0.18)).frame(width: 90, height: 9)
            Spacer()
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
    }

    private func appIcon(_ symbol: String, _ color: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 14, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: 26, height: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(color))
    }

    /// The row being tapped: tinted, with a touch circle where the finger goes (the chevron, or the switch).
    private func highlight(_ on: Bool, ringTrailing: CGFloat = 4) -> some View {
        ZStack(alignment: .trailing) {
            if on {
                Color.accentColor.opacity(scheme == .dark ? 0.28 : 0.14)
                TouchRing().padding(.trailing, ringTrailing)
            }
        }
    }
}

/// The switch in the walkthrough, drawn: the same in the card and in the picture-in-picture frames.
private struct DrawnSwitch: View {
    let on: Bool

    var body: some View {
        Capsule()
            .fill(on ? Color.green : Color(uiColor: .systemFill))
            .frame(width: 41, height: 25)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(Color.white).frame(width: 21, height: 21).padding(2).shadow(color: .black.opacity(0.15), radius: 1, y: 1)
            }
            .accessibilityHidden(true)
    }
}

// MARK: - The guide over Settings (picture in picture)

/// The walkthrough's screens floating over Settings while the person switches ContextFlow on (2.6, the owner's note:
/// "like Chrome, a video over the windows with the steps"). "Open Settings" starts it, then opens Settings; it stops
/// when the app is active again. The frames are the walkthrough's own screens with their step, drawn in the app's
/// language (no recorded clip per language), fed to a sample-buffer layer on a timeline, so they keep playing while
/// the app is in the background. It uses the "Audio, AirPlay, and Picture in Picture" background mode and a silent
/// playback audio session mixed with others (the person's music keeps playing). Where picture in picture isn't
/// possible, or doesn't start in time, Settings just opens, as before.
@MainActor
final class SettingsPiP: NSObject {
    static let shared = SettingsPiP()
    let layer = AVSampleBufferDisplayLayer()
    private var controller: AVPictureInPictureController?
    private var frames: [CVPixelBuffer] = []
    private var phases: [Int] = []
    private var path: SetupPath?
    /// The app went to the background since the guide started (Settings is in front).
    private var away = false
    private var queued = 0
    private var pendingOpen: (() -> Void)?
    /// Each screen this long, as in the card.
    private static let hold = CMTime(value: 22, timescale: 10)
    /// Frames queued ahead: about ten minutes of the loop.
    private static let maxFrames = 270

    private override init() {
        super.init()
        layer.videoGravity = .resizeAspect
        // Back in the app, the guide goes (2.8): from the system itself, as Activation's trip does. SwiftUI's scene phase
        // didn't arrive on the way back in the simulators, and the guide floated on over Safari afterwards. Only once the
        // app is active again (stopping it while the app is still coming to the front left a black window), and only
        // after the app really left (starting the guide doesn't count).
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in SettingsPiP.shared.away = true }
        }
        // From Settings straight to Safari, the app never comes back to the front: the extension says when the panel opens
        // (a Darwin notice), and the guide goes then.
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            #if DEBUG
            NSLog("[cf-setup] panel opened: the guide goes")
            #endif
            Task { @MainActor in SettingsPiP.shared.stop() }
        }, SharedDefaults.panelOpenedNotice as CFString, nil, .deliverImmediately)
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in
                guard SettingsPiP.shared.away else { return }
                SettingsPiP.shared.away = false
                SettingsPiP.shared.stop()
            }
        }
    }

    private func makeController() -> AVPictureInPictureController? {
        if let controller { return controller }
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return nil }
        let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: layer, playbackDelegate: self)
        let made = AVPictureInPictureController(contentSource: source)
        made.delegate = self
        made.requiresLinearPlayback = true
        controller = made
        return made
    }

    /// Floats the screens for `phases` (Settings opens on ContextFlow's page on 26.2+: the last three), then calls
    /// `open` once the window shows, or at once when it can't.
    /// The controller and the frames made ahead, when the card shows (2.8: on the first tap of a process the system's
    /// picture in picture wasn't ready yet, and the guide floated only on the second tap; the simulator showed the same).
    func prepare(phases: [Int], path: SetupPath) {
        guard makeController() != nil else { return }
        render(phases: phases, path: path)
    }

    private func render(phases: [Int], path: SetupPath) {
        guard phases != self.phases || path != self.path || frames.isEmpty else { return }
        self.phases = phases
        self.path = path
        frames = phases.compactMap { Self.frame(phase: $0, path: path) }
    }

    func start(phases: [Int], path: SetupPath, then open: @escaping () -> Void) {
        guard let controller = makeController() else {
            #if DEBUG
            NSLog("[cf-setup] guide start: picture in picture not supported")
            #endif
            return open()
        }
        render(phases: phases, path: path)
        #if DEBUG
        NSLog("[cf-setup] guide start: phases %@ frames %d size %@ possible %@", phases.description, frames.count,
              frames.first.map { "\(CVPixelBufferGetWidth($0))x\(CVPixelBufferGetHeight($0))" } ?? "-",
              controller.isPictureInPicturePossible ? "yes" : "no")
        #endif
        guard !frames.isEmpty else { return open() }
        // If it hasn't started by the time Settings is in front, it starts as the app leaves (this trip only).
        if #available(iOS 14.2, *) { controller.canStartPictureInPictureAutomaticallyFromInline = true }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try? session.setActive(true)
        play()
        pendingOpen = open
        // 2.8: started once the system says it's possible, not at once: the layer has no frame yet at this point, and an
        // early start failed (the director's iPad: no guide on the first try, the guide on the second).
        startWhenPossible(controller, tries: 9)
        // Not possible on this device right now, or slow to start: Settings opens anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.openPending() }
    }

    private func startWhenPossible(_ controller: AVPictureInPictureController, tries: Int) {
        guard pendingOpen != nil else { return }
        if controller.isPictureInPicturePossible || tries == 0 {
            #if DEBUG
            NSLog("[cf-setup] guide startPictureInPicture: possible %@ tries left %d layer status %d",
                  controller.isPictureInPicturePossible ? "yes" : "no", tries, layer.status.rawValue)
            #endif
            controller.startPictureInPicture()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.startWhenPossible(controller, tries: tries - 1) }
    }

    /// Back in the app: the window goes, and so does its last frame. 2.8 (В2.2): `flush()` kept the frame on the layer,
    /// which lives in the card under the walkthrough: back from Settings, a white box with the last step's caption
    /// stayed over the steps (and where picture in picture didn't start, the frames played there).
    func stop() {
        #if DEBUG
        NSLog("[cf-setup] guide stop: active %@ queued %d", controller?.isPictureInPictureActive == true ? "yes" : "no", queued)
        #endif
        guard controller?.isPictureInPictureActive == true || queued > 0 else { return }
        // Not on the next time the app goes to the background.
        if #available(iOS 14.2, *) { controller?.canStartPictureInPictureAutomaticallyFromInline = false }
        // Floating: it closes first, and its frames go when it has (the delegate's didStop); emptied while it was still
        // up, the window turned black. Not floating: the frames go now.
        if controller?.isPictureInPictureActive == true {
            controller?.stopPictureInPicture()
            // In the background (the panel opened in Safari) the system ignores stopPictureInPicture: without its content
            // and its controller the window goes. A new controller is made for the next time.
            if UIApplication.shared.applicationState != .active {
                controller?.contentSource = nil
                controller = nil
                clear()
            }
        } else {
            clear()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Nothing queued and nothing shown on the layer.
    private func clear() {
        layer.stopRequestingMediaData()
        layer.flushAndRemoveImage()
        queued = 0
    }

    private func openPending() {
        let open = pendingOpen
        pendingOpen = nil
        open?()
    }

    /// The loop of screens on the layer's own clock: queued ahead, so it plays without the app running. Fed on the
    /// main queue (the app's code is main-actor by default): the frames are few and go in at once.
    private func play() {
        layer.stopRequestingMediaData()
        layer.flush()
        var timebase: CMTimebase?
        CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault, sourceClock: CMClockGetHostTimeClock(), timebaseOut: &timebase)
        if let timebase {
            CMTimebaseSetTime(timebase, time: .zero)
            CMTimebaseSetRate(timebase, rate: 1)
            layer.controlTimebase = timebase
        }
        queued = 0
        let frames = self.frames
        let layer = self.layer
        var index = 0
        layer.requestMediaDataWhenReady(on: .main) {
            while layer.isReadyForMoreMediaData && index < Self.maxFrames {
                let at = CMTimeMultiply(Self.hold, multiplier: Int32(index))
                if let sample = Self.sample(frames[index % frames.count], at: at) { layer.enqueue(sample) }
                index += 1
            }
            if index >= Self.maxFrames { layer.stopRequestingMediaData() }
        }
        queued = Self.maxFrames
    }

    /// One screen with its step under it, drawn like the card's walkthrough, as a video frame.
    private static func frame(phase: Int, path: SetupPath) -> CVPixelBuffer? {
        let step: LocalizedStringKey = phase < 2 ? path.firstStep
            : phase < 4 ? "Tap ContextFlow and switch it on." : "Under Permissions, set All Websites to Allow."
        let view: AnyView
        if path == .fromApps {
            // 2.8 (the director's acceptance, iPad): a picture of a screen made a tall window over the right-hand pane,
            // hiding the very rows to tap (ContextFlow on the Extensions list, and its caption sat over the wrong
            // ContextFlow row on Apps). On iPad the guide is a short strip instead: the whole path, the step to tap now
            // marked, so it reads right on whichever screen the person is.
            //
            // Acceptance 3 (iPad mini, 26.5): the system sizes the window, not the app. Strips 92, 140, 200 and 280 high
            // all floated 465 points wide at the top right (465×74 … 465×231); the square screens of 2.7.1, 333×311.
            // So no shape clears Settings' Back button (under the strip's left end) without covering the rows to tap.
            // The switch-on trip needs no Back (each step goes forward; Apps on the left starts it again from any screen),
            // and the window drags away like any picture in picture: both seen. The «No ✦» trip does need Back (one row
            // per website after «Don't Allow»): on iPad it goes without the strip (SetupCard).
            view = AnyView(pathStrip(phase: phase)
                .padding(.horizontal, 14)
                .frame(width: 560, height: 92)
                .background(Color(uiColor: .systemBackground)))
        } else {
            view = AnyView(VStack(spacing: 10) {
                SettingsScreen(phase: phase).frame(height: 216)
                Text(step)
                    .font(.footnote.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(width: 320, height: 300, alignment: .top)
            .background(Color(uiColor: .systemBackground)))
        }
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage else { return nil }
        var buffer: CVPixelBuffer?
        let attrs = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, image.width, image.height, kCVPixelFormatType_32BGRA, attrs, &buffer) == kCVReturnSuccess, let buffer else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer), width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return buffer
    }

    /// The path in Settings as one line, the names Settings itself shows: the step for this screen marked, the ones
    /// before it dimmed (phase 0 marks Apps and Safari: the iPad starts from Apps on the left).
    private static func pathStrip(phase: Int) -> some View {
        let names = [String(localized: "Apps"), "Safari", String(localized: "Extensions"), "ContextFlow",
                     String(localized: "Allow Extension"), String(localized: "All Websites"), String(localized: "Allow")]
        let now: Set<Int> = phase == 0 ? [0, 1] : [phase + 1]
        var line = AttributedString()
        for (index, name) in names.enumerated() {
            if index > 0 {
                var arrow = AttributedString("  ›  ")
                arrow.foregroundColor = .secondary
                line += arrow
            }
            var part = AttributedString(name)
            if now.contains(index) {
                part.foregroundColor = .accentColor
                part.font = .system(size: 17, weight: .bold)
            } else {
                part.foregroundColor = index < (now.min() ?? 0) ? .secondary : .primary
            }
            line += part
        }
        return Text(line)
            .font(.system(size: 15, weight: .medium))
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private nonisolated static func sample(_ buffer: CVPixelBuffer, at time: CMTime) -> CMSampleBuffer? {
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format)
        guard let format else { return nil }
        var timing = CMSampleTimingInfo(duration: hold, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        return sample
    }
}

extension SettingsPiP: AVPictureInPictureControllerDelegate {
    #if DEBUG
    nonisolated func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        NSLog("[cf-setup] guide willStart")
    }
    #endif

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        #if DEBUG
        NSLog("[cf-setup] guide didStart")
        #endif
        Task { @MainActor in
            Activation.shared.guideStarted()
            self.openPending()
        }
    }

    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        #if DEBUG
        NSLog("[cf-setup] guide failedToStart: %@", "\(error)")
        #endif
        // 2.8: the frames stay queued, so it can still start as the app leaves for Settings (allowed for this trip); back
        // in the app, stop() takes them off the card (В2.2).
        Task { @MainActor in self.openPending() }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        #if DEBUG
        NSLog("[cf-setup] guide didStop")
        #endif
        // Closed by the person over Settings, or stopped on the way back: its frame doesn't come back into the card.
        Task { @MainActor in self.clear() }
    }
}

extension SettingsPiP: AVPictureInPictureSampleBufferPlaybackDelegate {
    // A guide, not a film: no pausing or skipping, always "live".
    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {}

    nonisolated func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
    }

    nonisolated func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool { false }

    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}

/// Puts the guide's layer in the window (picture in picture needs its source there), filling the view it's behind.
private struct PiPSource: UIViewRepresentable {
    let layer: AVSampleBufferDisplayLayer

    func makeUIView(context: Context) -> UIView {
        let view = LayerHost()
        view.hosted = layer
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    final class LayerHost: UIView {
        var hosted: CALayer? {
            didSet {
                oldValue?.removeFromSuperlayer()
                if let hosted { layer.addSublayer(hosted) }
            }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            hosted?.frame = bounds
        }
    }
}

/// A pulsing circle where the finger goes.
private struct TouchRing: View {
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(Color.accentColor.opacity(0.25))
            .overlay(Circle().stroke(Color.accentColor.opacity(0.7), lineWidth: 2))
            .frame(width: 26, height: 26)
            .scaleEffect(pulse ? 1.15 : 0.85)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulse = true }
            }
    }
}
#endif

// MARK: - Test builds: starting as a new user (2.7)

/// Whether this is a build for testing, never the App Store's: a debug build, or a release build that talks to a test
/// server.
/// - The server: the build submitted to the App Store talks to production (ChatAI.base as it is on main); only the
///   TestFlight builds made from the test branch have that line changed to a deploy preview's address. App Review
///   runs the App Store's own binary, so neither a reviewer nor anyone with the store's app sees a test row.
/// - Not the receipt any more (2.7 (108), the owner on TestFlight, about «Start as a new user»: «Не нашел»). Until 109
///   an iPhone or iPad build also had to carry TestFlight's receipt name at Bundle.main.appStoreReceiptURL. That
///   property is deprecated, what it gives on a TestFlight install can't be seen in a simulator, and it kept nothing
///   out that the server doesn't: a reviewer's receipt is a sandbox one as well. StoreKit's AppTransaction would say
///   the same thing later, through a request that can fail, while this is read at launch. So every platform decides
///   as the Mac always did.
enum TestBuild {
    static let isTest: Bool = {
        #if DEBUG
        return true
        #else
        return releaseIsTest(server: ChatAI.base)
        #endif
    }()

    /// A release build: a test build when its server isn't production's.
    static func releaseIsTest(server: URL) -> Bool {
        guard let host = server.host else { return false }
        return host != ChatAI.productionHost
    }
}

/// «Start as a new user» (2.7, the owner testing TestFlight 107: after deleting the app and installing it again his
/// chats and settings came back from iCloud, so the changed first run couldn't be seen as a new user). TestFlight and
/// debug builds only (TestBuild): a row in Settings. While it's on, this device shows the app as a new install has it:
/// the Get Started screen with the setup guide in place of the chats, the quiet reminders to finish setup, and the
/// extension counted as switched on and used only from what it did since. In Safari
/// the panel's own first run starts over once (src/shared/firstRun.ts).
///
/// Nothing is deleted or changed in iCloud, in the App Group's copy of the chats or in the settings: the chats are
/// only left out of what the root view shows (ContentView.hasChats), ChatLibrary and its sync run as always. No
/// "app opened", activation or use events are sent meanwhile: this isn't a new install. «Back to my data» (the same
/// row, or the line on the Get Started screen) ends it.
@MainActor
final class NewUserPreview: ObservableObject {
    static let shared = NewUserPreview()

    nonisolated private static let key = "cf_new_user_preview_since"
    /// What a new install hasn't had yet, in the app's own defaults on this device: the reminders to finish setup, and
    /// the setup funnel's once-an-install steps (2.8; they're not sent while this is on, so a preview can see them again).
    private static let firstRunKeys = ["cf_setup_reminders_offered", "cf_activation_shown_reported", "cf_activation_safari_shown_reported",
                                       "cf_setup_back_unused", "cf_setup_ask_shown_reported", "cf_setup_safari_trip_at"]

    /// On now (a store build never: the flag left by a test build installed before it counts for nothing).
    nonisolated static var isOn: Bool {
        TestBuild.isTest && UserDefaults.standard.double(forKey: key) > 0
    }

    @Published private(set) var on: Bool

    private init() {
        on = Self.isOn
        // A store build installed over a test build that had it on: the App Group's note goes, nothing else to undo.
        if !TestBuild.isTest, SharedDefaults.shared.newUserPreview() != nil { SharedDefaults.shared.setNewUserPreview(nil) }
    }

    func start() {
        guard TestBuild.isTest, !on else { return }
        let now = Date().timeIntervalSince1970
        let defaults = UserDefaults.standard
        defaults.set(now, forKey: Self.key)
        for key in Self.firstRunKeys { defaults.removeObject(forKey: key) }
        // The extension's side: what it does from now counts as a new install's, and the panel's first run starts over.
        SharedDefaults.shared.setNewUserPreview(now)
        on = true
        Activation.shared.previewChanged()
        // As at a new install's first launch: the quiet reminders to finish setup while ContextFlow is off in Safari.
        Task { await Activation.shared.launched() }
    }

    func end() {
        guard on else { return }
        UserDefaults.standard.removeObject(forKey: Self.key)
        SharedDefaults.shared.setNewUserPreview(nil)
        on = false
        Activation.shared.previewChanged()
        // Reminders to finish setup scheduled meanwhile aren't for someone who has it on.
        if Activation.shared.state != .off { SetupReminders.cancel() }
        Task { await Activation.shared.refresh() }
    }
}

/// Settings → «Test build», the first block on the screen (TestBuild.isTest only; 108, the owner looked for it and
/// didn't find it under everything else). English, and out of the string catalog (`verbatim`): it isn't part of what
/// ships.
struct NewUserPreviewSection: View {
    @ObservedObject private var preview = NewUserPreview.shared
    @State private var asking = false

    var body: some View {
        Section(
            header: Text(verbatim: "Test build"),
            footer: Text(verbatim: preview.on
                ? "You see ContextFlow as a new user on this device. Your chats, notes and collections are hidden here, not deleted, and keep syncing."
                : "Shows the first run again on this device: the setup guide, the reminders to finish setup, and the tour in Safari. Nothing is deleted, in iCloud or here.")
        ) {
            if preview.on {
                Button {
                    preview.end()
                } label: {
                    Label { Text(verbatim: "Back to my data") } icon: { Image(systemName: "arrow.uturn.backward") }
                }
                .accessibilityIdentifier("cf-newuser-end")
            } else {
                Button {
                    asking = true
                } label: {
                    Label { Text(verbatim: "Start as a new user") } icon: { Image(systemName: "person.badge.plus") }
                }
                .accessibilityIdentifier("cf-newuser-start")
                .alert(Text(verbatim: "Start as a new user?"), isPresented: $asking) {
                    Button(role: .cancel) { } label: { Text(verbatim: "Cancel") }
                    Button { preview.start() } label: { Text(verbatim: "Start") }
                } message: {
                    Text(verbatim: "Your chats, notes and collections will be hidden on this device until you choose “Back to my data”. Nothing is deleted.\n\nTo see the “switch it on” step too, first turn ContextFlow off in Settings → Apps → Safari → Extensions. If notifications are already allowed, iOS won't ask about them again.")
                }
            }
        }
    }
}

/// On the Get Started screen while «Start as a new user» is on: what this is, and the way back.
struct NewUserPreviewBanner: View {
    @ObservedObject private var preview = NewUserPreview.shared

    var body: some View {
        if preview.on {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "person.badge.plus")
                    .foregroundColor(.orange)
                    .accessibilityHidden(true)
                Text(verbatim: "Test build: you see ContextFlow as a new user. Your data is hidden, not deleted.")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button {
                    preview.end()
                } label: {
                    Text(verbatim: "Back to my data").font(.footnote.weight(.semibold))
                }
                .accessibilityIdentifier("cf-newuser-back")
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.orange.opacity(0.14)))
        }
    }
}
