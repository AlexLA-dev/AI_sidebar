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
        // Page watch: this device's watches in Reminders, and the notification question when they need it.
        WatchOpen.start()
        return true
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
