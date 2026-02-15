import WebKit
import os.log

/// Legacy WKWebView message handler.
///
/// This was previously used to relay StoreKit commands from the WKWebView
/// to StoreKitManager. Now that the container app uses SwiftUI with native
/// StoreKit integration, this handler is no longer actively used.
///
/// Kept for backward compatibility in case the WKWebView is still loaded
/// by the storyboard/XIB.
final class ExtensionMessageHandler: NSObject, WKScriptMessageHandler {

    private let logger = Logger(subsystem: "com.contextflow.app", category: "MessageHandler")

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        logger.info("Legacy WKWebView message received — purchases are now handled in the app UI")
    }
}
