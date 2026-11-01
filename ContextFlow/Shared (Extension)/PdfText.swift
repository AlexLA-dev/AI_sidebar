import Foundation
import PDFKit

/// Text of a PDF for the panel's context (`pdfText` command): the extension asks with the PDF's
/// address (downloaded here, on the device) or, for a PDF behind a sign-in, with the bytes it fetched
/// itself. Nothing leaves the device here; the text goes into the question like a page's text.
enum PdfText {
    static let maxBytes = 30 * 1024 * 1024
    static let maxChars = 150_000

    /// `{ok: true, text, pages, title}` or `{ok: false, error, status?}`; error is one of
    /// `badRequest`, `http`, `network`, `tooBig`, `notPdf`, `locked`, `noText`.
    static func read(url: String?, base64: String?) async -> [String: Any] {
        let data: Data
        if let base64, let decoded = Data(base64Encoded: base64) {
            data = decoded
        } else if let url, let link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") {
            switch await download(link) {
            case .success(let downloaded): data = downloaded
            case .failure(let failure): return failure.reply
            }
        } else {
            return ["ok": false, "error": "badRequest"]
        }
        return parse(data)
    }

    static func parse(_ data: Data) -> [String: Any] {
        guard data.count <= maxBytes else { return ["ok": false, "error": "tooBig"] }
        // "%PDF" near the start; servers that answer with a sign-in page are not PDFs.
        guard data.prefix(1024).range(of: Data("%PDF".utf8)) != nil, let document = PDFDocument(data: data) else {
            return ["ok": false, "error": "notPdf"]
        }
        if document.isLocked, !document.unlock(withPassword: "") {
            return ["ok": false, "error": "locked"]
        }
        var text = ""
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index), let content = page.string?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty else { continue }
            // Page marks let answers point to "page 12".
            text += "[Page \(index + 1)]\n\(content)\n\n"
            if text.count > maxChars { break }
        }
        // Scanned documents are pictures of text (no OCR yet).
        guard !text.isEmpty else { return ["ok": false, "error": "noText", "pages": document.pageCount] }
        let title = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ["ok": true, "text": String(text.prefix(maxChars)), "pages": document.pageCount, "title": title]
    }

    private struct Failure: Error {
        let reply: [String: Any]
    }

    private static func download(_ url: URL) async -> Result<Data, Failure> {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        var request = URLRequest(url: url)
        // Some servers only answer browsers.
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", forHTTPHeaderField: "User-Agent")
        request.setValue("application/pdf,*/*;q=0.8", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession(configuration: config).data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                return .failure(Failure(reply: ["ok": false, "error": "http", "status": http.statusCode]))
            }
            if data.count > maxBytes { return .failure(Failure(reply: ["ok": false, "error": "tooBig"])) }
            return .success(data)
        } catch {
            return .failure(Failure(reply: ["ok": false, "error": "network"]))
        }
    }
}
