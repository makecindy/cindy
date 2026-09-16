#if os(macOS)
import Foundation
import ApplicationServices
import SystemConfiguration

/// Trusted helper owner. Desktop Main gets only opaque session IDs, ciphertext
/// replies and already-authenticated desktop commands; never OS credentials.
@MainActor public final class HostCredentialServer {
  private struct Owner: Equatable { let realm: IdentityRealm; let membership: String; let authDevice: String }
  private struct Session {
    let handle: String
    let peer: String
    let offer: String
    let pendingUntil: TimeInterval
    let account: MacSystemAccount
    let channel: NativeChannel
    let host: HostCredentialSession
  }
  private let directory: URL
  private let limiter = CredentialAttemptLimiter()
  private var owner: Owner?
  private var generation: UInt64 = 0
  private var key: IdentityKey?
  private var sessions: [String: Session] = [:] // Native handle, never caller supplied.
  private var active: [String: String] = [:]
  private var candidates: [String: String] = [:]
  private var admissions: [String: UUID] = [:]

  public init(directory: URL) { self.directory = directory }

  public func configure(realm: String, membership: String, authDevice: String, token: String) async throws -> String {
    guard let realm = IdentityRealm(rawValue: realm), !membership.isEmpty, !authDevice.isEmpty else { throw CredentialError.invalidIdentity }
    let next = Owner(realm: realm, membership: membership, authDevice: authDevice)
    if owner != next { reset(); owner = next }
    let installation = try InstallationMarker.loadOrCreate(directory: directory)
    let signingKey = try InstallationIdentity.loadOrCreate(installation: installation, realm: realm)
    let descriptor = LocalCredentialIdentity(device: authDevice, membership: membership, realm: realm, publicKey: signingKey.publicKey)
    key = signingKey
    return try descriptor.encoded()
  }

  public func updateToken(realm: String, membership: String, token: String) throws {
    guard let owner, owner.realm.rawValue == realm, owner.membership == membership else { throw CredentialError.cancelled }
  }
  public func relayHeaders() async throws -> [String: String] { throw CredentialError.unavailable }
  public func begin(peer: String, offer: String, descriptor: String) async throws -> [String: String] {
    _ = status()
    let previousCandidate = candidates[peer]
    if let handle = previousCandidate, let state = sessions[handle], state.offer == offer {
      return ["handle": handle, "offer": try state.channel.offer()]
    }
    guard let owner, let key,
      Set(sessions.values.map(\.peer)).count < 8 || active[peer] != nil || previousCandidate != nil else { throw CredentialError.unavailable }
    let admission = UUID()
    admissions[peer] = admission
    defer { if admissions[peer] == admission { admissions.removeValue(forKey: peer) } }
    let local = LocalCredentialIdentity(device: owner.authDevice, membership: owner.membership, realm: owner.realm, publicKey: key.publicKey).peer
    let remote = try LocalCredentialIdentity.decode(descriptor, device: peer, membership: owner.membership, realm: owner.realm).peer
    let account = try MacSystemAccount.current()
    try requireAccount(account, allowLocked: true)
    let channel = try NativeChannel(local: local, remote: remote, key: key)
    try channel.accept(offer: offer)
    let handle = UUID().uuidString.lowercased()
    let host = HostCredentialSession(channel: channel,
      account: CredentialAccount(recordID: account.recordID, name: account.name), limiter: limiter) { [weak self] password in
        guard let self else { throw CredentialError.cancelled }
        try await self.verifyAndUnlock(handle: handle, account: account, password: password)
    }
    let state = Session(handle: handle, peer: peer, offer: offer,
      pendingUntil: ProcessInfo.processInfo.systemUptime + 120, account: account, channel: channel, host: host)
    // A cancelled/restarted unverified attempt may be replaced; the active
    // session is still untouched until the new password is verified.
    if let previousCandidate { closeHandle(previousCandidate) }
    sessions[state.handle] = state; candidates[peer] = state.handle
    return ["handle": state.handle, "offer": try channel.offer()]
  }

