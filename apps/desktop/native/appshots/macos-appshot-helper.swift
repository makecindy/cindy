import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let secureTextFieldRole = "AXSecureTextField"
private let maximumCaptureDimension = 8_192
private let outputDirectoryPrefix = "cindy-appshot-"

private enum HelperMode: Equatable {
  case selfTest
  case capture(outputDirectory: String, selfTestBeforeCapture: Bool)
}

private func parseHelperMode(_ arguments: [String]) -> HelperMode? {
  if arguments == ["--self-test"] { return .selfTest }
  if arguments.count == 2, arguments[0] == "--output-dir" {
    return .capture(outputDirectory: arguments[1], selfTestBeforeCapture: false)
  }
  if arguments.count == 3,
     arguments[0] == "--self-test-and-capture",
     arguments[1] == "--output-dir" {
    return .capture(outputDirectory: arguments[2], selfTestBeforeCapture: true)
  }
  return nil
}

enum AppshotError: Error {
  case invalidOutput
  case screenPermission
  case noWindow
  case windowClosed
  case protectedContent
  case nativeFailure

  var code: String {
    switch self {
    case .invalidOutput: return "APPSHOT_INVALID_OUTPUT"
    case .screenPermission: return "APPSHOT_SCREEN_PERMISSION"
    case .noWindow: return "APPSHOT_NO_WINDOW"
    case .windowClosed: return "APPSHOT_WINDOW_CLOSED"
    case .protectedContent: return "APPSHOT_PROTECTED_CONTENT"
    case .nativeFailure: return "APPSHOT_NATIVE_FAILURE"
    }
  }

  var message: String {
    switch self {
    case .invalidOutput: return "invalid output directory"
    case .screenPermission: return "screen recording permission is required"
    case .noWindow: return "no capturable window"
    case .windowClosed: return "target window closed"
    case .protectedContent: return "window content is unavailable"
    case .nativeFailure: return "native capture failed"
    }
  }
}

struct AXSerialization {
  let text: String?
  let truncated: Bool
  let unavailableReason: String?
}

private struct SerializationLimits {
  let maxNodes: Int
  let maxDepth: Int
  let maxBytes: Int
}

private struct TreeNodeSnapshot<Node> {
  let fields: [(String, String)]
  let children: [Node]
}

private struct FixtureNode {
  let role: String
  let label: String?
  let title: String?
  let value: String?
  let description: String?
  let containsProtectedContent: Bool
  let children: [FixtureNode]

  init(
    role: String,
    label: String? = nil,
    title: String? = nil,
    value: String? = nil,
    description: String? = nil,
    containsProtectedContent: Bool = false,
    children: [FixtureNode] = []
  ) {
    self.role = role
    self.label = label
    self.title = title
    self.value = value
    self.description = description
    self.containsProtectedContent = containsProtectedContent
    self.children = children
  }
}

private struct WindowCandidateFacts {
  let title: String?
  let frame: CGRect
  let alpha: Double?
}

private func sanitized(_ value: String) -> String {
  value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\r", with: "\\r")
    .replacingOccurrences(of: "\n", with: "\\n")
    .replacingOccurrences(of: "|", with: "\\|")
}

private func appendUTF8Prefix(_ value: String, to output: inout Data, maximumBytes: Int) {
  let remaining = maximumBytes - output.count
  guard remaining > 0 else { return }
  let bytes = Data(value.utf8.prefix(remaining))
  var validCount = bytes.count
  while validCount > 0 && String(data: bytes.prefix(validCount), encoding: .utf8) == nil {
    validCount -= 1
  }
  output.append(bytes.prefix(validCount))
}

private func serializeTree<Node>(
  root: Node?,
  limits: SerializationLimits,
  deadlineReached: (Int) -> Bool,
  prepareNode: (Node) -> Void = { _ in },
  readNode: (Node) -> TreeNodeSnapshot<Node>?
) -> AXSerialization {
  guard let root else { return AXSerialization(text: nil, truncated: false, unavailableReason: nil) }
  var output = Data()
  var visited = 0
  var truncated = false
  var stack: [(Node, Int)] = [(root, 0)]

  while let (node, depth) = stack.popLast() {
    if visited >= limits.maxNodes || deadlineReached(visited) {
      truncated = true
      break
    }
    prepareNode(node)
    guard let snapshot = readNode(node) else { continue }
    visited += 1

    if !snapshot.fields.isEmpty {
      let separator = output.isEmpty ? "" : "\n"
      let line = separator + String(repeating: "  ", count: depth)
        + snapshot.fields.map { "\($0.0): \(sanitized($0.1))" }.joined(separator: " | ")
      if output.count + line.lengthOfBytes(using: .utf8) > limits.maxBytes {
        appendUTF8Prefix(line, to: &output, maximumBytes: limits.maxBytes)
        truncated = true
        break
      }
      output.append(contentsOf: line.utf8)
    }

    if depth >= limits.maxDepth {
      if !snapshot.children.isEmpty { truncated = true }
      continue
    }
    for child in snapshot.children.reversed() {
      stack.append((child, depth + 1))
    }
  }

  return AXSerialization(
    text: output.isEmpty ? nil : String(data: output, encoding: .utf8),
    truncated: truncated,
    unavailableReason: nil
  )
}

