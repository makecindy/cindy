import Foundation
import Security
import CryptoKit

/// Shared with the notification extension. Contains only an independent notification
/// key and public, previously verified device keys. No account/transport credentials.
enum AgentNetNotifications {
  private static let lock = NSRecursiveLock()
  private static var ticket = UUID().uuidString
  private static let service = "app.cindy.agent-net.notifications.v2"
  static func begin() -> String {
    lock.lock(); defer { lock.unlock() }
    ticket = UUID().uuidString
    SecItemDelete(query("active") as CFDictionary)
    return ticket
  }
  static func configure(_ expected: String, raw: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard expected == ticket, let bytes = raw.data(using: .utf8), bytes.count <= 512 * 1024,
      let record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let version = record["version"] as? Int, [2, 3].contains(version),
      let key = decode(record["secret"] as? String), key.count == 32,
      let until = record["expiresAt"] as? Double, until > now(), until <= now() + 14 * 86_400_000,
      let peers = record["peers"] as? [String: String], peers.count <= 2048,
      version != 3 || (record["peerExpiresAt"] as? [String: Double]) != nil,
      let scope = record["scope"] as? String, scope.utf8.count <= 512
    else { throw failure() }
    try put("active", bytes)
  }
  static func activeScope() -> String? {
    guard let bytes = get("active"), let record = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
    return record["scope"] as? String
  }
  static func open(_ deepLink: String) -> [String: Any]? {
    lock.lock(); defer { lock.unlock() }
    do {
      guard let raw = get("active"), let config = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
        let version = config["version"] as? Int, [2, 3].contains(version),
        let until = config["expiresAt"] as? Double, until > now(),
        let scope = config["scope"] as? String,
        let parts = URLComponents(string: deepLink), parts.scheme == "cindy", parts.host == "agent-net-notification",
        let packet = decode(parts.queryItems?.first(where: { $0.name == "envelope" })?.value),
        packet.count >= 125, packet.count <= 1950, packet[0] == 4,
        let secret = decode(config["secret"] as? String), secret.count == 32
      else { return nil }
      let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
      let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: packet[1..<33])
      let shared = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
      let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: packet[33..<45],
        sharedInfo: Data("cindy-agent-net/notification/2".utf8), outputByteCount: 32)
      let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: packet[33..<45]),
        ciphertext: packet[45..<(packet.count - 16)], tag: packet.suffix(16))
      let clear = try AES.GCM.open(box, using: key, authenticating: packet.prefix(45))
      guard clear.count >= 64 else { return nil }
      let signed = clear.dropLast(64), signature = clear.suffix(64)
      guard let a = try JSONSerialization.jsonObject(with: signed) as? [Any], a.count == 9,
        a[0] as? String == "cindy-agent-net/notification/2", a[1] as? Int == 2,
        a[2] as? String == config["networkId"] as? String, a[4] as? String == config["deviceId"] as? String,
        let from = a[3] as? String, let id = a[5] as? String, !id.isEmpty, id.utf8.count <= 64,
        let at = a[6] as? Double, let expiry = a[7] as? Double,
        at <= now() + 30_000, expiry > now(), expiry > at, expiry - at <= 300_000,
        let peers = config["peers"] as? [String: String], let publicBytes = decode(peers[from]),
        let payload = a[8] as? [String: Any],
        ["session-done", "session-error", "session-needs-reply"].contains(payload["category"] as? String ?? ""),
        let title = payload["title"] as? String, title.utf8.count <= 512,
        let target = payload["deepLink"] as? String, target.utf8.count <= 512,
        target.hasPrefix("/") || target.hasPrefix("cindy://")
      else { return nil }
      if version == 3 {
        guard let deadlines = config["peerExpiresAt"] as? [String: Double],
          let deadline = deadlines[from], deadline > now() else { return nil }
      }
      let signer = try Curve25519.Signing.PublicKey(rawRepresentation: publicBytes)
      guard signer.isValidSignature(signature, for: signed) else { return nil }
      let history = get("seen").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      var seen = history?["scope"] as? String == scope ? history?["ids"] as? [String: Double] ?? [:] : [:]
      seen = seen.filter { $0.value > now() }
      guard seen[id] == nil, seen.count < 256 else { return nil }
      seen[id] = expiry
      try put("seen", JSONSerialization.data(withJSONObject: ["scope": scope, "ids": seen]))
      // The extension never rewrites active: a late delivery cannot resurrect a cleared account.
      guard get("active") == raw else { return nil }
      var result = payload
      if config["preview"] as? Bool == false { result["title"] = "Cindy"; result["body"] = ""; result.removeValue(forKey: "sender") }
      result["agentNetScope"] = scope
      return result
    } catch { return nil }
  }
  private static func query(_ account: String) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false]
    if let group = Bundle.main.object(forInfoDictionaryKey: "CindyAgentNetKeychainGroup") as? String { query[kSecAttrAccessGroup as String] = group }
    return query
  }
  private static func get(_ account: String) -> Data? {
    var q = query(account); q[kSecReturnData as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }
  private static func put(_ account: String, _ bytes: Data) throws {
    let q = query(account)
    let attributes: [String: Any] = [kSecValueData as String: bytes,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      guard SecItemAdd(q.merging(attributes) { _, value in value } as CFDictionary, nil) == errSecSuccess else { throw failure() }
    } else if status != errSecSuccess { throw failure() }
  }
  private static func decode(_ text: String?) -> Data? {
    guard let text else { return nil }
    let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    return Data(base64Encoded: padded + String(repeating: "=", count: (4 - padded.count % 4) % 4))
  }
  private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }
  private static func failure() -> NSError { NSError(domain: "CindyAgentNet", code: 1, userInfo: [NSLocalizedDescriptionKey: "AGENT_NET_NOTIFICATION_STORE_FAILED"]) }
}
