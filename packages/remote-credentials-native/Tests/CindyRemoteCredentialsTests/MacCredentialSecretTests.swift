#if os(macOS)
import CryptoKit
import Foundation
import LocalAuthentication
import Security
import XCTest
@testable import CindyRemoteCredentials

final class MacCredentialSecretTests: XCTestCase {
  private let binding = CredentialBinding(realm: .global, membership: "test-owner",
    controller: "test-controller", target: "test-target", targetThumbprint: "test-pin", systemRecord: "test-account")
  func testOptionalBiometricEnvelopeRoundTrip() throws {
    let secret = Data("synthetic-test-only".utf8)
    let encoded = try MacCredentialSecret.seal(secret, binding: binding, biometric: false)
    XCTAssertEqual(try MacCredentialSecret.open(encoded, binding: binding, context: LAContext()), secret)
    XCTAssertThrowsError(try MacCredentialSecret.open(Data("{}".utf8), binding: binding, context: LAContext()))
  }
  func testProtectedEnvelopeCannotDecryptWithoutBiometricAuthorization() throws {
    guard SecureEnclave.isAvailable else { throw XCTSkip("Secure Enclave unavailable") }
    let secret = Data("synthetic-test-only".utf8)
    let encoded = try MacCredentialSecret.seal(secret, binding: binding, biometric: true)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertNil(object["plain"])
    let context = LAContext(); context.interactionNotAllowed = true
    defer { context.invalidate() }
    XCTAssertThrowsError(try MacCredentialSecret.open(encoded, binding: binding, context: context))
  }
  func testHardwareEnvelopeRoundTripAndBindingAuthentication() throws {
    guard SecureEnclave.isAvailable else { throw XCTSkip("Secure Enclave unavailable") }
    // A transient test-only key without biometric gating lets CI exercise the
    // same envelope decoding and ECDH path without displaying an OS prompt.
    let access = try XCTUnwrap(SecAccessControlCreateWithFlags(nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, nil))
    let recipient = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    let sender = P256.KeyAgreement.PrivateKey()
    let shared = try sender.sharedSecretFromKeyAgreement(with: recipient.publicKey)
    let bindingData = Data(try binding.storageKey.utf8)
    let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: bindingData,
      sharedInfo: Data("cindy.desktop.saved-password.v1".utf8), outputByteCount: 32)
    let secret = Data("synthetic-test-only".utf8)
    let sealed = try AES.GCM.seal(secret, using: key, authenticating: bindingData)
    let encoded = try JSONSerialization.data(withJSONObject: ["version": 1,
      "key": recipient.dataRepresentation.base64EncodedString(),
      "peer": sender.publicKey.x963Representation.base64EncodedString(),
      "sealed": try XCTUnwrap(sealed.combined).base64EncodedString()])
    XCTAssertEqual(try MacCredentialSecret.open(encoded, binding: binding, context: LAContext()), secret)
    var other = binding; other.protectionVersion = "another-saved-version"
    XCTAssertThrowsError(try MacCredentialSecret.open(encoded, binding: other, context: LAContext()))
  }
  func testLoginKeychainVaultRoundTripAndForgetPreservesPreference() throws {
    guard ProcessInfo.processInfo.environment["CINDY_TEST_LOGIN_KEYCHAIN"] == "1" else {
      throw XCTSkip("Opt-in test creates and removes only its own synthetic Keychain items")
    }
    let installation = UUID(), settingsKey = "synthetic-test-settings"
    let vault = CredentialVault(installation: installation)
    defer {
      try? vault.forget(binding: binding)
      try? vault.setSettings(settingsKey, nil)
    }
    let secret = Data("synthetic-test-only".utf8)
    try vault.store(secret, binding: binding, requireBiometric: false)
    try vault.setSettings(settingsKey, SavedUnlockSettings(binding: binding, biometric: false))
    XCTAssertTrue(try vault.contains(binding: binding))
    XCTAssertEqual(try vault.read(binding: binding, reason: "Synthetic test", context: LAContext()), secret)
    try vault.forget(binding: binding)
    XCTAssertFalse(try vault.contains(binding: binding))
    XCTAssertEqual(try vault.settings(settingsKey)?.binding, binding)
    XCTAssertEqual(try vault.settings(settingsKey)?.biometric, false)
  }
}
#endif
