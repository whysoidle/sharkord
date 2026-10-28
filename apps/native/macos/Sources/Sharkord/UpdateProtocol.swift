import Foundation

struct ClientVersion: Comparable, Equatable {
    let components: [Int]
    let text: String
    init(_ value: String) throws {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.count < 7 && $0.allSatisfy(\.isNumber) }),
              parts.allSatisfy({ Int($0) != nil }) else { throw UpdateError.invalidRelease }
        text = value
        components = parts.map { Int($0)! }
    }
    static func < (lhs: ClientVersion, rhs: ClientVersion) -> Bool { lhs.components.lexicographicallyPrecedes(rhs.components) }
    static func == (lhs: ClientVersion, rhs: ClientVersion) -> Bool { lhs.components == rhs.components }
}

enum UpdateError: LocalizedError {
    case invalidRelease, invalidChecksum, notWritable, downloadFailed, installFailed
    var errorDescription: String? {
        switch self {
        case .invalidRelease: "GitHub вернул некорректные данные обновления."
        case .invalidChecksum: "Контрольная сумма не совпала. Обновление не будет установлено."
        case .notWritable: "Для обновления переместите Sharkord в доступную для записи папку «Программы» и запустите оттуда."
        case .downloadFailed: "Не удалось скачать обновление с GitHub. Попробуйте позже."
        case .installFailed: "Не удалось подготовить обновление. Текущая версия приложения сохранена."
        }
    }
}

struct ReleaseManifest: Decodable {
    struct Asset: Decodable {
        let name: String
        let sha256: String
        let size: Int
    }
    let version: String
    let assets: [Asset]

    func validatedAsset(version expected: String, name: String) throws -> Asset {
        guard version == expected, let asset = assets.first(where: { $0.name == name }),
              asset.size > 0, asset.size < 500_000_000, asset.sha256.count == 64,
              asset.sha256.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw UpdateError.invalidRelease }
        _ = try ClientVersion(version)
        return asset
    }
}
