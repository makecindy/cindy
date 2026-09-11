import XCTest
import CryptoKit
@testable import CindyRemoteCredentials

final class CredentialTests: XCTestCase {
  func testRecipientAndSenderAreBothRequired() throws {
    let sender = try IdentityKey.ephemeral(), recipient = try IdentityKey.ephemeral()
    let impostor = try IdentityKey.ephemeral()
    let payload = Data("INVALID_TEST_CREDENTIAL_ONLY".utf8)
    let packet = try SealedMessage.seal(payload, sender: sender, recipient: recipient.publicKey)
    XCTAssertFalse(packet.contains("INVALID_TEST_CREDENTIAL_ONLY"))
    XCTAssertEqual(try SealedMessage.open(packet, sender: sender.publicKey, recipient: recipient), payload)
    XCTAssertThrowsError(try SealedMessage.open(packet, sender: impostor.publicKey, recipient: recipient))
    XCTAssertThrowsError(try SealedMessage.open(packet, sender: sender.publicKey, recipient: impostor))
    var altered = Array(packet.utf8)
    altered[altered.count / 2] = altered[altered.count / 2] == 65 ? 66 : 65
    XCTAssertThrowsError(try SealedMessage.open(String(decoding: altered, as: UTF8.self), sender: sender.publicKey, recipient: recipient))
  }

  func testChallengeSignatureUsesRawP1363AndExactBytes() throws {
    let key = try IdentityKey.ephemeral()
    let message = Data("invalid-test-challenge".utf8)
    let signature = try Data(canonicalBase64URL: key.signChallenge(message))
    XCTAssertEqual(signature.count, 64)
    let pub = key.publicKey
    let raw = try Data([4]) + Data(canonicalBase64URL: pub.x) + Data(canonicalBase64URL: pub.y)
    let verifier = try P256.Signing.PublicKey(x963Representation: raw)
    XCTAssertTrue(verifier.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signature), for: message))
    XCTAssertFalse(verifier.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signature), for: Data("other".utf8)))
  }

  func testPublicKeyRoundTripAndCanonicalEncoding() throws {
    let key = try IdentityKey.ephemeral().publicKey
    XCTAssertEqual(try IdentityPublicKey(key: key.securityKey()), key)
    XCTAssertEqual(try Data(canonicalBase64URL: key.thumbprint).count, 32)
    XCTAssertThrowsError(try Data(canonicalBase64URL: key.x + "="))
    let invalid = Data("{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"\(String(repeating: "A", count: 43))\",\"y\":\"\(String(repeating: "A", count: 43))\"}".utf8)
    XCTAssertThrowsError(try JSONDecoder().decode(IdentityPublicKey.self, from: invalid).securityKey())
  }
}
