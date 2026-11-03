import Combine
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Quick insert's templates in the app: the same ones as in Safari (the store the extension shares, and
/// iCloud for the user's other devices). Made, edited, deleted and copied here; inserted in Safari.
@MainActor
final class TemplateLibrary: ObservableObject {
    static let shared = TemplateLibrary()
    @Published private(set) var templates: [TemplateRecord] = []

    init() {
        templates = TemplateStore.live()
    }

    func refresh() {
        templates = TemplateStore.live()
    }

    /// iCloud both ways, then the list again (offline or without iCloud it stays on this device).
    func sync() {
        Task {
            _ = try? await TemplateSync.sync()
            refresh()
        }
    }

    func save(_ t: TemplateRecord) {
        TemplateStore.save(t)
        refresh()
        sync()
    }

    func delete(_ id: String) {
        TemplateStore.delete(id)
        refresh()
        sync()
    }
}

struct TemplatesView: View {
    @StateObject private var library = TemplateLibrary.shared
    @State private var query = ""
    @State private var editing: TemplateRecord?
    @State private var filling: TemplateRecord?
    @State private var copied: String?

    private var shown: [TemplateRecord] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return library.templates }
        return library.templates.filter { "\($0.title) \($0.keywords.joined(separator: " ")) \($0.text)".lowercased().contains(q) }
    }

    var body: some View {
        Group {
            if library.templates.isEmpty {
                empty
            } else {
                List {
                    ForEach(shown) { t in
                        Button { editing = t } label: { row(t) }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button { copy(t) } label: { Label("Copy", systemImage: "doc.on.doc") }
                                Button(role: .destructive) { library.delete(t.id) } label: { Label("Delete", systemImage: "trash") }
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { library.delete(t.id) } label: { Label("Delete", systemImage: "trash") }
                            }
                            .swipeActions(edge: .leading) {
                                Button { copy(t) } label: { Label("Copy", systemImage: "doc.on.doc") }.tint(brandBlue)
                            }
                    }
                }
                .searchable(text: $query, prompt: Text("Search templates"))
            }
        }
        .navigationTitle("Templates")
        .toolbar {
            ToolbarItem {
                Button { editing = TemplateRecord(id: TemplateRecord.newId(), title: "", text: "", keywords: [], site: nil, createdAt: Date().timeIntervalSince1970 * 1000, updatedAt: 0) } label: {
                    Label("New Template", systemImage: "plus")
                }
            }
        }
        .sheet(item: $editing) { t in
            TemplateEditor(template: t, isNew: TemplateStore.get(t.id) == nil, onSave: { library.save($0) }, onDelete: { library.delete($0) })
        }
        .sheet(item: $filling) { t in
            BlanksForm(template: t) { text in
                Clipboard.copy(text)
                copied = t.id
            }
        }
        .overlay(alignment: .bottom) {
            if copied != nil {
                Text("Copied")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.opacity)
                    .task {
                        try? await Task.sleep(nanoseconds: 1_400_000_000)
                        withAnimation { copied = nil }
                    }
            }
        }
        .onAppear {
            library.refresh()
            library.sync()
        }
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image(systemName: "text.badge.plus")
                .font(.system(size: 40))
                .foregroundStyle(brandGradient)
            Text("Save the replies you write again and again")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("In Safari, select a reply and tap Template, or tap + here. ContextFlow marks what changes, like a name or a date, and can fill it in from the page. Your templates are on all your devices with the same Apple Account.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            Button { editing = TemplateRecord(id: TemplateRecord.newId(), title: "", text: "", keywords: [], site: nil, createdAt: Date().timeIntervalSince1970 * 1000, updatedAt: 0) } label: {
                Label("New Template", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(32)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func row(_ t: TemplateRecord) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(t.title).font(.body.weight(.semibold)).lineLimit(1)
            Text(t.text.replacingOccurrences(of: "\n", with: " "))
                .font(.subheadline)
                .foregroundColor(.secondary)
                .lineLimit(2)
            if !t.blanks.isEmpty {
                Text("Blanks: \(t.blanks.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundColor(brandBlue)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    /// A template with blanks asks for them first; one without goes straight to the clipboard.
    private func copy(_ t: TemplateRecord) {
        if t.blanks.isEmpty {
            Clipboard.copy(t.text)
            withAnimation { copied = t.id }
        } else {
            filling = t
        }
    }
}

/// Making or editing a template: its title, the text with {blanks}, words to find it by.
private struct TemplateEditor: View {
    @Environment(\.dismiss) private var dismiss
    let template: TemplateRecord
    let isNew: Bool
    let onSave: (TemplateRecord) -> Void
    let onDelete: (String) -> Void
    @State private var title: String
    @State private var text: String
    @State private var keywords: String

    init(template: TemplateRecord, isNew: Bool, onSave: @escaping (TemplateRecord) -> Void, onDelete: @escaping (String) -> Void) {
        self.template = template
        self.isNew = isNew
        self.onSave = onSave
        self.onDelete = onDelete
        _title = State(initialValue: template.title)
        _text = State(initialValue: template.text)
        _keywords = State(initialValue: template.keywords.joined(separator: ", "))
    }

    private var blanks: [String] {
        var seen: [String] = []
        for label in TemplateRecord.blankLabels(in: text) where !seen.contains(label) { seen.append(label) }
        return seen
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("Title")) {
                    TextField("Title", text: $title)
                }
                Section(header: Text("Text"), footer: Text("Put blanks in braces, like {Name}. They're filled in when the template is inserted, by hand, from Copied, or from the page.")) {
                    TextEditor(text: $text)
                        .frame(minHeight: 160)
                    if !blanks.isEmpty {
                        Text("Blanks: \(blanks.joined(separator: ", "))")
                            .font(.caption)
                            .foregroundColor(brandBlue)
                    }
                    Button { text += text.hasSuffix(" ") || text.isEmpty ? "{Name}" : " {Name}" } label: {
                        Label("Add a Blank", systemImage: "curlybraces")
                    }
                }
                Section(header: Text("Words to find it by"), footer: Text("Separated by commas. In Safari, type / and a few words in any field, or search the list.")) {
                    TextField("meeting, reschedule", text: $keywords)
                }
                if !isNew {
                    Section {
                        Button(role: .destructive) {
                            onDelete(template.id)
                            dismiss()
                        } label: { Text("Delete Template") }
                    }
                }
            }
            .navigationTitle(isNew ? Text("New Template") : Text("Template"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var t = template
                        t.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        t.text = String(text.prefix(8000))
                        t.keywords = keywords.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(6).map { String($0.prefix(30)) }
                        onSave(t)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 480)
        #endif
    }
}

/// The blanks of a template before it's copied: one field each.
private struct BlanksForm: View {
    @Environment(\.dismiss) private var dismiss
    let template: TemplateRecord
    let onCopy: (String) -> Void
    @State private var values: [String: String] = [:]

    var body: some View {
        NavigationStack {
            Form {
                Section(footer: Text(template.filled(values))) {
                    ForEach(template.blanks, id: \.self) { label in
                        TextField(label, text: Binding(get: { values[label] ?? "" }, set: { values[label] = $0 }))
                    }
                }
            }
            .navigationTitle(template.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Copy") {
                        onCopy(template.filled(values))
                        dismiss()
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, minHeight: 320)
        #endif
    }
}
