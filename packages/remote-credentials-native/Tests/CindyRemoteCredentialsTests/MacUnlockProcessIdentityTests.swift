#if os(macOS)
import XCTest
@testable import CindyRemoteCredentials

final class MacUnlockProcessIdentityTests: XCTestCase {
  func testKernelIdentityIsStableForCurrentProcessWithoutWorkspaceMetadata() throws {
    let first = try MacUnlockProcessIdentity.read(pid: getpid(), uid: getuid())
    let second = try MacUnlockProcessIdentity.read(pid: getpid(), uid: getuid())
    XCTAssertEqual(first, second)
    XCTAssertGreaterThan(first.seconds, 0)
  }
  func testDifferentOwnerOrMissingProcessCannotMatch() {
    XCTAssertThrowsError(try MacUnlockProcessIdentity.read(pid: getpid(), uid: getuid() == 0 ? 1 : 0))
    XCTAssertThrowsError(try MacUnlockProcessIdentity.read(pid: -1, uid: getuid()))
  }
}
#endif
