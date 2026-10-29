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

    #if DEBUG
    // `ContextFlow.app/Contents/MacOS/ContextFlow --cf-sync-selftest` stores a conversation in the
    // iCloud development environment, reads it back, prints the result and quits. Saving also
    // creates the record type there, ready to deploy to production in the CloudKit Console.
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.contains("--cf-sync-selftest") else { return }
        Task {
            let sent = ChatSync.Snapshot(updatedAt: Int64(Date().timeIntervalSince1970 * 1000), data: #"[{"role":"user","content":"selftest"}]"#)
            do {
                let stored = try await ChatSync.store(sent)
                let fetched = try await ChatSync.fetch()
                let ok = fetched?.updatedAt == stored.updatedAt && fetched?.data == stored.data
                print("cf-sync-selftest \(ok ? "OK" : "MISMATCH") stored=\(stored.updatedAt) fetched=\(fetched?.updatedAt ?? -1)")
            } catch {
                print("cf-sync-selftest FAILED \(error)")
            }
            exit(0)
        }
    }
    #endif
}
