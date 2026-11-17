import Foundation
import Security
import UserNotifications

/// One keychain item per identity: parallel extension processes cannot overwrite each
/// other's tombstones. Only recipient IDs, alert IDs and expiry times are stored.
enum NotificationRetirement {
  private static let service = "cindy.notification-retired"
  private static func query(_ recipient: String, _ id: String) -> [String: Any]? {
    guard !recipient.isEmpty, recipient.utf8.count <= 256, UUID(uuidString: id) != nil,
      let group = Bundle.main.object(forInfoDictionaryKey: "CindyAgentNetKeychainGroup") as? String,
      !group.isEmpty else { return nil }
    return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: recipient + ":" + id.lowercased(), kSecAttrAccessGroup as String: group]
  }
  static func isRetired(_ data: [AnyHashable: Any]) -> Bool {
    guard let recipient = data["recipientId"] as? String, let id = data["notificationId"] as? String,
      var q = query(recipient, id) else { return false }
    q[kSecReturnData as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
      let bytes = result as? Data, let text = String(data: bytes, encoding: .utf8),
      let expiry = Double(text) else { return false }
    if expiry > Date().timeIntervalSince1970 { return true }
    q.removeValue(forKey: kSecReturnData as String)
    SecItemDelete(q as CFDictionary)
    return false
  }
  static func retire(_ data: [AnyHashable: Any], completion: @escaping () -> Void) {
    guard let recipient = data["recipientId"] as? String, let ids = data["dismissIds"] as? [String],
      !ids.isEmpty, ids.count <= 50 else { completion(); return }
    // Reclaim expired entries without ever querying another keychain service.
    if var all = query(recipient, ids[0]) {
      all.removeValue(forKey: kSecAttrAccount as String)
      all[kSecReturnAttributes as String] = true
      all[kSecReturnData as String] = true
      all[kSecMatchLimit as String] = kSecMatchLimitAll
      var found: CFTypeRef?
      if SecItemCopyMatching(all as CFDictionary, &found) == errSecSuccess, let rows = found as? [[String: Any]] {
        for row in rows {
          guard let bytes = row[kSecValueData as String] as? Data,
            let text = String(data: bytes, encoding: .utf8), let until = Double(text),
            until <= Date().timeIntervalSince1970,
            let account = row[kSecAttrAccount as String] as? String else { continue }
          var expired = all
          expired.removeValue(forKey: kSecReturnAttributes as String)
          expired.removeValue(forKey: kSecReturnData as String)
          expired.removeValue(forKey: kSecMatchLimit as String)
          expired[kSecAttrAccount as String] = account
          SecItemDelete(expired as CFDictionary)
        }
      }
    }
    let expiry = Data(String(Date().timeIntervalSince1970 + 30 * 86400).utf8)
    let valid = Set(ids.filter { query(recipient, $0) != nil }.map { $0.lowercased() })
    for id in valid {
      guard var q = query(recipient, id) else { continue }
      let update = [kSecValueData as String: expiry]
      if SecItemUpdate(q as CFDictionary, update as CFDictionary) == errSecItemNotFound {
        q[kSecValueData as String] = expiry
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
      }
    }
    UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
      let identifiers = notifications.compactMap { notification -> String? in
        let info = notification.request.content.userInfo
        guard info["recipientId"] as? String == recipient,
          let id = info["notificationId"] as? String, valid.contains(id.lowercased()) else { return nil }
        return notification.request.identifier
      }
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
      completion()
    }
  }
}
