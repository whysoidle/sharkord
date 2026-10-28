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
}
