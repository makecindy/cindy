import XCTest
@testable import CindyRemoteCredentials

final class CredentialForegroundGateTests: XCTestCase {
  @MainActor func testCompletedBiometricsMayContinueWhileForegroundOverlayIsInactive() throws {
    XCTAssertNoThrow(try CredentialForegroundGate.require(isCurrent: true, state: .inactive))
    XCTAssertNoThrow(try CredentialForegroundGate.require(isCurrent: true, state: .active))
  }
  @MainActor func testBackgroundNeverContinues() {
    XCTAssertThrowsError(try CredentialForegroundGate.require(isCurrent: true, state: .background)) {
      XCTAssertEqual($0 as? CredentialError, .cancelled)
    }
  }
  @MainActor func testChangedOwnerOrSessionCannotContinueEvenInForeground() {
    for state in [CredentialForegroundGate.State.active, .inactive, .background] {
      XCTAssertThrowsError(try CredentialForegroundGate.require(isCurrent: false, state: state)) {
        XCTAssertEqual($0 as? CredentialError, .cancelled)
      }
    }
  }
}
