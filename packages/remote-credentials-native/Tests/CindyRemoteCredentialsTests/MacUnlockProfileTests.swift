#if os(macOS)
import XCTest
@testable import CindyRemoteCredentials

final class MacUnlockProfileTests: XCTestCase {
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
}
#endif
