import Foundation

enum MediaResource: String, CaseIterable {
    case microphone, camera
}

struct MediaPermissions {
    private let defaults: UserDefaults
    private let key = "serverMediaPermissions"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func decision(server: ServerAddress, resource: MediaResource) -> Bool? {
        let saved = defaults.dictionary(forKey: key) as? [String: [String: Bool]] ?? [:]
        return saved[server.id]?[resource.rawValue]
    }

    func remember(_ allowed: Bool, server: ServerAddress, resources: [MediaResource]) {
        var saved = defaults.dictionary(forKey: key) as? [String: [String: Bool]] ?? [:]
        var grants = saved[server.id] ?? [:]
        for resource in resources { grants[resource.rawValue] = allowed }
        saved[server.id] = grants
        defaults.set(saved, forKey: key)
    }

    func reset(server: ServerAddress) {
        var saved = defaults.dictionary(forKey: key) as? [String: [String: Bool]] ?? [:]
        saved.removeValue(forKey: server.id)
        defaults.set(saved, forKey: key)
    }
}
