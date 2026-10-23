//
//  SceneDelegate.swift
//  iOS (App)
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard scene is UIWindowScene else { return }
        // Cold start from a contextflow:// link (e.g. "Get Pro" in the Safari extension).
        if let url = connectionOptions.urlContexts.first?.url {
            DeepLinkRouter.shared.handle(url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url {
            DeepLinkRouter.shared.handle(url)
        }
    }
}
