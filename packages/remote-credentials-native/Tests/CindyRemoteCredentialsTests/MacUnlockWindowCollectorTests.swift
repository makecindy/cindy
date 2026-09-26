#if os(macOS)
import XCTest
@testable import CindyRemoteCredentials

final class MacUnlockWindowCollectorTests: XCTestCase {
  private func node(_ id: Int, _ parent: Int?) -> MacUnlockProfile.Node {
    let window = parent == nil
    let field = id == 12
    return .init(parent: parent, role: window ? "AXWindow" : field ? "AXTextField" : "AXGroup",
      subrole: field ? "AXSecureTextField" : "", identifier: window ? "login" : field ? "UserPasswordTextField" : "",
      enabled: true, writable: field, press: false, matchesAccount: false)
  }
  private func children(_ id: Int) -> [Int] {
    id == 10 ? [11] : id == 11 ? [12] : []
  }
  func testMapsSelectedObjectsAndResetsParentIndicesAcrossWindowOrder() throws {
    for windows in [[0, 10], [10, 0]] {
      let result = try MacUnlockWindowCollector.collect(windows: windows, equal: ==, read: node, children: children)
      XCTAssertEqual(result.elements, [10, 11, 12])
      XCTAssertEqual(result.nodes.map { $0.parent }, [nil, 0, 1])
      let selection = try MacUnlockProfile.selectField(result.nodes)
      XCTAssertEqual(result.elements[selection.field], 12)
    }
  }
  func testNodeBudgetIsSharedAcrossWindows() {
    var reads = 0
    func wideChildren(_ id: Int) -> [Int] {
      if id == 0 { return Array(1...150) }
      if id == 1000 { return Array(1001...1150) }
      return []
    }
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [0, 1000], equal: ==,
      read: { id, parent in reads += 1; return self.node(id, parent) },
      children: wideChildren))
    XCTAssertEqual(reads, 256)
  }
  func testCleanupRetainsOriginalObjectsWhenSiblingBecomesActionable() throws {
    func read(_ id: Int, _ parent: Int?) -> MacUnlockProfile.Node {
      node(id == 22 ? 12 : id, parent)
    }
    func expandedChildren(_ id: Int) -> [Int] {
      if id == 20 { return [22] }
      return children(id)
    }
    let original = try MacUnlockWindowCollector.collect(windows: [0, 10], equal: ==, read: read, children: children)
    let originalField = original.elements[try MacUnlockProfile.selectField(original.nodes).field]
    // Submission must abort once a second actionable surface appears.
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [20, 10], equal: ==,
      read: read, children: expandedChildren))
    let cleanup = try MacUnlockWindowCollector.collect(windows: [20, 10], cleanupWindow: original.elements[0],
      equal: ==, read: read, children: expandedChildren)
    XCTAssertEqual(cleanup.elements[try MacUnlockProfile.selectField(cleanup.nodes).field], originalField)
    XCTAssertEqual(cleanup.elements, [10, 11, 12])
  }
  func testCleanupDoesNotReadBrokenSiblingOrFallBackToReplacementWindow() throws {
    let cleanup = try MacUnlockWindowCollector.collect(windows: [0, 10], cleanupWindow: 10, equal: ==,
      read: { id, parent in
        if id == 0 { throw CredentialError.unlockUnavailable }
        return self.node(id, parent)
      }, children: children)
    XCTAssertEqual(cleanup.elements, [10, 11, 12])
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [10], cleanupWindow: 99,
      equal: ==, read: node, children: children))
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [10, 10], cleanupWindow: 10,
      equal: ==, read: node, children: children))
  }
  func testCleanupStillRejectsAnInvalidOriginalSecureField() {
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [0, 10], cleanupWindow: 10,
      equal: ==, read: { id, parent in self.node(id == 12 ? 99 : id, parent) }, children: children))
  }
  func testTimeBudgetIsNotResetForSecondWindow() {
    var time = 0.0
    var reads: [Int] = []
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [0, 10], now: { time }, equal: ==,
      read: { id, parent in
        reads.append(id)
        time += 1.1
        return self.node(id, parent)
      }, children: children))
    XCTAssertEqual(reads, [0, 10]) // The second window's children never get a fresh budget.
  }
  func testFinalReadCannotOverrunDeadlineUnnoticed() {
    var time = 0.0
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [0, 10], now: { time }, equal: ==,
      read: node, children: { id in
        if id == 12 { time = 2 }
        return self.children(id)
      }))
  }
  func testDuplicateObjectsAndReadFailuresInSiblingsFailClosed() {
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [10, 10], equal: ==, read: node, children: children))
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [10, 0], equal: ==,
      read: { id, parent in
        if id == 0 { throw CredentialError.unlockUnavailable }
        return self.node(id, parent)
      }, children: children))
  }
  func testWindowAndDepthLimitsRemainBounded() {
    var reads = 0
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: Array(0...16), equal: ==,
      read: { id, parent in reads += 1; return self.node(id, parent) }, children: children))
    XCTAssertEqual(reads, 0)
    XCTAssertThrowsError(try MacUnlockWindowCollector.collect(windows: [0], equal: ==,
      read: { id, parent in reads += 1; return self.node(id, parent) }, children: { [$0 + 1] }))
    XCTAssertEqual(reads, 13)
  }
}
#endif
