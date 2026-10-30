import Foundation
import JOSESwift

/// A strict JOSE profile: ES256 JWS over an ECDH-ES/A256GCM JWE. Verify the
/// expected sender before decrypting. Never follow key URLs in JOSE headers.
/// Session/account/expiry/replay checks belong to the native session layer.
enum SealedMessage {
  static let maximumBytes = 20 * 1024 * 1024
  static let type = "cindy-remote-desktop-v1"

  static func seal(_ plaintext: Data, sender: IdentityKey, recipient: IdentityPublicKey) throws -> String {
    guard plaintext.count <= maximumBytes else { throw CredentialError.invalidMessage }
    do {
      guard let encrypter = Encrypter(keyManagementAlgorithm: .ECDH_ES,
        contentEncryptionAlgorithm: .A256GCM, encryptionKey: try ECPublicKey(publicKey: recipient.securityKey())),
        let signer = Signer(signatureAlgorithm: .ES256, key: sender.key) else {
        throw CredentialError.unavailable
      }
      var encryptionHeader = JWEHeader(keyManagementAlgorithm: .ECDH_ES, contentEncryptionAlgorithm: .A256GCM)
      encryptionHeader.typ = type
      let ciphertext = try JWE(header: encryptionHeader, payload: Payload(plaintext), encrypter: encrypter)
      var signatureHeader = JWSHeader(algorithm: .ES256)
      signatureHeader.typ = type; signatureHeader.cty = "JWE"
      return try JWS(header: signatureHeader, payload: Payload(ciphertext.compactSerializedData), signer: signer)
        .compactSerializedString
    } catch { throw CredentialError.invalidMessage }
  }

  static func open(_ packet: String, sender: IdentityPublicKey, recipient: IdentityKey) throws -> Data {
    guard packet.utf8.count <= maximumBytes * 2 else { throw CredentialError.invalidMessage }
    do {
      let signed = try JWS(compactSerialization: packet)
      let outer = try header(packet)
      guard Set(outer.keys) == Set(["alg", "typ", "cty"]),
        outer["alg"] as? String == "ES256", outer["typ"] as? String == type,
        outer["cty"] as? String == "JWE",
        let verifier = Verifier(signatureAlgorithm: .ES256, key: try sender.securityKey()) else {
        throw CredentialError.invalidMessage
      }
      let validated = try signed.validate(using: verifier)
      guard let compact = String(data: validated.payload.data(), encoding: .utf8) else {
        throw CredentialError.invalidMessage
      }
      let inner = try header(compact)
      guard Set(inner.keys) == Set(["alg", "enc", "typ", "epk"]),
        inner["alg"] as? String == "ECDH-ES", inner["enc"] as? String == "A256GCM",
        inner["typ"] as? String == type,
        let epk = inner["epk"] as? [String: Any],
        Set(["kty", "crv", "x", "y"]).isSubset(of: Set(epk.keys)),
        Set(epk.keys).isSubset(of: Set(["kty", "crv", "x", "y", "kid"])),
        let decrypter = Decrypter(keyManagementAlgorithm: .ECDH_ES,
          contentEncryptionAlgorithm: .A256GCM, decryptionKey: try ECPrivateKey(privateKey: recipient.key)) else {
        throw CredentialError.invalidMessage
      }
      // JOSESwift adds a random UUID kid to epk. It is metadata, never a key
      // lookup instruction or a substitute for validating the actual point.
      if let kid = epk["kid"] { guard let value = kid as? String, UUID(uuidString: value) != nil else { throw CredentialError.invalidMessage } }
      _ = try JSONDecoder().decode(IdentityPublicKey.self, from: JSONSerialization.data(withJSONObject: epk)).securityKey()
      let result = try JWE(compactSerialization: compact).decrypt(using: decrypter).data()
      guard result.count <= maximumBytes else { throw CredentialError.invalidMessage }
      return result
    } catch { throw CredentialError.invalidMessage }
  }

  private static func header(_ compact: String) throws -> [String: Any] {
    guard let first = compact.split(separator: ".", omittingEmptySubsequences: false).first,
      first.utf8.count <= 4096,
      let object = try JSONSerialization.jsonObject(with: Data(canonicalBase64URL: String(first))) as? [String: Any]
      else { throw CredentialError.invalidMessage }
    return object
  }
}
