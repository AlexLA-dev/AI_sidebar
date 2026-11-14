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
        request = r
        state = .working
        let kind = r.item.kind
        #if os(iOS)
        if kind == .event && AppleItems.access(.event) != .write {
            state = .editor
            return
        }
        #endif
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

    /// The event editor closed: added, or cancelled.
    func editorDone(_ saved: Bool) {
        if saved {
            state = .saved(place: "")
            report("added")
        } else {
            report("dismissed")
            close()
        }
    }

    func close() {
        waitTask?.cancel()
        request = nil
    }

    private func report(_ action: String) {
        guard let kind = request?.item.kind else { return }
        ChatAI.reportUse("apple", action, ["what": kind.rawValue, "via": "app"])
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

    var body: some View {
        #if os(iOS)
        if model.state == .editor, let item = model.request?.item {
            EventEditor(item: item) { saved in model.editorDone(saved) }
                .ignoresSafeArea()
        } else {
            content
        }
        #else
        content
        #endif
    }

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

#if os(iOS)
/// The system's event editor, filled in (iOS 17+: it runs outside the app and needs no access to Calendar).
struct EventEditor: UIViewControllerRepresentable {
    let item: AppleItems.Item
    let done: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = AppleItems.editorEvent(item, store: store)
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let done: (Bool) -> Void
        init(done: @escaping (Bool) -> Void) { self.done = done }

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            done(action == .saved)
        }
    }
}
#endif
