#if os(macOS)
import Foundation
import Security
import XCTest
@testable import CindyRemoteCredentials

final class LocalHostConfigurationTests: XCTestCase {
  @MainActor func testHostPreparesWithoutAccountTokenOrDirectory() async throws {
    guard ProcessInfo.processInfo.environment["CINDY_TEST_LOGIN_KEYCHAIN"] == "1" else {
      throw XCTSkip("Opt-in local Keychain integration")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cindy-local-host-test-\(UUID().uuidString)")
    let installation = try InstallationMarker.loadOrCreate(directory: directory)
    let tag = Data("cindy.remote.identity.v2.login-keychain.global.\(installation.uuidString.lowercased())".utf8)
    defer {
      SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: tag,
        kSecAttrKeyClass: kSecAttrKeyClassPrivate] as CFDictionary)
      try? FileManager.default.removeItem(at: directory)
    }
    let host = HostCredentialServer(directory: directory)
    defer { host.reset() }
    let value = try await host.configure(realm: "global", membership: "local-test-account", authDevice: "local-test-mac", token: "")
    let descriptor = try LocalCredentialIdentity.decode(value, device: "local-test-mac", membership: "local-test-account", realm: .global)
    XCTAssertFalse(descriptor.publicKey.thumbprint.isEmpty)
    let repeated = try await host.configure(realm: "global", membership: "local-test-account", authDevice: "local-test-mac", token: "")
    XCTAssertEqual(repeated, value)
  }
}
#endif