private func serializeFixture(
  _ root: FixtureNode,
  limits: SerializationLimits,
  deadlineNode: Int? = nil,
  prepareNode: (FixtureNode) -> Void = { _ in }
) -> AXSerialization {
  serializeTree(
    root: root,
    limits: limits,
    deadlineReached: { visited in deadlineNode.map { visited >= $0 } ?? false },
    prepareNode: prepareNode,
    readNode: { node in
      if node.role == secureTextFieldRole {
        return TreeNodeSnapshot(
          fields: [("role", "Secure text field"), ("label", "Secure text field")],
          children: []
        )
      }
      let fields = [
        ("role", Optional(node.role)),
        ("label", node.label),
        ("title", node.title),
        ("value", node.containsProtectedContent ? nil : node.value),
        ("description", node.description),
      ].compactMap { name, value in value.flatMap { $0.isEmpty ? nil : (name, $0) } }
      return TreeNodeSnapshot(fields: fields, children: node.children)
    }
  )
}

private func copyAXAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
}

private func copyAXAttribute(
  _ element: AXUIElement,
  _ attribute: CFString,
  beforeDeadline: () -> Bool
) -> CFTypeRef? {
  guard beforeDeadline() else { return nil }
  return copyAXAttribute(element, attribute)
}

private func safeAXString(_ element: AXUIElement, _ attribute: CFString) -> String? {
  guard let value = copyAXAttribute(element, attribute), CFGetTypeID(value) == CFStringGetTypeID() else {
    return nil
  }
  return value as? String
}

private func safeAXString(
  _ element: AXUIElement,
  _ attribute: CFString,
  beforeDeadline: () -> Bool
) -> String? {
  guard let value = copyAXAttribute(element, attribute, beforeDeadline: beforeDeadline),
        CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
  return value as? String
}

private func safeAXPrimitive(_ element: AXUIElement, _ attribute: CFString) -> String? {
  guard let value = copyAXAttribute(element, attribute) else { return nil }
  if CFGetTypeID(value) == CFStringGetTypeID() {
    return value as? String
  }
  if CFGetTypeID(value) == CFBooleanGetTypeID() {
    return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
  }
  if CFGetTypeID(value) == CFNumberGetTypeID(), let number = value as? NSNumber {
    return number.stringValue
  }
  return nil
}

