import Foundation
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A collection's PDF (2.7 «Подборки», plan section 2): the same page as the panel's (src/shared/collectionPage.ts, its
/// styles copied here word for word; tests/collections-panel.test.mts checks). Under the title a line links to the site;
/// each card links its source and «Открыть чат в ContextFlow» (the site's /open-chat opens the chat in the app, or the
/// App Store without it); every page has the footer «Сделано в ContextFlow · context-flow.app».
@MainActor
enum BoardPDF {
    static let site = "https://context-flow.app"

    static func openChatLink(_ chat: String, _ msg: String?) -> String {
        let id = chat.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? chat
        guard let msg, !msg.isEmpty else { return "\(site)/open-chat?id=\(id)" }
        return "\(site)/open-chat?id=\(id)&m=\(msg.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? msg)"
    }

    static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
    }

    private static func web(_ url: String?) -> String? {
        guard let url, url.range(of: #"^https?://[^\s"<>]+$"#, options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
        return url
    }

    /// The chat a card goes back to: its own; a comparison's, the first compared card's.
    private static func chatOf(_ card: BoardCard, _ board: Board) -> (chat: String, msg: String?)? {
        if let chat = card.chat { return (chat, card.msg) }
        for id in card.of {
            if let c = board.cards.first(where: { $0.id == id && !$0.deleted && $0.chat != nil }) { return (c.chat!, c.msg) }
        }
        return nil
    }

    private static func cardHtml(_ card: BoardCard, _ board: Board) -> String {
        var links: [String] = []
        if let src = web(card.srcURL) {
            let shown = host(of: src).isEmpty ? src : host(of: src)
            links.append("<a href=\"\(esc(src))\">\(esc(shown))&nbsp;↗</a>")
        }
        if let back = chatOf(card, board) {
            links.append("<a href=\"\(esc(openChatLink(back.chat, back.msg)))\">\(esc(String(localized: "Open chat in ContextFlow", comment: "A collection's PDF: a card's link to its chat in the app (2.7)")))&nbsp;↗</a>")
        }
        var body = "<p class=\"gist\" dir=\"auto\">\(esc(card.gist))</p>"
        if card.kind == "compare", let table = card.table {
            let head = table.h.map { "<th dir=\"auto\">\(esc($0))</th>" }.joined()
            let rows = table.r.map { "<tr>" + $0.map { "<td dir=\"auto\">\(esc($0))</td>" }.joined() + "</tr>" }.joined()
            body = "<p class=\"gist\"><b>\(esc(String(localized: "Comparison"))).</b> <span dir=\"auto\">\(esc(card.gist))</span></p>"
                + "<table><thead><tr>\(head)</tr></thead><tbody>\(rows)</tbody></table>"
                + (table.note.map { "<p class=\"note\" dir=\"auto\">\(esc($0))</p>" } ?? "")
        }
        let tags = card.tags.isEmpty ? "" : "<p class=\"tags\">" + card.tags.map { "<span dir=\"auto\">\(esc($0))</span>" }.joined() + "</p>"
        return "<div class=\"card\">\(body)\(tags)\(links.isEmpty ? "" : "<p class=\"links\">\(links.joined())</p>")</div>"
    }

    /// The whole page; `native`: the app draws the footer itself on each page (iOS).
    static func html(_ board: Board, now: Date = Date(), native: Bool = false) -> String {
        let date = DateFormatter.localizedString(from: now, dateStyle: .long, timeStyle: .none)
        let count = String(localized: "\(board.countedCards) cards", comment: "A collection's card count (2.7)")
        let sections = board.liveSections.compactMap { s -> String? in
            let cards = board.cards(in: s.id)
            guard !cards.isEmpty else { return nil }
            return "<section><h2 dir=\"auto\">\(esc(s.name))</h2>" + cards.map { cardHtml($0, board) }.joined() + "</section>"
        }.joined()
        let sum = (board.summary?.isEmpty == false) ? "<div class=\"sum\"><b>\(esc(String(localized: "Summary"))).</b> <span dir=\"auto\">\(esc(board.summary!))</span></div>" : ""
        let made = String(localized: "made with", comment: "A collection's PDF: «… · made with ContextFlow — AI for Safari» (2.7)")
        let brand = String(localized: "ContextFlow — AI for Safari", comment: "A collection's PDF: the site's link under the title (2.7)")
        let footer = String(localized: "Made with ContextFlow", comment: "A collection's PDF: the footer on every page (2.7)")
        let lang = Locale.current.language.languageCode?.identifier ?? "en"
        let rtl = Locale.Language(identifier: lang).characterDirection == .rightToLeft
        return "<!doctype html><html lang=\"\(lang)\"\(rtl ? " dir=\"rtl\"" : "")><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<title>\(esc(board.name))</title><style>\(css)</style></head><body\(native ? " class=\"native\"" : "")>"
            + "<main><h1 dir=\"auto\">\(esc(board.name))</h1>"
            + "<p class=\"meta\">\(esc(count)) · \(esc(date)) · \(esc(made)) <a href=\"\(site)\">\(esc(brand))</a></p>"
            + sum + sections + "</main>"
            + "<footer>\(esc(footer)) · <a href=\"\(site)\">context-flow.app</a></footer></body></html>"
    }

    /// The page's styles: the panel's, word for word.
    static let css = """

@page { margin: 16mm 16mm 20mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: #fff; color: #17151c; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 28px 20px 24px; }
h1 { font-size: 30px; line-height: 1.15; margin: 0 0 8px; letter-spacing: -0.01em; }
.meta { color: #5d5a66; font-size: 14px; margin: 0 0 18px; }
a { color: #2563eb; }
.sum { background: #eef2fb; border-radius: 12px; padding: 12px 16px; margin: 0 0 8px; }
section { border-top: 2px solid #17151c; padding-top: 12px; margin-top: 22px; }
h2 { font-size: 17px; margin: 0 0 4px; break-after: avoid; }
.card { padding: 10px 0; border-bottom: 1px solid #e6e4ec; break-inside: avoid; }
.card p { margin: 0 0 4px; }
.links a { font-size: 13.5px; margin-inline-end: 18px; }
.tags span { display: inline-block; font-size: 12px; color: #5d5a66; background: #f1f0f5; border-radius: 6px; padding: 1px 7px; margin-inline-end: 6px; }
table { border-collapse: collapse; margin: 6px 0; font-size: 13.5px; width: 100%; }
th, td { border: 1px solid #e0dee8; padding: 5px 8px; text-align: start; vertical-align: top; }
th { background: #f6f5f9; }
.note { color: #5d5a66; font-size: 13.5px; }
footer { max-width: 760px; margin: 0 auto; padding: 14px 20px 28px; color: #5d5a66; font-size: 13px; border-top: 1px solid #e6e4ec; }
.bar { position: sticky; top: 0; display: flex; justify-content: center; gap: 10px; padding: 10px; background: rgba(246, 245, 249, 0.94); border-bottom: 1px solid #e6e4ec; }
.bar button { font: inherit; font-weight: 600; border: 0; border-radius: 10px; padding: 9px 18px; background: #2563eb; color: #fff; cursor: pointer; }
/* The app draws its own footer on each page (BoardPDF.swift on iOS). */
body.native footer { display: none; }
@media print {
  .bar { display: none; }
  main { padding: 0; max-width: none; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; max-width: none; padding: 6px 0 0; background: #fff; }
}
"""

    // MARK: The file

    enum Failure: Error { case render }

    /// The PDF in a temporary file named after the collection, to share or save.
    static func make(_ board: Board) async throws -> URL {
        let name = board.name.replacingOccurrences(of: #"[/\\:?%*|"<>]"#, with: "-", options: .regularExpression)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name.isEmpty ? "ContextFlow" : name).pdf")
        #if os(iOS)
        let data = try await render(html(board, native: true))
        try data.write(to: url, options: .atomic)
        #else
        try await renderMac(html(board), to: url)
        #endif
        return url
    }

    /// A web view that has loaded `html`, kept until it's done.
    private final class Loader: NSObject, WKNavigationDelegate {
        let view: WKWebView
        private var done: CheckedContinuation<Void, Error>?
        init(width: CGFloat) {
            view = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 1200), configuration: WKWebViewConfiguration())
            super.init()
            view.navigationDelegate = self
        }
        func load(_ html: String) async throws {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                done = c
                view.loadHTMLString(html, baseURL: nil)
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.resume(); done = nil }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done?.resume(throwing: error); done = nil }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done?.resume(throwing: error); done = nil }
    }

    // A4 in points, the margins as the page's @page.
    static let paper = CGSize(width: 595.2, height: 841.8)
    static let margin: CGFloat = 45

    #if os(iOS)
    /// Pages with the footer drawn on each, «n / N» on the right; links stay links.
    private final class Pages: UIPrintPageRenderer {
        let footer: String
        init(footer: String) {
            self.footer = footer
            super.init()
            footerHeight = 30
        }
        override func drawFooterForPage(at pageIndex: Int, in rect: CGRect) {
            let font = UIFont.systemFont(ofSize: 9.5)
            let color = UIColor(red: 0x5d / 255, green: 0x5a / 255, blue: 0x66 / 255, alpha: 1)
            let line = CGRect(x: rect.minX, y: rect.minY + 6, width: rect.width, height: 0.5)
            UIColor(red: 0xe6 / 255, green: 0xe4 / 255, blue: 0xec / 255, alpha: 1).setFill()
            UIRectFill(line)
            let text = NSAttributedString(string: footer, attributes: [.font: font, .foregroundColor: color])
            let at = CGPoint(x: rect.minX, y: rect.minY + 12)
            text.draw(at: at)
            UIGraphicsSetPDFContextURLForRect(URL(string: BoardPDF.site)!, CGRect(origin: at, size: text.size()))
            let page = NSAttributedString(string: "\(pageIndex + 1) / \(numberOfPages)", attributes: [.font: font, .foregroundColor: color])
            page.draw(at: CGPoint(x: rect.maxX - page.size().width, y: rect.minY + 12))
        }
    }

    static func render(_ html: String) async throws -> Data {
        let loader = Loader(width: paper.width - margin * 2)
        try await loader.load(html)
        let pages = Pages(footer: "\(String(localized: "Made with ContextFlow", comment: "A collection's PDF: the footer on every page (2.7)")) · context-flow.app")
        pages.addPrintFormatter(loader.view.viewPrintFormatter(), startingAtPageAt: 0)
        let paperRect = CGRect(origin: .zero, size: paper)
        pages.setValue(paperRect, forKey: "paperRect")
        pages.setValue(paperRect.insetBy(dx: margin, dy: margin), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paperRect, nil)
        pages.prepare(forDrawingPages: NSRange(location: 0, length: pages.numberOfPages))
        for i in 0..<pages.numberOfPages {
            UIGraphicsBeginPDFPage()
            pages.drawPage(at: i, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        guard pages.numberOfPages > 0 else { throw Failure.render }
        return data as Data
    }
    #else
    /// The Mac prints the page to a PDF file (the footer is the page's own, fixed on each page).
    static func renderMac(_ html: String, to url: URL) async throws {
        let loader = Loader(width: paper.width - margin * 2)
        try await loader.load(html)
        let info = NSPrintInfo()
        info.paperSize = paper
        info.topMargin = margin
        info.bottomMargin = margin
        info.leftMargin = margin
        info.rightMargin = margin
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url
        let op = loader.view.printOperation(with: info)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        // The view needs a size to lay the pages out.
        op.view?.frame = CGRect(x: 0, y: 0, width: paper.width - margin * 2, height: paper.height - margin * 2)
        guard op.run() else { throw Failure.render }
    }
    #endif
}
