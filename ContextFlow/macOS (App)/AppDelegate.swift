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
        AgentApp.start()
        // The Tips clips for the Safari panel, into the App Group once per build (TipClipShare), as on iOS. Until
        // build 95 this sat in the Debug-only launch below, so a Mac from TestFlight or the App Store had none.
        DispatchQueue.global(qos: .utility).async { TipClipShare.publish() }
    }

    // A reminder on a message (set here or in the panel): the app opens on that message. A page reminder
    // (the bell by a selection) opens its page in Safari; its note stays in the chat.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        // 2.6 (98): "ContextFlow … is here" opens the What's new tab.
        if info["whatsNew"] is String {
            await MainActor.run { DeepLinkRouter.shared.handle(WhatsNew.link) }
            return
        }
        // A reminder to finish setup (2.8, В1.1): counted, and the setup guide opens.
        if let which = info["setup"] as? String {
            await MainActor.run {
                ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "setup", "s": "notif", "when": which == "24h" ? "24h" : "15m"])
                if let setup = URL(string: "contextflow://setup") { DeepLinkRouter.shared.handle(setup) }
            }
            return
        }
        // Find similar is done: its chat opens in the panel, on its page in Safari (SimilarAway), not another default
        // browser, which has no panel.
        if info["similar"] is String {
            await MainActor.run {
                ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "similar", "s": "notif"])
                guard let page = SimilarAway.opened(info) else { return }
                if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
                    NSWorkspace.shared.open([page], withApplicationAt: safari, configuration: NSWorkspace.OpenConfiguration())
                } else {
                    _ = NSWorkspace.shared.open(page)
                }
            }
            return
        }
        // A deferred agent task (2.7.1): its page in Safari with #cf-task=<id> (AgentTasks).
        if info["agentTask"] is String {
            await MainActor.run {
                ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "agent", "s": "notif"])
                guard let page = AgentTasks.opened(info) else { return }
                if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
                    NSWorkspace.shared.open([page], withApplicationAt: safari, configuration: NSWorkspace.OpenConfiguration())
                } else {
                    _ = NSWorkspace.shared.open(page)
                }
            }
            return
        }
        // Page watch: "Changed: …" opens its page (WatchOpen).
        if info["watch"] != nil {
            await MainActor.run { WatchOpen.handle(info) }
            return
        }
        // 2.8: the answers-back reminder that also said there's a Pro discount (only for someone who opted in): its page
        // has #cf-offer=1, and the panel opens there on the discount.
        if let open = info["open"] as? String, open.contains("cf-offer=1") {
            await MainActor.run { ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "offer", "s": "notif"]) }
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
