#if os(macOS)
import ApplicationServices
import XCTest
@testable import CindyRemoteCredentials

@MainActor final class MacUnlockProfileTests: XCTestCase {
  private func node(_ parent: Int?, _ role: String, _ identifier: String = "", subrole: String = "",
    matches: Bool = false, enabled: Bool = true, writable: Bool = false, press: Bool = false) -> MacUnlockProfile.Node {
    .init(parent: parent, role: role, subrole: subrole, identifier: identifier,
      enabled: enabled, writable: writable, press: press, matchesAccount: matches)
  }
  private var valid: [MacUnlockProfile.Node] {
    [node(nil, "AXWindow", "login"), node(0, "AXGroup"),
      node(1, "AXStaticText", "FocusedUser", matches: true),
      node(1, "AXTextField", "UserPasswordTextField", subrole: "AXSecureTextField", writable: true),
      node(1, "AXButton", "LUIBUTTON_GO", press: true)]
  }
  func testSelectsOnlyKnownSecureProfile() throws {
    XCTAssertEqual(try MacUnlockProfile.select(valid), .init(field: 3, submit: 4, label: 2))
  }
  func testSelectsUniqueSurfaceAcrossDisplaysRegardlessOfOrder() throws {
    let empty = [node(nil, "AXWindow", "login")]
    XCTAssertEqual(try MacUnlockProfile.selectWindow([valid]), 0)
    XCTAssertEqual(try MacUnlockProfile.selectWindow([empty, valid]), 1)
    XCTAssertEqual(try MacUnlockProfile.selectWindow([valid, empty]), 0)
    let collapsed = [node(nil, "AXWindow", "login"), node(0, "AXStaticText", "FocusedUser", matches: true)]
    XCTAssertEqual(try MacUnlockProfile.selectWindow([empty, collapsed]), 1)
    // A button need not exist yet; selection must survive its later appearance.
    XCTAssertEqual(try MacUnlockProfile.selectWindow([empty, Array(valid.dropLast())]), 1)
  }
  func testRejectsAmbiguousOrUnavailableDisplaySurfaces() {
    let empty = [node(nil, "AXWindow", "login")]
    let collapsed = [node(nil, "AXWindow", "login"), node(0, "AXStaticText", "FocusedUser", matches: true)]
    for windows in [[], [empty], [empty, empty], [valid, valid], [collapsed, collapsed], [valid, collapsed]] {
      XCTAssertThrowsError(try MacUnlockProfile.selectWindow(windows))
    }
  }
  func testOtherWindowsCannotHideUnsafeFlows() {
    var otherAccount = valid
    otherAccount[2] = node(1, "AXStaticText", "FocusedUser", matches: false)
    let unsafe = [otherAccount, [node(nil, "AXWindow", "keychain")],
      [node(nil, "AXWindow", "login", subrole: "AXDialog")],
      [node(nil, "AXWindow", "login"), node(0, "AXTextField", "unknown")],
      [node(nil, "AXWindow", "login"), node(0, "AXList")]]
    for sibling in unsafe {
      XCTAssertThrowsError(try MacUnlockProfile.selectWindow([valid, sibling]))
      XCTAssertThrowsError(try MacUnlockProfile.selectWindow([sibling, valid]))
    }
  }
  func testFlatLayoutDoesNotRequireSubmitBeforeWriting() throws {
    let field = [node(nil, "AXWindow", "login"),
      node(0, "AXStaticText", "FocusedUser", matches: true),
      node(0, "AXTextField", "UserPasswordTextField", subrole: "AXSecureTextField", writable: true)]
    XCTAssertEqual(try MacUnlockProfile.selectField(field), .init(field: 2, label: 1))
    XCTAssertThrowsError(try MacUnlockProfile.select(field))
    let ready = field + [node(0, "AXButton", "LUIBUTTON_GO", press: true)]
    XCTAssertEqual(try MacUnlockProfile.select(ready), .init(field: 2, submit: 3, label: 1))
    let disabled = field + [node(0, "AXButton", "LUIBUTTON_GO", enabled: false, press: true)]
    XCTAssertNoThrow(try MacUnlockProfile.selectField(disabled))
    XCTAssertThrowsError(try MacUnlockProfile.select(disabled))
    XCTAssertThrowsError(try MacUnlockProfile.selectField(ready + [ready[3]]))
  }
  func testExpandedFieldMayReplaceAccountLabel() throws {
    let expanded = [node(nil, "AXWindow", "login"),
      node(0, "AXTextField", "UserPasswordTextField", subrole: "AXSecureTextField", writable: true),
      node(0, "AXButton", "LUIBUTTON_GO", press: true)]
    XCTAssertEqual(try MacUnlockProfile.select(expanded), .init(field: 1, submit: 2, label: nil))
    XCTAssertThrowsError(try MacUnlockProfile.presentationLabel(expanded))
    XCTAssertThrowsError(try MacUnlockProfile.select(expanded + [node(0, "AXStaticText", "FocusedUser", matches: false)]))
  }
  func testPresentationRequiresOwnAccountAndNoPasswordField() throws {
    let collapsed = [node(nil, "AXWindow", "login"), node(0, "AXStaticText", "FocusedUser", matches: true)]
    XCTAssertEqual(try MacUnlockProfile.presentationLabel(collapsed), 1)
    XCTAssertThrowsError(try MacUnlockProfile.presentationLabel(valid))
    for id in ["ResetPasswordTitle", "ResetUsingRecoveryButton"] {
      // Passive recovery help beside the normal secure login field is not a recovery dialog.
      XCTAssertNoThrow(try MacUnlockProfile.selectField(valid + [node(0, "AXButton", id)]))
      XCTAssertEqual(try MacUnlockProfile.select(valid + [node(0, "AXButton", id)]).submit, 4)
      XCTAssertThrowsError(try MacUnlockProfile.selectField([node(nil, "AXWindow", "login"), node(0, "AXButton", id)]))
      XCTAssertThrowsError(try MacUnlockProfile.presentationLabel(collapsed + [node(0, "AXButton", id)]))
    }
  }
  func testRejectsOtherUserAndUnknownPasswordOrWindow() {
    var nodes = valid
    nodes[2] = node(1, "AXStaticText", "FocusedUser", matches: false)
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
    nodes = valid; nodes[3] = node(1, "AXTextField", "other", subrole: "AXSecureTextField", writable: true)
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
    nodes = valid; nodes[0] = node(nil, "AXWindow", "keychain")
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
  }
  func testRejectsUsernameEntrySelectionAndModalFlows() {
    for role in ["AXTextField", "AXList", "AXTable", "AXSheet", "AXComboBox"] {
      XCTAssertThrowsError(try MacUnlockProfile.select(valid + [node(1, role)]))
    }
    var nodes = valid; nodes[0] = node(nil, "AXWindow", "login", subrole: "AXDialog")
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
  }
  func testRejectsDuplicateOrNonSecureFieldsAndUnrelatedSubmit() {
    XCTAssertThrowsError(try MacUnlockProfile.select(valid + [valid[3]]))
    var nodes = valid
    nodes[3] = node(1, "AXTextField", "UserPasswordTextField", writable: true)
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
    nodes = valid; nodes[4] = node(0, "AXButton", "LUIBUTTON_GO", press: true)
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
    nodes = valid; nodes[4] = node(1, "AXButton", "LUIBUTTON_GO", enabled: false, press: true)
    XCTAssertThrowsError(try MacUnlockProfile.select(nodes))
  }

