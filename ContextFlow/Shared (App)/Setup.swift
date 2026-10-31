import Combine
import Foundation
import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
import SafariServices
#endif

// MARK: - Is ContextFlow on in Safari?

/// Whether the Safari extension is switched on and has been used. The setup guide on the home screen,
/// the reminders to finish setup and the anonymous "app opened" funnel event follow from it.
///
/// iOS has no API to ask Safari, so the extension tells the app itself: every message it sends to its
/// native handler is recorded in the App Group (see SharedDefaults). On the Mac, Safari also answers.
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
        #endif
        state = next
        if next != .off { SetupReminders.cancel() }
    }

    /// On every launch: offer the reminders once on a new install that isn't set up yet, then report
    /// "app opened" (once a day).
    func launched() async {
        await refresh()
        let defaults = UserDefaults.standard
        if newInstall, state == .off, !defaults.bool(forKey: Self.remindersOfferedKey) {
            defaults.set(true, forKey: Self.remindersOfferedKey)
            // Let the guide appear before the system asks about notifications.
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await SetupReminders.schedule()
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
        var request = URLRequest(url: URL(string: "https://aisidebar.netlify.app/api/v2/event")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 15
        if let (_, response) = try? await URLSession.shared.data(for: request),
           (response as? HTTPURLResponse)?.statusCode == 200 {
            UserDefaults.standard.set(day, forKey: Self.openReportedKey)
        }
    }

    private static var platform: String {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        #else
        "macos"
        #endif
    }
}

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

    private var guide: some View {
        Card(title: "Turn on ContextFlow", systemImage: "switch.2") {
            SettingsWalkthrough()
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                Label("Open Settings", systemImage: "gear")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 4)
            Text("Settings opens on ContextFlow's page: tap “Apps” at the top left, then follow the steps above.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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
                Image(systemName: "chevron.left").font(.footnote.weight(.semibold))
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
                        Toggle("", isOn: .constant(phase >= 4)).labelsHidden().scaleEffect(0.8).allowsHitTesting(false)
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
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundColor(Color.secondary.opacity(0.6))
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
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundColor(Color.secondary.opacity(0.6))
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