private func safeAXPrimitive(
  _ element: AXUIElement,
  _ attribute: CFString,
  beforeDeadline: () -> Bool
) -> String? {
  guard let value = copyAXAttribute(element, attribute, beforeDeadline: beforeDeadline) else { return nil }
  if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
  if CFGetTypeID(value) == CFBooleanGetTypeID() {
    return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
  }
  if CFGetTypeID(value) == CFNumberGetTypeID(), let number = value as? NSNumber {
    return number.stringValue
  }
  return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  copyAXAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func axChildren(_ element: AXUIElement, beforeDeadline: () -> Bool) -> [AXUIElement] {
  copyAXAttribute(
    element,
    kAXChildrenAttribute as CFString,
    beforeDeadline: beforeDeadline
  ) as? [AXUIElement] ?? []
}

func serializeAccessibilityWindow(
  _ window: AXUIElement?,
  startedAt: ContinuousClock.Instant
) -> AXSerialization {
  guard AXIsProcessTrusted() else {
    return AXSerialization(text: nil, truncated: false, unavailableReason: "permission")
  }
  guard let window else {
    return AXSerialization(text: nil, truncated: false, unavailableReason: "unsupported")
  }
  _ = NSAccessibility.setMayContainProtectedContent(true)

  let clock = ContinuousClock()
  var hitDeadline = false
  var seen = Set<CFHashCode>()
  let deadlineReached: (Int) -> Bool = { _ in
    let reached = clock.now - startedAt >= .milliseconds(1_500)
    if reached { hitDeadline = true }
    return reached
  }
  let result = serializeTree(
    root: window,
    limits: SerializationLimits(maxNodes: 2_000, maxDepth: 16, maxBytes: 512 * 1_024),
    deadlineReached: deadlineReached,
    prepareNode: { AXUIElementSetMessagingTimeout($0, 0.1) },
    readNode: { element in
      let identity = CFHash(element)
      guard seen.insert(identity).inserted else { return nil }
      if deadlineReached(0) { return nil }

      let beforeDeadline = { !deadlineReached(0) }
      let role = safeAXString(element, kAXRoleAttribute as CFString, beforeDeadline: beforeDeadline)
      if role == secureTextFieldRole {
        return TreeNodeSnapshot(
          fields: [("role", "Secure text field"), ("label", "Secure text field")],
          children: []
        )
      }
      let containsProtectedContent = safeAXPrimitive(
        element,
        NSAccessibility.Attribute.containsProtectedContent.rawValue as CFString,
        beforeDeadline: beforeDeadline
      ) == "true"

      var fields: [(String, String)] = []
      func add(_ name: String, _ value: @autoclosure () -> String?) {
        guard !deadlineReached(0), let value = value(), !value.isEmpty else { return }
        fields.append((name, value))
      }
      add("role", role)
      add("label", safeAXString(element, kAXDescriptionAttribute as CFString, beforeDeadline: beforeDeadline))
      add("title", safeAXString(element, kAXTitleAttribute as CFString, beforeDeadline: beforeDeadline))
      if !containsProtectedContent {
        add("value", safeAXPrimitive(element, kAXValueAttribute as CFString, beforeDeadline: beforeDeadline))
      }
      add("description", safeAXString(element, kAXHelpAttribute as CFString, beforeDeadline: beforeDeadline))
      add("enabled", safeAXPrimitive(element, kAXEnabledAttribute as CFString, beforeDeadline: beforeDeadline))
      add("selected", safeAXPrimitive(element, kAXSelectedAttribute as CFString, beforeDeadline: beforeDeadline))
      add("focused", safeAXPrimitive(element, kAXFocusedAttribute as CFString, beforeDeadline: beforeDeadline))
      return TreeNodeSnapshot(
        fields: fields,
        children: axChildren(element, beforeDeadline: beforeDeadline)
      )
    }
  )

  if hitDeadline {
    return AXSerialization(
      text: result.text,
      truncated: true,
      unavailableReason: result.text == nil ? "timeout" : nil
    )
  }
  return result
}

private func focusedAXWindow(for app: NSRunningApplication) -> AXUIElement? {
  guard AXIsProcessTrusted() else { return nil }
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(appElement, 0.1)
  guard let value = copyAXAttribute(appElement, kAXFocusedWindowAttribute as CFString),
        CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  let window = value as! AXUIElement
  AXUIElementSetMessagingTimeout(window, 0.1)
  return window
}

private func axBounds(_ element: AXUIElement?) -> CGRect? {
  guard let element,
        let positionValue = copyAXAttribute(element, kAXPositionAttribute as CFString),
        let sizeValue = copyAXAttribute(element, kAXSizeAttribute as CFString),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
  var position = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue((positionValue as! AXValue), .cgPoint, &position),
        AXValueGetValue((sizeValue as! AXValue), .cgSize, &size) else { return nil }
  return CGRect(origin: position, size: size)
}

private func approximatelyMatches(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
  abs(lhs.minX - rhs.minX) <= 8
    && abs(lhs.minY - rhs.minY) <= 8
    && abs(lhs.width - rhs.width) <= 8
    && abs(lhs.height - rhs.height) <= 8
}

private func isFiniteNormalFrame(_ frame: CGRect) -> Bool {
  frame.origin.x.isFinite
    && frame.origin.y.isFinite
    && frame.width.isFinite
    && frame.height.isFinite
    && frame.width > 1
    && frame.height > 1
}

private func selectedWindowIndex(
  candidates: [WindowCandidateFacts],
  axTitle: String?,
  axBounds: CGRect?
) -> Int? {
  let eligible = candidates.indices.filter { index in
    let candidate = candidates[index]
    return candidate.alpha.map { $0 > 0 } == true && isFiniteNormalFrame(candidate.frame)
  }
  let usableTitle = axTitle.flatMap { $0.isEmpty ? nil : $0 }
  let usableBounds = axBounds.flatMap { isFiniteNormalFrame($0) ? $0 : nil }
  func uniqueMatch(where matches: (Int) -> Bool) -> Int? {
    let matching = eligible.filter(matches)
    return matching.count == 1 ? matching[0] : nil
  }
  switch (usableTitle, usableBounds) {
  case let (title?, bounds?):
    return uniqueMatch { index in
      candidates[index].title == title && approximatelyMatches(candidates[index].frame, bounds)
    }
  case let (title?, nil):
    return uniqueMatch { candidates[$0].title == title }
  case let (nil, bounds?):
    return uniqueMatch { approximatelyMatches(candidates[$0].frame, bounds) }
  case (nil, nil):
    return eligible.first
  }
}

private func windowAlpha(_ window: SCWindow) -> Double? {
  guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], window.windowID) as? [[String: Any]],
        let windowInfo = info.first else { return nil }
  return (windowInfo[kCGWindowAlpha as String] as? NSNumber)?.doubleValue
}