  // 生产入口 MacUnlockSubmission.run；保护真实解锁的单次提交/取消/失败阶段。
  // 原有测试只覆盖静态选择与遍历；这里用假 AX 对象和单调时钟，不访问锁屏或密码。
  // 最小输入：写入后按钮瞬态缺失、最终复验失败/取消、cannotComplete、等待超时。tier: unit。
  func testSubmitOnceWithTrace() async throws {
    let h = SubmissionHarness(valid: valid)
    try await h.run()
    XCTAssertEqual(h.writes, 1)
    XCTAssertEqual(h.presses, 1)
    XCTAssertTrue(h.events.contains("finalCheck:success"))
    XCTAssertTrue(h.events.contains("press:success"))
    XCTAssertTrue(h.events.contains("wait:success"))
  }
  func testFinalCheckFailureNoPress() async {
    for mode in 0...2 {
      let h = SubmissionHarness(valid: valid)
      if mode == 0 { h.currentErrorAt = 5 }
      if mode == 1 { h.validateErrorAt = 3 }
      if mode == 2 { h.finalElements = [0, 1, 2, 3, 99] }
      do {
        try await h.run()
        XCTFail("expected final check to fail")
      } catch {}
      XCTAssertEqual(h.writes, 1)
      XCTAssertEqual(h.presses, 0)
      XCTAssertTrue(h.events.contains(mode == 0 ? "finalCheck:cancelled" : "finalCheck:failed"))
    }
  }
  func testCannotCompleteNoRepress() async throws {
    let h = SubmissionHarness(valid: valid)
    h.pressStatus = .cannotComplete
    try await h.run()
    XCTAssertEqual(h.presses, 1)
    XCTAssertTrue(h.events.contains("press:cannotComplete"))
    XCTAssertTrue(h.events.contains("wait:success"))
  }
  func testWaitTimeoutNoRepress() async {
    let h = SubmissionHarness(valid: valid)
    h.unlockOnPress = false
    do {
      try await h.run()
      XCTFail("expected unlock timeout")
    } catch {}
    XCTAssertEqual(h.presses, 1)
    XCTAssertTrue(h.events.contains("wait:failed"))
  }
  func testCancelAfterPressNoRepress() async {
    let h = SubmissionHarness(valid: valid)
    h.currentErrorAt = 6
    do {
      try await h.run()
      XCTFail("expected cancellation while waiting")
    } catch {}
    XCTAssertEqual(h.presses, 1)
    XCTAssertTrue(h.events.contains("wait:cancelled"))
  }
  func testMissingButtonNoPress() async {
    let h = SubmissionHarness(valid: valid)
    h.snapshots = [Array(valid.dropLast()), Array(valid.dropLast())]
    do {
      try await h.run()
      XCTFail("expected submit button timeout")
    } catch {}
    XCTAssertEqual(h.writes, 1)
    XCTAssertEqual(h.presses, 0)
    XCTAssertTrue(h.events.contains("button:failed"))
  }
}

