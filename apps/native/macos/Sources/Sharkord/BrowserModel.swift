import AppKit
import Combine
import UserNotifications
@preconcurrency import WebKit

@MainActor
final class BrowserModel: NSObject, ObservableObject {
    @Published var webView = WKWebView()
    @Published var server: ServerAddress?
    @Published var recent: [ServerAddress] = []
    @Published var showServers = false
    @Published var isLoading = false
    @Published var capturing = false
    @Published var error: String?
    @Published var dark = false
    private var lastNotification = Date.distantPast
    private var authenticating = false
    private var relay: ScriptRelay?
    private let defaults = UserDefaults.standard
    private let mediaPermissions = MediaPermissions()
    let smokeTesting = ProcessInfo.processInfo.arguments.contains("--smoke-test")

    override init() {
        super.init()
        if smokeTesting {
            let args = ProcessInfo.processInfo.arguments
            if let index = args.firstIndex(of: "--smoke-url"), args.indices.contains(index + 1),
               let address = try? ServerAddress(args[index + 1]) { connect(address) }
            return
        }
        if let data = defaults.data(forKey: "servers"), let saved = try? JSONDecoder().decode([String].self, from: data) {
            recent = saved.compactMap { try? ServerAddress($0) }
        }
        if let last = defaults.string(forKey: "lastServer"), let address = try? ServerAddress(last) {
            connect(address)
        } else {
            showServers = true
        }
    }

    func connect(_ address: ServerAddress) {
        guard confirmInterruption() else { return }
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        server = address
        capturing = false
        authenticating = false
        error = nil
        recent.removeAll { $0 == address }
        recent.insert(address, at: 0)
        recent = Array(recent.prefix(10))
        if !smokeTesting {
            defaults.set(try? JSONEncoder().encode(recent.map(\.id)), forKey: "servers")
            defaults.set(address.id, forKey: "lastServer")
        }

        let configuration = WKWebViewConfiguration()
        // mediasoup recognizes desktop WebKit only when the user agent includes Safari.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        configuration.applicationNameForUserAgent = "Safari/605.1.15 Sharkord/\(version)"
        configuration.websiteDataStore = smokeTesting ? .nonPersistent() : WKWebsiteDataStore(forIdentifier: address.dataStoreID)
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        let handler = ScriptRelay(model: self)
        relay = handler
        controller.add(handler, name: "sharkord")
        if let path = Bundle.main.url(forResource: "client", withExtension: "js") ?? Bundle.module.url(forResource: "client", withExtension: "js", subdirectory: "Resources"),
           let script = try? String(contentsOf: path, encoding: .utf8),
           let json = try? JSONEncoder().encode(address.id), let urlJSON = String(data: json, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: "window.__sharkordServerUrl=\(urlJSON);\n" + script,
                                                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        configuration.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        webView = view
        isLoading = true
        view.load(URLRequest(url: address.url))
        showServers = false
    }

    func confirmInterruption() -> Bool {
        guard capturing else { return true }
        let alert = NSAlert()
        alert.messageText = "Прервать голосовое подключение?"
        alert.informativeText = "Текущее подключение использует микрофон или камеру."
        alert.addButton(withTitle: "Продолжить")
        alert.addButton(withTitle: "Отмена")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func reload() {
        guard confirmInterruption(), let server else { return }
        error = nil
        webView.load(URLRequest(url: server.url))
    }

    func openInBrowser() {
        if let url = server?.url { NSWorkspace.shared.open(url) }
    }

    func resetMediaPermissions() {
        guard let server, confirmInterruption() else { return }
        mediaPermissions.reset(server: server)
        // the interruption was confirmed above; a fresh WebView releases cached grants.
        capturing = false
        connect(server)
    }

    func receive(_ message: WKScriptMessage) {
        guard let server, message.frameInfo.isMainFrame, server.trusts(webView.url),
              server.trusts(message.frameInfo.request.url),
              let data = message.body as? [String: Any], let type = data["type"] as? String else { return }
        switch type {
        case "capture": capturing = data["active"] as? Bool ?? false
        case "appearance":
            dark = data["dark"] as? Bool ?? false
            NSApp.appearance = data["system"] as? Bool == true ? nil : NSAppearance(named: dark ? .darkAqua : .aqua)
        case "requestNotifications", "notificationStatus":
            guard let id = data["id"] as? Int else { return }
            Task {
                let center = UNUserNotificationCenter.current()
                if type == "requestNotifications" {
                    _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                }
                let settings = await center.notificationSettings()
                let permission = settings.authorizationStatus == .authorized ? "granted" :
                    (settings.authorizationStatus == .denied ? "denied" : "default")
                guard self.server == server else { return }
                self.webView.evaluateJavaScript("window.__sharkordNativeReply?.(\(id), '\(permission)')", completionHandler: nil)
            }
        case "notify":
            guard Date().timeIntervalSince(lastNotification) > 1,
                  let title = data["title"] as? String, let body = data["body"] as? String else { return }
            lastNotification = Date()
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(120))
            content.body = String(body.prefix(2000))
            content.sound = .default
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request) { _ in }
        default: break
        }
    }
}

