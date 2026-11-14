import DeviceCheck
import SwiftUI

/// Invite a friend (2.7, plan section 5; the rules are src/shared/invite.ts, the server /api/v2/invite). The install's
/// code and link, its friends and its reward in Settings; a friend's code on the first screen of a new install. No
/// account: the code belongs to the install (the extension's install id once known, else the app's own id). Optional,
/// and nothing waits behind it (App Store rule 3.2.2(x)): the friend gets answers, the inviter an App Store offer code.
@MainActor
final class InviteModel: ObservableObject {
    static let shared = InviteModel()

    struct Offer: Equatable {
        let code: String
        let discount: Int
    }

    struct Reward: Equatable {
        let pro: Offer?
        let ultra: Offer?
        /// The director's proposal (server INVITE_INVITER_ANSWERS): extra answers when both discounts are used.
        let answers: (daily: Int, left: Int)?

        static func == (a: Reward, b: Reward) -> Bool {
            a.pro == b.pro && a.ultra == b.ultra && a.answers?.daily == b.answers?.daily && a.answers?.left == b.answers?.left
        }
    }

    @Published private(set) var code: String?
    @Published private(set) var link: String?
    @Published private(set) var joined = 0
    @Published private(set) var active = 0
    @Published private(set) var reward: Reward?
    @Published private(set) var answersUntil: Date?
    @Published private(set) var enteredUntil: Date?
    @Published private(set) var canEnter = false
    @Published private(set) var friendDaily = 5
    @Published private(set) var busy = false
    @Published var error: String?
    /// A code from a link (contextflow://invite?code=…), put into the field.
    @Published var draft = ""
    /// The screen from Settings, or from a link.
    @Published var shown = false

    /// The first screen's card: a new install (first week, not an update) without a friend's code yet.
    var offersEntry: Bool {
        if enteredUntil != nil || Self.keptUntil() != nil { return false }
        guard let first = SharedDefaults.shared.appFirstLaunch() else { return true }
        return !first.updated && Date().timeIntervalSince(first.at) < 7 * 86_400
    }

    /// The first screen's card was put away ("Not now").
    @Published var entryHidden = UserDefaults.standard.bool(forKey: "cf_invite_entry_hidden") {
        didSet { UserDefaults.standard.set(entryHidden, forKey: "cf_invite_entry_hidden") }
    }
    /// The inviter's discount as named before the server says (the App Store shows the real price).
    var discount: Int { reward?.pro?.discount ?? reward?.ultra?.discount ?? 50 }

    // MARK: Server

