import Foundation

/// Public material only. Transport delivery alone does not establish trust.
struct LocalCredentialIdentity: Codable {
  let version: Int
  let device: String
  let membership: String
  let realm: IdentityRealm
  let publicKey: IdentityPublicKey

  init(device: String, membership: String, realm: IdentityRealm, publicKey: IdentityPublicKey) {
    version = 1; self.device = device; self.membership = membership; self.realm = realm; self.publicKey = publicKey
  }
  func encoded() throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(self), as: UTF8.self)
  }
  static func decode(_ text: String, device: String, membership: String, realm: IdentityRealm) throws -> LocalCredentialIdentity {
    guard text.utf8.count <= 4096, let value = try? JSONDecoder().decode(Self.self, from: Data(text.utf8)),
      value.version == 1, value.device == device, !device.isEmpty, device.utf8.count <= 512,
      value.membership == membership, !membership.isEmpty, membership.utf8.count <= 512,
      value.realm == realm else { throw CredentialError.invalidIdentity }
    _ = try value.publicKey.securityKey()
    return value
  }
  var peer: ChannelIdentity {
    ChannelIdentity(id: device, membershipId: membership, publicKey: publicKey, realm: realm, checkedAt: Date())
  }
  func requirePin(_ pin: IdentityPublicKey?) throws {
    guard let pin, pin == publicKey else { throw CredentialError.invalidIdentity }
  }
}
