import CryptoKit
import Foundation

struct CredentialAccount: Codable, Equatable {
  let recordID: String
  let name: String
}

struct AuthenticationAttempt: Codable {
  let id: String
  let account: CredentialAccount
  let password: Data
}

struct AuthenticationResult: Codable, Equatable {
  let id: String
  let account: CredentialAccount
  let accepted: Bool
  var failure: CredentialError? = nil
}

private struct AttemptQuery: Codable { let id: String }

struct CredentialDesktopRequest: Codable { let id: String; let payload: Data }
struct CredentialDesktopResponse: Codable { let id: String; let payload: Data; let success: Bool }

/// Shared by all sessions of one host, so reconnecting cannot reset the limit.
/// Its owner serializes access on the same queue as the host sessions.
final class CredentialAttemptLimiter {
  private var attempts: [TimeInterval] = []
  private let uptime: () -> TimeInterval
  init(uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.uptime = uptime
  }
  func admit() throws {
    let instant = uptime()
    attempts.removeAll { instant - $0 >= 60 }
    guard attempts.count < 5 else { throw CredentialError.unavailable }
    attempts.append(instant)
  }
}

/// Password-bearing packets terminate here. Only authenticated ordinary desktop
/// commands and encrypted replies may cross the helper's Main-process bridge.
/// The production owner must supply OS verification and serialize all calls.
@MainActor final class HostCredentialSession {
  enum Delivery {
    case reply(String)
    case command(id: String, body: Data)
    case closed
  }
  private struct Completed {
    let digest: Data
    let result: AuthenticationResult
  }
  private let channel: NativeChannel
  private let account: CredentialAccount
  private let limiter: CredentialAttemptLimiter
  private let verify: @MainActor (Data) async throws -> Void
  private var verifying = false
  private var completed: [String: Completed] = [:]
  private var authorization: String?
  private var pendingCommands = Set<String>()

  init(channel: NativeChannel, account: CredentialAccount, limiter: CredentialAttemptLimiter,
    verify: @escaping @MainActor (Data) async throws -> Void) {
    self.channel = channel; self.account = account; self.limiter = limiter; self.verify = verify
  }

  var authenticationSession: String? {
    do {
      try channel.active()
      // A status query before the first ready packet is normal. It must not
      // close the very handshake that will establish peer confirmation.
      guard channel.peerConfirmed else { return nil }
      return authorization
    }
    catch { close(); return nil }
  }

  func receive(_ ciphertext: String) async throws -> Delivery {
    let packet = try channel.open(ciphertext)
    switch packet.purpose {
    case "ready":
      return .reply(try channel.seal(body: JSONEncoder().encode(account), purpose: "ready"))
    case "authenticate":
      guard packet.body.count <= 8192 else { throw CredentialError.invalidMessage }
      let attempt: AuthenticationAttempt
      do { attempt = try JSONDecoder().decode(AuthenticationAttempt.self, from: packet.body) }
      catch { throw CredentialError.invalidMessage }
      guard UUID(uuidString: attempt.id)?.uuidString.lowercased() == attempt.id,
        attempt.account == account, !attempt.password.isEmpty,
        attempt.password.count <= 4096, !attempt.password.contains(0),
        String(data: attempt.password, encoding: .utf8) != nil else { throw CredentialError.invalidMessage }
      let digest = Data(SHA256.hash(data: packet.body))
      if let existing = completed[attempt.id] {
        guard existing.digest == digest else { close(); throw CredentialError.invalidMessage }
        return .reply(try resultPacket(existing.result))
      }
      // Do not evict outcomes: an evicted attempt could execute a second time.
      guard !verifying, authorization == nil, completed.count < 5 else { throw CredentialError.unavailable }
      try limiter.admit()
      verifying = true
      defer { verifying = false }
      let accepted: Bool
      var failure: CredentialError?
      do { try await verify(attempt.password); accepted = true }
      catch {
        accepted = false
        if let error = error as? CredentialError {
          if error != .invalidIdentity { failure = error }
        } else { failure = .unavailable }
      }
      // Verification may have blocked while the security session expired.
      try channel.requireConfirmed()
      let result = AuthenticationResult(id: attempt.id, account: account, accepted: accepted, failure: failure)
      completed[attempt.id] = Completed(digest: digest, result: result)
      if accepted { authorization = UUID().uuidString.lowercased() }
      return .reply(try resultPacket(result))
    case "authentication-status":
      guard packet.body.count <= 256,
        let query = try? JSONDecoder().decode(AttemptQuery.self, from: packet.body),
        let existing = completed[query.id] else { throw CredentialError.invalidMessage }
      return .reply(try resultPacket(existing.result))
    case "request":
      guard authenticationSession != nil else { throw CredentialError.invalidIdentity }
      guard pendingCommands.count < 64,
        let request = try? JSONDecoder().decode(CredentialDesktopRequest.self, from: packet.body),
        validIdentityID(request.id), !pendingCommands.contains(request.id) else {
        throw CredentialError.invalidMessage
      }
      pendingCommands.insert(request.id)
      return .command(id: request.id, body: request.payload)
    case "revoke":
      close(); return .closed
    default:
      throw CredentialError.invalidMessage
    }
  }

  func response(id: String, body: Data, success: Bool) throws -> String {
    guard authenticationSession != nil else { throw CredentialError.invalidIdentity }
    guard pendingCommands.remove(id) != nil else { throw CredentialError.invalidMessage }
    return try channel.seal(body: JSONEncoder().encode(CredentialDesktopResponse(id: id,
      payload: body, success: success)), purpose: "response")
  }

  func close() { authorization = nil; completed.removeAll(); pendingCommands.removeAll(); channel.close() }

  private func resultPacket(_ result: AuthenticationResult) throws -> String {
    try channel.seal(body: JSONEncoder().encode(result), purpose: "authentication-result")
  }
}