private func isEligibleFrontmostProcess(
  processIdentifier: pid_t,
  isTerminated: Bool,
  activationPolicy: NSApplication.ActivationPolicy,
  selfProcessIdentifier: pid_t
) -> Bool {
  guard !isTerminated,
        processIdentifier != selfProcessIdentifier,
        activationPolicy != .prohibited else { return false }
  // The host (Cindy) stays eligible as a last-resort target: the composer
  // action runs while Cindy is already active, and the spec verification
  // matrix lists Cindy as a valid capture target when no other app window is
  // visible. Normal invocations prefer the previously visible app behind
  // Cindy, and the global-shortcut path captures before Cindy activates.
  return true
}

private func captureTarget(
  for app: NSRunningApplication,
  preferredWindowID: CGWindowID?
) async throws -> (app: NSRunningApplication, window: SCWindow, axWindow: AXUIElement?) {
  let axWindow = focusedAXWindow(for: app)
  let axTitle = axWindow.flatMap { safeAXString($0, kAXTitleAttribute as CFString) }
  let focusedBounds = axBounds(axWindow)
  let content: SCShareableContent
  do {
    content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
  } catch {
    throw CGPreflightScreenCaptureAccess() ? AppshotError.nativeFailure : AppshotError.screenPermission
  }
  guard !app.isTerminated else { throw AppshotError.windowClosed }

  let candidates = content.windows.filter { candidate in
    candidate.owningApplication?.processID == app.processIdentifier
      && candidate.windowLayer == 0
      && candidate.isOnScreen
  }
  var selectedIndex: Int?
  if let preferredWindowID {
    selectedIndex = candidates.indices.first { candidates[$0].windowID == preferredWindowID }
  }
  if selectedIndex == nil {
    let candidateFacts = candidates.map { candidate in
      WindowCandidateFacts(
        title: candidate.title,
        frame: candidate.frame,
        alpha: windowAlpha(candidate)
      )
    }
    selectedIndex = selectedWindowIndex(
      candidates: candidateFacts,
      axTitle: axTitle,
      axBounds: focusedBounds
    )
  }
  guard let selectedIndex else { throw AppshotError.noWindow }
  return (app, candidates[selectedIndex], axWindow)
}

private struct PreviousWindowTarget {
  let ownerProcessIdentifier: pid_t
  let windowID: CGWindowID
}

private func firstVisibleForeignWindow(
  from windowInfos: [[String: Any]],
  selfProcessIdentifier: pid_t,
  parentProcessIdentifier: pid_t
) -> PreviousWindowTarget? {
  for info in windowInfos {
    guard let ownerPID = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
          ownerPID != selfProcessIdentifier,
          ownerPID != parentProcessIdentifier,
          (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0,
          (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
          let windowIDNumber = info[kCGWindowNumber as String] as? NSNumber,
          let bounds = info[kCGWindowBounds as String] as? [String: NSNumber],
          (bounds["Width"]?.doubleValue ?? 0) > 1,
          (bounds["Height"]?.doubleValue ?? 0) > 1 else { continue }
    return PreviousWindowTarget(
      ownerProcessIdentifier: ownerPID,
      windowID: CGWindowID(windowIDNumber.uint32Value)
    )
  }
  return nil
}

func frontmostTarget() async throws -> (app: NSRunningApplication, window: SCWindow, axWindow: AXUIElement?) {
  guard let frontmost = NSWorkspace.shared.frontmostApplication else { throw AppshotError.noWindow }
  let selfProcessIdentifier = ProcessInfo.processInfo.processIdentifier
  let parentProcessIdentifier = getppid()
  if frontmost.processIdentifier == parentProcessIdentifier
      || frontmost.processIdentifier == selfProcessIdentifier {
    // The host (Cindy) is frontmost whenever the composer action or the
    // shortcut is invoked while Cindy is active. Like Codex, capture the app
    // window the user was looking at before Cindy: the topmost visible
    // non-host window. Fall back to the host window itself when nothing else
    // is visible so the action never silently fails.
    if let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .optionIncludingWindow], kCGNullWindowID)
        as? [[String: Any]],
       let previous = firstVisibleForeignWindow(
         from: windowList,
         selfProcessIdentifier: selfProcessIdentifier,
         parentProcessIdentifier: parentProcessIdentifier
       ),
       let previousApp = NSRunningApplication(processIdentifier: previous.ownerProcessIdentifier),
       isEligibleFrontmostProcess(
         processIdentifier: previousApp.processIdentifier,
         isTerminated: previousApp.isTerminated,
         activationPolicy: previousApp.activationPolicy,
         selfProcessIdentifier: selfProcessIdentifier
       ) {
      return try await captureTarget(for: previousApp, preferredWindowID: previous.windowID)
    }
  }
  guard isEligibleFrontmostProcess(
    processIdentifier: frontmost.processIdentifier,
    isTerminated: frontmost.isTerminated,
    activationPolicy: frontmost.activationPolicy,
    selfProcessIdentifier: selfProcessIdentifier
  ) else { throw AppshotError.noWindow }
  return try await captureTarget(for: frontmost, preferredWindowID: nil)
}

