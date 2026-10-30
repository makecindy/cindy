import CryptoKit
import Foundation
import JOSESwift

private struct ChannelOffer: Codable {
  let domain: String
  let realm: IdentityRealm
  let membership: String
  let from: String
  let to: String
  let nonce: String
  let ephemeral: IdentityPublicKey
  let expiresAt: Int64
}

private struct ChannelPacket: Codable {
  let domain: String
  let session: String
  let from: String
  let to: String
  let sequence: UInt64
  let purpose: String
  let body: Data
}

/// One native security session, independent of media leases and relay retries.
/// Owners serialize access to this object; it is deliberately not Sendable.
final class NativeChannel {
  private let local: ChannelIdentity
  private let remote: ChannelIdentity
  private let signingKey: IdentityKey
  private var ephemeral: IdentityKey?
  private let localOffer: ChannelOffer
  private var remoteOffer: ChannelOffer?
  private var session: String?
  private var outgoing: UInt64 = 0
  private var incomingHigh: UInt64 = 0
  private var received = Set<UInt64>()
  private var closed = false
  private(set) var peerConfirmed = false
  private let now: () -> Date
  private let deadline: Date
  private let uptime: () -> TimeInterval
  private let uptimeDeadline: TimeInterval

  init(local: ChannelIdentity, remote: ChannelIdentity, key: IdentityKey,
    now: @escaping () -> Date = Date.init,
    uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) throws {
    let instant = now()
    guard local.id != remote.id, local.realm == remote.realm,
      local.membershipId == remote.membershipId, local.publicKey == key.publicKey,
      instant.timeIntervalSince(local.checkedAt) >= 0, instant.timeIntervalSince(local.checkedAt) <= 30,
      instant.timeIntervalSince(remote.checkedAt) >= 0, instant.timeIntervalSince(remote.checkedAt) <= 30 else {
      throw CredentialError.invalidIdentity
    }
    self.local = local; self.remote = remote; signingKey = key; self.now = now
    let ephemeral = try IdentityKey.ephemeral()
    self.ephemeral = ephemeral
    self.uptime = uptime; uptimeDeadline = uptime() + 30 * 60
    deadline = instant.addingTimeInterval(30 * 60)
    localOffer = ChannelOffer(domain: "cindy.remote-desktop.offer.v1", realm: local.realm,
      membership: local.membershipId, from: local.id, to: remote.id,
      nonce: UUID().uuidString.lowercased(), ephemeral: ephemeral.publicKey,
      expiresAt: Int64(instant.addingTimeInterval(60).timeIntervalSince1970 * 1000))
  }

  func offer() throws -> String {
    try active()
    guard let signer = Signer(signatureAlgorithm: .ES256, key: signingKey.key) else {
      throw CredentialError.unavailable
    }
    var header = JWSHeader(algorithm: .ES256)
    header.typ = "cindy-remote-desktop-offer-v1"
    do { return try JWS(header: header, payload: Payload(JSONEncoder().encode(localOffer)), signer: signer).compactSerializedString }
    catch { throw CredentialError.invalidMessage }
  }

  func accept(offer: String) throws {
    try active()
    guard remoteOffer == nil, offer.utf8.count <= 4096 else { throw CredentialError.invalidMessage }
    do {
      let signed = try JWS(compactSerialization: offer)
      guard signed.header.algorithm == .ES256, signed.header.typ == "cindy-remote-desktop-offer-v1",
        signed.header.crit == nil,
        let verifier = Verifier(signatureAlgorithm: .ES256, key: try remote.publicKey.securityKey()) else {
        throw CredentialError.invalidIdentity
      }
      let value = try JSONDecoder().decode(ChannelOffer.self, from: signed.validate(using: verifier).payload.data())
      let instant = Int64(now().timeIntervalSince1970 * 1000)
      guard value.domain == localOffer.domain, value.realm == local.realm,
        value.membership == local.membershipId, value.from == remote.id, value.to == local.id,
        validIdentityID(value.nonce), value.expiresAt > instant, value.expiresAt - instant <= 120_000,
        localOffer.expiresAt > instant else { throw CredentialError.invalidIdentity }
      _ = try value.ephemeral.securityKey()
      // Both independently signed offers contribute fresh entropy. A recorded
      // peer offer cannot establish an old session with our new ephemeral key.
      let offers = [localOffer, value].sorted { $0.from < $1.from }
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      session = Data(SHA256.hash(data: try encoder.encode(offers))).base64URL
      remoteOffer = value
    } catch { throw CredentialError.invalidIdentity }
  }

  func seal(body: Data, purpose: String) throws -> String {
    try active()
    guard let session, let remoteOffer, outgoing < UInt64.max,
      allowedPurpose(purpose), purpose == "ready" || peerConfirmed else { throw CredentialError.invalidMessage }
    outgoing += 1
    let value = ChannelPacket(domain: "cindy.remote-desktop.packet.v1", session: session,
      from: local.id, to: remote.id, sequence: outgoing, purpose: purpose, body: body)
    return try SealedMessage.seal(JSONEncoder().encode(value), sender: signingKey, recipient: remoteOffer.ephemeral)
  }

  func open(_ ciphertext: String) throws -> (purpose: String, body: Data) {
    try active()
    guard let session, let ephemeral else { throw CredentialError.invalidMessage }
    let plaintext = try SealedMessage.open(ciphertext, sender: remote.publicKey, recipient: ephemeral)
    let value: ChannelPacket
    do { value = try JSONDecoder().decode(ChannelPacket.self, from: plaintext) }
    catch { throw CredentialError.invalidMessage }
    guard value.domain == "cindy.remote-desktop.packet.v1", value.session == session,
      value.from == remote.id, value.to == local.id, allowedPurpose(value.purpose), value.sequence > 0,
      value.purpose == "ready" || peerConfirmed,
      !received.contains(value.sequence), value.sequence > incomingHigh || incomingHigh - value.sequence < 256 else {
      throw CredentialError.invalidMessage
    }
    incomingHigh = max(incomingHigh, value.sequence)
    received = received.filter { incomingHigh - $0 < 256 }
    received.insert(value.sequence)
    if value.purpose == "ready" { peerConfirmed = true }
    return (value.purpose, value.body)
  }

  func close() {
    closed = true; peerConfirmed = false; session = nil; remoteOffer = nil; ephemeral = nil; received.removeAll()
  }

  func requireConfirmed() throws {
    try active()
    guard peerConfirmed else { throw CredentialError.invalidIdentity }
  }

  func active() throws {
    guard !closed, now() < deadline, uptime() < uptimeDeadline else { throw CredentialError.expired }
  }
  private func allowedPurpose(_ value: String) -> Bool {
    ["ready", "authenticate", "authentication-result", "authentication-status", "request", "response", "revoke"].contains(value)
  }
}