    private func post(_ op: String, _ fields: [String: Any] = [:]) async -> (Int, [String: Any]) {
        var body = ChatAI.identity()
        body["op"] = op
        body["appId"] = Activation.shared.appId
        for (key, value) in fields { body[key] = value }
        guard let request = try? ChatAI.request("api/v2/invite", body),
              let (data, response) = try? await URLSession.shared.data(for: request) else { return (0, ["code": "NETWORK"]) }
        let object = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, object)
    }

    /// What's there already, or (create) the install's code, made on the first ask.
    func load(create: Bool) async {
        busy = true
        let (status, object) = await post("state", ["create": create])
        busy = false
        guard status == 200, object["ok"] as? Bool == true else {
            if create { error = Self.failureText(object["code"] as? String) }
            return
        }
        apply(object)
        error = nil
    }

    private func apply(_ object: [String: Any]) {
        code = object["code"] as? String
        link = object["link"] as? String
        joined = object["joined"] as? Int ?? 0
        active = object["active"] as? Int ?? 0
        canEnter = object["canEnter"] as? Bool ?? false
        friendDaily = object["friendDaily"] as? Int ?? friendDaily
        enteredUntil = ((object["entered"] as? [String: Any])?["until"] as? String).flatMap(Self.date)
        answersUntil = (object["answersUntil"] as? String).flatMap(Self.date)
        reward = (object["reward"] as? [String: Any]).map { reward in
            let offer = { (key: String) -> Offer? in
                guard let o = reward[key] as? [String: Any], let code = o["code"] as? String else { return nil }
                return Offer(code: code, discount: o["discount"] as? Int ?? 50)
            }
            let answers = (reward["answers"] as? [String: Any]).map { (daily: $0["daily"] as? Int ?? 5, left: $0["left"] as? Int ?? 0) }
            return Reward(pro: offer("pro"), ultra: offer("ultra"), answers: answers)
        }
        if let code { SharedDefaults.shared.updateInvite(["code": code]) }
        if let enteredUntil { SharedDefaults.shared.updateInvite(["until": enteredUntil.timeIntervalSince1970]) }
    }

    /// A friend's code: checked with Apple's DeviceCheck (one friend's bonus per device), then kept with the install.
    @discardableResult
    func redeem(_ raw: String, via: String) async -> Bool {
        guard let code = Self.parseCode(raw) else {
            error = Self.failureText("CODE_UNKNOWN")
            return false
        }
        busy = true
        var fields: [String: Any] = ["code": code]
        if let token = await Self.deviceToken() { fields["deviceToken"] = token }
        let (status, object) = await post("redeem", fields)
        busy = false
        ChatAI.reportUse("invite", status == 200 ? "code_ok" : "code_bad", ["via": via])
        guard status == 200, object["ok"] as? Bool == true, let until = (object["until"] as? String).flatMap(Self.date) else {
            error = Self.failureText(object["code"] as? String)
            return false
        }
        error = nil
        draft = ""
        enteredUntil = until
        friendDaily = object["friendDaily"] as? Int ?? friendDaily
        // The extension's install takes it over the next time it runs (it links with this app id), unless it was
        // already known and sent along now.
        let linked = SharedDefaults.shared.readExtensionStatus().installId != nil
        SharedDefaults.shared.updateInvite(["until": until.timeIntervalSince1970, "appId": Activation.shared.appId, "linked": linked])
        return true
    }

    func takeAnswers() async {
        let (status, object) = await post("answers")
        if status == 200, object["ok"] as? Bool == true { apply(object) } else { error = Self.failureText(object["code"] as? String) }
    }

    static func deviceToken() async -> String? {
        guard DCDevice.current.isSupported else { return nil }
        return await withCheckedContinuation { done in
            DCDevice.current.generateToken { data, _ in done.resume(returning: data?.base64EncodedString()) }
        }
    }

    // MARK: Rules shared with the panel (src/shared/invite.ts)

    /// The code in what was typed or pasted: the code in any case, with spaces or a dash, or the link.
    nonisolated static func parseCode(_ raw: String) -> String? {
        let text = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        let valid = { (s: String) -> Bool in
            s.count == 6 && s.allSatisfy { "ABCDEFGHJKMNPQRSTUVWXYZ23456789".contains($0) }
        }
        if let range = text.range(of: #"/i/[A-Za-z0-9]{6}(?![A-Za-z0-9])"#, options: .regularExpression) {
            let code = String(text[range].dropFirst(3)).uppercased()
            return valid(code) ? code : nil
        }
        guard text.count <= 20 else { return nil }
        let bare = text.filter { !" \t\n-–—_.".contains($0) }.uppercased()
        return valid(bare) ? bare : nil
    }

    /// While a friend's code's extra answers run, requests say so (the server checks it).
    nonisolated static func keptUntil() -> Date? {
        guard let until = SharedDefaults.shared.readInvite()["until"] as? Double else { return nil }
        let date = Date(timeIntervalSince1970: until)
        return date > Date() ? date : nil
    }

    static func failureText(_ code: String?) -> String {
        switch code {
        case "CODE_UNKNOWN": return String(localized: "There's no such code. Check it and try again.")
        case "OWN_CODE": return String(localized: "That's your own code. Send it to a friend.")
        case "ALREADY": return String(localized: "A friend's code has already been entered here.")
        case "TOO_LATE": return String(localized: "A friend's code works in the first week after installing.")
        case "CODE_FULL": return String(localized: "This code has reached its limit.")
        case "DEVICE_USED": return String(localized: "A friend's code has already been used on this device.")
        case "DEVICE_CHECK": return String(localized: "Couldn't check this device. Try again later.")
        default: return String(localized: "Couldn't do that right now. Try again later.")
        }
    }

    static func date(_ iso: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    static func day(_ date: Date) -> String {
        date.formatted(.dateTime.day().month(.wide))
    }

    /// The App Store's redeem page for an offer code (Pro's or Ultra's first month at a discount).
    static func redeemURL(_ code: String) -> URL {
        var parts = URLComponents(string: "https://apps.apple.com/redeem")!
        parts.queryItems = [URLQueryItem(name: "ctx", value: "offercodes"), URLQueryItem(name: "id", value: "6759115793"), URLQueryItem(name: "code", value: code)]
        return parts.url!
    }
}

