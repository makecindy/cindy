import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let secureTextFieldRole = "AXSecureTextField"
private let maximumCaptureDimension = 8_192

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
  let children: [FixtureNode]

  init(
    role: String,
    label: String? = nil,
    title: String? = nil,
    value: String? = nil,
    description: String? = nil,
    children: [FixtureNode] = []
  ) {
    self.role = role
    self.label = label
    self.title = title
    self.value = value
    self.description = description
    self.children = children
  }
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
  deadlineNode: Int? = nil
) -> AXSerialization {
  serializeTree(
    root: root,
    limits: limits,
    deadlineReached: { visited in deadlineNode.map { visited >= $0 } ?? false },
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
        ("value", node.value),
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

private func safeAXString(_ element: AXUIElement, _ attribute: CFString) -> String? {
  guard let value = copyAXAttribute(element, attribute), CFGetTypeID(value) == CFStringGetTypeID() else {
    return nil
  }
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

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  copyAXAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
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

  var pid: pid_t = 0
  if AXUIElementGetPid(window, &pid) == .success {
    AXUIElementSetMessagingTimeout(AXUIElementCreateApplication(pid), 0.1)
  }

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
    readNode: { element in
      let identity = CFHash(element)
      guard seen.insert(identity).inserted else { return nil }
      if deadlineReached(0) { return nil }

      let role = safeAXString(element, kAXRoleAttribute as CFString)
      if role == secureTextFieldRole {
        return TreeNodeSnapshot(
          fields: [("role", "Secure text field"), ("label", "Secure text field")],
          children: []
        )
      }

      var fields: [(String, String)] = []
      func add(_ name: String, _ value: @autoclosure () -> String?) {
        guard !deadlineReached(0), let value = value(), !value.isEmpty else { return }
        fields.append((name, value))
      }
      add("role", role)
      add("label", safeAXString(element, kAXDescriptionAttribute as CFString))
      add("title", safeAXString(element, kAXTitleAttribute as CFString))
      add("value", safeAXPrimitive(element, kAXValueAttribute as CFString))
      add("description", safeAXString(element, kAXHelpAttribute as CFString))
      add("enabled", safeAXPrimitive(element, kAXEnabledAttribute as CFString))
      add("selected", safeAXPrimitive(element, kAXSelectedAttribute as CFString))
      add("focused", safeAXPrimitive(element, kAXFocusedAttribute as CFString))
      return TreeNodeSnapshot(fields: fields, children: deadlineReached(0) ? [] : axChildren(element))
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
  return (value as! AXUIElement)
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

private func windowAlpha(_ window: SCWindow) -> Double? {
  guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], window.windowID) as? [[String: Any]],
        let windowInfo = info.first else { return nil }
  return (windowInfo[kCGWindowAlpha as String] as? NSNumber)?.doubleValue
}

func frontmostTarget() async throws -> (app: NSRunningApplication, window: SCWindow, axWindow: AXUIElement?) {
  guard let app = NSWorkspace.shared.frontmostApplication,
        !app.isTerminated,
        app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
        app.processIdentifier != getppid(),
        app.activationPolicy != .prohibited else { throw AppshotError.noWindow }

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
      && windowAlpha(candidate).map { $0 > 0 } != false
      && isFiniteNormalFrame(candidate.frame)
  }
  guard !candidates.isEmpty else { throw AppshotError.noWindow }

  let titleAndBoundsMatch = candidates.first { candidate in
    guard let axTitle, candidate.title == axTitle, let focusedBounds else { return false }
    return approximatelyMatches(candidate.frame, focusedBounds)
  }
  let titleMatch = candidates.first { candidate in
    guard let axTitle else { return false }
    return candidate.title == axTitle
  }
  let boundsMatch = candidates.first { candidate in
    guard let focusedBounds else { return false }
    return approximatelyMatches(candidate.frame, focusedBounds)
  }
  let selected = titleAndBoundsMatch ?? titleMatch ?? boundsMatch ?? candidates[0]
  return (app, selected, axWindow)
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

func captureWindow(_ window: SCWindow, to outputURL: URL) async throws -> CGImage {
  let frame = window.frame
  guard isFiniteNormalFrame(frame) else { throw AppshotError.noWindow }
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
    try pngData(for: image).write(to: outputURL, options: .atomic)
  } catch let error as AppshotError {
    throw error
  } catch {
    throw AppshotError.nativeFailure
  }
  return image
}

func validatedOutputURL(argument: String) throws -> URL {
  guard argument.hasPrefix("/") else { throw AppshotError.invalidOutput }
  let directory = URL(fileURLWithPath: argument, isDirectory: true)
    .standardizedFileURL
    .resolvingSymlinksInPath()
  guard directory.path.hasPrefix("/"),
        let values = try? directory.resourceValues(forKeys: [.isDirectoryKey]),
        values.isDirectory == true else { throw AppshotError.invalidOutput }
  let output = directory.appendingPathComponent("appshot.png", isDirectory: false)
  if FileManager.default.fileExists(atPath: output.path) {
    guard let values = try? output.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
          values.isSymbolicLink != true,
          values.isRegularFile == true else {
      throw AppshotError.invalidOutput
    }
  } else if let values = try? output.resourceValues(forKeys: [.isSymbolicLinkKey]),
            values.isSymbolicLink == true {
    throw AppshotError.invalidOutput
  }
  return output
}

private func emitJSON(_ payload: [String: Any]) throws {
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func runSelfTest() -> Bool {
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

  let deadlineLimited = serializeFixture(siblings, limits: ordinaryLimits, deadlineNode: 2)
  return deadlineLimited.truncated
    && deadlineLimited.text?.contains("button-0") == true
    && deadlineLimited.text?.contains("button-1") == false
}

private enum MacOSAppshotHelper {
  static func run() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--self-test"] {
      guard runSelfTest() else { exit(1) }
      do {
        try emitJSON(["type": "self-test", "ok": true])
        exit(0)
      } catch {
        exit(1)
      }
    }

    do {
      guard arguments.count == 2, arguments[0] == "--output-dir" else {
        throw AppshotError.invalidOutput
      }
      let outputURL = try validatedOutputURL(argument: arguments[1])
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
