//
//  AppDelegate.swift
//  iOS (App)
//
//  Created by Alexandr Lubchenko on 15/02/2026.
//

import UIKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Before launch ends, so a tap on a reminder that launched the app reaches us.
        UNUserNotificationCenter.current().delegate = self
        // Page watch: this device's watches in Watching, and the notification question when they need it.
        WatchOpen.start()
        AgentApp.start()
        // The Tips clips for the Safari panel, into the App Group once per build (TipClipShare).
        DispatchQueue.global(qos: .utility).async { TipClipShare.publish() }
        // 2.6 (98): the App Store's version, read in the background too (What's new).
        WhatsNew.registerBackground()
        return true
    }

    // Find similar's answer, downloaded while Safari was away (build 94): iOS wakes the app when the download the
    // extension started has ended; the app says how the search ended (SimilarAway).
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier.hasPrefix(SimilarAway.sessionPrefix) else {
            completionHandler()
            return
        }
        SimilarAway.handleEvents(identifier, completion: completionHandler)
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
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
        // A deferred agent task (2.7.1): its page in Safari itself (another default browser has no panel), with
        // #cf-task=<id>; the panel there goes on with the task (AgentTasks).
        if info["agentTask"] is String {
            await MainActor.run {
                ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "agent", "s": "notif"])
                guard let page = AgentTasks.opened(info) else { return }
                SafariPage.open(page)
            }
            return
        }
        // Page watch: "Changed: …" opens its page (WatchOpen).
        if info["watch"] != nil {
            await MainActor.run { WatchOpen.handle(info) }
            return
        }
        // Find similar is done: its chat opens in the panel, on its page in Safari (another default browser has no
        // panel; the chat is in the page's address, SimilarAway.pageOpening).
        if info["similar"] is String {
            await MainActor.run {
                ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "similar", "s": "notif"])
                if let page = SimilarAway.opened(info) {
                    SafariPage.open(page)
                } else if let chats = URL(string: "contextflow://chats") {
                    DeepLinkRouter.shared.handle(chats)
                }
            }
            return
        }
        // Read aloud carried on from Safari (2.6): the app plays it from the second it had reached.
        if info["listen"] is String, let link = info["link"] as? String, let url = URL(string: link) {
            await MainActor.run {
                ChatAI.reportUse("listen", "carried_on")
                DeepLinkRouter.shared.handle(url)
            }
            return
        }
        // 2.8: the answers-back reminder that also said there's a Pro discount (only for someone who opted in): its page
        // has #cf-offer=1, and the panel opens there on the discount.
        if let open = info["open"] as? String, open.contains("cf-offer=1") {
            // The panel acts on the page's mark only with this note, taken within moments (OfferTap).
            OfferTap.record()
            await MainActor.run { ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "offer", "s": "notif"]) }
        }
        await MainActor.run { ChatAI.reportUx("ux_remind", info["open"] != nil ? ["action": "opened", "what": "page"] : ["action": "opened"]) }
        if let open = info["open"] as? String, let page = URL(string: open) {
            await MainActor.run { UIApplication.shared.open(page) }
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
}
