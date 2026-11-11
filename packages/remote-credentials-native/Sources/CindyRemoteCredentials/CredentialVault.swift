#if os(iOS) || os(macOS)
import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct CredentialBinding: Codable, Equatable, Sendable {
  let realm: IdentityRealm
  let membership: String
  let controller: String
  let target: String
  let targetThumbprint: String
  let systemRecord: String
  var protectionVersion: String? = nil

  var storageKey: String {
    get throws {
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      return Data(SHA256.hash(data: try encoder.encode(self))).base64URL
    }
  }
}

struct SavedUnlockSettings: Codable, Sendable {
  var targetPublicKey: IdentityPublicKey? = nil
  let binding: CredentialBinding
  let biometric: Bool
}

/// Only native credential transactions use this vault; never export read/store
/// as Expo functions. The coordinator saves only after authenticated connection
/// confirmation, and revalidates its owner/target after every asynchronous step.
final class CredentialVault: Sendable {
  private let service: String
  init(installation: UUID) {
    // Installation UUID is held outside Keychain in a no-backup installation
    // marker. Reinstall never adopts an old Keychain namespace.
    service = "cindy.remote.credentials.v1." + installation.uuidString.lowercased()
  }

  func settings(_ key: String) throws -> SavedUnlockSettings? {
    var query = settingsItem(key)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = value as? Data else { throw CredentialError.unavailable }
    return try JSONDecoder().decode(SavedUnlockSettings.self, from: data)
  }

  func setSettings(_ key: String, _ value: SavedUnlockSettings?) throws {
    let query = settingsItem(key)
    guard let value else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialError.unavailable }
      return
    }
    let data = try JSONEncoder().encode(value)
    var attributes = query
    attributes[kSecValueData] = data
    #if os(macOS)
    attributes[kSecAttrAccess] = try loginAccess()
    #else
    attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    #endif
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary) == errSecSuccess else { throw CredentialError.unavailable }
    } else if status != errSecSuccess { throw CredentialError.unavailable }
  }

  private func settingsItem(_ key: String) -> [CFString: Any] {
    query(service: service + ".settings", account: key)
  }

  func store(_ secret: Data, binding: CredentialBinding, requireBiometric: Bool = true) throws {
    #if os(macOS)
    guard !secret.isEmpty, secret.count <= 4096 else { throw CredentialError.unavailable }
    let data = try MacCredentialSecret.seal(secret, binding: binding, biometric: requireBiometric)
    let query = try item(binding)
    var attributes = query
    attributes[kSecAttrAccess] = try loginAccess()
    attributes[kSecValueData] = data
    let result = SecItemAdd(attributes as CFDictionary, nil)
    if result == errSecDuplicateItem {
      guard SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary) == errSecSuccess else { throw CredentialError.unavailable }
    } else if result != errSecSuccess { throw CredentialError.unavailable }
    #else
    let accessibility = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
    guard !secret.isEmpty, secret.count <= 4096,
      let access = SecAccessControlCreateWithFlags(nil,
        accessibility, requireBiometric ? .biometryCurrentSet : [], nil) else {
      throw CredentialError.unavailable
    }
    let query = try item(binding)
    var attributes = query
    attributes[kSecAttrAccessControl] = access
    attributes[kSecValueData] = secret
    let result = SecItemAdd(attributes as CFDictionary, nil)
    if result == errSecDuplicateItem {
      // Preserve an existing value until the replacement write succeeds. Never
      // delete first: a failed update must not lose a previously working secret.
      let update: [CFString: Any] = [kSecValueData: secret, kSecAttrAccessControl: access]
      guard SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecSuccess else {
        throw CredentialError.unavailable
      }
    } else if result != errSecSuccess { throw CredentialError.unavailable }
    #endif
  }

  func read(binding: CredentialBinding, reason: String, context: LAContext) throws -> Data {
    var query = try item(binding)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    #if !os(macOS)
    query[kSecUseAuthenticationContext] = context
    #endif
    context.localizedReason = reason
    // No separate evaluatePolicy bool: authorization protects the actual read.
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data, !data.isEmpty, data.count <= 16384 else {
      switch status {
      case errSecUserCanceled: throw CredentialError.cancelled
      case errSecItemNotFound: throw CredentialError.savedPasswordMissing
      case errSecAuthFailed: throw CredentialError.savedReadDenied
      case errSecInteractionNotAllowed: throw CredentialError.savedInteractionRequired
      default: throw CredentialError.savedReadFailed
      }
    }
    #if os(macOS)
    return try MacCredentialSecret.open(data, binding: binding, context: context)
    #else
    guard data.count <= 4096 else { throw CredentialError.savedReadFailed }
    return data
    #endif
  }

  func forget(binding: CredentialBinding) throws {
    let result = SecItemDelete(try item(binding) as CFDictionary)
    guard result == errSecSuccess || result == errSecItemNotFound else { throw CredentialError.unavailable }
  }

  func contains(binding: CredentialBinding) throws -> Bool {
    var query = try item(binding)
    query[kSecMatchLimit] = kSecMatchLimitOne
    let context = LAContext(); context.interactionNotAllowed = true
    defer { context.invalidate() }
    #if !os(macOS)
    query[kSecUseAuthenticationContext] = context
    #endif
    let result = SecItemCopyMatching(query as CFDictionary, nil)
    if result == errSecItemNotFound { return false }
    // This is only a native presentation hint. Actual retrieval still uses
    // the protected SecItemCopyMatching call and a fresh LAContext.
    guard result == errSecSuccess || result == errSecInteractionNotAllowed else { throw CredentialError.unavailable }
    return true
  }

  private func item(_ binding: CredentialBinding) throws -> [CFString: Any] {
    query(service: service, account: try binding.storageKey)
  }
  private func query(service: String, account: String) -> [CFString: Any] {
    var value: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
      kSecAttrService: service, kSecAttrAccount: account, kSecAttrSynchronizable: false]
    #if !os(macOS)
    value[kSecUseDataProtectionKeychain] = true
    #endif
    return value
  }
  #if os(macOS)
  private func loginAccess() throws -> SecAccess {
    var trusted: SecTrustedApplication?
    var access: SecAccess?
    guard SecTrustedApplicationCreateFromPath(nil, &trusted) == errSecSuccess, let trusted,
      SecAccessCreate("Cindy remote desktop credentials" as CFString, [trusted] as CFArray, &access) == errSecSuccess,
      let access else { throw CredentialError.unavailable }
    return access
  }
  #endif
}
#endif
