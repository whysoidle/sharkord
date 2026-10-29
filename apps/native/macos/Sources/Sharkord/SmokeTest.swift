import AppKit
import Foundation
import WebKit

extension AppDelegate {
    func runSmokeTest() async {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--smoke-test"), args.indices.contains(index + 1) else { return }
        let output = URL(fileURLWithPath: args[index + 1])
        let probe = """
            JSON.stringify({
                ready: !!document.querySelector('[data-testid="theme-switcher"]'),
                cardVisible: Number(getComputedStyle(document.querySelector('[data-slot="card"]') || document.body).opacity) > 0.99,
                url: location.href,
                platform: document.documentElement.dataset.sharkordNative,
                nativeStyle: !!document.getElementById('sharkord-native-style'),
                notifications: Notification.name,
                nativeNotifications: typeof window.__sharkordNativeReply === 'function',
                microphoneAPI: typeof navigator.mediaDevices?.getUserMedia,
                codecs: RTCRtpSender.getCapabilities('audio').codecs.map(c => c.mimeType)
            })
            """
        for _ in 0..<90 {
            try? await Task.sleep(for: .milliseconds(500))
            guard let model = browser else { continue }
            let report: String? = await withCheckedContinuation { continuation in
                model.webView.evaluateJavaScript(probe) { value, _ in continuation.resume(returning: value as? String) }
            }
            guard let report, let data = report.data(using: .utf8),
                  let values = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  values["ready"] as? Bool == true, values["cardVisible"] as? Bool == true else { continue }
            do {
                guard values["platform"] as? String == "macos", values["nativeStyle"] as? Bool == true,
                      values["microphoneAPI"] as? String == "function",
                      values["nativeNotifications"] as? Bool == true,
                      (values["codecs"] as? [String])?.contains(where: { $0.lowercased() == "audio/opus" }) == true else {
                    throw UpdateError.installFailed
                }
                await withCheckedContinuation { continuation in
                    model.webView.evaluateJavaScript("window.webkit.messageHandlers.sharkord.postMessage({type:'capture',active:true})") { _, _ in continuation.resume() }
                }
                try? await Task.sleep(for: .milliseconds(100))
                guard model.capturing else { throw UpdateError.installFailed }
                model.capturing = false
                if args.contains("--smoke-layout") {
                    await runLayoutSmokeTest(model: model, output: output)
                    NSApp.terminate(nil)
                    return
                }
                try data.write(to: output)
                await withCheckedContinuation { continuation in
                    model.webView.takeSnapshot(with: nil) { image, _ in
                        if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                           let png = bitmap.representation(using: .png, properties: [:]) {
                            try? png.write(to: output.deletingPathExtension().appendingPathExtension("png"))
                        }
                        continuation.resume()
                    }
                }
                NSApp.terminate(nil)
                return
            } catch { break }
        }
        try? Data("{\"ready\":false,\"error\":\"Native WebKit smoke test failed\"}".utf8).write(to: output)
        NSApp.terminate(nil)
    }

    private func runLayoutSmokeTest(model: BrowserModel, output: URL) async {
        guard let window = model.webView.window else { return }
        var cases: [[String: Any]] = []
        let probe = """
            JSON.stringify((() => {
                const card = document.querySelector('[data-slot="card"]');
                const bounds = card.getBoundingClientRect();
                return {
                    innerWidth, innerHeight,
                    clientWidth: document.documentElement.clientWidth,
                    scrollWidth: document.documentElement.scrollWidth,
                    card: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                    root: { width: document.getElementById('root').getBoundingClientRect().width },
                    theme: localStorage.getItem('vite-ui-theme'),
                    dark: document.documentElement.classList.contains('dark')
                };
            })())
            """
        for theme in ["dark", "light", "system"] {
            _ = try? await model.webView.evaluateJavaScript("localStorage.setItem('vite-ui-theme', '\(theme)'); location.reload()")
            for _ in 0..<60 {
                try? await Task.sleep(for: .milliseconds(100))
                let ready = try? await model.webView.evaluateJavaScript("!!document.querySelector('[data-testid=\"theme-switcher\"]')") as? Bool
                if !model.isLoading && ready == true { break }
            }
            for size in [NSSize(width: 1180, height: 800), NSSize(width: 1600, height: 1000), .zero, NSSize(width: 780, height: 580)] {
                if size == .zero {
                    window.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                    window.toggleFullScreen(nil)
                    try? await Task.sleep(for: .milliseconds(1500))
                } else {
                    window.setContentSize(size)
                }
                try? await Task.sleep(for: .milliseconds(400))
                guard let report = try? await model.webView.evaluateJavaScript(probe) as? String,
                      let data = report.data(using: .utf8),
                      var values = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                let origin = model.webView.convert(.zero, to: window.contentView).x
                let card = values["card"] as? [String: Double] ?? [:]
                let center = ((card["x"] ?? -10000) + (card["width"] ?? 0) / 2) * model.webView.pageZoom + origin
                let viewport = (values["innerWidth"] as? Double ?? 0) * model.webView.pageZoom
                let centered = abs(center - window.contentLayoutRect.width / 2) < 2
                let fits = abs(viewport - model.webView.bounds.width) < 2
                let correctMode = window.styleMask.contains(.fullScreen) == (size == .zero)
                values["passed"] = centered && fits && correctMode
                values["requestedTheme"] = theme
                values["windowWidth"] = window.contentLayoutRect.width
                values["webViewX"] = model.webView.frame.minX
                values["webViewWidth"] = model.webView.frame.width
                values["webViewHeight"] = model.webView.frame.height
                values["requestedWidth"] = size.width
                values["fullscreen"] = window.styleMask.contains(.fullScreen)
                values["viewOriginX"] = model.webView.convert(.zero, to: window.contentView).x
                cases.append(values)
                if size == .zero {
                    window.toggleFullScreen(nil)
                    try? await Task.sleep(for: .milliseconds(1500))
                }
            }
        }
        if let data = try? JSONSerialization.data(withJSONObject: [
            "ready": true,
            "passed": cases.count == 12 && cases.allSatisfy { $0["passed"] as? Bool == true },
            "cases": cases
        ], options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: output)
        }
    }
}
