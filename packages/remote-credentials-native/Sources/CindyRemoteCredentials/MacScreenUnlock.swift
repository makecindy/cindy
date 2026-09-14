#if os(macOS)
import AppKit
import ApplicationServices
import Foundation
import IOKit.pwr_mgt
import Security
import SystemConfiguration

/// Only an already logged-in, foreground session owned by this helper is eligible.
struct MacConsoleState {
  let locked: Bool
  static func read(account: MacSystemAccount) throws -> Self {
    guard try MacSystemAccount.current() == account else { throw CredentialError.invalidIdentity }
    var uid: uid_t = 0, gid: gid_t = 0
    guard SCDynamicStoreCopyConsoleUser(nil, &uid, &gid) != nil, uid == account.uid,
      let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == account.uid,
      session[kCGSessionOnConsoleKey as String] as? Bool == true,
      session[kCGSessionLoginDoneKey as String] as? Bool == true else { throw CredentialError.invalidIdentity }
    return Self(locked: session["CGSSessionScreenIsLocked"] as? Bool ?? false)
  }
}

/// The identifiers are evidenced in Apple's LoginUIKit implementation. Unknown
/// layouts deliberately fail rather than falling back to focused/global input.
struct MacUnlockProfile {
  struct Node {
    let parent: Int?
    let role: String
    let subrole: String
    let identifier: String
    let enabled: Bool
    let writable: Bool
    let press: Bool
    let matchesAccount: Bool
  }
  struct Selection: Equatable { let field: Int; let submit: Int; let label: Int? }
  struct FieldSelection: Equatable { let field: Int; let label: Int? }
  private static func accountLabel(_ nodes: [Node]) throws -> Int? {
    guard nodes.first?.identifier == "login", nodes.first?.role == kAXWindowRole,
      !nodes.contains(where: { [kAXSheetRole, kAXListRole, kAXTableRole, kAXOutlineRole, kAXComboBoxRole, kAXPopUpButtonRole].contains($0.role)
        || $0.subrole == kAXDialogSubrole || $0.subrole == kAXSystemDialogSubrole }) else { throw CredentialError.unlockUnavailable }
    let labels = nodes.indices.filter { nodes[$0].identifier == "FocusedUser" }
    // Modern lock screens replace the account label with the password field.
    // collect() independently binds the console UID and Apple loginwindow PID.
    guard labels.count <= 1 else { throw CredentialError.unlockUnavailable }
    guard let label = labels.first else { return nil }
    guard nodes[label].role == kAXStaticTextRole, nodes[label].matchesAccount else { throw CredentialError.unlockUnavailable }
    return label
  }
  static func presentationLabel(_ nodes: [Node]) throws -> Int {
    guard let label = try accountLabel(nodes),
      !nodes.contains(where: { $0.role == kAXTextFieldRole || ["ResetPasswordTitle", "ResetUsingRecoveryButton"].contains($0.identifier) }) else { throw CredentialError.unlockUnavailable }
    return label
  }
  static func selectField(_ nodes: [Node]) throws -> FieldSelection {
    let label = try accountLabel(nodes)
    guard nodes.filter({ $0.role == kAXTextFieldRole }).count == 1 else { throw CredentialError.unlockUnavailable }
    let fields = nodes.indices.filter { nodes[$0].identifier == "UserPasswordTextField" }
    let buttons = nodes.indices.filter { nodes[$0].identifier == "LUIBUTTON_GO" }
    guard fields.count == 1, buttons.count <= 1 else { throw CredentialError.unlockUnavailable }
    let field = fields[0]
    guard nodes[field].role == kAXTextFieldRole, nodes[field].subrole == kAXSecureTextFieldSubrole,
      nodes[field].enabled, nodes[field].writable, let parent = nodes[field].parent,
      nodes.indices.contains(parent) else { throw CredentialError.unlockUnavailable }
    if let button = buttons.first {
      guard nodes[button].role == kAXButtonRole, nodes[button].parent == parent else { throw CredentialError.unlockUnavailable }
    }
    return FieldSelection(field: field, label: label)
  }
  static func select(_ nodes: [Node]) throws -> Selection {
    let field = try selectField(nodes)
    let buttons = nodes.indices.filter { nodes[$0].identifier == "LUIBUTTON_GO" }
    guard buttons.count == 1 else { throw CredentialError.unlockUnavailable }
    let button = buttons[0]
    guard
      nodes[button].role == kAXButtonRole, nodes[button].enabled, nodes[button].press,
      nodes[button].parent == nodes[field.field].parent else { throw CredentialError.unlockUnavailable }
    return Selection(field: field.field, submit: button, label: field.label)
  }
}

