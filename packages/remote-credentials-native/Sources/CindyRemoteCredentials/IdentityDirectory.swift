import Foundation

public enum IdentityRealm: String, Codable, Sendable { case global, cn }

/// Metadata used by the encrypted channel. Peer trust is established by a
/// local pin after explicit setup over the account-authenticated connection.
public struct ChannelIdentity {
  public let id: String
  public let membershipId: String
  public let publicKey: IdentityPublicKey
  public let realm: IdentityRealm
  let checkedAt: Date
}

func validIdentityID(_ value: String) -> Bool {
  guard let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value else { return false }
  let bytes = Array(value.utf8)
  return bytes[14] == 52 && [56, 57, 97, 98].contains(bytes[19])
}
