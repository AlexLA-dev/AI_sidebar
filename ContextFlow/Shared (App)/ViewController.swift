//
//  ViewController.swift
//  Shared (App)
//

import SwiftUI
import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.contextflow.app.Extension"

@available(macOS 12.0, iOS 15.0, *)
class ViewController: PlatformViewController, WKNavigationDelegate {
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        // Hide the default WebView — replace with SwiftUI ContentView
        webView.isHidden = true

        #if os(iOS)
        let hostingController = UIHostingController(rootView: ContentView())
        addChild(hostingController)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hostingController.view)
        NSLayoutConstraint.activate([
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        hostingController.didMove(toParent: self)

        // Register for URL scheme handling — UIKit dispatches open-url events
        // via SceneDelegate / AppDelegate. We listen for those and re-broadcast
        // via NotificationCenter so the SwiftUI ContentView can react reliably.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleIncomingURL(_:)),
            name: .contextFlowOpenURL,
            object: nil
        )
        #elseif os(macOS)
        let hostingView = NSHostingView(rootView: ContentView())
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.topAnchor.constraint(equalTo: view.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            hostingView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        #endif
    }

    #if os(iOS)
    @objc private func handleIncomingURL(_ notification: Notification) {
        // Already handled by ContentView via .onOpenURL — this observer
        // exists as a fallback for edge cases where .onOpenURL doesn't fire.
    }
    #endif
}

// Notification name used to forward deep-link URLs from UIKit to SwiftUI.
extension Notification.Name {
    static let contextFlowOpenURL = Notification.Name("contextFlowOpenURL")
}
