import SwiftUI

// The agent in the app (2.7.1): deferred tasks in the lists the app already has (a task at a time under the bell,
// «Reminders»; a task waiting for a page watch under the eye, «Watching»: the owner's split of time and change), and
// «My details» in the settings, the same store the panel edits (FormData.swift), with the one iCloud question.

/// Deferred agent tasks in "Reminders" (at a time) or "Watching" (on a watch). A tap opens the page; cancel takes the
/// task and its notification away (the extension hears it on its next exchange).
struct AgentTaskSource: LaterSource {
    let kind: LaterItem.Kind

    func items() async -> [LaterItem] {
        AgentTasks.entries().filter { kind == .remind ? $0.at != nil : $0.watch != nil }.map { task in
            let when = task.at.map { Date(timeIntervalSince1970: $0 / 1000) }
            let host = URL(string: task.url)?.host?.replacingOccurrences(of: "www.", with: "") ?? task.url
            let status = when.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? String(localized: "Watching: \(host)")
            return LaterItem(id: "agent:\(task.id)", kind: kind, title: task.title.isEmpty ? host : task.title, url: URL(string: task.url),
                             status: status, detail: task.request, sortAt: when ?? Date(timeIntervalSince1970: task.createdAt / 1000))
        }
    }

    func cancel(_ id: String) async {
        guard id.hasPrefix("agent:") else { return }
        AgentTasks.cancelInApp(String(id.dropFirst("agent:".count)))
    }
}

enum AgentApp {
    /// At launch, with the other lists' sources.
    @MainActor
    static func start() {
        LaterCenter.shared.register(AgentTaskSource(kind: .remind))
        LaterCenter.shared.register(AgentTaskSource(kind: .watch))
    }
}

// MARK: - My details

/// What a detail is, as the panel names it (src/shared/agent/formdata.ts FORM_KEYS).
enum FormKeyName {
    static let keys: [String] = [
        "name.full", "name.given", "name.family", "name.latin", "name.phonetic", "email", "phone", "address.line",
        "address.apartment", "address.city", "address.region", "address.postal", "address.country", "company",
        "jobTitle", "website", "birthDate", "fact"
    ]

    static func name(_ key: String) -> String {
        switch key {
        case "name.full": return String(localized: "Full name")
        case "name.given": return String(localized: "First name")
        case "name.family": return String(localized: "Last name")
        case "name.latin": return String(localized: "Name in Latin letters")
        case "name.phonetic": return String(localized: "Name reading (phonetic)")
        case "email": return String(localized: "E-mail")
        case "phone": return String(localized: "Phone")
        case "address.line": return String(localized: "Street and house")
        case "address.apartment": return String(localized: "Apartment, floor")
        case "address.city": return String(localized: "City")
        case "address.region": return String(localized: "Region or state")
        case "address.postal": return String(localized: "Postal code")
        case "address.country": return String(localized: "Country")
        case "company": return String(localized: "Company")
        case "jobTitle": return String(localized: "Job title")
        case "website": return String(localized: "Website")
        case "birthDate": return String(localized: "Date of birth")
        default: return String(localized: "Something else")
        }
    }
}

/// What can't be kept (the panel's rules, src/shared/agent/formdata.ts refusedEntry): a card number (Luhn), an IBAN,
/// a social security number, or a label that names a password, card, document, code or health.
enum FormDataRules {
    private static let secretLabel = try? NSRegularExpression(pattern: "pass(word|code)|парол|passwort|mot de passe|contraseña|senha|şifre|كلمة المرور|パスワード|暗証番号|비밀번호|密码|密碼|mật khẩu|card|карт[аы]|karte|carte|tarjeta|carta|cartão|kart numar|بطاقة|カード|카드|卡号|卡號|thẻ|cvv|cvc|iban|bic|swift|passport|паспорт|pasaport|pasaporte|passeport|passaporto|passaporte|パスポート|여권|护照|護照|hộ chiếu|ssn|инн|снилс|кімлік|kimlik|codice fiscale|cpf|dni|マイナンバー|주민등록|身份证|身分證|pin|otp|код из|verification code|diagnos|диагноз|аллерг|allerg|診断|진단|诊断|診斷", options: [.caseInsensitive])

