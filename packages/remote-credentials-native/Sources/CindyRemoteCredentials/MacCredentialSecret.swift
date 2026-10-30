#if os(macOS)
import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The standalone helper uses the login Keychain, which cannot enforce
/// SecAccessControl biometric constraints. For biometric entries the Keychain
/// stores only ciphertext and a hardware-wrapped Secure Enclave key. The actual
/// key agreement (not a separate evaluatePolicy Boolean) authorizes decryption.
enum MacCredentialSecret {
  private struct Envelope: Codable {
    let version: Int
    let plain: Data?
    let key: Data?
    let peer: Data?
    let sealed: Data?
  }
  static func seal(_ secret: Data, binding: CredentialBinding, biometric: Bool) throws -> Data {
    guard biometric else {
      return try JSONEncoder().encode(Envelope(version: 1, plain: secret, key: nil, peer: nil, sealed: nil))
    }
    guard SecureEnclave.isAvailable,
      let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet], nil) else { throw CredentialError.unavailable }
    let recipient = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    let sender = P256.KeyAgreement.PrivateKey()
    let shared = try sender.sharedSecretFromKeyAgreement(with: recipient.publicKey)
    let bindingData = Data(try binding.storageKey.utf8)
    let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: bindingData,
      sharedInfo: Data("cindy.desktop.saved-password.v1".utf8), outputByteCount: 32)
    let ciphertext = try AES.GCM.seal(secret, using: key, authenticating: bindingData)
    return try JSONEncoder().encode(Envelope(version: 1, plain: nil,
      key: recipient.dataRepresentation, peer: sender.publicKey.x963Representation, sealed: ciphertext.combined))
  }
  static func open(_ data: Data, binding: CredentialBinding, context: LAContext) throws -> Data {
    do {
      let envelope = try JSONDecoder().decode(Envelope.self, from: data)
      guard envelope.version == 1 else { throw CredentialError.savedReadFailed }
      let secret: Data
      if let plain = envelope.plain {
        guard envelope.key == nil, envelope.peer == nil, envelope.sealed == nil else { throw CredentialError.savedReadFailed }
        secret = plain
      } else {
        guard let representation = envelope.key, let peer = envelope.peer, let sealed = envelope.sealed else { throw CredentialError.savedReadFailed }
        let recipient = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: representation, authenticationContext: context)
        let shared = try recipient.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: peer))
        let bindingData = Data(try binding.storageKey.utf8)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: bindingData,
          sharedInfo: Data("cindy.desktop.saved-password.v1".utf8), outputByteCount: 32)
        secret = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: bindingData)
      }
      guard !secret.isEmpty, secret.count <= 4096 else { throw CredentialError.savedReadFailed }
      return secret
    } catch let error as CredentialError { throw error }
    catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel { throw CredentialError.cancelled }
    catch { throw CredentialError.savedReadDenied }
  }
}
#endif
