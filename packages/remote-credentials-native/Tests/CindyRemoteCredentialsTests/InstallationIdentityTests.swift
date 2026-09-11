import Foundation
import Security
import XCTest
@testable import CindyRemoteCredentials

final class InstallationIdentityTests: XCTestCase {
  func testLoginKeychainIdentityCanReloadAndSignWithoutExport() throws {
    #if os(macOS)
    guard ProcessInfo.processInfo.environment["CINDY_TEST_LOGIN_KEYCHAIN"] == "1" else {
      throw XCTSkip("Opt-in test creates and removes its own login Keychain key")
    }
    let installation = UUID()
    let tag = Data("cindy.remote.identity.v2.login-keychain.global.\(installation.uuidString.lowercased())".utf8)
    defer {
      SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: tag,
        kSecAttrKeyClass: kSecAttrKeyClassPrivate] as CFDictionary)
    }
    let first = try InstallationIdentity.loadOrCreate(installation: installation, realm: .global)
    let second = try InstallationIdentity.loadOrCreate(installation: installation, realm: .global)
    XCTAssertEqual(first.publicKey, second.publicKey)
    XCTAssertFalse(try second.signChallenge(Data("test challenge".utf8)).isEmpty)
    XCTAssertTrue(SecKeyCopyExternalRepresentation(second.key, nil) == nil, "Private key export must be refused")
    #else
    throw XCTSkip("macOS login Keychain test")
    #endif
  }
}
