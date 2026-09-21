#if os(macOS)
import Foundation
import OpenDirectory
import SystemConfiguration

struct MacSystemAccount: Codable, Equatable {
  let uid: UInt32
  let recordID: String
  let name: String

  static func current() throws -> MacSystemAccount {
    let uid = getuid()
    guard uid != 0, uid == geteuid(), let entry = getpwuid(uid) else { throw CredentialError.unavailable }
    let name = String(cString: entry.pointee.pw_name)
    let record = try localRecord(name)
    guard let ids = try record.values(forAttribute: kODAttributeTypeGUID) as? [String],
      ids.count == 1, let uuid = UUID(uuidString: ids[0]) else { throw CredentialError.unavailable }
    return MacSystemAccount(uid: uid, recordID: uuid.uuidString.lowercased(), name: name)
  }

  /// Exactly one OS password verification attempt; never invokes shell tools,
  /// simulates keyboard input, retries, or stores a local copy of the password.
  func verify(_ password: Data) throws {
    guard !password.isEmpty, password.count <= 4096, !password.contains(0),
      let text = String(data: password, encoding: .utf8) else { throw CredentialError.invalidMessage }
    do {
      guard try Self.current() == self else { throw CredentialError.invalidIdentity }
      var consoleUID: uid_t = 0, consoleGID: gid_t = 0
      guard SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID) != nil,
        consoleUID == uid else { throw CredentialError.invalidIdentity }
      try Self.localRecord(name).verifyPassword(text)
      guard try Self.current() == self else { throw CredentialError.invalidIdentity }
      // Check again after OpenDirectory returns; fast user switching must not
      // authorize a different current desktop through the same long-lived helper.
      guard SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID) != nil,
        consoleUID == uid else { throw CredentialError.invalidIdentity }
    } catch { throw CredentialError.invalidIdentity }
  }

  private static func localRecord(_ name: String) throws -> ODRecord {
    let node = try ODNode(session: ODSession.default(), type: UInt32(kODNodeTypeLocalNodes))
    return try node.record(withRecordType: kODRecordTypeUsers, name: name,
      attributes: [kODAttributeTypeGUID, kODAttributeTypeUniqueID])
  }

  /// A display name is accepted only if it identifies this one local record.
  /// Duplicate full names must not let another selected user receive a secret.
  func unambiguousDisplayNames() throws -> Set<String> {
    var names = Set<String>()
    let node = try ODNode(session: ODSession.default(), type: UInt32(kODNodeTypeLocalNodes))
    let fullNames = try Self.localRecord(name).values(forAttribute: kODAttributeTypeFullName) as? [String] ?? []
    for label in Set([name] + fullNames) where !label.isEmpty {
      var ids = Set<String>()
      for attribute in [kODAttributeTypeFullName, kODAttributeTypeRecordName] {
        let query = try ODQuery(node: node, forRecordTypes: kODRecordTypeUsers,
          attribute: attribute, matchType: ODMatchType(kODMatchEqualTo), queryValues: label,
          returnAttributes: [kODAttributeTypeGUID], maximumResults: 2)
        let records = try query.resultsAllowingPartial(false) as? [ODRecord] ?? []
        for record in records {
          guard let values = try record.values(forAttribute: kODAttributeTypeGUID) as? [String], values.count == 1 else {
            throw CredentialError.unlockUnavailable
          }
          ids.insert(values[0].lowercased())
        }
      }
      if ids == Set([recordID]) { names.insert(label) }
    }
    return names
  }
}
#endif
