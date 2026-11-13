import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Share, from the button that was tapped (2.6.1, the owner on his iPad: «Вот кстати как в приложении отображается окно
/// Share...»). On an iPad the share sheet is a popover. It hung from wherever ShareLink or our own sheet guessed: under
/// the tab bar, a sliver tall. Here it hangs from the button itself, at its full size. On an iPhone it's the usual sheet
/// from the bottom; on a Mac, the share menu by the button.
struct ShareButton<Content: View>: View {
    /// What's shared, made when tapped: the text with its links, or an answer as rich text (its highlights in bold).
    let items: () -> [Any]
    /// The sheet closed, shared or not (iPhone and iPad; the Mac's menu doesn't say).
    var done: (() -> Void)? = nil
    @ViewBuilder let label: () -> Content
    @State private var anchor = ShareAnchor()

    var body: some View {
        Button {
            ShareSheet.present(items(), from: anchor.view, done: done)
        } label: {
            label()
        }
        .background(ShareAnchorView(anchor: anchor))
    }
}

/// The button's own view, which the popover (iPad) or the menu (Mac) hangs from.
final class ShareAnchor {
    #if os(iOS)
    weak var view: UIView?
    #else
    weak var view: NSView?
    #endif
}

#if os(iOS)
private struct ShareAnchorView: UIViewRepresentable {
    let anchor: ShareAnchor

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        // Taps go to the button.
        view.isUserInteractionEnabled = false
        anchor.view = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        anchor.view = view
    }
}
#else
private final class ShareAnchorNSView: NSView {
    // Clicks go to the button.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private struct ShareAnchorView: NSViewRepresentable {
    let anchor: ShareAnchor

    func makeNSView(context: Context) -> NSView {
        let view = ShareAnchorNSView()
        anchor.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        anchor.view = view
    }
}
#endif

/// The share sheet (iPhone, iPad) or menu (Mac) for what's shared, from the button it was tapped on.
enum ShareSheet {
    #if os(iOS)
    static func present(_ items: [Any], from anchor: UIView?, done: (() -> Void)? = nil) {
        let window = anchor?.window ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }?
            .windows.first(where: \.isKeyWindow)
        guard var top = window?.rootViewController else {
            done?()
            return
        }
        while let shown = top.presentedViewController, !shown.isBeingDismissed { top = shown }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in done?() }
        if let popover = sheet.popoverPresentationController {
            if let anchor, anchor.window != nil {
                // iPad: from the button, on whichever side has room.
                popover.sourceView = anchor
                popover.sourceRect = anchor.bounds
            } else {
                // No button to hang from: in the middle, without an arrow.
                popover.sourceView = top.view
                popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
        }
        top.present(sheet, animated: true)
    }
    #else
    static func present(_ items: [Any], from anchor: NSView?, done: (() -> Void)? = nil) {
        let view = anchor?.window != nil ? anchor : NSApp.keyWindow?.contentView
        guard let view else { return }
        // Under the button (or over it when there's no room under it).
        NSSharingServicePicker(items: items).show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }
    #endif
}