/// Kernel start time is available for loginwindow even when NSWorkspace has no
/// launchDate. Bind PID reuse checks to the same OS process and owning user.
struct MacUnlockProcessIdentity: Equatable {
  let pid: pid_t
  let uid: uid_t
  let seconds: UInt64
  let microseconds: UInt64

  static func read(pid: pid_t, uid: uid_t) throws -> Self {
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
      info.pbi_uid == uid, info.pbi_start_tvsec > 0 else { throw CredentialError.invalidIdentity }
    return Self(pid: pid, uid: uid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
  }
}

@MainActor
final class MacScreenUnlocker {
  static let shared = MacScreenUnlocker()
  private var busy = false
  private let path = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"
  private struct Target {
    let application: NSRunningApplication
    let launch: MacUnlockProcessIdentity
    let code: SecCode
    let elements: [AXUIElement]
    let nodes: [MacUnlockProfile.Node]
    let selection: MacUnlockProfile.FieldSelection
  }
  private typealias Snapshot = (application: NSRunningApplication, launch: MacUnlockProcessIdentity, code: SecCode,
    elements: [AXUIElement], nodes: [MacUnlockProfile.Node])

  func unlock(account: MacSystemAccount, password: Data, current: () async throws -> Void) async throws {
    guard !busy else { throw CredentialError.unlockUnavailable }
    busy = true; defer { busy = false }
    try await current()
    guard try MacConsoleState.read(account: account).locked else { return }
    guard let text = String(data: password, encoding: .utf8), !password.isEmpty else { throw CredentialError.invalidMessage }
    var activity: IOPMAssertionID = 0
    guard IOPMAssertionDeclareUserActivity("Cindy remote desktop unlock" as CFString, kIOPMUserActiveRemote, &activity) == kIOReturnSuccess else {
      throw CredentialError.unlockUnavailable
    }
    defer { IOPMAssertionRelease(activity) }
    let target = try await prepare(account: account, current: current)
    let field = target.elements[target.selection.field]
    var wrote = false
    defer {
      // Clear only the same still-verified secure object; never chase new focus.
      if wrote, (try? validate(target, account: account)) != nil {
        _ = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, "" as CFString)
      }
    }
    try await current()
    _ = try validate(target, account: account)
    wrote = true
    guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, text as CFString) == .success else {
      throw CredentialError.unlockUnavailable
    }
    try await current()
    // The submit button is created/enabled only after text is inserted on
    // modern loginwindow. Wait for it while retaining the original field.
    var submission: Snapshot?
    let submitDeadline = ProcessInfo.processInfo.systemUptime + 2
    while ProcessInfo.processInfo.systemUptime < submitDeadline {
      try await current()
      let next = try validate(target, account: account)
      if (try? MacUnlockProfile.select(next.nodes)) != nil { submission = next; break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    guard let submission else { throw CredentialError.unlockUnavailable }
    let selected = try MacUnlockProfile.select(submission.nodes)
    try await current()
    let final = try validate(target, account: account)
    let finalSelection = try MacUnlockProfile.select(final.nodes)
    guard CFEqual(submission.elements[selected.submit], final.elements[finalSelection.submit]) else { throw CredentialError.unlockUnavailable }
    // Exactly one targeted action. cannotComplete may mean the action already
    // ran; inspect the session instead of ever resubmitting the password.
    let action = AXUIElementPerformAction(final.elements[finalSelection.submit], kAXPressAction as CFString)
    guard action == .success || action == .cannotComplete else { throw CredentialError.unlockUnavailable }
    let deadline = ProcessInfo.processInfo.systemUptime + 7
    while ProcessInfo.processInfo.systemUptime < deadline {
      try await current()
      if !(try MacConsoleState.read(account: account).locked) { return }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw CredentialError.unlockUnavailable
  }

  /// Fixed metadata only: never read a secure AXValue or return account text.
  func prepareInspection(account: MacSystemAccount) async -> [String: Any] {
    var activity: IOPMAssertionID = 0
    guard IOPMAssertionDeclareUserActivity("Cindy unlock preparation check" as CFString, kIOPMUserActiveRemote, &activity) == kIOReturnSuccess else {
      return ["fieldReady": false, "error": CredentialError.unlockUnavailable.rawValue]
    }
    defer { IOPMAssertionRelease(activity) }
    do {
      _ = try await prepare(account: account) { _ = try MacConsoleState.read(account: account) }
      return ["fieldReady": true]
    } catch { return ["fieldReady": false, "error": (error as? CredentialError)?.rawValue ?? CredentialError.unlockUnavailable.rawValue] }
  }

  func inspect(account: MacSystemAccount) -> [String: Any] {
    do {
      let state = try MacConsoleState.read(account: account)
      guard state.locked else { return ["locked": false, "profileMatched": false] }
      let target = try collect(account: account)
      let selection = try? MacUnlockProfile.select(target.nodes)
      let allowed = Set(["login", "UserPasswordTextField", "FocusedUser", "LUIBUTTON_GO"])
      let nodes: [[String: Any]] = target.nodes.enumerated().map { index, node in
        ["index": index, "parent": node.parent ?? -1, "role": node.role, "subrole": node.subrole,
          "identifier": allowed.contains(node.identifier) ? node.identifier : "",
          "enabled": node.enabled, "valueSettable": node.writable, "press": node.press,
          "matchesOwnAccount": node.matchesAccount]
      }
      return ["locked": true, "profileMatched": selection != nil, "nodes": nodes]
    } catch { return ["profileMatched": false, "error": (error as? CredentialError)?.rawValue ?? CredentialError.unlockUnavailable.rawValue] }
  }

  private func resolve(account: MacSystemAccount) throws -> Target {
    let raw = try collect(account: account)
    return Target(application: raw.application, launch: raw.launch, code: raw.code, elements: raw.elements,
      nodes: raw.nodes, selection: try MacUnlockProfile.selectField(raw.nodes))
  }
  private func prepare(account: MacSystemAccount, current: () async throws -> Void) async throws -> Target {
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    var presented = false
    while ProcessInfo.processInfo.systemUptime < deadline {
      try await current()
      let raw: Snapshot
      do { raw = try collect(account: account) }
      catch CredentialError.unlockUnavailable {
        // Waking can temporarily expose no window/children. Identity and
        // accessibility failures are never treated as readiness delays.
        try await Task.sleep(nanoseconds: 100_000_000)
        continue
      }
      if let selection = try? MacUnlockProfile.selectField(raw.nodes) {
        return Target(application: raw.application, launch: raw.launch, code: raw.code,
          elements: raw.elements, nodes: raw.nodes, selection: selection)
      }
      if !presented, let label = try? MacUnlockProfile.presentationLabel(raw.nodes) {
        // A non-secret Return reveals the system lock-screen input surface. Only
        // do this after verifying the locked own-account loginwindow twice.
        // Password delivery remains restricted to its exact secure AX field.
        let next = try collect(account: account)
        let nextLabel = try MacUnlockProfile.presentationLabel(next.nodes)
        guard next.launch == raw.launch, CFEqual(next.elements[0], raw.elements[0]),
          CFEqual(next.elements[nextLabel], raw.elements[label]) else { throw CredentialError.invalidIdentity }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) else { throw CredentialError.unlockUnavailable }
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        presented = true
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw CredentialError.unlockUnavailable
  }
  private func collect(account: MacSystemAccount) throws -> Snapshot {
    guard AXIsProcessTrusted() else { throw CredentialError.accessibilityRequired }
    guard try MacConsoleState.read(account: account).locked else { throw CredentialError.unlockUnavailable }
    let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.apple.loginwindow" && $0.executableURL?.path == path }
    guard apps.count == 1, let app = apps.first else { throw CredentialError.unlockUnavailable }
    let launch = try MacUnlockProcessIdentity.read(pid: app.processIdentifier, uid: account.uid)
    var code: SecCode?, requirement: SecRequirement?
    guard SecRequirementCreateWithString("identifier \"com.apple.loginwindow\" and anchor apple" as CFString, [], &requirement) == errSecSuccess,
      SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: app.processIdentifier] as CFDictionary, [], &code) == errSecSuccess,
      let code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { throw CredentialError.invalidIdentity }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.25)
    guard let windows = try value(root, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 else { throw CredentialError.unlockUnavailable }
    let names = try account.unambiguousDisplayNames()
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    var elements: [AXUIElement] = [], nodes: [MacUnlockProfile.Node] = []
    func visit(_ element: AXUIElement, parent: Int?, depth: Int) throws {
      guard ProcessInfo.processInfo.systemUptime < deadline, depth <= 12, nodes.count < 256,
        !elements.contains(where: { CFEqual($0, element) }) else { throw CredentialError.unlockUnavailable }
      AXUIElementSetMessagingTimeout(element, 0.1)
      guard let role = try value(element, kAXRoleAttribute) as? String, !role.isEmpty else { throw CredentialError.unlockUnavailable }
      let subrole = try value(element, kAXSubroleAttribute) as? String ?? ""
      let identifier = try value(element, kAXIdentifierAttribute) as? String ?? ""
      var writable: DarwinBoolean = false
      if identifier == "UserPasswordTextField" {
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success else { throw CredentialError.unlockUnavailable }
      }
      guard try value(element, kAXModalAttribute) as? Bool != true else { throw CredentialError.unlockUnavailable }
      var actions: CFArray?
      let actionStatus = AXUIElementCopyActionNames(element, &actions)
      guard actionStatus == .success || actionStatus == .noValue || actionStatus == .attributeUnsupported else {
        throw CredentialError.unlockUnavailable
      }
      // AXValue is read only for the specifically identified static account label.
      var matches = false
      if identifier == "FocusedUser", role == kAXStaticTextRole {
        matches = names.contains(try value(element, kAXValueAttribute) as? String ?? "")
      }
      let index = nodes.count
      elements.append(element)
      nodes.append(.init(parent: parent, role: role, subrole: subrole, identifier: identifier,
        enabled: try value(element, kAXEnabledAttribute) as? Bool == true, writable: writable.boolValue,
        press: (actions as? [String])?.contains(kAXPressAction) == true, matchesAccount: matches))
      if let children = try value(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { try visit(child, parent: index, depth: depth + 1) }
      }
    }
    try visit(windows[0], parent: nil, depth: 0)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw CredentialError.unlockUnavailable }
    return (app, launch, code, elements, nodes)
  }
  private func validate(_ target: Target, account: MacSystemAccount) throws -> Snapshot {
    guard !target.application.isTerminated,
      try MacUnlockProcessIdentity.read(pid: target.application.processIdentifier, uid: account.uid) == target.launch,
      SecCodeCheckValidity(target.code, [], nil) == errSecSuccess else { throw CredentialError.invalidIdentity }
    let next = try collect(account: account)
    let selection = try MacUnlockProfile.selectField(next.nodes)
    guard next.application.processIdentifier == target.application.processIdentifier, next.launch == target.launch,
      CFEqual(next.elements[0], target.elements[0]),
      CFEqual(next.elements[selection.field], target.elements[target.selection.field]) else { throw CredentialError.unlockUnavailable }
    if let label = selection.label, let previous = target.selection.label {
      guard CFEqual(next.elements[label], target.elements[previous]) else { throw CredentialError.unlockUnavailable }
    }
    return next
  }
  private func value(_ element: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
    var result: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &result)
    if status == .attributeUnsupported || status == .noValue { return nil }
    guard status == .success else { throw CredentialError.unlockUnavailable }
    return result
  }
}

public enum MacRemoteUnlockDiagnostics {
  /// Explicit, non-secret preparation probe: wake/show the verified field only.
  @MainActor public static func prepare() async -> [String: Any] {
    do { return await MacScreenUnlocker.shared.prepareInspection(account: try MacSystemAccount.current()) }
    catch { return ["fieldReady": false, "error": CredentialError.unavailable.rawValue] }
  }
  @MainActor public static func inspect() -> [String: Any] {
    do { return MacScreenUnlocker.shared.inspect(account: try MacSystemAccount.current()) }
    catch { return ["profileMatched": false, "error": CredentialError.unavailable.rawValue] }
  }
}
#endif
