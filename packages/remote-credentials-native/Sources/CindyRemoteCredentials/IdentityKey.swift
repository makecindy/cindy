import CryptoKit
import Foundation
import Security

extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  init(canonicalBase64URL value: String) throws {
    guard !value.isEmpty, value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
      || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
      let data = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)),
      data.base64URL == value else { throw CredentialError.invalidMessage }
    self = data
  }
}

public struct IdentityPublicKey: Codable, Equatable, Sendable {
  public let kty: String
  public let crv: String
  public let x: String
  public let y: String

  public init(key: SecKey) throws {
    var error: Unmanaged<CFError>?
    guard let raw = SecKeyCopyExternalRepresentation(key, &error) as Data?, raw.count == 65,
      raw.first == 4 else { throw CredentialError.invalidIdentity }
    kty = "EC"; crv = "P-256"
    x = raw.subdata(in: 1..<33).base64URL; y = raw.subdata(in: 33..<65).base64URL
  }

  public func securityKey() throws -> SecKey {
    guard kty == "EC", crv == "P-256" else { throw CredentialError.invalidIdentity }
    let xBytes = try Data(canonicalBase64URL: x), yBytes = try Data(canonicalBase64URL: y)
    guard xBytes.count == 32, yBytes.count == 32 else { throw CredentialError.invalidIdentity }
    let raw = Data([4]) + xBytes + yBytes
    // CryptoKit validates that the point is on P-256 before Security import.
    guard (try? P256.Signing.PublicKey(x963Representation: raw)) != nil else {
      throw CredentialError.invalidIdentity
    }
    guard let key = SecKeyCreateWithData(raw as CFData, [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass: kSecAttrKeyClassPublic, kSecAttrKeySizeInBits: 256,
    ] as CFDictionary, nil) else { throw CredentialError.invalidIdentity }
    return key
  }

  public var thumbprint: String {
    // Only validated base64url coordinates are accepted by the directory.
    let canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
    return Data(SHA256.hash(data: Data(canonical.utf8))).base64URL
  }
}

/// Private keys remain native. This type exposes no private-key export method.
public final class IdentityKey {
  let key: SecKey
  public let publicKey: IdentityPublicKey

  public init(key: SecKey) throws {
    guard let pub = SecKeyCopyPublicKey(key),
      SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256) else {
      throw CredentialError.invalidIdentity
    }
    self.key = key
    publicKey = try IdentityPublicKey(key: pub)
    _ = try publicKey.securityKey()
  }

  /// Ephemeral keys and test keys only; persistent installation keys use Keychain.
  public static func ephemeral() throws -> IdentityKey {
    guard let key = SecKeyCreateRandomKey([
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
    ] as CFDictionary, nil) else { throw CredentialError.unavailable }
    return try IdentityKey(key: key)
  }

  /// Exact server challenge bytes, never a JSON reserialization. Caller first
  /// validates the directory origin, purpose, account, key and expiry.
  func signChallenge(_ message: Data) throws -> String {
    guard let der = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256,
      message as CFData, nil) as Data? else { throw CredentialError.unavailable }
    do { return try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation.base64URL }
    catch { throw CredentialError.unavailable }
  }
}
