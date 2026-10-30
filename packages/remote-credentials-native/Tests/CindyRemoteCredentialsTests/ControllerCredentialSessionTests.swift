import XCTest
@testable import CindyRemoteCredentials

@MainActor final class ControllerCredentialSessionTests: XCTestCase {
  private func pair(saveAfterVerification: Bool = false, save: @escaping (Data, CredentialAccount) throws -> Void,
    verify: @escaping (Data) throws -> Void = { _ in }) async throws -> (ControllerCredentialSession, HostCredentialSession) {
    let time = Date(), aKey = try IdentityKey.ephemeral(), bKey = try IdentityKey.ephemeral()
    let a = ChannelIdentity(id: UUID().uuidString.lowercased(), membershipId: "test",
      publicKey: aKey.publicKey, realm: .global, checkedAt: time)
    let b = ChannelIdentity(id: UUID().uuidString.lowercased(), membershipId: "test",
      publicKey: bKey.publicKey, realm: .global, checkedAt: time)
    let left = try NativeChannel(local: a, remote: b, key: aKey)
    let right = try NativeChannel(local: b, remote: a, key: bKey)
    try left.accept(offer: right.offer()); try right.accept(offer: left.offer())
    let client = ControllerCredentialSession(channel: left, saveAfterVerification: saveAfterVerification, save: save)
    let host = HostCredentialSession(channel: right,
      account: CredentialAccount(recordID: UUID().uuidString.lowercased(), name: "test-user"),
      limiter: CredentialAttemptLimiter(), verify: verify)
    XCTAssertThrowsError(try client.authenticate(password: Data("invalid-test".utf8), remember: true))
    guard case .reply(let ready) = try await host.receive(client.ready()) else { throw CredentialError.invalidMessage }
    _ = try client.receive(ready)
    return (client, host)
  }

  private func authenticate(_ client: ControllerCredentialSession, _ host: HostCredentialSession, remember: Bool = true) async throws {
    guard case .reply(let result) = try await host.receive(client.authenticate(password: Data("invalid-test".utf8), remember: remember)) else {
      throw CredentialError.invalidMessage
    }
    _ = try client.receive(result)
  }

  private func start(_ client: ControllerCredentialSession, _ host: HostCredentialSession, success: Bool) async throws -> ControllerCredentialSession.Received {
    let request = try client.request(JSONSerialization.data(withJSONObject: ["op": "start", "displayId": "test-display"]))
    guard case .command(let id, _) = try await host.receive(request.ciphertext) else { throw CredentialError.invalidMessage }
    let result = try JSONSerialization.data(withJSONObject: ["lease": "test-lease", "display": [:], "controlling": false])
    return try client.receive(host.response(id: id, body: result, success: success))
  }

  func testSavesOnlyAfterAuthenticatedPasswordAndSuccessfulConnection() async throws {
    var saves = 0
    let (client, host) = try await pair(save: { secret, _ in
      XCTAssertEqual(secret, Data("invalid-test".utf8)); saves += 1
    })
    XCTAssertThrowsError(try client.request(Data("{\"op\":\"start\"}".utf8)))
    try await authenticate(client, host)
    XCTAssertEqual(saves, 0)
    _ = try await start(client, host, success: false)
    XCTAssertEqual(saves, 0)
    guard case .response(_, _, _, let saved) = try await start(client, host, success: true) else { return XCTFail() }
    XCTAssertTrue(saved)
    XCTAssertEqual(saves, 1)
    _ = try await start(client, host, success: true)
    XCTAssertEqual(saves, 1)
  }

  func testSettingsSaveRequiresVerifiedPasswordButNoDesktopLease() async throws {
    var saves = 0
    let (client, host) = try await pair(saveAfterVerification: true, save: { _, _ in saves += 1 })
    XCTAssertEqual(saves, 0)
    try await authenticate(client, host)
    XCTAssertEqual(saves, 1)
    client.close()
    XCTAssertEqual(saves, 1)
    let (rejected, rejectingHost) = try await pair(saveAfterVerification: true,
      save: { _, _ in saves += 1 }, verify: { _ in throw CredentialError.invalidIdentity })
    try await authenticate(rejected, rejectingHost)
    XCTAssertEqual(saves, 1)
  }

  func testSettingsStorageFailureDoesNotReportSuccessfulSetup() async throws {
    let (client, host) = try await pair(saveAfterVerification: true, save: { _, _ in throw CredentialError.unavailable })
    await assertThrowsAsync(try await authenticate(client, host))
  }

  func testFailedPasswordNeverAllowsDesktopOrSaving() async throws {
    var saves = 0
    let (client, host) = try await pair(save: { _, _ in saves += 1 }, verify: { _ in throw CredentialError.invalidIdentity })
    try await authenticate(client, host)
    await assertThrowsAsync(try await start(client, host, success: true))
    XCTAssertEqual(saves, 0)
  }

  func testRememberIsOptionalAndCloseDiscardsPendingPassword() async throws {
    var saves = 0
    let (client, host) = try await pair(save: { _, _ in saves += 1 })
    try await authenticate(client, host, remember: false)
    _ = try await start(client, host, success: true)
    XCTAssertEqual(saves, 0)
    let (second, otherHost) = try await pair(save: { _, _ in saves += 1 })
    try await authenticate(second, otherHost)
    second.close()
    await assertThrowsAsync(try await start(second, otherHost, success: true))
    XCTAssertEqual(saves, 0)
  }

  func testQueryRecoversLostAuthenticationWithoutReverification() async throws {
    var attempts = 0
    let (client, host) = try await pair(save: { _, _ in }, verify: { _ in attempts += 1 })
    _ = try await host.receive(client.authenticate(password: Data("invalid-test".utf8), remember: false))
    guard case .reply(let result) = try await host.receive(client.authenticationStatus()) else { return XCTFail() }
    _ = try client.receive(result)
    _ = try await start(client, host, success: true)
    XCTAssertEqual(attempts, 1)
  }
  func testAbandonedRequestsDoNotExhaustSessionAndLateRepliesCannotSave() async throws {
    var saves = 0
    let (client, host) = try await pair(save: { _, _ in saves += 1 })
    try await authenticate(client, host)
    for _ in 0..<80 {
      let request = try client.request(Data("{\"op\":\"start\"}".utf8))
      guard case .command(let id, _) = try await host.receive(request.ciphertext) else { return XCTFail() }
      client.abandonRequest(id)
      let body = Data("{\"lease\":\"test\",\"display\":{},\"controlling\":false}".utf8)
      guard case .ignored = try client.receive(host.response(id: id, body: body, success: true)) else { return XCTFail() }
    }
    XCTAssertEqual(saves, 0)
    _ = try await start(client, host, success: true)
    XCTAssertEqual(saves, 1)
  }

}
