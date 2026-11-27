// Compare item identities without reading passwords or writing account names to CI logs.
import Foundation
import Security

let env = ProcessInfo.processInfo.environment
guard env["GITHUB_ACTIONS"] == "true", env["RUNNER_ENVIRONMENT"] == "github-hosted",
      env["CINDY_SYSTEM_PROXY_COMPARE"] == "1" else { exit(2) }

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecReturnAttributes as String: true,
    kSecReturnPersistentRef as String: true,
    kSecMatchLimit as String: kSecMatchLimitAll,
]
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecItemNotFound {
    print("[]")
    exit(0)
}
guard status == errSecSuccess, let rows = result as? [[String: Any]] else {
    fatalError("Cannot enumerate keychain attributes (OSStatus \(status))")
}
let matches = rows.compactMap { row -> String? in
    let names = [row[kSecAttrService as String], row[kSecAttrLabel as String]]
    guard names.contains(where: { ($0 as? String)?.hasSuffix("Safe Storage") == true }) else { return nil }
    guard let identity = row[kSecValuePersistentRef as String] as? Data else {
        fatalError("Keychain query returned an item without its identity")
    }
    return identity.base64EncodedString()
}
print(String(decoding: try JSONEncoder().encode(matches.sorted()), as: UTF8.self))
