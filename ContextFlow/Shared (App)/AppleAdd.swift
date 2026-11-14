import Combine
import EventKit
import SwiftUI
#if os(iOS)
import EventKitUI
import UIKit
#else
import AppKit
#endif

/// Calendar and Reminders handed over by the Safari panel (2.7, contextflow://add?id=…): the extension can't ask for
/// access, so the app does it here, once, and adds the item the person already confirmed in the panel. On iPhone and
/// iPad an event opens the system's event editor (no access needed); a reminder asks for full access to Reminders. On a
/// Mac, write-only access to Calendar or full access to Reminders. See AppleItems.
@MainActor
final class AppleAdd: ObservableObject {
    static let shared = AppleAdd()

    struct Request: Identifiable {
        let id: String
        let item: AppleItems.Item
        let key: String?
    }

    enum State: Equatable {
        case working
        /// iPhone and iPad: the system's event editor is up.
        case editor
        case saved(place: String)
        case denied
        case failed
        /// The link's request isn't here (too old, or already added).
        case gone
    }

    @Published var request: Request?
    @Published var state: State = .working
    private var waitTask: Task<Void, Never>?
    /// The item being added (its sheet shows only after the event editor, on iPhone and iPad).
    private var current: Request?
    #if os(iOS)
    private let editorDelegate = EditorDelegate()
    #endif

