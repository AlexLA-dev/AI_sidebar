import SwiftUI
import UserNotifications
#if os(iOS)
import BackgroundTasks
#endif

// What's new (2.6 (98), the owner on TestFlight 97: «Нужна возможность слать нотификации в приложение пользователям когда
// новая версия вышла, и открывать в приложении обычно скрытую вкладку, где описано, что меняется в приложении, с новыми
// короткими видео как в Tips»; the director: when a new version is out the app says so by a notification, a tap opens a
// hidden "What's new" tab with short clips, and after an update the tab opens once by itself).
// - The tab: this version's main features, as Tips' cards (their words and clips, in every language already); with a
//   newer version in the App Store not installed yet, that version's notes and Update over them.
// - The App Store's version is read at most every 12 hours (on iPhone and iPad also in the background, BGAppRefreshTask
//   `taskId`, Info.plist): a newer one is told once per version by a local notification, only when notifications are
//   on for ContextFlow (never asked for this). No server, no push.
// - After an update the tab opens once by itself (not on a first install: that has the setup guide).
enum WhatsNew {
    /// The version the cards are about (major.minor).
    static let version = "2.6"
    /// The version whose tab was shown (or that was installed first).
    static let seenKey = "cf_whatsnew_seen"
    /// The App Store version a notification was sent for: one per version.
    static let notifiedKey = "cf_update_notified"
    static let checkedKey = "cf_update_checked"
    static let storeKey = "cf_update_store"
    /// The background check (Info.plist BGTaskSchedulerPermittedIdentifiers).
    static let taskId = "com.contextflow.app.versioncheck"
    static let every: TimeInterval = 12 * 3600

    static var installed: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }

    /// "2.6.1" → "2.6".
    static func majorMinor(_ v: String) -> String { v.split(separator: ".").prefix(2).joined(separator: ".") }

    /// Whether `a` is a later version than `b`, number by number ("2.10" after "2.9").
    static func newer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    /// The main features of 2.6, as Tips shows them (the same words and clips). Build 98: organizing too (its clip
    /// starts at 2.6's Suggestions bar), and Listen's clip on iPhone and iPad; the clips of Remind me and Watch show the
    /// note of your own.
    static var items: [Tip] {
        [TipGroup.similarTip, TipGroup.organizeTip, TipGroup.listenTip, TipGroup.chipsTip, TipGroup.remindTip, TipGroup.watchTip]
    }

    /// Whether the tab opens by itself now: the first launch of this version after an update (`existingUser`: the app
    /// was used before; a version that didn't keep `seenKey` leaves only that to go by). Marks this version seen.
    static func dueAfterUpdate(existingUser: Bool) -> Bool {
        let defaults = UserDefaults.standard
        let seen = defaults.string(forKey: seenKey)
        let now = majorMinor(installed)
        guard seen != now else { return false }
        defaults.set(now, forKey: seenKey)
        guard seen != nil || existingUser else { return false }
        return now == version
    }

    /// A version in the App Store: its number, its notes, its page.
    struct Store: Codable, Equatable {
        var version: String
        var notes: String
        var url: String
    }

    /// The App Store's version as last read.
    static var store: Store? {
        guard let data = UserDefaults.standard.data(forKey: storeKey) else { return nil }
        return try? JSONDecoder().decode(Store.self, from: data)
    }

    /// The App Store's version, read now (nil offline or when the lookup has nothing).
    static func lookup() async -> Store? {
        #if DEBUG
        // Frames of a newer version waiting in the App Store: -CFDebugStoreVersion 2.7.
        if let debug = UserDefaults.standard.string(forKey: "CFDebugStoreVersion") {
            return Store(version: debug, notes: "Fixes and improvements.", url: "https://apps.apple.com/app/id6759115793")
        }
        #endif
        guard let id = Bundle.main.bundleIdentifier, var parts = URLComponents(string: "https://itunes.apple.com/lookup") else { return nil }
        parts.queryItems = [URLQueryItem(name: "bundleId", value: id)]
        if let country = Locale.current.region?.identifier, country.count == 2 { parts.queryItems?.append(URLQueryItem(name: "country", value: country.lowercased())) }
        guard let url = parts.url, let (data, _) = try? await URLSession.shared.data(from: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let first = (object["results"] as? [[String: Any]])?.first,
              let version = first["version"] as? String else { return nil }
        return Store(version: version, notes: first["releaseNotes"] as? String ?? "", url: first["trackViewUrl"] as? String ?? "")
    }

    /// Reads the App Store's version (at most every 12 hours) and tells a newer one once, by a notification, when
    /// notifications are on for ContextFlow.
    static func check(force: Bool = false) async {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        guard force || now - defaults.double(forKey: checkedKey) > every else { return }
        defaults.set(now, forKey: checkedKey)
        guard let found = await lookup() else { return }
        if let data = try? JSONEncoder().encode(found) { defaults.set(data, forKey: storeKey) }
        guard newer(found.version, than: installed), defaults.string(forKey: notifiedKey) != found.version else { return }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = String(localized: "ContextFlow \(found.version) is here")
        content.body = String(localized: "See what's new in this version.")
        content.userInfo = ["whatsNew": found.version]
        do {
            try await center.add(UNNotificationRequest(identifier: "cf.whatsnew.\(found.version)", content: content, trigger: nil))
            defaults.set(found.version, forKey: notifiedKey)
        } catch {}
    }

    /// The link a "What's new" notification opens in the app.
    static let link = URL(string: "contextflow://whatsnew")!

    #if os(iOS)
    /// Before launch ends (AppDelegate): the background check.
    static func registerBackground() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            schedule()
            let work = Task {
                await check()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    /// The next background check, about 12 hours from now (iOS picks the moment).
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: every)
        try? BGTaskScheduler.shared.submit(request)
    }
    #endif
}

/// The "What's new" tab: shown when it opens by itself after an update or from the notification, else hidden.
struct WhatsNewView: View {
    @Environment(\.openURL) private var openURL
    @State private var store = WhatsNew.store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // A newer version in the App Store, not installed yet: its notes and Update first.
                if let store, WhatsNew.newer(store.version, than: WhatsNew.installed) {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Version \(store.version) is in the App Store", systemImage: "arrow.down.app")
                            .font(.headline)
                        if !store.notes.isEmpty {
                            Text(store.notes)
                                .font(.callout)
                                .foregroundColor(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let url = URL(string: store.url) {
                            Button("Update") { openURL(url) }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.cardFill)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                Text("New in ContextFlow \(WhatsNew.version)")
                    .font(.title2.weight(.bold))
                Text("The main things this version brings, each shown in a short clip.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12, alignment: .top)], alignment: .leading, spacing: 12) {
                    ForEach(WhatsNew.items.indices, id: \.self) { i in
                        TipCard(tip: WhatsNew.items[i])
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("What's new")
        .task {
            // Fresh from the App Store when the tab opens (it may have come from the notification).
            if let found = await WhatsNew.lookup() { store = found }
        }
    }
}