@MainActor
private final class SubmissionHarness {
  var snapshots: [[MacUnlockProfile.Node]]
  var elements: [[Int]]
  var finalElements: [Int]?
  var currentErrorAt: Int?
  var validateErrorAt: Int?
  var pressStatus = AXError.success
  var unlockOnPress = true
  var writes = 0, presses = 0, currentCalls = 0, validateCalls = 0
  var time = 0.0
  var unlocked = false
  var events: [String] = []
  init(valid: [MacUnlockProfile.Node]) {
    let fieldOnly = Array(valid.dropLast())
    let nodes = [fieldOnly, fieldOnly, valid, valid]
    snapshots = nodes
    elements = nodes.indices.map { Array(0..<nodes[$0].count) }
  }
  func run() async throws {
    try await MacUnlockSubmission.run(
      field: 3,
      current: {
        currentCalls += 1
        if currentCalls == currentErrorAt { throw CredentialError.cancelled }
      },
      validate: {
        let call = validateCalls
        validateCalls += 1
        if call == validateErrorAt { throw CredentialError.unlockUnavailable }
        let index = min(call, snapshots.count - 1)
        if call == 3, let finalElements { return (finalElements, snapshots[index]) }
        return (elements[index], snapshots[index])
      },
      same: ==,
      write: { _ in writes += 1; return .success },
      press: { _ in presses += 1; unlocked = unlockOnPress; return pressStatus },
      unlocked: { unlocked },
      record: { stage, result in events.append("\(stage.rawValue):\(result.rawValue)") },
      now: { time },
      sleep: { time += Double($0) / 1_000_000_000 }
    )
  }
}
#endif
