import Foundation
import Security

/// Native installation identity. The installation UUID must come from the
/// host's non-migrating installation marker, not a peer or a device display ID.
public enum InstallationIdentity {
  public static func loadOrCreate(installation: UUID, realm: IdentityRealm) throws -> IdentityKey {
    #if os(macOS)
    let version = "v2.login-keychain"
    #else
    let version = "v1"
    #endif
    let tag = Data("cindy.remote.identity.\(version).\(realm.rawValue).\(installation.uuidString.lowercased())".utf8)
    var query: [CFString: Any] = [
      kSecClass: kSecClassKey, kSecAttrApplicationTag: tag,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecReturnRef: true,
    ]
    #if !os(macOS)
    query[kSecUseDataProtectionKeychain] = true
    #endif
    var value: CFTypeRef?
    let result = SecItemCopyMatching(query as CFDictionary, &value)
    if result == errSecSuccess {
      guard let value, CFGetTypeID(value) == SecKeyGetTypeID() else { throw CredentialError.unavailable }
      return try IdentityKey(key: value as! SecKey)
    }
    // A locked/unavailable key is not a missing key. Never silently replace it.
    #if os(iOS) && !targetEnvironment(simulator)
    let flags: SecAccessControlCreateFlags = .privateKeyUsage
    #else
    // privateKeyUsage is a Secure Enclave constraint; Security rejects it for
    // software keys (including macOS and the iOS Simulator).
    let flags: SecAccessControlCreateFlags = []
    #endif
    guard result == errSecItemNotFound,
      let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        flags, nil) else { throw CredentialError.unavailable }
    var attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256,
      kSecUseDataProtectionKeychain: true,
      kSecPrivateKeyAttrs: [kSecAttrIsPermanent: true, kSecAttrApplicationTag: tag,
        kSecAttrAccessControl: access] as [CFString: Any],
    ]
    #if os(iOS) && !targetEnvironment(simulator)
    attributes[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave
    #endif
    #if os(macOS)
    // A standalone signed helper uses the login Keychain. Restrict signing to
    // this executable; no all-app ACL and no extractable private key.
    var trusted: SecTrustedApplication?
    var keyAccess: SecAccess?
    guard SecTrustedApplicationCreateFromPath(nil, &trusted) == errSecSuccess,
      let trusted,
      SecAccessCreate("Cindy remote desktop identity" as CFString, [trusted] as CFArray, &keyAccess) == errSecSuccess,
      let keyAccess else { throw CredentialError.unavailable }
    attributes.removeValue(forKey: kSecUseDataProtectionKeychain)
    attributes[kSecAttrIsExtractable] = false
    attributes[kSecAttrIsSensitive] = true
    attributes[kSecPrivateKeyAttrs] = [kSecAttrIsPermanent: true, kSecAttrApplicationTag: tag,
      kSecAttrIsExtractable: false, kSecAttrAccess: keyAccess] as [CFString: Any]
    #endif
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      // Another native initialization may have created the exact same tag.
      if let error, CFErrorGetCode(error.takeRetainedValue()) == errSecDuplicateItem,
        SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
        let value, CFGetTypeID(value) == SecKeyGetTypeID() {
        return try IdentityKey(key: value as! SecKey)
      }
      throw CredentialError.unavailable
    }
    return try IdentityKey(key: key)
  }
}
