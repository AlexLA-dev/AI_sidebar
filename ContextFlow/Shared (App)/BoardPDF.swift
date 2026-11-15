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
        // As encodeURIComponent (the panel's openChatLink): letters, digits and - _ . ! ~ * ' ( ) stay.
        let kept = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        let id = chat.addingPercentEncoding(withAllowedCharacters: kept) ?? chat
        guard let msg, !msg.isEmpty else { return "\(site)/open-chat?id=\(id)" }
        return "\(site)/open-chat?id=\(id)&m=\(msg.addingPercentEncoding(withAllowedCharacters: kept) ?? msg)"
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
                // The note is the card's gist when the AI gave one: not twice.
                + (table.note.flatMap { $0 == card.gist ? nil : "<p class=\"note\" dir=\"auto\">\(esc($0))</p>" } ?? "")
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
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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
body.native main { padding: 0; max-width: none; }
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
        try await render(html(board, native: true)).write(to: url, options: .atomic)
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

    // The paper in points: Letter where people print on it (the US, Canada, Mexico and the rest of the Americas that do,
    // the Philippines), A4 elsewhere; on a Mac, the paper its printing is set to. The margins as the page's @page.
    static let a4 = CGSize(width: 595.2, height: 841.8)
    static let letter = CGSize(width: 612, height: 792)
    static let letterRegions: Set<String> = ["US", "PR", "CA", "MX", "BZ", "CL", "CO", "CR", "GT", "NI", "PA", "PH", "SV", "VE"]
    static func paperFor(region: String?, metric: Bool) -> CGSize {
        if let region { return letterRegions.contains(region.uppercased()) ? letter : a4 }
        return metric ? a4 : letter
    }
    static var paper: CGSize {
        #if os(macOS)
        let set = NSPrintInfo.shared.paperSize
        if (400...1_000).contains(set.width), (400...1_400).contains(set.height) { return set }
        #endif
        return paperFor(region: Locale.current.region?.identifier, metric: Locale.current.measurementSystem != .us)
    }
    static let margin: CGFloat = 45
    static let footerRoom: CGFloat = 26

    /// Where a page may end: under a card, the summary or the title's line, or above a section (content points).
    static func slices(height: CGFloat, breaks: [CGFloat], page: CGFloat) -> [(top: CGFloat, bottom: CGFloat)] {
        var out: [(top: CGFloat, bottom: CGFloat)] = []
        var top: CGFloat = 0
        while top < height - 1 {
            let limit = top + page
            if limit >= height {
                out.append((top, height))
                break
            }
            // The last break that fits, if it fills at least a third of the page; else cut where the page ends.
            let bottom = breaks.filter { $0 > top + page / 3 && $0 <= limit }.max() ?? limit
            out.append((top, bottom))
            // The next page starts under the line a card ends with.
            top = bottom + 1
        }
        return out
    }

    /// The page drawn by the web view as one tall vector page, laid onto A4 or Letter pages: each page breaks between
    /// cards, keeps its links (the sources, «Открыть чат в ContextFlow», the site) and has the footer with «n / N».
    static func render(_ html: String) async throws -> Data {
        let paper = BoardPDF.paper
        let width = paper.width - margin * 2
        let loader = Loader(width: width)
        try await loader.load(html)
        let script = """
        JSON.stringify({ h: Math.ceil(document.querySelector('main').getBoundingClientRect().bottom + scrollY),
          b: [...document.querySelectorAll('.card, .sum, .meta')].map((e) => e.getBoundingClientRect().bottom + scrollY)
            .concat([...document.querySelectorAll('section')].map((e) => e.getBoundingClientRect().top + scrollY - 1)),
          a: [...document.querySelectorAll('a[href]')].flatMap((e) => [...e.getClientRects()].map((r) => [e.href, r.left, r.top + scrollY, r.width, r.height])) })
        """
        // The content's own height (a short page's document is as tall as the view on iOS), measured with the view
        // that tall: shorter, a scrollbar (Mac) narrows the text and moves everything.
        var page: [String: Any] = [:]
        var height: CGFloat = 0
        for _ in 0..<3 {
            guard let json = try await loader.view.evaluateJavaScript(script) as? String,
                  let measured = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
                  let h = (measured["h"] as? NSNumber).map({ CGFloat($0.doubleValue) }), h > 0 else { throw Failure.render }
            page = measured
            if abs(h - loader.view.frame.height) < 1 { break }
            height = h
            loader.view.frame.size.height = h
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        height = (page["h"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? height
        let breaks = (page["b"] as? [NSNumber] ?? []).map { CGFloat($0.doubleValue) }
        let links: [(url: URL, rect: CGRect)] = (page["a"] as? [[Any]] ?? []).compactMap { a in
            let n = a.dropFirst().compactMap { ($0 as? NSNumber).map { CGFloat($0.doubleValue) } }
            guard a.count == 5, n.count == 4, let href = a[0] as? String, let url = URL(string: href), ["https", "http"].contains(url.scheme ?? "") else { return nil }
            return (url, CGRect(x: n[0], y: n[1], width: n[2], height: n[3]))
        }
        let config = WKPDFConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: width, height: height)
        let tall: Data = try await withCheckedThrowingContinuation { c in
            loader.view.createPDF(configuration: config) { result in c.resume(with: result) }
        }
        guard let provider = CGDataProvider(data: tall as CFData), let doc = CGPDFDocument(provider), let source = doc.page(at: 1) else { throw Failure.render }
        let drawn = source.getBoxRect(.mediaBox)
        // The web view's points to the tall page's (the same unless it scaled).
        let scale = drawn.width / width
        let contentArea = paper.height - margin * 2 - footerRoom
        let pages = slices(height: height, breaks: breaks, page: contentArea)

        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: paper)
        guard let consumer = CGDataConsumer(data: data as CFMutableData), let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { throw Failure.render }
        let top = paper.height - margin
        let font = CTFontCreateUIFontForLanguage(.system, 9.5, nil) ?? CTFontCreateWithName("Helvetica" as CFString, 9.5, nil)
        let grey = CGColor(red: 0x5d / 255, green: 0x5a / 255, blue: 0x66 / 255, alpha: 1)
        let footer = "\(String(localized: "Made with ContextFlow", comment: "A collection's PDF: the footer on every page (2.7)")) · "
        for (i, slice) in pages.enumerated() {
            ctx.beginPDFPage(nil)
            // The slice of the tall page, under the top margin (Core Graphics: y up).
            ctx.saveGState()
            ctx.clip(to: CGRect(x: margin, y: top - (slice.bottom - slice.top), width: width, height: slice.bottom - slice.top))
            ctx.translateBy(x: margin, y: top + slice.top)
            ctx.scaleBy(x: 1 / scale, y: 1 / scale)
            ctx.translateBy(x: -drawn.minX, y: -drawn.maxY)
            ctx.drawPDFPage(source)
            ctx.restoreGState()
            for link in links where link.rect.minY >= slice.top - 1 && link.rect.maxY <= slice.bottom + 1 {
                ctx.setURL(link.url as CFURL, for: CGRect(x: margin + link.rect.minX, y: top - (link.rect.maxY - slice.top), width: link.rect.width, height: link.rect.height))
            }
            // The footer: a line, «Сделано в ContextFlow · context-flow.app» (a link), «n / N» on the right.
            ctx.setFillColor(CGColor(red: 0xe6 / 255, green: 0xe4 / 255, blue: 0xec / 255, alpha: 1))
            ctx.fill(CGRect(x: margin, y: margin - 6, width: width, height: 0.5))
            let say = { (text: String, x: CGFloat, color: CGColor) -> CGFloat in
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                    NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color
                ]))
                ctx.textPosition = CGPoint(x: x, y: margin - 20)
                CTLineDraw(line, ctx)
                return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
            }
            let made = say(footer, margin, grey)
            let site = say("context-flow.app", margin + made, CGColor(red: 0x25 / 255, green: 0x63 / 255, blue: 0xeb / 255, alpha: 1))
            ctx.setURL(URL(string: BoardPDF.site)! as CFURL, for: CGRect(x: margin + made, y: margin - 24, width: site, height: 14))
            let count = "\(i + 1) / \(pages.count)"
            let countLine = CTLineCreateWithAttributedString(NSAttributedString(string: count, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
            _ = say(count, paper.width - margin - CGFloat(CTLineGetTypographicBounds(countLine, nil, nil, nil)), grey)
            ctx.endPDFPage()
        }
        ctx.closePDF()
        guard !pages.isEmpty else { throw Failure.render }
        return data as Data
    }
}