    func open(_ url: URL) {
        let id = AppleItems.validId(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value)
        guard let id, AppleItems.available else { return }
        state = .working
        // The panel follows the link during the tap and sends the item meanwhile: it may land a moment after the app opens.
        waitTask?.cancel()
        waitTask = Task { [weak self] in
            for _ in 0..<24 {
                if let taken = AppleItems.takeRequest(id) {
                    await self?.run(Request(id: id, item: taken.item, key: taken.key))
                    return
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
                if Task.isCancelled { return }
            }
            guard let self else { return }
            self.request = Request(id: id, item: AppleItems.Item(kind: .reminder, title: ""), key: nil)
            self.state = .gone
        }
    }

    private func run(_ r: Request) async {
        current = r
        state = .working
        let kind = r.item.kind
        #if os(iOS)
        // The system's editor runs outside the app and draws nothing inside a SwiftUI sheet: UIKit presents it.
        if kind == .event && AppleItems.access(.event) != .write {
            state = .editor
            presentEditor(r.item)
            return
        }
        #endif
        request = r
        if AppleItems.access(kind) == .none { _ = await AppleItems.ask(kind) }
        guard AppleItems.access(kind) == .write else {
            state = .denied
            report("denied")
            return
        }
        do {
            state = .saved(place: try AppleItems.save(r.item, key: r.key))
            report("added")
        } catch {
            AppleItems.log("app save failed: \(error)")
            state = .failed
            report("failed")
        }
    }

    /// The event editor closed: added (the sheet says so), or cancelled.
    func editorDone(_ saved: Bool) {
        if saved {
            state = .saved(place: "")
            request = current
            report("added")
        } else {
            report("dismissed")
            close()
        }
    }

    func close() {
        waitTask?.cancel()
        request = nil
        current = nil
    }

    #if os(iOS)
    private func presentEditor(_ item: AppleItems.Item) {
        let store = EKEventStore()
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = AppleItems.editorEvent(item, store: store)
        controller.editViewDelegate = editorDelegate
        editorDelegate.done = { [weak self] saved, editor in
            editor.dismiss(animated: true) { self?.editorDone(saved) }
        }
        guard let top = Self.topController() else {
            state = .failed
            request = current
            report("failed")
            return
        }
        top.present(controller, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var top = (scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first)?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    final class EditorDelegate: NSObject, EKEventEditViewDelegate {
        var done: ((Bool, EKEventEditViewController) -> Void)?

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            done?(action == .saved, controller)
        }
    }
    #endif

    private func report(_ action: String) {
        guard let kind = (current ?? request)?.item.kind else { return }
        ChatAI.reportUse("apple", action, ["what": kind.rawValue, "via": "app"])
    }

    /// -CFDebugAppleAdd reminder|event (DEBUG): what the panel would hand over (a reminder tomorrow at 9, a flight on
    /// the 14th of next month), opened as its link would open it. -CFDebugAppleSave YES: written at once from here, as
    /// the extension does when access is given (prints where it went).
    func debugStartIfAsked() {
        #if DEBUG
        let kind = UserDefaults.standard.string(forKey: "CFDebugAppleAdd")
        guard let kind = kind.flatMap(AppleItems.Item.Kind.init(rawValue:)) else { return }
        let cal = Calendar.current
        let day = cal.date(byAdding: kind == .reminder ? .day : .month, value: 1, to: Date()) ?? Date()
        let wall = AppleItems.wall(cal.date(bySettingHour: kind == .reminder ? 9 : 10, minute: kind == .reminder ? 0 : 40, second: 0, of: day) ?? day)
        var item = AppleItems.Item(kind: kind, title: kind == .reminder ? "Book the hotel in Sochi" : "Flight SU 1234 Moscow → Sochi")
        item.date = kind == .reminder ? wall.date : String(wall.date.prefix(8)) + "14"
        item.time = wall.time
        item.location = kind == .event ? "Sheremetyevo, Terminal B" : ""
        item.notes = "Seat 12A\n\nhttps://example.com/booking\n\ncontextflow://chat?id=debug&m=debug"
        item.url = "https://example.com/booking"
        if UserDefaults.standard.bool(forKey: "CFDebugAppleSave") {
            do {
                print("CFDebugAppleSave saved to: \(try AppleItems.save(item, key: "cf.remind.debug.debug")) access: \(AppleItems.status())")
            } catch {
                print("CFDebugAppleSave failed: \(error) access: \(AppleItems.status())")
            }
            return
        }
        let id = "0000aaaa-bbbb-cccc-dddd-a991e0000001"
        AppleItems.handOff(item, key: nil, id: id)
        open(URL(string: "contextflow://add?id=\(id)")!)
        #endif
    }

    /// Settings, where access to Reminders or Calendar is turned on.
    static func openSettings(_ kind: AppleItems.Item.Kind) {
        #if os(iOS)
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #else
        let pane = kind == .reminder ? "Privacy_Reminders" : "Privacy_Calendars"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
        #endif
    }
}

struct AppleAddView: View {
    @ObservedObject var model: AppleAdd

    var body: some View { content }

    private var kind: AppleItems.Item.Kind { model.request?.item.kind ?? .reminder }

    private var content: some View {
        NavigationStack {
            VStack(spacing: 14) {
                switch model.state {
                case .working, .editor:
                    ProgressView()
                case .saved(let place):
                    Image(systemName: kind == .reminder ? "checklist" : "calendar.badge.checkmark")
                        .font(.system(size: 40)).foregroundColor(brandBlue)
                    Text(model.request?.item.title ?? "").font(.headline).multilineTextAlignment(.center)
                    Text(kind == .reminder
                         ? (place.isEmpty ? String(localized: "Added to Reminders.") : String(localized: "Added to Reminders: \(place)."))
                         : String(localized: "Added to Calendar."))
                        .foregroundColor(.secondary).multilineTextAlignment(.center)
                    #if os(iOS)
                    Text("To go back, tap ◀ Safari at the top left.")
                        .font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
                    #endif
                case .denied:
                    Image(systemName: "lock").font(.system(size: 34)).foregroundColor(.secondary)
                    Text(kind == .reminder
                         ? LocalizedStringKey("ContextFlow has no access to Reminders. Turn it on in Settings, then try again in Safari.")
                         : LocalizedStringKey("ContextFlow has no access to Calendar. Turn it on in Settings, then try again in Safari."))
                        .multilineTextAlignment(.center)
                    Button("Open Settings") { AppleAdd.openSettings(kind) }
                        .buttonStyle(.borderedProminent)
                case .failed:
                    Text("Couldn't add it. Try again in Safari.").multilineTextAlignment(.center)
                case .gone:
                    Text("This is no longer here. Tap Add in Safari again.").multilineTextAlignment(.center)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(kind == .reminder ? LocalizedStringKey("Reminders") : LocalizedStringKey("Calendar"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { model.close() } }
            }
        }
        .presentationDetents([.medium])
        .frame(minWidth: 360, minHeight: 260)
    }
}
