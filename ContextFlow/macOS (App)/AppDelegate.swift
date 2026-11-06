//
//  AppDelegate.swift
//  macOS (App)
//

import Cocoa
import UserNotifications

@main
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(_ application: NSApplication, open urls: [URL]) {
        if let url = urls.first {
            DeepLinkRouter.shared.handle(url)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        localizeMainMenu()
        // Before launch ends, so a click on a reminder that launched the app reaches us.
        UNUserNotificationCenter.current().delegate = self
        // Page watch: this device's watches in Watching, and the notification question when they need it.
        WatchOpen.start()
    }

    // A reminder on a message (set here or in the panel): the app opens on that message. A page reminder
    // (the bell by a selection) opens its page in Safari; its note stays in the chat.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        // Page watch: "Changed: …" opens its page (WatchOpen).
        if info["watch"] != nil {
            await MainActor.run { WatchOpen.handle(info) }
            return
        }
        await MainActor.run { ChatAI.reportUx("ux_remind", info["open"] != nil ? ["action": "opened", "what": "page"] : ["action": "opened"]) }
        if let open = info["open"] as? String, let page = URL(string: open) {
            await MainActor.run { _ = NSWorkspace.shared.open(page) }
            return
        }
        guard let link = info["link"] as? String, let url = URL(string: link) else { return }
        MessageReminders.log("opened \(link)")
        await MainActor.run { DeepLinkRouter.shared.handle(url) }
    }

    // While the app is open, a reminder still shows as a banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// Main.storyboard's menu bar is in English only; its items take the user's language here.
    private func localizeMainMenu() {
        let app = "ContextFlow"
        let titles = [
            "About ContextFlow": String(localized: "About \(app)"),
            "Hide ContextFlow": String(localized: "Hide \(app)"),
            "Hide Others": String(localized: "Hide Others"),
            "Show All": String(localized: "Show All"),
            "Quit ContextFlow": String(localized: "Quit \(app)"),
            "Help": String(localized: "Help"),
            "ContextFlow Help": String(localized: "\(app) Help")
        ]
        func localize(_ menu: NSMenu) {
            for item in menu.items {
                if let title = titles[item.title] { item.title = title }
                guard let submenu = item.submenu else { continue }
                if let title = titles[submenu.title] { submenu.title = title }
                localize(submenu)
            }
        }
        NSApp.mainMenu.map(localize)
    }

    #if DEBUG
    // `ContextFlow.app/Contents/MacOS/ContextFlow --cf-sync-selftest` saves a thread to the iCloud
    // development environment, checks it comes back with the changes, deletes it, prints the result
    // and quits.
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.contains("--cf-sync-selftest") else { return }
        Task {
            let id = "selftest-\(UUID().uuidString)"
            let sent = ChatSync.Snapshot(id: id, updatedAt: Int64(Date().timeIntervalSince1970 * 1000), data: #"[{"role":"user","content":"selftest"}]"#)
            do {
                let first = try await ChatSync.sync(token: nil, changes: [.save(sent)])
                let back = first.changed.first { $0.id == id }
                let second = try await ChatSync.sync(token: first.token, changes: [.delete(id)])
                let ok = back?.data == sent.data && back?.updatedAt == sent.updatedAt && second.deleted.contains(id)
                print("cf-sync-selftest \(ok ? "OK" : "MISMATCH") threads=\(first.changed.count) deleted=\(second.deleted)")
            } catch {
                print("cf-sync-selftest FAILED \(error)")
            }
            exit(0)
        }
    }
    #endif
}
