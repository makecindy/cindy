#if os(macOS)
import AppKit
import ApplicationServices
import Foundation
import IOKit.pwr_mgt
import Security
import SystemConfiguration
#if DEBUG
import os
#endif

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
  /// Secondary displays can expose empty login windows. Never pick the first
  /// window: accept exactly one actionable surface and reject unknown siblings.
  static func selectWindow(_ windows: [[Node]]) throws -> Int {
    var candidates: [Int] = []
    for (index, nodes) in windows.enumerated() {
      _ = try accountLabel(nodes)
      if nodes.count == 1 { continue }
      guard (try? selectField(nodes)) != nil || (try? presentationLabel(nodes)) != nil else {
        throw CredentialError.unlockUnavailable
      }
      candidates.append(index)
    }
    guard candidates.count == 1, let selected = candidates.first else { throw CredentialError.unlockUnavailable }
    return selected
  }
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

/// The production traversal, with AX reads and the monotonic clock injectable
/// so budget and object-mapping regressions can be tested without a real login.
enum MacUnlockWindowCollector {
  static func collect<Element>(windows: [Element], cleanupWindow: Element? = nil,
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    equal: (Element, Element) -> Bool,
    read: (Element, Int?) throws -> MacUnlockProfile.Node,
    children: (Element) throws -> [Element]) throws -> (elements: [Element], nodes: [MacUnlockProfile.Node]) {
    // Cleanup may inspect only the original window. It must never fall back to
    // another candidate, and unrelated sibling changes cannot suppress clearing.
    let windows = cleanupWindow.map { original in windows.filter { equal($0, original) } } ?? windows
    guard !windows.isEmpty, windows.count <= 16,
      cleanupWindow == nil || windows.count == 1 else { throw CredentialError.unlockUnavailable }
    let deadline = now() + 2
    var elements: [Element] = [], nodes: [MacUnlockProfile.Node] = []
    var visited: [Element] = []
    func visit(_ element: Element, parent: Int?, depth: Int) throws {
      guard now() < deadline, depth <= 12, visited.count < 256,
        !visited.contains(where: { equal($0, element) }) else { throw CredentialError.unlockUnavailable }
      visited.append(element)
      let index = nodes.count
      elements.append(element)
      nodes.append(try read(element, parent))
      for child in try children(element) { try visit(child, parent: index, depth: depth + 1) }
    }
    var surfaces: [(elements: [Element], nodes: [MacUnlockProfile.Node])] = []
    for window in windows {
      elements = []; nodes = []
      try visit(window, parent: nil, depth: 0)
      surfaces.append((elements, nodes))
    }
    guard now() < deadline else { throw CredentialError.unlockUnavailable }
    return surfaces[try MacUnlockProfile.selectWindow(surfaces.map { $0.nodes })]
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

/// 只输出固定阶段/结果和耗时；不接收密码、AXValue、账户或原始 OS 错误。
@MainActor
final class MacUnlockTrace {
  enum Stage: String { case write, button, finalCheck, press, wait, cleanup }
  enum Result: String { case start, success, cannotComplete, failed, cancelled }
  private let started = ProcessInfo.processInfo.systemUptime
  func record(_ stage: Stage, _ result: Result) {
    #if DEBUG
    let elapsedMs = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
    Logger(subsystem: "app.cindy.remote-desktop", category: "auto-unlock").debug(
      "stage=\(stage.rawValue, privacy: .public) result=\(result.rawValue, privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
    )
    #endif
  }
}

/// 生产提交编排；注入 AX/时钟以便用假对象覆盖取消、瞬态按钮和单次提交。
enum MacUnlockSubmission {
  @MainActor
  static func run<Element>(
    field: Element,
    current: () async throws -> Void,
    validate: () throws -> (elements: [Element], nodes: [MacUnlockProfile.Node]),
    same: (Element, Element) -> Bool,
    write: (Element) -> AXError,
    press: (Element) -> AXError,
    unlocked: () throws -> Bool,
    record: (MacUnlockTrace.Stage, MacUnlockTrace.Result) -> Void,
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    sleep: (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
  ) async throws {
    var stage = MacUnlockTrace.Stage.write
    do {
      try await current()
      _ = try validate()
      record(.write, .start)
      guard write(field) == .success else { throw CredentialError.unlockUnavailable }
      record(.write, .success)
      stage = .button
      record(.button, .start)
      try await current()
      var submission: (elements: [Element], selection: MacUnlockProfile.Selection)?
      let submitDeadline = now() + 2
      while now() < submitDeadline {
        try await current()
        let next = try validate()
        if let selection = try? MacUnlockProfile.select(next.nodes) {
          submission = (next.elements, selection)
          break
        }
        try await sleep(50_000_000)
      }
      guard let submission else { throw CredentialError.unlockUnavailable }
      record(.button, .success)
      stage = .finalCheck
      record(.finalCheck, .start)
      try await current()
      let final = try validate()
      let finalSelection = try MacUnlockProfile.select(final.nodes)
      guard same(submission.elements[submission.selection.submit], final.elements[finalSelection.submit]) else {
        throw CredentialError.unlockUnavailable
      }
      record(.finalCheck, .success)
      stage = .press
      record(.press, .start)
      // cannotComplete 也可能已经提交；只检查锁状态，绝不重按。
      let action = press(final.elements[finalSelection.submit])
      guard action == .success || action == .cannotComplete else { throw CredentialError.unlockUnavailable }
      record(.press, action == .success ? .success : .cannotComplete)
      stage = .wait
      record(.wait, .start)
      let deadline = now() + 7
      while now() < deadline {
        try await current()
        if try unlocked() { record(.wait, .success); return }
        try await sleep(100_000_000)
      }
      throw CredentialError.unlockUnavailable
    } catch {
      record(stage, error is CancellationError || (error as? CredentialError) == .cancelled ? .cancelled : .failed)
      throw error
    }
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
    let trace = MacUnlockTrace()
    let target = try await prepare(account: account, current: current)
    let field = target.elements[target.selection.field]
    var wrote = false
    defer {
      // Clear only the same still-verified secure object; never chase new focus.
      if wrote {
        trace.record(.cleanup, .start)
        if (try? validate(target, account: account, forCleanup: true)) != nil {
          AXUIElementSetMessagingTimeout(field, 2)
          let status = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, "" as CFString)
          trace.record(.cleanup, status == .success ? .success : .failed)
        } else {
          trace.record(.cleanup, .failed)
        }
      }
    }
    try await MacUnlockSubmission.run(
      field: field,
      current: current,
      validate: {
        let next = try validate(target, account: account)
        return (next.elements, next.nodes)
      },
      same: { CFEqual($0, $1) },
      write: {
        // loginwindow secure writes can exceed the 0.1s traversal budget.
        AXUIElementSetMessagingTimeout($0, 2)
        wrote = true
        return AXUIElementSetAttributeValue($0, kAXValueAttribute as CFString, text as CFString)
      },
      press: {
        AXUIElementSetMessagingTimeout($0, 2)
        return AXUIElementPerformAction($0, kAXPressAction as CFString)
      },
      unlocked: { try !MacConsoleState.read(account: account).locked },
      record: trace.record
    )
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
  private func collect(account: MacSystemAccount, cleanupWindow: AXUIElement? = nil) throws -> Snapshot {
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
    guard let windows = try value(root, kAXWindowsAttribute) as? [AXUIElement] else { throw CredentialError.unlockUnavailable }
    let names = try account.unambiguousDisplayNames()
    let selected = try MacUnlockWindowCollector.collect(windows: windows, cleanupWindow: cleanupWindow, equal: { CFEqual($0, $1) }, read: { element, parent in
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
      return .init(parent: parent, role: role, subrole: subrole, identifier: identifier,
        enabled: try value(element, kAXEnabledAttribute) as? Bool == true, writable: writable.boolValue,
        press: (actions as? [String])?.contains(kAXPressAction) == true, matchesAccount: matches)
    }, children: { element in
      try value(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    })
    return (app, launch, code, selected.elements, selected.nodes)
  }
  private func validate(_ target: Target, account: MacSystemAccount, forCleanup: Bool = false) throws -> Snapshot {
    guard !target.application.isTerminated,
      try MacUnlockProcessIdentity.read(pid: target.application.processIdentifier, uid: account.uid) == target.launch,
      SecCodeCheckValidity(target.code, [], nil) == errSecSuccess else { throw CredentialError.invalidIdentity }
    let next = try collect(account: account, cleanupWindow: forCleanup ? target.elements[0] : nil)
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