    static func refused(label: String, value: String) -> Bool {
        let l = label as NSString
        if secretLabel?.firstMatch(in: label, range: NSRange(location: 0, length: l.length)) != nil { return true }
        return hasCardNumber(value) || hasIBAN(value) || value.range(of: #"\b\d{3}-\d{2}-\d{4}\b"#, options: .regularExpression) != nil
    }

    static func hasCardNumber(_ text: String) -> Bool {
        let groups = text.components(separatedBy: CharacterSet(charactersIn: "0123456789 -").inverted)
        for g in groups {
            let digits = g.filter(\.isNumber).compactMap { $0.wholeNumberValue }
            guard (13...19).contains(digits.count) else { continue }
            var sum = 0
            for (i, d) in digits.reversed().enumerated() {
                var x = d
                if i % 2 == 1 { x *= 2; if x > 9 { x -= 9 } }
                sum += x
            }
            if sum % 10 == 0 { return true }
        }
        return false
    }

    static func hasIBAN(_ text: String) -> Bool {
        let compact = text.uppercased().replacingOccurrences(of: " ", with: "")
        guard let r = compact.range(of: #"[A-Z]{2}\d{2}[A-Z0-9]{11,30}"#, options: .regularExpression) else { return false }
        let iban = String(compact[r])
        let moved = iban.dropFirst(4) + iban.prefix(4)
        var rest = 0
        for ch in moved {
            let n = ch.isLetter ? Int(ch.asciiValue! - 55) : (ch.wholeNumberValue ?? 0)
            for digit in String(n) { rest = (rest * 10 + Int(String(digit))!) % 97 }
        }
        return rest == 1
    }
}

@MainActor
final class MyDetailsModel: ObservableObject {
    @Published var entries: [FormDataEntry] = FormDataStore.live()
    @Published var icloud: Bool? = FormDataStore.syncChoice

    func reload() {
        entries = FormDataStore.live()
        icloud = FormDataStore.syncChoice
    }

    /// False: refused (a password, a card, a document…).
    func add(key: String, label: String, value: String) -> Bool {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = key == "fact" ? label.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        guard !v.isEmpty, key != "fact" || !l.isEmpty else { return true }
        if FormDataRules.refused(label: l.isEmpty ? FormKeyName.name(key) : l, value: v) { return false }
        FormDataStore.save(FormDataEntry(id: FormDataStore.newId(), key: key, label: l, value: String(v.prefix(500)), updatedAt: 0))
        reload()
        syncSoon()
        return true
    }

    func delete(_ e: FormDataEntry) {
        FormDataStore.delete(e.id)
        reload()
        syncSoon()
    }

    func deleteAll() {
        FormDataStore.deleteAll()
        reload()
        syncSoon()
    }

    func setICloud(_ on: Bool) {
        FormDataStore.syncChoice = on
        icloud = on
        Task {
            if on { _ = try? await FormDataSync.sync() } else { await FormDataSync.removeCloud() }
            reload()
        }
    }

    private func syncSoon() {
        guard FormDataStore.syncChoice == true else { return }
        Task {
            _ = try? await FormDataSync.sync()
            reload()
        }
    }
}

struct MyDetailsView: View {
    @StateObject private var model = MyDetailsModel()
    @State private var key = "name.full"
    @State private var label = ""
    @State private var value = ""
    @State private var refused = false
    @State private var askICloud = false
    @State private var confirmAll = false

    var body: some View {
        Form {
            Section(footer: Text("For filling in forms on sites. Kept on your device; the agent fills them in only after you agree, and the AI never sees them.")) {
                ForEach(model.entries, id: \.id) { e in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(e.key == "fact" ? e.label : FormKeyName.name(e.key)).font(.caption).foregroundStyle(.secondary)
                        Text(e.value)
                    }
                }
                .onDelete { idx in idx.map { model.entries[$0] }.forEach(model.delete) }
            }
            Section {
                Picker("Something else", selection: $key) {
                    ForEach(FormKeyName.keys, id: \.self) { Text(FormKeyName.name($0)).tag($0) }
                }
                .labelsHidden()
                if key == "fact" {
                    TextField("What is it (e.g. shoe size)", text: $label)
                }
                TextField(FormKeyName.name(key), text: $value)
                Button("Add") {
                    let first = model.entries.isEmpty && model.icloud == nil
                    refused = !model.add(key: key, label: label, value: value)
                    if !refused {
                        value = ""
                        label = ""
                        if first && !model.entries.isEmpty { askICloud = true }
                    }
                }
                if refused {
                    Text("I don't keep passwords, cards, bank or document numbers, codes or health data.").font(.footnote).foregroundStyle(.red)
                }
            }
            if let on = model.icloud {
                Section(footer: Text("Through your private iCloud, which we can't access. Without it, they stay on this device.")) {
                    Toggle("Sync through iCloud", isOn: Binding(get: { on }, set: { model.setICloud($0) }))
                }
            }
            if model.entries.count > 1 {
                Section {
                    Button("Delete all", role: .destructive) { confirmAll = true }
                }
            }
        }
        .navigationTitle("My details")
        .onAppear { model.reload() }
        .alert("Sync your details on your devices through iCloud?", isPresented: $askICloud) {
            Button("Yes") { model.setICloud(true) }
            Button("No", role: .cancel) { model.setICloud(false) }
        } message: {
            Text("Through your private iCloud, which we can't access. Without it, they stay on this device.")
        }
        .confirmationDialog("Delete all your details from this device (and from iCloud, if they sync)?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Delete all", role: .destructive) { model.deleteAll() }
        }
    }
}
