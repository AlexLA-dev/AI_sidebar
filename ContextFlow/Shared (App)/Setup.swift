import Combine
import Foundation
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
    }

    private static func recordedState() -> State {
        let status = SharedDefaults.shared.readExtensionStatus()
        return status.firstUsed != nil ? .inUse : status.firstSeen != nil ? .on : .off
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
        state = next
        if next != .off { SetupReminders.cancel() }
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

    /// On every launch: offer the reminders once on a new install that isn't set up yet, then report
    /// "app opened" (once a day).
    func launched() async {
        await refresh()
        let defaults = UserDefaults.standard
        if newInstall, state == .off, !defaults.bool(forKey: Self.remindersOfferedKey) {
            defaults.set(true, forKey: Self.remindersOfferedKey)
            // Let the guide appear before the system asks about notifications.
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            #if os(iOS)
            // 2.6: our screen first (what they're for, reading aloud included), then the system's question.
            await NotifyAsk.shared.show(.launch)
            #else
            await SetupReminders.schedule()
            #endif
        }
        await reportOpen()
    }

    /// What StoreKit attaches to a purchase, so the server knows which install subscribed: the
    /// extension's install id once known, else the app's own id.
    var accountToken: UUID? {
        SharedDefaults.shared.readExtensionStatus().installId.flatMap(UUID.init(uuidString:)) ?? UUID(uuidString: appId)
    }

    private var reporting = false

    private func reportOpen() async {
        let day = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        guard !reporting, UserDefaults.standard.string(forKey: Self.openReportedKey) != day else { return }
        reporting = true
        defer { reporting = false }
        var body: [String: Any] = [
            "kind": "app_open",
            "appId": appId,
            "client": [
                "platform": Self.platform,
                "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                "locale": Bundle.main.preferredLocalizations.first ?? ""
            ],
            "extension": state.rawValue
        ]
        body["notifications"] = await SetupReminders.permission()
        if let installId = SharedDefaults.shared.readExtensionStatus().installId { body["installId"] = installId }
        let adToken = Self.adAttributionToken()
        if let adToken { body["adToken"] = adToken }
        var request = URLRequest(url: URL(string: "https://aisidebar.netlify.app/api/v2/event")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 15
        if let (data, response) = try? await URLSession.shared.data(for: request),
           (response as? HTTPURLResponse)?.statusCode == 200 {
            UserDefaults.standard.set(day, forKey: Self.openReportedKey)
            if adToken != nil {
                let answer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["ads"] as? String
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

#if os(iOS)
// MARK: - Notifications, asked with a reason (2.6)

/// The system's question about notifications can't say what they're for, so this screen comes first: reminders, pages
/// that change, and read aloud carried on from Safari when the page goes away or the screen locks. When they're off
/// (iOS asks only once), it opens the app's notification settings instead. Shown on a new install, once after an
/// Ultra purchase, and when Listen in Safari needs them (the extension can't ask): then the text plays here after.
@MainActor
final class NotifyAsk: ObservableObject {
    static let shared = NotifyAsk()

    enum Reason: String {
        case launch, ultra, listen
    }

    struct Ask: Identifiable {
        let id = UUID()
        let reason: Reason
        /// Turned off: iOS won't ask again, only Settings can turn them on.
        let denied: Bool
        /// From Listen in Safari: the text handed over, played here once this is answered.
        let listen: String?
    }

    @Published var ask: Ask?
    private static let ultraKey = "cf_notify_asked_ultra"

    /// Shown when notifications aren't on (not asked yet, or turned off); otherwise a text handed over just plays.
    func show(_ reason: Reason, listen id: String? = nil) async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard status == .notDetermined || status == .denied else {
            // Already on (the panel hadn't heard yet): back to Safari, where it plays (build 93).
            if let id, !backToSafari(id) { play(id) }
            return
        }
        ask = Ask(reason: reason, denied: status == .denied, listen: id)
        ChatAI.reportUse("notify", "shown", ["why": reason.rawValue, "status": status == .denied ? "denied" : "not_asked"])
    }

    /// Once, after an Ultra purchase (read aloud carries on from Safari only with notifications).
    func afterUltra() async {
        guard !UserDefaults.standard.bool(forKey: Self.ultraKey) else { return }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard status == .notDetermined || status == .denied else { return }
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
        if ask.reason == .launch {
            // The setup reminders ask the system themselves, and are scheduled when allowed.
            await SetupReminders.schedule()
        } else {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        }
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
        ask = nil
        guard let id else { return }
        // Build 93 (the owner: "is it necessary to move it to the app if Safari wasn't hidden?"): with notifications on,
        // back to the page in Safari, where the panel plays it; without them, it plays here (and the panel says so).
        Task {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            if [.authorized, .provisional, .ephemeral].contains(status), backToSafari(id) { return }
            SharedDefaults.shared.markListenTaken(id)
            play(id)
        }
    }

    /// The page the text came from, opened in Safari again with word to play it in the panel; false without one.
    private func backToSafari(_ id: String) -> Bool {
        guard let stored = SharedDefaults.shared.readListenRequest(id), let link = stored["url"] as? String,
              let url = URL(string: link), url.scheme == "https" || url.scheme == "http" else { return false }
        SharedDefaults.shared.markListenReturn(id, play: true)
        ChatAI.reportUse("listen", "back_safari", ["what": stored["what"] as? String ?? "answer"])
        Task {
            // After this screen has gone.
            try? await Task.sleep(nanoseconds: 400_000_000)
            await UIApplication.shared.open(url)
        }
        return true
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
enum SetupReminders {
    static func schedule() async {
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
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
        for reminder in reminders {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: reminder.after, repeats: false)
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
        default: return "granted"
        }
    }
}

#if os(iOS)
// MARK: - Setup guide (iOS)

/// The home screen's first card: how to switch ContextFlow on, shown as the Settings screens themselves
/// with each tap played out; then "almost there" until the panel has been opened once.
struct SetupCard: View {
    @ObservedObject var activation: Activation
    var openSafari: () -> Void

    var body: some View {
        switch activation.state {
        case .off: guide
        case .on: almostThere
        case .inUse: ready
        }
    }

    /// iOS and iPadOS 26.2 and later open Safari's settings on ContextFlow itself (2.6, the owner: "Open Settings"
    /// led to the app's own settings). Older versions open the app's page, from where the steps above lead on.
    private var directSettings: Bool {
        if #available(iOS 26.2, *) { return true }
        return false
    }

    private var guide: some View {
        Card(title: "Turn on ContextFlow", systemImage: "switch.2") {
            SettingsWalkthrough()
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
            if directSettings {
                Text("Settings opens on ContextFlow: switch it on, then set All Websites to Allow.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Settings opens on ContextFlow's page: tap “Apps” at the top left, then follow the steps above.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // This iOS can't tell the app it's on until the panel is used: the way on from here.
                Button(action: openSafari) {
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
        SettingsPiP.shared.start(phases: directSettings ? [3, 4, 5] : Array(0..<6), then: openExtensionSettings)
    }

    private func openExtensionSettings() {
        let appSettings = {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        if #available(iOS 26.2, *) {
            SFSafariSettings.openExtensionsSettings(forIdentifiers: [extensionBundleIdentifier]) { error in
                if error != nil { appSettings() }
            }
        } else {
            appSettings()
        }
    }

    private var almostThere: some View {
        Card(title: "Almost there", systemImage: "checkmark.circle") {
            Text("ContextFlow is on. Now open any page in Safari and tap ✦. If Safari asks, choose Always Allow, then Always Allow on Every Website.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let url = TipClip.url("open") {
                TipClipView(url: url)
                    .aspectRatio(TipClip.aspect, contentMode: .fit)
                    .frame(maxWidth: TipClip.width)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.08)))
                    .frame(maxWidth: .infinity)
            }
            safariButton
        }
    }

    private var ready: some View {
        Card(title: "ContextFlow is on in Safari", systemImage: "checkmark.seal.fill") {
            Text("Open any page and tap ✦ — or choose ContextFlow in the page menu of the address bar.")
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            safariButton
        }
    }

    private var safariButton: some View {
        Button(action: openSafari) {
            Label("Open Safari", systemImage: "safari")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .padding(.top, 4)
    }
}

/// The Settings screens on the way to switching ContextFlow on, drawn like iOS Settings and stepped
/// through on their own (tap to skip ahead). With Reduce Motion it waits for taps.
struct SettingsWalkthrough: View {
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
                Step(number: 1, text: "Open the Settings app and go to Apps → Safari → Extensions.")
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
    private var queued = 0
    private var pendingOpen: (() -> Void)?
    /// Each screen this long, as in the card.
    private static let hold = CMTime(value: 22, timescale: 10)
    /// Frames queued ahead: about ten minutes of the loop.
    private static let maxFrames = 270

    private override init() {
        super.init()
        layer.videoGravity = .resizeAspect
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
    func start(phases: [Int], then open: @escaping () -> Void) {
        guard let controller = makeController() else { return open() }
        if phases != self.phases || frames.isEmpty {
            self.phases = phases
            frames = phases.compactMap { Self.frame(phase: $0) }
        }
        guard !frames.isEmpty else { return open() }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try? session.setActive(true)
        play()
        pendingOpen = open
        controller.startPictureInPicture()
        // Not possible on this device right now, or slow to start: Settings opens anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.openPending() }
    }

    /// Back in the app: the window goes.
    func stop() {
        guard controller?.isPictureInPictureActive == true || queued > 0 else { return }
        controller?.stopPictureInPicture()
        layer.stopRequestingMediaData()
        layer.flush()
        queued = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
    private static func frame(phase: Int) -> CVPixelBuffer? {
        let step: LocalizedStringKey = phase < 2 ? "Open the Settings app and go to Apps → Safari → Extensions."
            : phase < 4 ? "Tap ContextFlow and switch it on." : "Under Permissions, set All Websites to Allow."
        let view = VStack(spacing: 10) {
            SettingsScreen(phase: phase).frame(height: 216)
            Text(step)
                .font(.footnote.weight(.semibold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(width: 320, height: 300, alignment: .top)
        .background(Color(uiColor: .systemBackground))
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
    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        Task { @MainActor in self.openPending() }
    }

    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        Task { @MainActor in self.openPending() }
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
