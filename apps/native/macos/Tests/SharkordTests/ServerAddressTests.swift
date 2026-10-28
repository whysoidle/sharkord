import Foundation
import Testing
@testable import Sharkord

@Test func normalizesURLsAndPreservesSubpath() throws {
    let address = try ServerAddress(" example.com/voice ")
    #expect(address.id == "https://example.com/voice/")
    #expect(try ServerAddress("https://example.com:443/voice/") == address)
    #expect(try ServerAddress("безбаб.рф/voice").url.host == "xn--80ababrm.xn--p1ai")
    #expect(try ServerAddress("https://example.com").url.path == "/")
}

@Test func rejectsCredentialsUnsafeSchemesAndAmbiguousURLs() {
    for input in ["", "https://u:p@example.com/", "http://example.com/", "file:///tmp/index.html", "https://example.com/?token=secret", "https://example.com/#hash", "https://example.com\\@evil.com/", "https://example.com:99999/"] {
        #expect(throws: (any Error).self) { try ServerAddress(input) }
    }
}

@Test func trustsOnlySelectedServerAndPath() throws {
    let address = try ServerAddress("https://example.com/voice/")
    #expect(address.trusts(URL(string: "https://example.com/voice/oidc/login")))
    #expect(address.trusts(URL(string: "https://example.com:443/voice/")))
    for input in ["https://example.com/", "https://example.com/voice-other/", "https://example.com/voice/../admin/", "https://evil.com/voice/", "http://example.com/voice/", "https://example.com:444/voice/", "https://user@example.com/voice/"] {
        #expect(!address.trusts(URL(string: input)))
    }
    #expect(address.trustsOrigin(scheme: "https", host: "example.com", port: 0))
    #expect(!address.trustsOrigin(scheme: "https", host: "example.com", port: 444))
    #expect(!address.trusts(URL(string: "https://example.com/voice/%2e%2e/admin/")))
}

@Test func separatesProfilesEvenOnTheSameOrigin() throws {
    let first = try ServerAddress("https://example.com/first/")
    let second = try ServerAddress("https://example.com/second/")
    #expect(first.dataStoreID != second.dataStoreID)
    #expect(try ServerAddress(first.id).dataStoreID == first.dataStoreID)
}
