import CryptoKit
import Foundation

struct ServerAddress: Codable, Hashable, Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    var label: String { (url.host ?? "Sharkord") + (url.path == "/" ? "" : url.path) }
    var dataStoreID: UUID {
        let digest = SHA256.hash(data: Data(id.utf8))
        let bytes = Array(digest.prefix(16))
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    init(_ input: String) throws {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard !text.contains("\\"), var components = URLComponents(string: text),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port == nil || (1...65535).contains(components.port!) else {
            throw AddressError.invalid
        }
        components.scheme = components.scheme?.lowercased()
        components.host = host.lowercased()
        let local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host.lowercased())
        guard components.scheme == "https" || (components.scheme == "http" && local) else {
            throw AddressError.insecure
        }
        if components.path.isEmpty { components.path = "/" }
        if !components.path.hasSuffix("/") { components.path += "/" }
        if (components.scheme == "https" && components.port == 443) || (components.scheme == "http" && components.port == 80) {
            components.port = nil
        }
        guard let result = components.url?.standardized,
              !result.path.contains("%"), !result.path.contains("\\") else { throw AddressError.invalid }
        url = result
    }

    func trusts(_ candidate: URL?) -> Bool {
        guard let candidate, candidate.user == nil, candidate.password == nil else { return false }
        let value = candidate.standardized
        guard !value.path.contains("%"), !value.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return false }
        return trustsOrigin(scheme: value.scheme ?? "", host: value.host ?? "", port: value.port ?? 0) &&
            (value.path == url.path || value.path.hasPrefix(url.path.hasSuffix("/") ? url.path : url.path + "/"))
    }

    func trustsOrigin(scheme: String, host: String, port: Int) -> Bool {
        let expectedPort = url.port ?? (url.scheme == "https" ? 443 : 80)
        let actualPort = port == 0 ? (scheme == "https" ? 443 : 80) : port
        return scheme.lowercased() == url.scheme && host.lowercased() == url.host && actualPort == expectedPort
    }

    enum AddressError: LocalizedError {
        case invalid, insecure
        var errorDescription: String? {
            switch self {
            case .invalid: "Введите адрес сервера без логина, пароля, параметров и #. Подпуть поддерживается: https://example.com/voice/"
            case .insecure: "Для безопасного входа и микрофона нужен HTTPS. HTTP разрешён только для localhost."
            }
        }
    }
}