func isBlankImage(_ image: CGImage) -> Bool {
  let width = min(image.width, 64)
  let height = min(image.height, 64)
  guard width > 0, height > 0 else { return true }
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  guard let context = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return true }
  context.interpolationQuality = .low
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

  var minimum = [UInt8](repeating: 255, count: 3)
  var maximum = [UInt8](repeating: 0, count: 3)
  var maximumAlpha: UInt8 = 0
  for offset in stride(from: 0, to: pixels.count, by: 4) {
    maximumAlpha = max(maximumAlpha, pixels[offset + 3])
    for channel in 0..<3 {
      minimum[channel] = min(minimum[channel], pixels[offset + channel])
      maximum[channel] = max(maximum[channel], pixels[offset + channel])
    }
  }
  if maximumAlpha <= 2 { return true }
  return zip(minimum, maximum).allSatisfy { Int($0.1) - Int($0.0) <= 3 }
}

private func pngData(for image: CGImage) throws -> Data {
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(
    data,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else { throw AppshotError.nativeFailure }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw AppshotError.nativeFailure }
  return data as Data
}

private func openValidatedOutputDirectory(_ argument: String) throws -> (url: URL, fileDescriptor: Int32) {
  guard argument.hasPrefix("/") else { throw AppshotError.invalidOutput }
  let directory = URL(fileURLWithPath: argument, isDirectory: true).standardizedFileURL
  let lexicalTemporaryRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    .standardizedFileURL
  let temporaryRoot = lexicalTemporaryRoot.resolvingSymlinksInPath()
  let resolvedDirectory = directory.resolvingSymlinksInPath()
  let suppliedParent = directory.deletingLastPathComponent().path
  guard directory.path == argument,
        suppliedParent == lexicalTemporaryRoot.path || suppliedParent == temporaryRoot.path,
        resolvedDirectory.deletingLastPathComponent().path == temporaryRoot.path,
        resolvedDirectory.lastPathComponent.hasPrefix(outputDirectoryPrefix) else {
    throw AppshotError.invalidOutput
  }

  var pathStatus = stat()
  guard lstat(argument, &pathStatus) == 0,
        (pathStatus.st_mode & S_IFMT) == S_IFDIR,
        (pathStatus.st_mode & 0o777) == 0o700,
        pathStatus.st_uid == geteuid() else { throw AppshotError.invalidOutput }

  let directoryFD = open(argument, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard directoryFD >= 0 else { throw AppshotError.invalidOutput }
  var openedStatus = stat()
  guard fstat(directoryFD, &openedStatus) == 0,
        (openedStatus.st_mode & S_IFMT) == S_IFDIR,
        (openedStatus.st_mode & 0o777) == 0o700,
        openedStatus.st_uid == geteuid(),
        openedStatus.st_dev == pathStatus.st_dev,
        openedStatus.st_ino == pathStatus.st_ino else {
    close(directoryFD)
    throw AppshotError.invalidOutput
  }
  var outputStatus = stat()
  guard fstatat(directoryFD, "appshot.png", &outputStatus, AT_SYMLINK_NOFOLLOW) != 0,
        errno == ENOENT else {
    close(directoryFD)
    throw AppshotError.invalidOutput
  }
  return (directory, directoryFD)
}

private func writePNG(_ data: Data, toDirectoryFileDescriptor directoryFD: Int32) throws {
  let filename = "appshot.png"
  let outputFD = openat(
    directoryFD,
    filename,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    mode_t(0o600)
  )
  guard outputFD >= 0 else { throw AppshotError.invalidOutput }
  var keepFile = false
  defer {
    close(outputFD)
    if !keepFile { unlinkat(directoryFD, filename, 0) }
  }

  var outputStatus = stat()
  guard fstat(outputFD, &outputStatus) == 0,
        (outputStatus.st_mode & S_IFMT) == S_IFREG,
        (outputStatus.st_mode & 0o777) == 0o600,
        outputStatus.st_uid == geteuid(),
        outputStatus.st_nlink == 1 else { throw AppshotError.invalidOutput }
  try data.withUnsafeBytes { rawBuffer in
    guard let baseAddress = rawBuffer.baseAddress else { return }
    var written = 0
    while written < rawBuffer.count {
      let count = Darwin.write(outputFD, baseAddress.advanced(by: written), rawBuffer.count - written)
      if count < 0 {
        if errno == EINTR { continue }
        throw AppshotError.nativeFailure
      }
      guard count > 0 else { throw AppshotError.nativeFailure }
      written += count
    }
  }
  keepFile = true
}

func captureWindow(_ window: SCWindow, to outputURL: URL) async throws -> CGImage {
  let frame = window.frame
  guard isFiniteNormalFrame(frame) else { throw AppshotError.noWindow }
  guard outputURL.lastPathComponent == "appshot.png" else { throw AppshotError.invalidOutput }
  let directory = try openValidatedOutputDirectory(outputURL.deletingLastPathComponent().path)
  defer { close(directory.fileDescriptor) }
  let screenScale = NSScreen.screens.first(where: { $0.frame.intersects(frame) })?.backingScaleFactor
    ?? NSScreen.main?.backingScaleFactor
    ?? 2
  var width = max(1, Int((frame.width * screenScale).rounded()))
  var height = max(1, Int((frame.height * screenScale).rounded()))
  let largest = max(width, height)
  if largest > maximumCaptureDimension {
    let ratio = Double(maximumCaptureDimension) / Double(largest)
    width = max(1, Int((Double(width) * ratio).rounded()))
    height = max(1, Int((Double(height) * ratio).rounded()))
  }

  let configuration = SCStreamConfiguration()
  configuration.width = width
  configuration.height = height
  configuration.showsCursor = false
  configuration.capturesAudio = false
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let image: CGImage
  do {
    image = try await SCScreenshotManager.captureImage(
      contentFilter: filter,
      configuration: configuration
    )
  } catch {
    if !CGPreflightScreenCaptureAccess() { throw AppshotError.screenPermission }
    if let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false),
       !content.windows.contains(where: { $0.windowID == window.windowID }) {
      throw AppshotError.windowClosed
    }
    throw AppshotError.nativeFailure
  }
  guard !isBlankImage(image) else { throw AppshotError.protectedContent }
  do {
    try writePNG(pngData(for: image), toDirectoryFileDescriptor: directory.fileDescriptor)
  } catch let error as AppshotError {
    throw error
  } catch {
    throw AppshotError.nativeFailure
  }
  return image
}

