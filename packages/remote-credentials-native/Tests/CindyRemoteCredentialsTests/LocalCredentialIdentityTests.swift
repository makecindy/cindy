import Foundation
import XCTest
@testable import CindyRemoteCredentials

final class LocalCredentialIdentityTests: XCTestCase {
  func testDescriptorIsScopedAndPinsRejectReplacement() throws {
    let key = try IdentityKey.ephemeral()
    let descriptor = LocalCredentialIdentity(device: "mac", membership: "account", realm: .global, publicKey: key.publicKey)
    let text = try descriptor.encoded()
    let decoded = try LocalCredentialIdentity.decode(text, device: "mac", membership: "account", realm: .global)
    XCTAssertEqual(decoded.publicKey, descriptor.publicKey)
    XCTAssertNoThrow(try decoded.requirePin(key.publicKey))
    XCTAssertThrowsError(try decoded.requirePin(nil))
    XCTAssertThrowsError(try decoded.requirePin(IdentityKey.ephemeral().publicKey))
    XCTAssertThrowsError(try LocalCredentialIdentity.decode(text, device: "another-mac", membership: "account", realm: .global))
    XCTAssertThrowsError(try LocalCredentialIdentity.decode(text, device: "mac", membership: "another-account", realm: .global))
    XCTAssertThrowsError(try LocalCredentialIdentity.decode(text, device: "mac", membership: "account", realm: .cn))
  }
  func testLocalPinnedPeersExchangeWithoutDirectory() throws {
    let phone = try IdentityKey.ephemeral(), mac = try IdentityKey.ephemeral()
    let phoneDescriptor = LocalCredentialIdentity(device: "phone", membership: "account", realm: .global, publicKey: phone.publicKey)
    let macDescriptor = LocalCredentialIdentity(device: "mac", membership: "account", realm: .global, publicKey: mac.publicKey)
    try macDescriptor.requirePin(mac.publicKey)
    let a = try NativeChannel(local: phoneDescriptor.peer, remote: macDescriptor.peer, key: phone)
    let b = try NativeChannel(local: macDescriptor.peer, remote: phoneDescriptor.peer, key: mac)
    try a.accept(offer: b.offer()); try b.accept(offer: a.offer())
    let secret = Data("test-password".utf8)
    let encrypted = try a.seal(body: secret, purpose: "ready")
    XCTAssertFalse(encrypted.contains("test-password"))
    XCTAssertNoThrow(try b.open(encrypted))
    XCTAssertThrowsError(try b.open(encrypted))
  }
}