extension BrowserModel: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

@MainActor
private final class ScriptRelay: NSObject, WKScriptMessageHandler {
    weak var model: BrowserModel?
    init(model: BrowserModel) { self.model = model }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        model?.receive(message)
    }
}

extension BrowserModel: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        guard navigationAction.targetFrame?.isMainFrame != false else { decisionHandler(.allow); return }
        if server?.trusts(url) == true {
            if url.path.hasSuffix("/oidc/login") { authenticating = true }
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
            return
        }
        if authenticating && url.scheme == "https" && navigationAction.navigationType != .linkActivated {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "blob", navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if navigationAction.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
        capturing = false
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        error = nil
        if server?.trusts(webView.url) == true { authenticating = false }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        if (error as NSError).code != NSURLErrorCancelled { self.error = error.localizedDescription }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        self.error = error.localizedDescription
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        capturing = false
        error = "Процесс интерфейса остановился. Нажмите «Повторить», чтобы подключиться заново."
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        if smokeTesting { decisionHandler(.deny); return }
        guard webView === self.webView, let server, server.trustsOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
              server.trusts(webView.url), server.trusts(frame.request.url), frame.isMainFrame else {
            decisionHandler(.deny)
            return
        }
        let resources: [MediaResource]
        switch type {
        case .microphone: resources = [.microphone]
        case .camera: resources = [.camera]
        case .cameraAndMicrophone: resources = [.microphone, .camera]
        @unknown default: decisionHandler(.deny); return
        }
        if resources.contains(where: { mediaPermissions.decision(server: server, resource: $0) == false }) {
            decisionHandler(.deny)
            return
        }
        let pending = resources.filter { mediaPermissions.decision(server: server, resource: $0) == nil }
        if !pending.isEmpty {
            let alert = NSAlert()
            let names = pending.map { $0 == .microphone ? "микрофону" : "камере" }.joined(separator: " и ")
            alert.messageText = "Разрешить серверу доступ к \(names)?"
            alert.informativeText = "\(server.id)\nРешение будет сохранено для этого сервера. Сбросить его можно в меню «Сервер → Сбросить доступ к микрофону и камере»."
            alert.addButton(withTitle: "Разрешить для этого сервера")
            alert.addButton(withTitle: "Не разрешать")
            let allowed = alert.runModal() == .alertFirstButtonReturn
            guard self.server == server, webView === self.webView, server.trusts(webView.url) else {
                decisionHandler(.deny)
                return
            }
            mediaPermissions.remember(allowed, server: server, resources: pending)
            decisionHandler(allowed ? .grant : .deny)
            return
        }
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        guard server?.trusts(webView.url) == true && frame.isMainFrame else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.begin { result in
            guard result == .OK, let destination = panel.url else { completionHandler(nil); return }
            if FileManager.default.fileExists(atPath: destination.path) {
                do { try FileManager.default.removeItem(at: destination) }
                catch { completionHandler(nil); return }
            }
            completionHandler(destination)
        }
    }
}
