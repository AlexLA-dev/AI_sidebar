import Foundation
import UserNotifications
#if canImport(os)
import os
#endif

/// Find similar after leaving Safari (build 94, the owner: «Поиск прерывается, если выходишь из Safari, а надо, чтобы
/// шел и приходила нотификация от приложения, когда найдено с переходом прямо к вариантам»).
///
/// Our server finishes a Find similar on its own and keeps the answer (/api/v2/similar-result). When the person leaves
/// Safari mid-search, the extension starts a background download of that answer here: iOS carries it on while Safari's
/// extension is suspended and, once it's done, wakes the ContextFlow app with it (`handleEvents`). The app (or the
/// extension, still running) then says how it ended in a notification. Its tap asks the panel to open that chat
/// (ChatMirror's "Open in Safari" and `takeOpen`) and opens the page in Safari, where the extension picks the answer up
/// from our server and writes it into the chat. Back in Safari first, everything is called off: no notification for
/// someone who stayed. No push and no keys: only the user's own download.
///
/// Compiled into the app and the extension targets (the App Group holds what both need: `cf.similarAway`). Not on the
/// main actor (the app's default): URLSession calls its delegate on a queue of its own.
nonisolated enum SimilarAway {
    static let sessionPrefix = "com.contextflow.similar."
    static let notificationPrefix = "cf.similar."
    private static let watchesKey = "cf.similarAway"
    private static let openKey = "cf.similarOpen"
    /// How long a tap's "open this chat" waits for the panel.
    private static let openWindow: TimeInterval = 15 * 60
    /// Asked again while the server still searches, at most this often (each round holds up to 55 s there).
    private static let maxRounds = 3

    /// A search the app watches: what to ask, and the notification's words in the person's language.
    struct Watch: Codable {
        var job: String
        var thread: String
        var install: String
        var base: String
        var open: String
        /// When the search started (ms).
        var at: Double
        var title: String
        /// With `%d` for how many were found.
        var found: String
        var none: String
        var failed: String
        var rounds: Int
    }

    /// The App Group (SharedDefaults.suiteName, which is the main actor's in the app).
    private static let group = "group.com.contextflow.shared"
    private static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }

    private static func watches() -> [String: Watch] {
        guard let data = defaults.data(forKey: watchesKey) else { return [:] }
        return (try? JSONDecoder().decode([String: Watch].self, from: data)) ?? [:]
    }

    private static func save(_ all: [String: Watch]) {
        // Older than an hour: the search is long over.
        let now = Date().timeIntervalSince1970 * 1000
        let kept = all.filter { now - $0.value.at < 3_600_000 }
        if let data = try? JSONEncoder().encode(kept) { defaults.set(data, forKey: watchesKey) }
    }

    private static let validJob = try? NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,64}$")

    private static func isJob(_ s: String) -> Bool {
        validJob?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    // MARK: The extension's side

    /// The person left Safari mid-search: a download of the kept answer, which iOS carries on with Safari suspended.
    static func start(_ message: [String: Any]) {
        #if os(iOS)
        let job = message["job"] as? String ?? ""
        let install = message["install"] as? String ?? ""
        let base = message["base"] as? String ?? ""
        guard isJob(job), UUID(uuidString: install) != nil, base.hasPrefix("https://") else { return }
        let text = { (key: String, max: Int) in String((message[key] as? String ?? "").prefix(max)) }
        let watch = Watch(
            job: job, thread: text("thread", 80), install: install, base: base, open: text("open", 2_000),
            at: (message["at"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000,
            title: text("title", 120), found: text("found", 240), none: text("none", 240), failed: text("failed", 240), rounds: 0
        )
        var all = watches()
        all[job] = watch
        save(all)
        ask(watch)
        log("watching \(job)")
        #endif
    }

    /// Back in Safari: every download called off, "found" notifications withdrawn (the chat has the answer now); the
    /// chat a notification's tap asked to open, once, if recent.
    static func back() -> String? {
        #if os(iOS)
        let all = watches()
        for job in all.keys { cancel(job) }
        save([:])
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let ids = delivered.map(\.request.identifier).filter { $0.hasPrefix(notificationPrefix) }
            if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
        }
        #endif
        return takeOpen()
    }

    /// The search ended while the extension still ran (Safari had only just been left): the notification now, when
    /// `notify`; the download called off either way.
    static func ended(_ message: [String: Any]) async {
        let job = message["job"] as? String ?? ""
        guard isJob(job) else { return }
        var all = watches()
        let watch = all.removeValue(forKey: job)
        save(all)
        #if os(iOS)
        cancel(job)
        #endif
        guard message["notify"] as? Bool == true else { return }
        let outcome = message["outcome"] as? String ?? ""
        let items = (message["items"] as? NSNumber)?.intValue ?? 0
        let w = watch ?? Watch(
            job: job, thread: message["thread"] as? String ?? "", install: "", base: "", open: message["open"] as? String ?? "",
            at: 0, title: message["title"] as? String ?? "", found: message["found"] as? String ?? "",
            none: message["none"] as? String ?? "", failed: message["failed"] as? String ?? "", rounds: 0
        )
        await notify(w, outcome: outcome, items: items)
    }

    // MARK: Both: the download and its outcome

    #if os(iOS)
    private static let lock = NSLock()
    private static var sessions: [String: URLSession] = [:]
    private static var completions: [String: () -> Void] = [:]

    /// The background session for a job's download (one per job; the same object for the process's life).
    private static func session(_ identifier: String) -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let s = sessions[identifier] { return s }
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sharedContainerIdentifier = group
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.timeoutIntervalForResource = 15 * 60
        let s = URLSession(configuration: config, delegate: SimilarAwayDelegate.shared, delegateQueue: nil)
        sessions[identifier] = s
        return s
    }

    private static func ask(_ w: Watch) {
        var parts = URLComponents(string: "\(w.base)/api/v2/similar-result")
        parts?.queryItems = [URLQueryItem(name: "install", value: w.install), URLQueryItem(name: "job", value: w.job), URLQueryItem(name: "wait", value: "55")]
        guard let url = parts?.url else { return }
        let task = session(sessionPrefix + w.job).downloadTask(with: url)
        task.taskDescription = w.job
        task.resume()
    }

    private static func cancel(_ job: String) {
        let s = session(sessionPrefix + job)
        s.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    }

    /// The app, woken by iOS for a download that ended: its session again, so its events come; `completion` when done.
    static func handleEvents(_ identifier: String, completion: @escaping () -> Void) {
        lock.lock()
        completions[identifier] = completion
        lock.unlock()
        _ = session(identifier)
    }

    fileprivate static func eventsDone(_ identifier: String) {
        lock.lock()
        let completion = completions.removeValue(forKey: identifier)
        lock.unlock()
        // iOS's own handler, called once on the main thread.
        nonisolated(unsafe) let call = completion
        if call != nil { DispatchQueue.main.async { call?() } }
    }

    /// A download ended with the server's word on the job: the notification, or asked again while it still searches.
    fileprivate static func delivered(_ job: String, data: Data?) {
        var all = watches()
        guard var w = all[job] else { return }
        let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let state = body["state"] as? String ?? ""
        if state == "running", w.rounds + 1 < maxRounds {
            w.rounds += 1
            all[job] = w
            save(all)
            ask(w)
            return
        }
        all.removeValue(forKey: job)
        save(all)
        // Taken already (the person came back to Safari, which wrote the answer): nothing to say.
        guard state == "done" || state == "failed" || state == "running" else { return }
        let items = ((body["result"] as? [String: Any])?["items"] as? [Any])?.count ?? 0
        let outcome = state == "done" ? (items > 0 ? "found" : "none") : "failed"
        let done = DispatchSemaphore(value: 0)
        Task {
            await notify(w, outcome: outcome, items: items)
            done.signal()
        }
        // The app may be suspended right after its events are handled: the notification is in first.
        _ = done.wait(timeout: .now() + 5)
    }
    #endif

    /// "Find similar is done": how it ended, in the person's language. Its tap opens the chat in Safari.
    static func notify(_ w: Watch, outcome: String, items: Int) async {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        #if os(iOS)
        guard status == .authorized || status == .provisional || status == .ephemeral else { return }
        #else
        guard status == .authorized || status == .provisional else { return }
        #endif
        let content = UNMutableNotificationContent()
        content.title = w.title.isEmpty ? "ContextFlow" : w.title
        switch outcome {
        case "found": content.body = w.found.replacingOccurrences(of: "%d", with: String(items))
        case "none": content.body = w.none
        default: content.body = w.failed
        }
        content.sound = .default
        content.threadIdentifier = "cf.similar"
        content.userInfo = ["similar": w.job, "chat": w.thread, "open": w.open]
        try? await center.add(UNNotificationRequest(identifier: notificationPrefix + w.job, content: content, trigger: nil))
        log("notified \(w.job) \(outcome)")
    }

    // MARK: The app: the notification's tap

    /// The page to open in Safari (the app opens it: UIApplication isn't an extension's), with the chat in its address:
    /// the tab it opens in shows the panel on that chat (build 95, the owner: «Никогда не открывает расширение на
    /// странице». Build 94 left the chat for "the next panel to ask", and the tab the search started in could take it
    /// first, behind the new one; nor did a page ask at all half an hour after the search).
    @MainActor
    static func opened(_ info: [AnyHashable: Any]) -> URL? {
        guard info["similar"] is String else { return nil }
        let thread = info["chat"] as? String ?? ""
        guard let page = (info["open"] as? String).flatMap(URL.init(string:)), page.scheme == "https" || page.scheme == "http" else {
            if isThread(thread) { ChatMirror.requestOpen(thread) }
            return nil
        }
        guard isThread(thread) else { return page }
        ChatMirror.requestOpen(thread)
        return pageOpening(page, thread: thread)
    }

    /// The page with `#cf-similar=<chat>` (the panel takes it out at once); a page with an address fragment of its own
    /// keeps it, and the chat waits for the next panel that asks instead.
    static func pageOpening(_ page: URL, thread: String) -> URL {
        if var parts = URLComponents(url: page, resolvingAgainstBaseURL: false), (parts.fragment ?? "").isEmpty {
            parts.fragment = "cf-similar=\(thread)"
            if let marked = parts.url { return marked }
        }
        defaults.set(["thread": thread, "at": Date().timeIntervalSince1970], forKey: openKey)
        return page
    }

    private static let validThread = try? NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,80}$")

    private static func isThread(_ s: String) -> Bool {
        validThread?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// The chat a notification's tap asked to open, once, if recent.
    private static func takeOpen() -> String? {
        guard let stored = defaults.dictionary(forKey: openKey) else { return nil }
        defaults.removeObject(forKey: openKey)
        guard let thread = stored["thread"] as? String, let at = stored["at"] as? Double, Date().timeIntervalSince1970 - at < openWindow else { return nil }
        return thread
    }

    static func log(_ text: String) {
        #if canImport(os)
        Logger(subsystem: "com.contextflow.app", category: "similar").notice("\(text, privacy: .public)")
        #endif
    }
}

#if os(iOS)
/// The background downloads' delegate (the app's or the extension's process, whichever runs when they end).
nonisolated final class SimilarAwayDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = SimilarAwayDelegate()

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file goes when this returns: read now.
        let data = try? Data(contentsOf: location)
        guard let job = downloadTask.taskDescription else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        SimilarAway.delivered(job, data: status == 200 ? data : nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error, (error as NSError).code != NSURLErrorCancelled { SimilarAway.log("download failed: \(error.localizedDescription)") }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        if let identifier = session.configuration.identifier { SimilarAway.eventsDone(identifier) }
    }
}
#endif