func validatedOutputURL(argument: String) throws -> URL {
  let directory = try openValidatedOutputDirectory(argument)
  close(directory.fileDescriptor)
  return directory.url.appendingPathComponent("appshot.png", isDirectory: false)
}

private func emitJSON(_ payload: [String: Any]) throws {
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func runSelfTest() -> Bool {
  guard parseHelperMode(["--self-test"]) == .selfTest,
        parseHelperMode(["--output-dir", "/private/tmp/cindy-appshot-test"]) == .capture(
          outputDirectory: "/private/tmp/cindy-appshot-test",
          selfTestBeforeCapture: false
        ),
        parseHelperMode([
          "--self-test-and-capture",
          "--output-dir",
          "/private/tmp/cindy-appshot-test",
        ]) == .capture(
          outputDirectory: "/private/tmp/cindy-appshot-test",
          selfTestBeforeCapture: true
        ),
        parseHelperMode(["--self-test-and-capture"]) == nil else { return false }

  let ordinaryLimits = SerializationLimits(maxNodes: 10, maxDepth: 4, maxBytes: 4_096)
  let secure = serializeFixture(
    FixtureNode(
      role: secureTextFieldRole,
      label: "Password",
      title: "private title",
      value: "correct horse battery staple",
      description: "private description",
      children: [FixtureNode(role: "AXStaticText", value: "descendant secret")]
    ),
    limits: ordinaryLimits
  )
  guard secure.text == "role: Secure text field | label: Secure text field",
        secure.text?.contains("correct horse") == false,
        secure.text?.contains("private") == false,
        secure.text?.contains("descendant secret") == false,
        !secure.truncated else { return false }

  let siblings = FixtureNode(
    role: "AXWindow",
    children: (0..<4).map { FixtureNode(role: "AXButton", label: "button-\($0)") }
  )
  let nodeLimited = serializeFixture(
    siblings,
    limits: SerializationLimits(maxNodes: 3, maxDepth: 8, maxBytes: 4_096)
  )
  guard nodeLimited.truncated, nodeLimited.text?.contains("button-1") == true,
        nodeLimited.text?.contains("button-2") == false else { return false }

  let deep = FixtureNode(
    role: "AXWindow",
    children: [FixtureNode(
      role: "AXGroup",
      label: "depth-1",
      children: [FixtureNode(role: "AXStaticText", label: "depth-2")]
    )]
  )
  let depthLimited = serializeFixture(
    deep,
    limits: SerializationLimits(maxNodes: 10, maxDepth: 1, maxBytes: 4_096)
  )
  guard depthLimited.truncated, depthLimited.text?.contains("depth-1") == true,
        depthLimited.text?.contains("depth-2") == false else { return false }

  let byteLimited = serializeFixture(
    FixtureNode(role: "AXWindow", label: String(repeating: "é", count: 20)),
    limits: SerializationLimits(maxNodes: 10, maxDepth: 4, maxBytes: 31)
  )
  guard byteLimited.truncated, let byteText = byteLimited.text,
        byteText.lengthOfBytes(using: .utf8) <= 31 else { return false }

  var preparedRoles: [String] = []
  let deadlineLimited = serializeFixture(
    siblings,
    limits: ordinaryLimits,
    deadlineNode: 2,
    prepareNode: { preparedRoles.append($0.role) }
  )
  guard deadlineLimited.truncated
    && preparedRoles == ["AXWindow", "AXButton"]
    && deadlineLimited.text?.contains("button-0") == true
    && deadlineLimited.text?.contains("button-1") == false else { return false }

  let targetBounds = CGRect(x: 100, y: 100, width: 640, height: 480)
  let conflictingIdentifiers = [
    WindowCandidateFacts(
      title: "Target",
      frame: CGRect(x: 0, y: 0, width: 640, height: 480),
      alpha: 1
    ),
    WindowCandidateFacts(title: "Other", frame: targetBounds, alpha: 1),
  ]
  guard selectedWindowIndex(
    candidates: conflictingIdentifiers,
    axTitle: "Target",
    axBounds: targetBounds
  ) == nil else { return false }

  guard selectedWindowIndex(
    candidates: [WindowCandidateFacts(title: "Other", frame: targetBounds, alpha: 1)],
    axTitle: "Missing",
    axBounds: CGRect(x: 900, y: 900, width: 640, height: 480)
  ) == nil else { return false }

  let alphaCandidates = [
    WindowCandidateFacts(title: "Unknown alpha", frame: targetBounds, alpha: nil),
    WindowCandidateFacts(title: "Visible", frame: targetBounds, alpha: 1),
  ]
  guard selectedWindowIndex(candidates: alphaCandidates, axTitle: nil, axBounds: nil) == 1 else {
    return false
  }

  let duplicateMatches = [
    WindowCandidateFacts(title: "Target", frame: targetBounds, alpha: 1),
    WindowCandidateFacts(title: "Target", frame: targetBounds, alpha: 1),
  ]
  guard selectedWindowIndex(
    candidates: duplicateMatches,
    axTitle: "Target",
    axBounds: targetBounds
  ) == nil else { return false }
  guard selectedWindowIndex(
    candidates: duplicateMatches,
    axTitle: "Target",
    axBounds: nil
  ) == nil else { return false }
  guard selectedWindowIndex(
    candidates: duplicateMatches,
    axTitle: nil,
    axBounds: targetBounds
  ) == nil else { return false }

  // The frontmost app may be the host process that spawned this helper (the
  // composer attachment action runs while Cindy is active). Capturing Cindy
  // itself is an approved spec scenario, so the parent PID must stay eligible.
  guard isEligibleFrontmostProcess(
    processIdentifier: 42,
    isTerminated: false,
    activationPolicy: .regular,
    selfProcessIdentifier: 41
  ) else { return false }
  // The helper must never target itself or a terminated or prohibited app.
  guard isEligibleFrontmostProcess(
    processIdentifier: 42,
    isTerminated: false,
    activationPolicy: .regular,
    selfProcessIdentifier: 42
  ) == false,
  isEligibleFrontmostProcess(
    processIdentifier: 42,
    isTerminated: true,
    activationPolicy: .regular,
    selfProcessIdentifier: 41
  ) == false,
  isEligibleFrontmostProcess(
    processIdentifier: 42,
    isTerminated: false,
    activationPolicy: .prohibited,
    selfProcessIdentifier: 41
  ) == false else { return false }

  func windowInfo(
    pid: pid_t,
    layer: Int = 0,
    alpha: Double = 1,
    onscreen: Bool = true,
    windowID: UInt32 = 0,
    width: CGFloat = 100,
    height: CGFloat = 100
  ) -> [String: Any] {
    [
      kCGWindowOwnerPID as String: NSNumber(value: pid),
      kCGWindowLayer as String: NSNumber(value: layer),
      kCGWindowAlpha as String: NSNumber(value: alpha),
      kCGWindowIsOnscreen as String: NSNumber(value: onscreen),
      kCGWindowNumber as String: NSNumber(value: windowID),
      kCGWindowBounds as String: [
        "Width": NSNumber(value: width),
        "Height": NSNumber(value: height),
      ],
    ]
  }
  guard firstVisibleForeignWindow(
    from: [
      windowInfo(pid: 41),
      windowInfo(pid: 50, windowID: 100),
    ],
    selfProcessIdentifier: 42,
    parentProcessIdentifier: 41
  )?.ownerProcessIdentifier == 50,
  firstVisibleForeignWindow(
    from: [
      windowInfo(pid: 41),
      windowInfo(pid: 42),
      windowInfo(pid: 50, layer: 25),
      windowInfo(pid: 50, alpha: 0),
      windowInfo(pid: 50, width: 1, height: 1),
      windowInfo(pid: 50, windowID: 200),
    ],
    selfProcessIdentifier: 42,
    parentProcessIdentifier: 41
  )?.windowID == 200,
  firstVisibleForeignWindow(
    from: [windowInfo(pid: 41), windowInfo(pid: 42)],
    selfProcessIdentifier: 42,
    parentProcessIdentifier: 41
  ) == nil else { return false }

  let protected = serializeFixture(
    FixtureNode(
      role: "AXStaticText",
      label: "Account balance",
      title: "Balance",
      value: "secret-value",
      description: "Visible structure",
      containsProtectedContent: true
    ),
    limits: ordinaryLimits
  )
  return protected.text?.contains("role: AXStaticText") == true
    && protected.text?.contains("Account balance") == true
    && protected.text?.contains("Balance") == true
    && protected.text?.contains("Visible structure") == true
    && protected.text?.contains("secret-value") == false
}

private enum MacOSAppshotHelper {
  static func run() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let mode = parseHelperMode(arguments) else {
      FileHandle.standardError.write(Data("APPSHOT_INVALID_OUTPUT: invalid output directory\n".utf8))
      exit(2)
    }
    if mode == .selfTest {
      guard runSelfTest() else { exit(1) }
      do {
        try emitJSON(["type": "self-test", "ok": true])
        exit(0)
      } catch {
        exit(1)
      }
    }

    do {
      guard case let .capture(outputDirectory, selfTestBeforeCapture) = mode else {
        throw AppshotError.nativeFailure
      }
      if selfTestBeforeCapture, !runSelfTest() {
        throw AppshotError.nativeFailure
      }
      let outputURL = try validatedOutputURL(argument: outputDirectory)
      let target = try await frontmostTarget()
      _ = try await captureWindow(target.window, to: outputURL)
      let accessibility = serializeAccessibilityWindow(
        target.axWindow,
        startedAt: ContinuousClock().now
      )
      var payload: [String: Any] = [
        "type": "capture",
        "pngPath": outputURL.path,
        "applicationName": target.app.localizedName ?? "",
        "bundleIdentifier": target.app.bundleIdentifier ?? NSNull(),
        "windowTitle": target.window.title ?? NSNull(),
        "accessibilityText": accessibility.text ?? NSNull(),
        "accessibilityTruncated": accessibility.truncated,
      ]
      if let reason = accessibility.unavailableReason {
        payload["accessibilityUnavailableReason"] = reason
      }
      try emitJSON(payload)
      exit(0)
    } catch let error as AppshotError {
      FileHandle.standardError.write(Data("\(error.code): \(error.message)\n".utf8))
      exit(2)
    } catch {
      FileHandle.standardError.write(Data("APPSHOT_NATIVE_FAILURE: native capture failed\n".utf8))
      exit(2)
    }
  }
}

Task {
  await MacOSAppshotHelper.run()
}
dispatchMain()
