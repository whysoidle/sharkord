import AppKit
import Foundation
import WebKit

extension AppDelegate {
    func runVoiceSmokeTest(model: BrowserModel, output: URL) async {
        let args = ProcessInfo.processInfo.arguments
        guard model.smokeTesting, let host = model.server?.url.host,
              ["localhost", "127.0.0.1", "::1"].contains(host),
              let index = args.firstIndex(of: "--smoke-voice-script"), args.indices.contains(index + 1) else {
            try? Data("{\"passed\":false,\"error\":\"Voice tests require a loopback server\"}".utf8).write(to: output)
            return
        }
        let peer = BrowserModel()
        let peerWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
                                  styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        peerWindow.isReleasedWhenClosed = false
        peerWindow.contentView = peer.webView
        peerWindow.orderBack(nil)
        defer {
            peer.webView.stopLoading()
            peerWindow.close()
        }
        do {
            let script = try String(contentsOfFile: args[index + 1], encoding: .utf8)
            for browser in [model, peer] {
                for _ in 0..<100 {
                    let ready = try? await browser.webView.evaluateJavaScript("!!document.querySelector('[data-testid=\"theme-switcher\"]')") as? Bool
                    if !browser.isLoading && ready == true { break }
                    try await Task.sleep(for: .milliseconds(100))
                }
            }
            let run = { (browser: BrowserModel, phase: String, identity: String) async throws -> [String: Any] in
                let value = try await browser.webView.callAsyncJavaScript(script, arguments: ["phase": phase, "identity": identity], in: nil, contentWorld: .page)
                guard let json = value as? String, let data = json.data(using: .utf8),
                      let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw UpdateError.installFailed }
                return result
            }
            _ = try await run(model, "setup", "testowner")
            _ = try await run(peer, "setup", "testuser")
            _ = try await run(model, "create", "testowner")
            _ = try await run(model, "join", "testowner")
            _ = try await run(peer, "join", "testuser")
            let first = try await run(model, "check", "testowner")
            let second = try await run(peer, "check", "testuser")
            _ = try? await run(peer, "cleanup", "testuser")
            _ = try? await run(model, "cleanup", "testowner")
            let passed = first["passed"] as? Bool == true && second["passed"] as? Bool == true
            let data = try JSONSerialization.data(withJSONObject: ["passed": passed, "first": first, "second": second], options: [.prettyPrinted, .sortedKeys])
            try data.write(to: output)
        } catch {
            let data = try? JSONSerialization.data(withJSONObject: ["passed": false, "error": String(describing: error)])
            try? data?.write(to: output)
        }
    }
}
