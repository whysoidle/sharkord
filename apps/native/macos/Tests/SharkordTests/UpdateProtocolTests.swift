import Foundation
import Testing
@testable import Sharkord

@Test func comparesVersionsNumerically() throws {
    #expect(try ClientVersion("0.1.10") > ClientVersion("0.1.2"))
    #expect(try ClientVersion("1.0.0") > ClientVersion("0.99.99"))
    #expect(try ClientVersion("0.1.0") == ClientVersion("0.1.0"))
    for value in ["../evil", "1.0", "1.0.0-preview", "1.2.3/evil", "1.a.0", "9999999.0.0"] {
        #expect(throws: (any Error).self) { try ClientVersion(value) }
    }
}

@Test func validatesReleaseIdentityChecksumAndSize() throws {
    let asset = ReleaseManifest.Asset(name: "Sharkord-macos-universal.zip", sha256: String(repeating: "a", count: 64), size: 123)
    let manifest = ReleaseManifest(version: "0.2.0", assets: [asset])
    #expect(try manifest.validatedAsset(version: "0.2.0", name: asset.name).size == 123)
    #expect(throws: (any Error).self) { try manifest.validatedAsset(version: "0.3.0", name: asset.name) }
    #expect(throws: (any Error).self) { try manifest.validatedAsset(version: "0.2.0", name: "Other.zip") }
    for bad in [
        ReleaseManifest.Asset(name: asset.name, sha256: "invalid", size: 123),
        ReleaseManifest.Asset(name: asset.name, sha256: String(repeating: "z", count: 64), size: 123),
        ReleaseManifest.Asset(name: asset.name, sha256: asset.sha256, size: -1),
        ReleaseManifest.Asset(name: asset.name, sha256: asset.sha256, size: 500_000_001)
    ] {
        let invalid = ReleaseManifest(version: "0.2.0", assets: [bad])
        #expect(throws: (any Error).self) { try invalid.validatedAsset(version: "0.2.0", name: asset.name) }
    }
}
