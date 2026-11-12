import XCTest
@testable import CindyRemoteCredentials

@MainActor final class HostCredentialSessionTests: XCTestCase {
  private let account = CredentialAccount(recordID: "test-system-account", name: "test-user")

  private func pair(limiter: CredentialAttemptLimiter = CredentialAttemptLimiter(), probeBeforeReady: Bool = false,
    verify: @escaping @MainActor (Data) async throws -> Void) async throws -> (NativeChannel, HostCredentialSession) {
    let at = Date(), leftKey = try IdentityKey.ephemeral(), rightKey = try IdentityKey.ephemeral()
    let leftIdentity = ChannelIdentity(id: UUID().uuidString.lowercased(), membershipId: "test",
      publicKey: leftKey.publicKey, realm: .global, checkedAt: at)
    let rightIdentity = ChannelIdentity(id: UUID().uuidString.lowercased(), membershipId: "test",
      publicKey: rightKey.publicKey, realm: .global, checkedAt: at)
    let left = try NativeChannel(local: leftIdentity, remote: rightIdentity, key: leftKey)
    let right = try NativeChannel(local: rightIdentity, remote: leftIdentity, key: rightKey)
    try left.accept(offer: right.offer()); try right.accept(offer: left.offer())
    let host = HostCredentialSession(channel: right, account: account, limiter: limiter, verify: verify)
    if probeBeforeReady {
      // HostCredentialServer.validate reads this before the first ready packet.
      XCTAssertNil(host.authenticationSession)
      XCTAssertNil(host.authenticationSession)
      try right.active()
    }
    guard case .reply(let ready) = try await host.receive(left.seal(body: Data(), purpose: "ready")) else {
      throw CredentialError.invalidMessage
    }
    XCTAssertEqual(try JSONDecoder().decode(CredentialAccount.self, from: left.open(ready).body), account)
    return (left, host)
  }

  private func attempt(_ id: String = UUID().uuidString.lowercased(), password: String = "invalid-test-only") throws -> Data {
    try JSONEncoder().encode(AuthenticationAttempt(id: id, account: account, password: Data(password.utf8)))
  }

  func testStatusBeforeReadyDoesNotClosePendingHandshake() async throws {
    var executions = 0
    let (client, host) = try await pair(probeBeforeReady: true) { _ in executions += 1 }
    XCTAssertNil(host.authenticationSession)
    await assertThrowsAsync(try await host.receive(client.seal(body: Data(), purpose: "request")))
    XCTAssertEqual(executions, 0)
    _ = try await host.receive(client.seal(body: attempt(), purpose: "authenticate"))
    XCTAssertEqual(executions, 1)
    XCTAssertNotNil(host.authenticationSession)
  }

  func testLostReplyRecoveryDoesNotRepeatVerificationAndKeepsAuthorization() async throws {
    var executions = 0
    let (client, host) = try await pair { _ in executions += 1 }
    XCTAssertNil(host.authenticationSession)
    await assertThrowsAsync(try await host.receive(client.seal(body: Data(), purpose: "request")))
    let id = UUID().uuidString.lowercased(), body = try attempt(id)
    _ = try await host.receive(client.seal(body: body, purpose: "authenticate")) // Simulate a lost result.
    let authorization = try XCTUnwrap(host.authenticationSession)
    let query = try JSONSerialization.data(withJSONObject: ["id": id])
    guard case .reply(let reply) = try await host.receive(client.seal(body: query, purpose: "authentication-status")) else {
      return XCTFail("Expected encrypted result")
    }
    XCTAssertTrue(try JSONDecoder().decode(AuthenticationResult.self, from: client.open(reply).body).accepted)
    _ = try await host.receive(client.seal(body: body, purpose: "authenticate"))
    XCTAssertEqual(executions, 1)
    XCTAssertEqual(host.authenticationSession, authorization)
    let request = CredentialDesktopRequest(id: UUID().uuidString.lowercased(), payload: Data("test-command".utf8))
    guard case .command(let commandID, let command) = try await host.receive(client.seal(body: JSONEncoder().encode(request), purpose: "request")) else {
      return XCTFail("Expected authorized command")
    }
    XCTAssertEqual(command, Data("test-command".utf8))
    XCTAssertEqual(commandID, request.id)
    host.close()
    XCTAssertNil(host.authenticationSession)
    XCTAssertThrowsError(try host.response(id: commandID, body: Data(), success: true))
  }

  func testChangedPasswordUnderSameAttemptClosesSession() async throws {
    var executions = 0
    let (client, host) = try await pair { _ in executions += 1; throw CredentialError.invalidIdentity }
    let id = UUID().uuidString.lowercased()
    _ = try await host.receive(client.seal(body: attempt(id), purpose: "authenticate"))
    await assertThrowsAsync(try await host.receive(client.seal(body: attempt(id, password: "different-invalid-test"), purpose: "authenticate")))
    XCTAssertEqual(executions, 1)
    XCTAssertNil(host.authenticationSession)
    await assertThrowsAsync(try await host.receive(client.seal(body: Data(), purpose: "request")))
  }

  func testReconnectCannotResetHostAttemptLimit() async throws {
    var uptime: TimeInterval = 0, executions = 0
    let limiter = CredentialAttemptLimiter(uptime: { uptime })
    for _ in 0..<5 {
      let (client, host) = try await pair(limiter: limiter) { _ in executions += 1; throw CredentialError.invalidIdentity }
      _ = try await host.receive(client.seal(body: attempt(), purpose: "authenticate"))
      host.close()
    }
    let (client, host) = try await pair(limiter: limiter) { _ in executions += 1 }
    await assertThrowsAsync(try await host.receive(client.seal(body: attempt(), purpose: "authenticate")))
    XCTAssertEqual(executions, 5)
    uptime = 60
    _ = try await host.receive(client.seal(body: attempt(), purpose: "authenticate"))
    XCTAssertEqual(executions, 6)
    XCTAssertNotNil(host.authenticationSession)
  }

  func testCloseDuringVerificationCannotAuthorizeOrReply() async throws {
    var continuation: CheckedContinuation<Void, Never>?
    var executions = 0
    let (client, host) = try await pair { _ in
      executions += 1
      await withCheckedContinuation { continuation = $0 }
    }
    let packet = try client.seal(body: attempt(), purpose: "authenticate")
    let pending = Task { try await host.receive(packet) }
    while continuation == nil { await Task.yield() }
    await assertThrowsAsync(try await host.receive(client.seal(body: attempt(), purpose: "authenticate")))
    host.close()
    continuation?.resume()
    await assertThrowsAsync(try await pending.value)
    XCTAssertEqual(executions, 1)
    XCTAssertNil(host.authenticationSession)
  }

  func testPermissionFailureIsNotReportedAsWrongPassword() async throws {
    let (client, host) = try await pair { _ in throw CredentialError.accessibilityRequired }
    guard case .reply(let packet) = try await host.receive(client.seal(body: attempt(), purpose: "authenticate")) else {
      return XCTFail("Expected encrypted failure")
    }
    let result = try JSONDecoder().decode(AuthenticationResult.self, from: client.open(packet).body)
    XCTAssertFalse(result.accepted)
    XCTAssertEqual(result.failure, .accessibilityRequired)
    XCTAssertNil(host.authenticationSession)
  }

}
