import Foundation
import Testing
@testable import Sharkord

@Test func remembersMediaDecisionsAcrossStoreInstances() throws {
    let suite = "SharkordTest-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let server = try ServerAddress("https://example.com/voice/")
    let store = MediaPermissions(defaults: defaults)
    #expect(store.decision(server: server, resource: .microphone) == nil)
    store.remember(true, server: server, resources: [.microphone])
    store.remember(false, server: server, resources: [.camera])
    let restored = MediaPermissions(defaults: UserDefaults(suiteName: suite)!)
    #expect(restored.decision(server: server, resource: .microphone) == true)
    #expect(restored.decision(server: server, resource: .camera) == false)
}

@Test func mediaPermissionsAreScopedToTheFullServerURL() throws {
    let suite = "SharkordTest-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = MediaPermissions(defaults: defaults)
    let server = try ServerAddress("https://example.com/voice/")
    store.remember(true, server: server, resources: [.microphone, .camera])
    for input in ["https://other.example.com/voice/", "https://example.com/other/", "https://example.com:444/voice/"] {
        #expect(store.decision(server: try ServerAddress(input), resource: .microphone) == nil)
    }
    #expect(store.decision(server: try ServerAddress("https://example.com:443/voice"), resource: .microphone) == true)
}

@Test func resetsOnlyTheSelectedServersMediaPermissions() throws {
    let suite = "SharkordTest-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = MediaPermissions(defaults: defaults)
    let first = try ServerAddress("https://example.com/voice/")
    let second = try ServerAddress("https://example.com/other/")
    store.remember(true, server: first, resources: [.microphone, .camera])
    store.remember(false, server: second, resources: [.microphone])
    store.reset(server: first)
    #expect(store.decision(server: first, resource: .microphone) == nil)
    #expect(store.decision(server: first, resource: .camera) == nil)
    #expect(store.decision(server: second, resource: .microphone) == false)
}