  public func receive(peer: String, handle: String, ciphertext: String) async throws -> [String: String] {
    let original = try current(peer, handle)
    let received = try await original.host.receive(ciphertext)
    if case .closed = received { closeHandle(handle); return ["kind": "closed"] }
    guard sessions[handle]?.host === original.host else { throw CredentialError.cancelled }
    let state = try current(peer, handle)
    if candidates[peer] == handle, state.host.authenticationSession != nil {
      try requireAccount(state.account)
      if let previous = active[peer] { closeHandle(previous) }
      candidates.removeValue(forKey: peer); active[peer] = handle
    }
    switch received {
    case .reply(let ciphertext): return ["kind": "reply", "ciphertext": ciphertext]
    case .command(let id, let body):
      guard active[peer] == handle, let authentication = state.host.authenticationSession,
        let text = String(data: body, encoding: .utf8) else { throw CredentialError.invalidMessage }
      return ["kind": "command", "id": id, "body": text, "authenticationSession": authentication]
    case .closed:
      closeHandle(handle); return ["kind": "closed"]
    }
  }

  public func response(peer: String, handle: String, id: String, body: String, success: Bool) throws -> String {
    let state = try current(peer, handle)
    try requireAccount(state.account)
    return try state.host.response(id: id, body: Data(body.utf8), success: success)
  }

  /// Local-only: directory latency must never queue media or input behind HTTPS.
  public func status() -> [String: String] {
    var result: [String: String] = [:]
    for (handle, state) in sessions {
      do {
        try validate(state)
        if active[state.peer] == handle, let id = state.host.authenticationSession { result[state.peer] = id }
      } catch { closeHandle(handle) }
    }
    return result
  }

  private func validate(_ state: Session) throws {
    let now = ProcessInfo.processInfo.systemUptime
    if candidates[state.peer] == state.handle, now >= state.pendingUntil { throw CredentialError.expired }
    try state.channel.active()
    try requireAccount(state.account, allowLocked: candidates[state.peer] == state.handle && state.host.authenticationSession == nil)
  }

  private func verifyAndUnlock(handle: String, account: MacSystemAccount, password: Data) async throws {
    try checkAttempt(handle)
    try account.verify(password)
    try checkAttempt(handle)
    try await MacScreenUnlocker.shared.unlock(account: account, password: password) { [weak self] in
      guard let self else { throw CredentialError.cancelled }
      try self.checkAttempt(handle)
    }
    try checkAttempt(handle)
    try requireAccount(account)
  }
  private func checkAttempt(_ handle: String) throws {
    guard let state = sessions[handle], candidates[state.peer] == handle else { throw CredentialError.cancelled }
    try validate(state)
  }

  private func closeHandle(_ handle: String) {
    guard let state = sessions.removeValue(forKey: handle) else { return }
    state.host.close()
    if active[state.peer] == handle { active.removeValue(forKey: state.peer) }
    if candidates[state.peer] == handle { candidates.removeValue(forKey: state.peer) }
  }
  public func close(peer: String) {
    admissions.removeValue(forKey: peer)
    if let handle = active[peer] { closeHandle(handle) }
    if let handle = candidates[peer] { closeHandle(handle) }
  }
  public func closeAll() {
    generation &+= 1
    for state in sessions.values { state.host.close() }
    sessions.removeAll(); active.removeAll(); candidates.removeAll(); admissions.removeAll()
  }
  public func reset() {
    closeAll()
    owner = nil; key = nil
  }
  private func current(_ peer: String, _ handle: String) throws -> Session {
    guard let state = sessions[handle], state.peer == peer else { throw CredentialError.invalidIdentity }
    try validate(state)
    return state
  }
  private func requireAccount(_ account: MacSystemAccount, allowLocked: Bool = false) throws {
    guard !(try MacConsoleState.read(account: account).locked) || allowLocked else { throw CredentialError.unlockUnavailable }
  }
}
#endif
