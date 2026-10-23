//
//  AppDelegate.swift
//  macOS (App)
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func application(_ application: NSApplication, open urls: [URL]) {
        if let url = urls.first {
            DeepLinkRouter.shared.handle(url)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
