import XCTest
@testable import CindyRemoteCredentials

final class NativeChannelTests: XCTestCase {
  private func identity(_ key: IdentityKey, _ at: Date, membership: String = "test-membership") -> ChannelIdentity {
    ChannelIdentity(id: UUID().uuidString.lowercased(), membershipId: membership,
      publicKey: key.publicKey, realm: .global, checkedAt: at)
  }

  func testBidirectionalSessionRejectsReplayAndAcceptsBoundedOutOfOrderDelivery() throws {
    let time = Date(), aKey = try IdentityKey.ephemeral(), bKey = try IdentityKey.ephemeral()
    let a = identity(aKey, time), b = identity(bKey, time)
    let left = try NativeChannel(local: a, remote: b, key: aKey, now: { time })
    let right = try NativeChannel(local: b, remote: a, key: bKey, now: { time })
    try left.accept(offer: right.offer()); try right.accept(offer: left.offer())
    XCTAssertThrowsError(try left.seal(body: Data("invalid-test-password".utf8), purpose: "authenticate"))
    _ = try right.open(left.seal(body: Data(), purpose: "ready"))
    _ = try left.open(right.seal(body: Data(), purpose: "ready"))
    let first = try left.seal(body: Data("first".utf8), purpose: "request")
    let second = try left.seal(body: Data("second".utf8), purpose: "request")
    XCTAssertEqual(try right.open(second).body, Data("second".utf8))
    XCTAssertEqual(try right.open(first).body, Data("first".utf8))
    XCTAssertThrowsError(try right.open(first))
    let response = try right.seal(body: Data("response".utf8), purpose: "response")
    XCTAssertEqual(try left.open(response).body, Data("response".utf8))
    XCTAssertThrowsError(try right.open(response))
    left.close()
    XCTAssertThrowsError(try left.open(response))
    XCTAssertThrowsError(try left.seal(body: Data(), purpose: "request"))
  }

  func testOldPeerOfferCannotReplayPacketsIntoNewSession() throws {
    let time = Date(), aKey = try IdentityKey.ephemeral(), bKey = try IdentityKey.ephemeral()
    let a = identity(aKey, time), b = identity(bKey, time)
    let left = try NativeChannel(local: a, remote: b, key: aKey, now: { time })
    let right = try NativeChannel(local: b, remote: a, key: bKey, now: { time })
    let oldOffer = try right.offer()
    try left.accept(offer: oldOffer); try right.accept(offer: left.offer())
    let oldPacket = try right.seal(body: Data("test-only".utf8), purpose: "ready")
    let fresh = try NativeChannel(local: a, remote: b, key: aKey, now: { time })
    try fresh.accept(offer: oldOffer)
    XCTAssertFalse(fresh.peerConfirmed)
    XCTAssertThrowsError(try fresh.seal(body: Data("invalid-test-password".utf8), purpose: "authenticate"))
    XCTAssertThrowsError(try fresh.open(oldPacket))
    XCTAssertThrowsError(try fresh.accept(offer: oldOffer))
  }

  func testDirectoryFreshnessAccountAndKeyAreRequired() throws {
    let time = Date(), aKey = try IdentityKey.ephemeral(), bKey = try IdentityKey.ephemeral()
    let a = identity(aKey, time)
    XCTAssertThrowsError(try NativeChannel(local: a, remote: identity(bKey, time, membership: "other"), key: aKey, now: { time }))
    XCTAssertThrowsError(try NativeChannel(local: a, remote: identity(bKey, time.addingTimeInterval(-31)), key: aKey, now: { time }))
    XCTAssertThrowsError(try NativeChannel(local: a, remote: identity(bKey, time), key: bKey, now: { time }))
  }

  func testHandshakeAndSessionExpireIndependentlyOfTraffic() throws {
    var time = Date()
    let aKey = try IdentityKey.ephemeral(), bKey = try IdentityKey.ephemeral()
    let a = identity(aKey, time), b = identity(bKey, time)
    let left = try NativeChannel(local: a, remote: b, key: aKey, now: { time })
    let right = try NativeChannel(local: b, remote: a, key: bKey, now: { time })
    try left.accept(offer: right.offer()); try right.accept(offer: left.offer())
    let lateLeft = try NativeChannel(local: a, remote: b, key: aKey, now: { time })
    let lateRight = try NativeChannel(local: b, remote: a, key: bKey, now: { time })
    let lateOffer = try lateLeft.offer()
    time.addTimeInterval(1800)
    XCTAssertThrowsError(try left.seal(body: Data(), purpose: "request"))
    time = a.checkedAt.addingTimeInterval(61)
    XCTAssertThrowsError(try lateRight.accept(offer: lateOffer))
  }
}
