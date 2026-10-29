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
