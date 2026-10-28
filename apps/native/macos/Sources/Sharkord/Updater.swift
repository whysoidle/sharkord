import AppKit
import Combine
import CryptoKit
import Foundation

@MainActor
final class Updater: ObservableObject {
    @Published var busy = false
    @Published var status: String?
    private let repository = "whysoidle/sharkord"
    private let filename = "Sharkord-macos-universal.zip"

    private func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.setValue("Sharkord-Native", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        return request
    }

    func check(browser: BrowserModel) async {
        guard !busy else { return }
        busy = true
        status = "Проверка обновлений…"
        defer { busy = false; status = nil }
        do {
            let endpoint = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=100")!
            let (data, response) = try await URLSession.shared.data(for: request(endpoint))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.downloadFailed }
            struct Release: Decodable {
                let tag_name: String
                let draft: Bool
                let prerelease: Bool
            }
            let releases = try JSONDecoder().decode([Release].self, from: data)
            let versions = releases.filter { !$0.draft && !$0.prerelease && $0.tag_name.hasPrefix("client-v") }
                .compactMap { try? ClientVersion(String($0.tag_name.dropFirst(8))) }
            let current = try ClientVersion(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0")
            guard let newest = versions.max(), newest > current else {
                let alert = NSAlert()
                alert.messageText = "Установлена актуальная версия"
                alert.informativeText = "Sharkord \(current.text)"
                alert.runModal()
                return
            }
            let base = "https://github.com/\(repository)/releases/download/client-v\(newest.text)/"
            let (manifestData, manifestResponse) = try await URLSession.shared.data(for: request(URL(string: base + "client-update.json")!))
            guard (manifestResponse as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.downloadFailed }
            let manifest = try JSONDecoder().decode(ReleaseManifest.self, from: manifestData)
            let asset = try manifest.validatedAsset(version: newest.text, name: filename)
            let alert = NSAlert()
            alert.messageText = "Доступен Sharkord \(newest.text)"
            alert.informativeText = "Скачать обновление с GitHub и перезапустить приложение? Активное голосовое подключение будет прервано."
            alert.addButton(withTitle: "Обновить")
            alert.addButton(withTitle: "Позже")
            guard alert.runModal() == .alertFirstButtonReturn, browser.confirmInterruption() else { return }
            let target = Bundle.main.bundleURL
            guard target.pathExtension == "app", !target.path.contains("AppTranslocation"),
                  FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path) else { throw UpdateError.notWritable }
            status = "Загрузка обновления…"
            let (downloaded, downloadResponse) = try await URLSession.shared.download(for: request(URL(string: base + filename)!))
            guard (downloadResponse as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.downloadFailed }
            defer { try? FileManager.default.removeItem(at: downloaded) }
            let archive = try Data(contentsOf: downloaded, options: .mappedIfSafe)
            guard archive.count == asset.size, SHA256.hash(data: archive).map({ String(format: "%02x", $0) }).joined() == asset.sha256 else { throw UpdateError.invalidChecksum }
            status = "Подготовка установки…"
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Sharkord-update-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let extract = Process()
            extract.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            extract.arguments = ["-x", "-k", downloaded.path, directory.path]
            try extract.run()
            extract.waitUntilExit()
            let staged = directory.appendingPathComponent("Sharkord.app")
            let infoURL = staged.appendingPathComponent("Contents/Info.plist")
            guard extract.terminationStatus == 0,
                  let info = NSDictionary(contentsOf: infoURL), info["CFBundleIdentifier"] as? String == "io.github.whysoidle.sharkord",
                  info["CFBundleShortVersionString"] as? String == newest.text else { throw UpdateError.installFailed }
            let verify = Process()
            verify.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
            verify.arguments = ["--verify", "--deep", "--strict", staged.path]
            try verify.run()
            verify.waitUntilExit()
            guard verify.terminationStatus == 0,
                  let helper = Bundle.main.url(forResource: "update-macos", withExtension: "sh") else { throw UpdateError.installFailed }
            let helperCopy = directory.appendingPathComponent("update.sh")
            try FileManager.default.copyItem(at: helper, to: helperCopy)
            let install = Process()
            install.executableURL = URL(fileURLWithPath: "/bin/sh")
            install.arguments = [helperCopy.path, String(ProcessInfo.processInfo.processIdentifier), staged.path, target.path]
            try install.run()
            browser.capturing = false
            NSApp.terminate(nil)
        } catch {
            let alert = NSAlert()
            alert.messageText = "Не удалось обновить Sharkord"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
