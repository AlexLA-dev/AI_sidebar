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
        // The Tips clips for the Safari panel, into the App Group once per build (TipClipShare).
        DispatchQueue.global(qos: .utility).async { TipClipShare.publish() }
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
        // Page watch: "Changed: …" opens its page (WatchOpen).
        if info["watch"] != nil {
            await MainActor.run { WatchOpen.handle(info) }
            return
        }
        // Find similar is done (build 94): its chat opens in the panel, on its page in Safari.
        if info["similar"] is String {
            await MainActor.run {
                ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "similar", "s": "notif"])
                if let page = SimilarAway.opened(info) {
                    UIApplication.shared.open(page)
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