/// Settings' «Invite a friend» screen.
struct InviteView: View {
    @ObservedObject var model = InviteModel.shared
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    private func shareText(_ code: String, _ link: String) -> String {
        String(localized: "I use ContextFlow, AI right on the page in Safari. With my code \(code) you get bonus answers for your first week: \(link)")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Your friend gets bonus answers: +\(model.friendDaily) a day for their first week. You get \(model.discount)% off the first month of Pro or Ultra once they've asked questions on two different days.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                Section(header: Text("Your code")) {
                    if let code = model.code, let link = model.link {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(code)
                                .font(.system(size: 28, weight: .bold, design: .monospaced))
                                .kerning(3)
                                .textSelection(.enabled)
                            Text(link.replacingOccurrences(of: "https://", with: ""))
                                .font(.footnote)
                                .foregroundColor(.secondary)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 4)
                        ShareButton(items: { [shareText(code, link)] }, done: { ChatAI.reportUse("invite", "share", ["via": "app"]) }) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                        Button {
                            Clipboard.copy(shareText(code, link))
                            copied = true
                            ChatAI.reportUse("invite", "copy", ["via": "app"])
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        } label: {
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                        if model.joined > 0 {
                            Text("Came with your code: \(model.joined) · using it: \(model.active)")
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        }
                    } else {
                        Button {
                            Task { await model.load(create: true) }
                        } label: {
                            Label("Get my code and link", systemImage: "gift")
                        }
                        .disabled(model.busy)
                    }
                }
                if let reward = model.reward {
                    Section(header: Text("A friend you invited is using ContextFlow"),
                            footer: Text("Thank you: \(model.discount)% off the first month of Pro or Ultra, your choice. The App Store applies it if you haven't used this discount before.")) {
                        if let pro = reward.pro {
                            Button {
                                ChatAI.reportUse("invite", "reward_pro", ["via": "app"])
                                openURL(InviteModel.redeemURL(pro.code))
                            } label: {
                                Text(verbatim: "Pro −\(pro.discount)%")
                            }
                        }
                        if let ultra = reward.ultra {
                            Button {
                                ChatAI.reportUse("invite", "reward_ultra", ["via": "app"])
                                openURL(InviteModel.redeemURL(ultra.code))
                            } label: {
                                Text(verbatim: "Ultra −\(ultra.discount)%")
                            }
                        }
                        if let answers = reward.answers, answers.left > 0 {
                            Button("Used both discounts? Take bonus answers instead: +\(answers.daily) a day for a week") {
                                ChatAI.reportUse("invite", "reward_answers", ["via": "app"])
                                Task { await model.takeAnswers() }
                            }
                        }
                    }
                }
                if let until = model.answersUntil {
                    Section { Text("Your bonus answers run until \(InviteModel.day(until)).") }
                }
                if let until = model.enteredUntil {
                    Section { Text("You came with a friend's code: bonus answers, +\(model.friendDaily) a day, until \(InviteModel.day(until)).") }
                } else if model.canEnter || !model.draft.isEmpty {
                    Section(header: Text("Have a friend's code?")) {
                        FriendCodeField(via: "app")
                    }
                }
                if let error = model.error {
                    Section { Text(error).foregroundColor(.red) }
                }
            }
            .navigationTitle("Invite a friend")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task {
                ChatAI.reportUse("invite", "open", ["via": "app"])
                await model.load(create: false)
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }
}

/// A friend's code: typed, pasted (the system's paste button asks nothing), or from the invite link.
struct FriendCodeField: View {
    @ObservedObject var model = InviteModel.shared
    let via: String

    var body: some View {
        HStack(spacing: 8) {
            TextField("Code or link", text: $model.draft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.characters)
                #endif
                .onSubmit { Task { await model.redeem(model.draft, via: via) } }
            PasteButton(payloadType: String.self) { strings in
                guard let text = strings.first else { return }
                Task { @MainActor in model.draft = InviteModel.parseCode(text) ?? text }
            }
            .labelStyle(.iconOnly)
            Button("Enter") { Task { await model.redeem(model.draft, via: via) } }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy || model.draft.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }
}

/// The first screen's card on a new install: «Have a friend's code?».
struct FriendCodeCard: View {
    @ObservedObject var model = InviteModel.shared

    var body: some View {
        if let until = model.enteredUntil {
            Label("Code accepted: bonus answers, +\(model.friendDaily) a day, until \(InviteModel.day(until)).", systemImage: "gift")
                .font(.subheadline)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.cardFill))
        } else if model.offersEntry && (!model.entryHidden || !model.draft.isEmpty) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Have a friend's code?", systemImage: "gift")
                        .font(.headline)
                    Spacer()
                    Button("Not now") { model.entryHidden = true }
                        .font(.subheadline)
                }
                Text("Enter it for bonus answers in your first week.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                FriendCodeField(via: "first_screen")
                if let error = model.error {
                    Text(error).font(.footnote).foregroundColor(.red)
                }
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.cardFill))
        }
    }
}
