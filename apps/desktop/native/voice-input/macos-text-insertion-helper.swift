import AppKit
import ApplicationServices
import Foundation

enum HelperError: Error, CustomStringConvertible {
  case missingValue(String)
  case invalidArgument(String)
  case accessibilityNotTrusted
  case targetNotFound
  case commandFailed(String)
  case unsupported(String)

  var description: String {
    switch self {
    case .missingValue(let name):
      return "Missing value for \(name)"
    case .invalidArgument(let message):
      return message
    case .accessibilityNotTrusted:
      return "Accessibility permission is not granted"
    case .targetNotFound:
      return "Could not identify the target app for voice input."
    case .commandFailed(let message):
      return message
    case .unsupported(let message):
      return message
    }
  }
}

struct Options {
  var command = "capture-target"
  var text = ""
  var key = ""
  var scrollDeltaY = 0
  var targetPid: pid_t?
  var targetBundleId = ""
  var targetName = ""
  /// Only collect the focused window frame when the caller actually needs it.
  /// On a single-display Mac the answer cannot change which display the overlay
  /// opens on, and on an AX-slow target these extra requests each cost up to the
  /// configured messaging timeout — that would delay the paste target capture for
  /// nothing.
  var withFocusedFrame = false
}

struct Snapshot {
  let appName: String?
  let bundleId: String?
  let pid: pid_t
  let role: String?
  let value: String?
  let selectedText: String?
  let selectedRange: CFRange?
  let numberOfCharacters: Int?

  var valueChars: Int? { value?.count }
  var selectedTextChars: Int? { selectedText?.count }
  var selectedRangeFingerprint: String? {
    guard let selectedRange else { return nil }
    return "\(selectedRange.location):\(selectedRange.length)"
  }
}

final class LazyTextProvider: NSObject, NSPasteboardItemDataProvider {
  let text: String
  private let requestedTypesLock = NSLock()
  private var lockedRequestedTypes: [String] = []
  var hasRequestedTypes: Bool {
    requestedTypesLock.lock()
    defer { requestedTypesLock.unlock() }
    return !lockedRequestedTypes.isEmpty
  }
  var requestedTypesSnapshot: [String] {
    requestedTypesLock.lock()
    defer { requestedTypesLock.unlock() }
    return lockedRequestedTypes
  }

  init(text: String) {
    self.text = text
  }

  func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
    requestedTypesLock.lock()
    lockedRequestedTypes.append(type.rawValue)
    requestedTypesLock.unlock()
    if type == .string {
      item.setString(text, forType: .string)
      return
    }
    item.setData(text.data(using: .utf8) ?? Data(), forType: type)
  }
}

final class PasteboardSnapshot {
  struct Item {
    let values: [(NSPasteboard.PasteboardType, Data)]
  }

  let items: [Item]

  init(_ pasteboard: NSPasteboard) {
    items = (pasteboard.pasteboardItems ?? []).map { item in
      let values = item.types.compactMap { type -> (NSPasteboard.PasteboardType, Data)? in
        guard let data = item.data(forType: type) else { return nil }
        return (type, data)
      }
      return Item(values: values)
    }
  }

  func restore(to pasteboard: NSPasteboard) -> Bool {
    pasteboard.clearContents()
    let restoredItems = items.map { source -> NSPasteboardItem in
      let item = NSPasteboardItem()
      for (type, data) in source.values {
        item.setData(data, forType: type)
      }
      return item
    }
    if restoredItems.isEmpty {
      return true
    }
    return pasteboard.writeObjects(restoredItems)
  }
}

func parseOptions() throws -> Options {
  var options = Options()
  var iterator = CommandLine.arguments.dropFirst().makeIterator()
  while let arg = iterator.next() {
    switch arg {
    case "--command":
      guard let value = iterator.next() else { throw HelperError.missingValue(arg) }
      options.command = value
    case "--text":
      guard let value = iterator.next() else { throw HelperError.missingValue(arg) }
      options.text = value
    case "--target-pid":
      guard let value = iterator.next(), let intValue = Int32(value) else {
        throw HelperError.invalidArgument("Invalid --target-pid value")
      }
      options.targetPid = intValue
    case "--target-bundle-id":
      guard let value = iterator.next() else { throw HelperError.missingValue(arg) }
      options.targetBundleId = value
    case "--target-name":
      guard let value = iterator.next() else { throw HelperError.missingValue(arg) }
      options.targetName = value
    case "--with-focused-frame":
      options.withFocusedFrame = true
    case "--key":
      guard let value = iterator.next() else { throw HelperError.missingValue(arg) }
      options.key = value
    case "--scroll-delta-y":
      guard let value = iterator.next(), let intValue = Int(value) else {
        throw HelperError.invalidArgument("Invalid --scroll-delta-y value")
      }
      options.scrollDeltaY = intValue
    default:
      throw HelperError.invalidArgument("Unknown argument: \(arg)")
    }
  }
  if options.command == "paste-verified" && options.text.isEmpty {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    options.text = String(data: inputData, encoding: .utf8) ?? ""
  }
  return options
}

func resolveTargetApplication(options: Options) -> NSRunningApplication? {
  if let pid = options.targetPid,
     let app = NSRunningApplication(processIdentifier: pid) {
    return app
  }
  if !options.targetBundleId.isEmpty {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: options.targetBundleId)
    if let app = apps.first {
      return app
    }
  }
  if !options.targetName.isEmpty {
    return NSWorkspace.shared.runningApplications.first { app in
      app.localizedName == options.targetName
    }
  }
  return NSWorkspace.shared.frontmostApplication
}

func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute, &value)
  return error == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
  guard let value = copyAttribute(element, attribute) else { return nil }
  if let string = value as? String {
    return string
  }
  return String(describing: value)
}

func intAttribute(_ element: AXUIElement, _ attribute: CFString) -> Int? {
  guard let value = copyAttribute(element, attribute) else { return nil }
  if let number = value as? NSNumber {
    return number.intValue
  }
  return nil
}

func rangeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFRange? {
  guard let value = copyAttribute(element, attribute) else { return nil }
  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  var range = CFRange()
  if AXValueGetValue(axValue, .cfRange, &range) {
    return range
  }
  return nil
}

func snapshot(for app: NSRunningApplication) -> Snapshot {
  let fallback = Snapshot(
    appName: app.localizedName,
    bundleId: app.bundleIdentifier,
    pid: app.processIdentifier,
    role: nil,
    value: nil,
    selectedText: nil,
    selectedRange: nil,
    numberOfCharacters: nil
  )
  guard AXIsProcessTrusted() else { return fallback }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(axApp, 0.8)
  guard let focusedValue = copyAttribute(axApp, kAXFocusedUIElementAttribute as CFString),
        CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
    return fallback
  }
  let focused = focusedValue as! AXUIElement
  AXUIElementSetMessagingTimeout(focused, 0.8)
  return Snapshot(
    appName: app.localizedName,
    bundleId: app.bundleIdentifier,
    pid: app.processIdentifier,
    role: stringAttribute(focused, kAXRoleAttribute as CFString),
    value: stringAttribute(focused, kAXValueAttribute as CFString),
    selectedText: stringAttribute(focused, kAXSelectedTextAttribute as CFString),
    selectedRange: rangeAttribute(focused, kAXSelectedTextRangeAttribute as CFString),
    numberOfCharacters: intAttribute(focused, kAXNumberOfCharactersAttribute as CFString)
  )
}

// Allowlist intentionally excludes AXSecureTextField. macOS exposes password
// fields (NSSecureTextField, Chromium/WebKit `<input type="password">`) under
// that role specifically, so they are filtered here BEFORE we read AXValue
// for the focused element context — the captured surroundings end up in
// refiner prompts and must not include secret input.
//
// Plain text fields containing sensitive content (API keys, tokens, etc.)
// can't be distinguished from regular text fields via AX role alone. If the
// false-positive rate becomes a real concern, a bundleId blocklist for known
// credential apps (1Password, Keychain Access, etc.) is the next defense.
func isTextRole(_ role: String?) -> Bool {
  role == "AXTextArea" || role == "AXTextField"
}

func expectedAfterChars(before: Snapshot, insertedChars: Int) -> Int? {
  guard let beforeChars = before.valueChars else { return nil }
  if let selectedTextChars = before.selectedTextChars {
    return beforeChars - selectedTextChars + insertedChars
  }
  if let selectedRange = before.selectedRange {
    return beforeChars - selectedRange.length + insertedChars
  }
  return beforeChars + insertedChars
}

func runCommand(_ executable: String, _ arguments: [String]) throws -> String {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  let output = Pipe()
  let error = Pipe()
  process.standardOutput = output
  process.standardError = error
  try process.run()
  process.waitUntilExit()
  let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  let stderr = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  if process.terminationStatus != 0 {
    throw HelperError.commandFailed(stderr.isEmpty ? stdout : stderr)
  }
  return stdout
}

func elapsedMs(since startedAt: Date) -> Int {
  max(0, Int((Date().timeIntervalSince(startedAt) * 1000).rounded()))
}

func isSameRunningApplication(_ current: NSRunningApplication?, _ target: NSRunningApplication) -> Bool {
  guard let current else { return false }
  if current.processIdentifier == target.processIdentifier {
    return true
  }
  if let currentBundleId = current.bundleIdentifier,
     let targetBundleId = target.bundleIdentifier,
     !targetBundleId.isEmpty,
     currentBundleId == targetBundleId {
    return true
  }
  if let currentName = current.localizedName,
     let targetName = target.localizedName,
     !targetName.isEmpty,
     currentName == targetName {
    return true
  }
  return false
}

func focusTargetApplication(_ app: NSRunningApplication) throws -> (name: String?, bundleId: String?, restored: Bool) {
  // The overlay is shown inactive, so in the common path the user's target app
  // is still frontmost. Skip activation/System Events entirely in that case:
  // activating an already-frontmost app is cheap in theory but measured as the
  // dominant pre-Cmd+V cost for global dictation.
  if let frontmost = NSWorkspace.shared.frontmostApplication,
     isSameRunningApplication(frontmost, app) {
    return (frontmost.localizedName, frontmost.bundleIdentifier, false)
  }

  // If focus did drift, native activation is fast and avoids relying solely on
  // System Events to rebuild the target app's first responder before paste.
  if #available(macOS 14.0, *) {
    app.activate()
  } else {
    app.activate(options: [.activateIgnoringOtherApps])
  }
  if waitUntil(Date().addingTimeInterval(0.12), {
    guard let frontmost = NSWorkspace.shared.frontmostApplication else { return false }
    return isSameRunningApplication(frontmost, app)
  }), let frontmost = NSWorkspace.shared.frontmostApplication {
    return (frontmost.localizedName, frontmost.bundleIdentifier, true)
  }

  let script = """
  on run argv
    set targetPid to item 1 of argv
    set targetBundleId to item 2 of argv
    set targetName to item 3 of argv
    tell application "System Events"
      if targetPid is not "" then
        try
          set frontmost of first application process whose unix id is targetPid to true
        end try
      end if
      if targetBundleId is not "" then
        try
          set frontmost of first application process whose bundle identifier is targetBundleId to true
        end try
      end if
      if targetName is not "" then
        try
          set frontmost of first application process whose name is targetName to true
        end try
      end if
      repeat with attempt from 1 to 7
        set frontApp to first application process whose frontmost is true
        set frontName to name of frontApp
        set frontBundleId to ""
        set frontPid to ""
        try
          set frontBundleId to bundle identifier of frontApp
        end try
        try
          set frontPid to (unix id of frontApp) as text
        end try
        if targetPid is not "" and frontPid is targetPid then
          return frontName & linefeed & frontBundleId
        end if
        if targetPid is "" and targetBundleId is not "" and frontBundleId is targetBundleId then
          return frontName & linefeed & frontBundleId
        end if
        if targetPid is "" and targetBundleId is "" and targetName is not "" and frontName is targetName then
          return frontName & linefeed & frontBundleId
        end if
        delay 0.03
      end repeat
      error "Could not restore focus to " & targetName & ". Current front app is " & frontName
    end tell
  end run
  """
  let stdout = try runCommand(
    "/usr/bin/osascript",
    [
      "-e",
      script,
      String(app.processIdentifier),
      app.bundleIdentifier ?? "",
      app.localizedName ?? "",
    ]
  )
  let lines = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map(String.init)
  let bundleId = lines.count > 1 && lines[1] != "missing value" ? lines[1] : nil
  return (lines.first, bundleId, true)
}

func postCommandV() throws {
  // Use a private event source so a still-held physical modifier from the
  // dictation shortcut does not turn Cmd+V into Cmd+Option+V / Cmd+Shift+V.
  guard let source = CGEventSource(stateID: .privateState),
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
    throw HelperError.commandFailed("Could not create Cmd+V keyboard event")
  }
  keyDown.flags = .maskCommand
  keyUp.flags = .maskCommand
  keyDown.post(tap: .cghidEventTap)
  waitWithRunLoop(for: 0.02)
  keyUp.post(tap: .cghidEventTap)
}

func virtualKey(for name: String) throws -> CGKeyCode {
  switch name {
  case "return", "enter":
    return 36
  case "up":
    return 126
  case "down":
    return 125
  default:
    throw HelperError.invalidArgument("Unknown key: \(name)")
  }
}

func requireAccessibilityTrusted() throws {
  guard AXIsProcessTrusted() else {
    throw HelperError.accessibilityNotTrusted
  }
}

func postHardwareKey(name: String) throws {
  try requireAccessibilityTrusted()
  let virtualKey = try virtualKey(for: name)
  guard let source = CGEventSource(stateID: .privateState),
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
    throw HelperError.commandFailed("Could not create \(name) keyboard event")
  }
  keyDown.post(tap: .cghidEventTap)
  waitWithRunLoop(for: 0.02)
  keyUp.post(tap: .cghidEventTap)
}

func postScroll(deltaY: Int) throws {
  guard deltaY != 0 else { return }
  let wheel1 = Int32(clamping: deltaY)
  guard let source = CGEventSource(stateID: .privateState),
        let event = CGEvent(
          scrollWheelEvent2Source: source,
          units: .pixel,
          wheelCount: 1,
          wheel1: wheel1,
          wheel2: 0,
          wheel3: 0
        ) else {
    throw HelperError.commandFailed("Could not create scroll event")
  }
  event.post(tap: .cghidEventTap)
}

func keyEventPayload(options: Options) throws -> [String: Any] {
  let name = options.key.isEmpty ? "return" : options.key
  try postHardwareKey(name: name)
  return [
    "ok": true,
    "status": "ok",
    "outcome": "verified_success",
    "method": "post-key",
    "key": name,
  ]
}

func scrollEventPayload(options: Options) throws -> [String: Any] {
  try requireAccessibilityTrusted()
  try postScroll(deltaY: options.scrollDeltaY)
  return [
    "ok": true,
    "status": "ok",
    "outcome": "verified_success",
    "method": "post-scroll",
    "scrollDeltaY": options.scrollDeltaY,
  ]
}

/// Stay alive and post wheel events until stdin says stop. The parent writes
/// signed pixels/second; we own the 16ms clock so a held stick keeps scrolling
/// even when the device stops sending move events.
func runHoldScroll() throws {
  try requireAccessibilityTrusted()
  let lock = NSLock()
  var velocity = 0
  var stopped = false
  DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine() {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed == "stop" { break }
      if let next = Int(trimmed) {
        lock.lock()
        velocity = next
        lock.unlock()
      }
    }
    lock.lock()
    stopped = true
    lock.unlock()
  }
  var last = Date()
  while true {
    waitWithRunLoop(for: 0.016)
    lock.lock()
    let current = velocity
    let done = stopped
    lock.unlock()
    if done { break }
    let now = Date()
    let dt = min(0.1, now.timeIntervalSince(last))
    last = now
    let delta = Int((Double(current) * dt).rounded())
    if delta != 0 {
      try postScroll(deltaY: delta)
    }
  }
}

func waitWithRunLoop(for interval: TimeInterval) {
  let deadline = Date().addingTimeInterval(interval)
  while Date() < deadline {
    let slice = min(0.03, max(0.001, deadline.timeIntervalSinceNow))
    let sliceEnd = Date().addingTimeInterval(slice)
    _ = RunLoop.current.run(mode: .default, before: sliceEnd)
    let remaining = sliceEnd.timeIntervalSinceNow
    if remaining > 0 {
      Thread.sleep(forTimeInterval: remaining)
    }
  }
}

func waitUntil(_ deadline: Date, _ predicate: () -> Bool) -> Bool {
  while Date() < deadline {
    if predicate() { return true }
    waitWithRunLoop(for: min(0.03, max(0.001, deadline.timeIntervalSinceNow)))
  }
  return predicate()
}

// Cap on selectionBefore/After length we ship to the refiner. 800 chars each
// side is enough to convey local context (recent paragraph, current sentence)
// without bloating the prompt or adding latency. The TS layer truncates again
// to MAX_REFINEMENT_SIDE_CONTEXT_CHARS, so this is just a fast pre-trim that
// avoids carrying multi-MB of editor content over stdout for big text views.
let CAPTURE_CONTEXT_MAX_SIDE_CHARS = 800
// Full-field content is only used for local edit tracking after a global paste.
// Keep it bounded: small chat inputs benefit from exact diffing, while very
// large editors fall back to cursor-side anchors instead of flooding stdout.
let CAPTURE_CONTEXT_MAX_FULL_FIELD_CHARS = 12000
let CAPTURE_CONTEXT_MAX_TREE_NODES = 700
let AX_SELECTED_TEXT_MARKER_RANGE = "AXSelectedTextMarkerRange" as CFString
let AX_TEXT_MARKER_RANGE_FOR_UI_ELEMENT = "AXTextMarkerRangeForUIElement" as CFString
let AX_STRING_FOR_TEXT_MARKER_RANGE = "AXStringForTextMarkerRange" as CFString

func captureTargetPayload(withFocusedFrame: Bool) -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else {
    return [
      "ok": false,
      "error": "No frontmost application"
    ]
  }
  // Read the focused window frame FIRST, before any AX mutation below: it must
  // describe the same frontmostApplication snapshot as the paste target, and it
  // must not observe a layout perturbed by the AXEnhancedUserInterface flip.
  // Deriving both from one helper run is what keeps "which display do we open
  // on" and "which app do we paste into" from disagreeing — two separate helper
  // processes would each read frontmostApplication at a slightly different
  // moment.
  // Two frames, streamed in cost order, each on its own line before the
  // (potentially slow) context capture below:
  //
  // 1. CGWindowList — an in-process window-server query with no Accessibility
  //    grant and no per-request timeout. It always lands inside the caller's
  //    ~90 ms display-selection deadline, but z-order is only an approximation of
  //    focus: an app's unfocused always-on-top palette can sit in front of the
  //    focused document.
  // 2. AX kAXFocusedWindow — authoritative about focus, but each request can burn
  //    a messaging timeout against an unresponsive target, so it may miss the
  //    deadline entirely.
  //
  // Emitting both lets the caller use the accurate answer whenever it arrives in
  // time and still have a usable one when it does not. The final payload carries
  // the best available frame so buffered callers keep working.
  var bestFrame: (frame: [String: Any], source: String)? = nil
  if withFocusedFrame {
    if let listFrame = frontWindowFrameFromWindowList(pid: app.processIdentifier) {
      bestFrame = (listFrame, "window-list")
      emitLine([
        "event": "focused-window-frame",
        "frame": listFrame,
        "frameSource": "window-list"
      ])
    }
    if let axFrame = axFocusedWindowFrame(for: app) {
      bestFrame = (axFrame, "ax")
      emitLine([
        "event": "focused-window-frame",
        "frame": axFrame,
        "frameSource": "ax"
      ])
    }
  }
  let focusedFrame = bestFrame
  var context = captureFocusedElementContext(for: app)
  var enhancedAxAttempted = false
  var enhancedAxHelped = false
  var enhancedAxLifecycle: EnhancedAxLifecycle? = nil

  // Keep capture-target capability aligned with paste-verified: Chromium-based
  // shells (Feishu/Lark, Claude, Cursor, many browsers) often hide the real
  // focused editor until AXEnhancedUserInterface is flipped on the focused
  // window. Without this, global dictation can paste correctly but still fail
  // to collect the before/after text needed for refinement context and
  // dictionary-learning edit tracking.
  if context == nil {
    enhancedAxAttempted = true
    installEnhancedAxSignalHandlers()
    enhancedAxLifecycle = tryEnableEnhancedAxOnFocusedWindow(of: app)
    if enhancedAxLifecycle != nil {
      context = captureFocusedElementContext(for: app)
      enhancedAxHelped = context != nil
    }
  }
  defer {
    revertEnhancedAxIfNeeded(enhancedAxLifecycle)
    if enhancedAxLifecycle != nil {
      pendingEnhancedAxLifecycle = nil
    }
  }

  var payload: [String: Any] = [
    "ok": true,
    "target": [
      "processName": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? "",
      "pid": Int(app.processIdentifier)
    ],
    "enhancedAxAttempted": enhancedAxAttempted,
    "enhancedAxHelped": enhancedAxHelped
  ]
  if let context = context {
    payload["context"] = context
  }
  if let focusedFrame = focusedFrame {
    payload["frame"] = focusedFrame.frame
    payload["frameSource"] = focusedFrame.source
  }
  return payload
}

// Reports the frontmost window's frame so the global voice overlay can open on
// the display the user is actually working on.
//
// Coordinates are AX/CGWindow screen coordinates: origin at the top-left of the
// primary display, y growing downwards, in points. That matches Electron's DIP
// screen coordinate space on macOS, so main can feed the frame straight into
// screen.getDisplayMatching().

func axFocusedWindowFrame(for app: NSRunningApplication) -> [String: Any]? {
  guard AXIsProcessTrusted() else { return nil }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(axApp, 0.2)
  guard let windowValue = copyAttribute(axApp, kAXFocusedWindowAttribute as CFString),
        CFGetTypeID(windowValue) == AXUIElementGetTypeID() else {
    return nil
  }
  let window = windowValue as! AXUIElement
  AXUIElementSetMessagingTimeout(window, 0.2)
  guard let origin = axPointAttribute(window, kAXPositionAttribute as CFString),
        let size = axSizeAttribute(window, kAXSizeAttribute as CFString) else {
    return nil
  }
  return [
    "x": Double(origin.x),
    "y": Double(origin.y),
    "width": Double(size.width),
    "height": Double(size.height)
  ]
}

func axPointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
  guard let value = copyAttribute(element, attribute),
        CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  var point = CGPoint.zero
  guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
  return point
}

func axSizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
  guard let value = copyAttribute(element, attribute),
        CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  var size = CGSize.zero
  guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
  return size
}

func frontWindowFrameFromWindowList(pid: pid_t) -> [String: Any]? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  // This is the deadline-safe approximation only; AX kAXFocusedWindow is what
  // actually knows where focus is, and the caller prefers it whenever it arrives
  // in time (see captureTargetPayload).
  //
  // Within that role, prefer the frontmost layer-0 window: an app's document
  // windows live on layer 0, while higher layers hold palettes, tooltips and
  // always-on-top helpers that are commonly NOT focused. Only if the app exposes
  // no layer-0 window at all do we fall back to its frontmost window on any layer
  // (some apps are panel-only).
  var fallbackAnyLayer: [String: Any]? = nil
  for window in windows {
    // 这些值是 NSNumber。不要写 `as? pid_t`：NSNumber 只桥接到 Int，条件转换到
    // Int32 会一律失败，整条兜底就变成永远返回 nil。
    guard let ownerPid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
          ownerPid == pid else { continue }
    // 完全透明的窗口不是用户在看的东西（点击穿透层、隐藏的辅助窗口）。
    if let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha <= 0 {
      continue
    }
    guard let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else {
      continue
    }
    // 退化尺寸同样跳过：1x1 之类的占位窗口没法用来判断用户在哪块屏。
    if rect.width <= 1 || rect.height <= 1 { continue }
    let frame: [String: Any] = [
      "x": Double(rect.origin.x),
      "y": Double(rect.origin.y),
      "width": Double(rect.width),
      "height": Double(rect.height)
    ]
    let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue
    if layer == 0 { return frame }
    if fallbackAnyLayer == nil { fallbackAnyLayer = frame }
  }
  return fallbackAnyLayer
}

// Extracts before/selected/after text around the cursor in the focused element.
// Used by the global voice overlay path to give the refiner the same kind of
// surrounding context that ChatInput already provides for in-app dictation —
// without it, global refine has to rely on dictation history alone, which
// produces noticeably worse output for proper-noun and reference-resolution
// cases.
//
// Returns nil if AX is not trusted or the focused input does not expose either
// normal AXValue/AXSelectedTextRange or Chromium's TextMarker APIs. We
// intentionally do not use generic visible-window text as a fallback: Typeless
// keeps that as app context only, while dictionary learning needs the actual
// insertion point's full field content.
func captureFocusedElementContext(for app: NSRunningApplication) -> [String: Any]? {
  guard let focused = focusedElement(for: app) else { return nil }
  AXUIElementSetMessagingTimeout(focused, 0.25)

  let role = stringAttribute(focused, kAXRoleAttribute as CFString)
  if isTextRole(role), let value = stringAttribute(focused, kAXValueAttribute as CFString) {
    return buildTextContext(
      value: value,
      selectedRange: rangeAttribute(focused, kAXSelectedTextRangeAttribute as CFString),
      focusedRole: role,
      contextSource: "ax_value"
    )
  }

  if let markerContext = captureTextMarkerContext(element: focused, role: role) {
    return markerContext
  }

  return captureWindowTextContext(for: app)
}

func focusedElement(for app: NSRunningApplication) -> AXUIElement? {
  guard AXIsProcessTrusted() else { return nil }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(axApp, 0.8)
  guard let focusedValue = copyAttribute(axApp, kAXFocusedUIElementAttribute as CFString),
        CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
    return nil
  }
  return (focusedValue as! AXUIElement)
}

func copyParameterizedAttribute(_ element: AXUIElement, _ attribute: CFString, _ parameter: CFTypeRef) -> CFTypeRef? {
  var value: CFTypeRef?
  let error = AXUIElementCopyParameterizedAttributeValue(element, attribute, parameter, &value)
  return error == .success ? value : nil
}

func stringForTextMarkerRange(_ element: AXUIElement, _ range: CFTypeRef) -> String? {
  guard let value = copyParameterizedAttribute(element, AX_STRING_FOR_TEXT_MARKER_RANGE, range) else {
    return nil
  }
  return value as? String
}

func captureTextMarkerContext(element: AXUIElement, role: String?) -> [String: Any]? {
  if role == "AXSecureTextField" { return nil }
  guard let fullRange = copyParameterizedAttribute(element, AX_TEXT_MARKER_RANGE_FOR_UI_ELEMENT, element),
        let fullText = stringForTextMarkerRange(element, fullRange),
        !fullText.isEmpty else {
    return nil
  }
  let selectedRange = rangeAttribute(element, kAXSelectedTextRangeAttribute as CFString)
  let selectedText = copyAttribute(element, AX_SELECTED_TEXT_MARKER_RANGE)
    .flatMap { stringForTextMarkerRange(element, $0) }
  return buildTextContext(
    value: fullText,
    selectedRange: selectedRange,
    focusedRole: role,
    selectedTextFallback: selectedText,
    contextSource: "text_marker",
    assumeCursorAtEndWhenRangeMissing: false
  )
}

func buildTextContext(
  value: String,
  selectedRange: CFRange?,
  focusedRole: String?,
  selectedTextFallback: String? = nil,
  contextSource: String? = nil,
  assumeCursorAtEndWhenRangeMissing: Bool = true
) -> [String: Any] {

  // AX uses NSString (UTF-16 code unit) indices, so go through NSString to
  // slice. Swift String indices would mis-count surrogate pairs and emoji
  // would shift the cursor location relative to AX's view.
  let nsValue = value as NSString
  let total = nsValue.length
  if selectedRange == nil && !assumeCursorAtEndWhenRangeMissing {
    return [
      "selectionBefore": "",
      "selectedText": selectedTextFallback ?? "",
      "selectionAfter": "",
      "fullFieldContent": total <= CAPTURE_CONTEXT_MAX_FULL_FIELD_CHARS ? value : NSNull(),
      "fullFieldContentTruncated": total > CAPTURE_CONTEXT_MAX_FULL_FIELD_CHARS,
      "totalChars": total,
      "selectionLocation": NSNull(),
      "selectionLength": NSNull(),
      "focusedRole": focusedRole ?? NSNull(),
      "contextSource": contextSource ?? "unknown",
    ]
  }
  let rawLocation = selectedRange?.location ?? total
  let rawLength = selectedRange?.length ?? 0
  let location = max(0, min(rawLocation, total))
  let length = max(0, min(rawLength, total - location))

  let beforeStart = max(0, location - CAPTURE_CONTEXT_MAX_SIDE_CHARS)
  let beforeRange = NSRange(location: beforeStart, length: location - beforeStart)
  let selectedRange = NSRange(location: location, length: length)
  let afterEnd = min(total, location + length + CAPTURE_CONTEXT_MAX_SIDE_CHARS)
  let afterRange = NSRange(location: location + length, length: afterEnd - (location + length))

  return [
    "selectionBefore": nsValue.substring(with: beforeRange),
    "selectedText": nsValue.substring(with: selectedRange),
    "selectionAfter": nsValue.substring(with: afterRange),
    "fullFieldContent": total <= CAPTURE_CONTEXT_MAX_FULL_FIELD_CHARS ? value : NSNull(),
    "fullFieldContentTruncated": total > CAPTURE_CONTEXT_MAX_FULL_FIELD_CHARS,
    "totalChars": total,
    "selectionLocation": location,
    "selectionLength": length,
    "focusedRole": focusedRole ?? NSNull(),
    "contextSource": contextSource ?? "unknown",
  ]
}

func focusedWindowElement(for app: NSRunningApplication) -> AXUIElement? {
  guard AXIsProcessTrusted() else { return nil }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(axApp, 0.3)
  guard let windowValue = copyAttribute(axApp, kAXFocusedWindowAttribute as CFString),
        CFGetTypeID(windowValue) == AXUIElementGetTypeID() else {
    return axApp
  }
  return (windowValue as! AXUIElement)
}

func elementChildren(_ element: AXUIElement, _ attribute: CFString) -> [AXUIElement] {
  guard let value = copyAttribute(element, attribute) else { return [] }
  guard let values = value as? [Any] else { return [] }
  return values.compactMap { item in
    guard CFGetTypeID(item as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
    return (item as! AXUIElement)
  }
}

func uniqueChildren(_ element: AXUIElement) -> [AXUIElement] {
  var result: [AXUIElement] = []
  var seen = Set<String>()
  for child in elementChildren(element, kAXVisibleChildrenAttribute as CFString) +
    elementChildren(element, kAXChildrenAttribute as CFString) {
    let key = String(describing: child)
    if seen.insert(key).inserted {
      AXUIElementSetMessagingTimeout(child, 0.12)
      result.append(child)
    }
  }
  return result
}

func captureWindowTextContext(for app: NSRunningApplication) -> [String: Any]? {
  guard let root = focusedWindowElement(for: app) else { return nil }
  AXUIElementSetMessagingTimeout(root, 0.12)

  var visited = 0
  let deadline = Date().addingTimeInterval(0.45)

  func visit(_ element: AXUIElement, depth: Int) -> [String: Any]? {
    if visited >= CAPTURE_CONTEXT_MAX_TREE_NODES || depth > 14 || Date() > deadline {
      return nil
    }
    visited += 1

    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    if role == "AXSecureTextField" {
      return nil
    }

    if isTextRole(role), let value = stringAttribute(element, kAXValueAttribute as CFString) {
      return buildTextContext(
        value: value,
        selectedRange: rangeAttribute(element, kAXSelectedTextRangeAttribute as CFString),
        focusedRole: role,
        contextSource: "window_ax_value"
      )
    }

    if let markerContext = captureTextMarkerContext(element: element, role: role) {
      return markerContext
    }

    for child in uniqueChildren(element) {
      if let context = visit(child, depth: depth + 1) {
        return context
      }
    }
    return nil
  }

  if let textContext = visit(root, depth: 0) {
    return textContext
  }
  return nil
}

// AXEnhancedUserInterface is an undocumented but widely-honored AX attribute.
// Setting it on a Chromium-based app's focused window (browsers + newer Electron
// apps like Claude for Desktop / Cursor / Notion app) forces Chromium to build
// its full web-content AX tree, which is otherwise gated on AT software being
// active. Same trick used by https://github.com/joewongjc/type4me. We flip it on
// only when the first AX snapshot returns nothing useful, then revert at the
// end of the paste so the cost (target app builds + maintains the tree) is paid
// just for this paste, not permanently.
struct EnhancedAxLifecycle {
  let window: AXUIElement
  /// True only when WE flipped it. If the user / another AT tool already had it
  /// on, we leave it alone on the way out.
  let setByUs: Bool
}

// Tracks the live Enhanced-AX lifecycle for best-effort SIGTERM cleanup.
// defer-based revert only runs on clean function return; if the controller
// kills this helper mid-paste (timeout = SIGTERM by default), defer doesn't
// fire and the target app is left with AXEnhancedUserInterface = true
// forever (until the app restarts). The signal handler below performs a
// best-effort revert on SIGTERM / SIGINT / SIGHUP so the leak window
// collapses to "helper hit SIGKILL or crashed", which is much rarer.
//
// Caveats / why this is "best-effort", not "always":
//
//   1. A tiny race exists between AXUIElementSetAttributeValue(true) inside
//      tryEnableEnhancedAxOnFocusedWindow returning success and that same
//      function publishing the lifecycle to pendingEnhancedAxLifecycle. If
//      the signal lands inside that gap, the handler sees nil and does not
//      revert. The window is one assignment wide (nanoseconds) but real.
//   2. SIGKILL and hard crashes cannot run any userspace handler at all.
//   3. Signal handlers run on an arbitrary thread and can preempt almost
//      anything; AXUIElementSetAttributeValue is not documented as
//      async-signal-safe but is a simple IPC call to WindowServer and
//      works in practice (type4me runs the same trick without trouble).
//      We accept that small risk rather than leave the leak in.
nonisolated(unsafe) var pendingEnhancedAxLifecycle: EnhancedAxLifecycle?

private var enhancedAxSignalHandlersInstalled = false

func installEnhancedAxSignalHandlers() {
  if enhancedAxSignalHandlersInstalled { return }
  enhancedAxSignalHandlersInstalled = true
  let action: @convention(c) (Int32) -> Void = { sig in
    if let lifecycle = pendingEnhancedAxLifecycle, lifecycle.setByUs {
      _ = AXUIElementSetAttributeValue(
        lifecycle.window,
        "AXEnhancedUserInterface" as CFString,
        false as CFTypeRef
      )
    }
    // Re-raise with default handler so the process actually exits.
    signal(sig, SIG_DFL)
    raise(sig)
  }
  signal(SIGTERM, action)
  signal(SIGINT, action)
  signal(SIGHUP, action)
}

func tryEnableEnhancedAxOnFocusedWindow(of app: NSRunningApplication) -> EnhancedAxLifecycle? {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(appElement, 0.3)
  var windowValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    appElement,
    kAXFocusedWindowAttribute as CFString,
    &windowValue
  ) == .success,
    let windowValue,
    CFGetTypeID(windowValue) == AXUIElementGetTypeID()
  else { return nil }
  let window = windowValue as! AXUIElement
  AXUIElementSetMessagingTimeout(window, 0.3)

  var current: CFTypeRef?
  let getStatus = AXUIElementCopyAttributeValue(
    window,
    "AXEnhancedUserInterface" as CFString,
    &current
  )
  if getStatus == .success, let n = current as? NSNumber, n.boolValue {
    return EnhancedAxLifecycle(window: window, setByUs: false)
  }

  let setStatus = AXUIElementSetAttributeValue(
    window,
    "AXEnhancedUserInterface" as CFString,
    true as CFTypeRef
  )
  guard setStatus == .success else { return nil }
  let lifecycle = EnhancedAxLifecycle(window: window, setByUs: true)
  // Publish to the signal-handler-visible slot AS CLOSE AS POSSIBLE to the
  // set that actually flipped Enhanced UI. There is still a one-statement
  // gap between AXUIElementSetAttributeValue returning success and this
  // assignment, but it is the narrowest we can make it without atomics.
  // See the pendingEnhancedAxLifecycle docstring.
  pendingEnhancedAxLifecycle = lifecycle
  return lifecycle
}

func revertEnhancedAxIfNeeded(_ lifecycle: EnhancedAxLifecycle?) {
  guard let lifecycle, lifecycle.setByUs else { return }
  _ = AXUIElementSetAttributeValue(
    lifecycle.window,
    "AXEnhancedUserInterface" as CFString,
    false as CFTypeRef
  )
}

// Own the whole paste cycle inside the native helper. Splitting this between
// Electron clipboard writes, AppleScript keystrokes, and JS-side AX polling made
// success/failure classification race-prone: the clipboard could be restored
// before the target consumed it, or AX could be sampled from a different focus
// state. The helper keeps those operations in one process and returns one of:
// verified_success, verified_failure, or unconfirmed.
func pasteVerifiedPayload(options: Options) -> [String: Any] {
  let totalStartedAt = Date()
  var timings: [String: Int] = [:]
  guard AXIsProcessTrusted() else {
    return buildPasteResult(
      outcome: "verified_failure",
      reason: HelperError.accessibilityNotTrusted.description,
      commandIssued: false,
      target: nil,
      before: nil,
      after: nil,
      providerRequested: false,
      requestedTypes: [],
      restoredClipboard: false,
      error: HelperError.accessibilityNotTrusted.description,
      timings: ["totalMs": elapsedMs(since: totalStartedAt)]
    )
  }
  guard let app = resolveTargetApplication(options: options) else {
    return buildPasteResult(
      outcome: "verified_failure",
      reason: HelperError.targetNotFound.description,
      commandIssued: false,
      target: nil,
      before: nil,
      after: nil,
      providerRequested: false,
      requestedTypes: [],
      restoredClipboard: false,
      error: HelperError.targetNotFound.description,
      timings: ["totalMs": elapsedMs(since: totalStartedAt)]
    )
  }

  var restoredClipboard = false
  var commandIssued = false
  var commandTargetApp: String?
  var commandTargetBundleId: String?

  do {
    let focusStartedAt = Date()
    let focusResult = try focusTargetApplication(app)
    timings["focusMs"] = elapsedMs(since: focusStartedAt)
    timings["focusRestored"] = focusResult.restored ? 1 : 0
    commandTargetApp = focusResult.name
    commandTargetBundleId = focusResult.bundleId
  } catch {
    timings["totalMs"] = elapsedMs(since: totalStartedAt)
    return buildPasteResult(
      outcome: "verified_failure",
      reason: "paste target focus failed",
      commandIssued: false,
      target: app,
      before: nil,
      after: nil,
      providerRequested: false,
      requestedTypes: [],
      restoredClipboard: false,
      error: String(describing: error),
      timings: timings
    )
  }

  let beforeSnapshotStartedAt = Date()
  var before = snapshot(for: app)
  let initialSnapshotWasAxBlind = before.role == nil
  var enhancedAxAttempted = false
  var enhancedAxHelped = false
  var enhancedAxLifecycle: EnhancedAxLifecycle? = nil

  // AX-blind first snapshot: try AXEnhancedUserInterface to coax Chromium-based
  // targets into building their full AX tree, then re-snapshot. Cost when it
  // doesn't help: a single AX round-trip + the 30ms wait, only on already-blind
  // targets. AXSecureTextField (password fields revealed via web AX) is
  // explicitly NOT promoted — the resulting char count would flow into the
  // result JSON, leaking length even though we never expose the value.
  if initialSnapshotWasAxBlind {
    enhancedAxAttempted = true
    installEnhancedAxSignalHandlers()
    // tryEnableEnhancedAxOnFocusedWindow publishes the lifecycle into
    // pendingEnhancedAxLifecycle itself immediately after the AX set call
    // succeeds, so the signal handler's visibility window is one assignment
    // wide instead of (the function-return + this caller-line) wide.
    enhancedAxLifecycle = tryEnableEnhancedAxOnFocusedWindow(of: app)
    if enhancedAxLifecycle != nil {
      waitWithRunLoop(for: 0.03)
      let postEnhanced = snapshot(for: app)
      if postEnhanced.role == "AXSecureTextField" {
        revertEnhancedAxIfNeeded(enhancedAxLifecycle)
        enhancedAxLifecycle = nil
        pendingEnhancedAxLifecycle = nil
      } else if postEnhanced.role != nil {
        before = postEnhanced
        enhancedAxHelped = true
      }
    }
  }
  // Always revert before returning, regardless of which return path fires.
  // Pair with the SIGTERM handler in installEnhancedAxSignalHandlers() so
  // the target window's AXEnhancedUserInterface gets cleared whether we
  // return normally or the controller kills us mid-paste.
  defer {
    revertEnhancedAxIfNeeded(enhancedAxLifecycle)
    pendingEnhancedAxLifecycle = nil
  }
  timings["beforeSnapshotMs"] = elapsedMs(since: beforeSnapshotStartedAt)

  let clipboardStartedAt = Date()
  let pasteboard = NSPasteboard.general
  let originalPasteboard = PasteboardSnapshot(pasteboard)
  let provider = LazyTextProvider(text: options.text)
  pasteboard.clearContents()
  let item = NSPasteboardItem()
  item.setDataProvider(provider, forTypes: [.string])
  // Tell clipboard managers (Maccy, Paste, Alfred, Pastebot, …) that this
  // entry is ephemeral so voice transcripts don't pile up in users'
  // clipboard history. Convention from http://nspasteboard.org/.
  item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
  pasteboard.writeObjects([item])
  timings["clipboardPrepareMs"] = elapsedMs(since: clipboardStartedAt)
  timings["timeToCommandVMs"] = elapsedMs(since: totalStartedAt)

  do {
    let commandStartedAt = Date()
    try postCommandV()
    commandIssued = true
    timings["commandVMs"] = elapsedMs(since: commandStartedAt)
  } catch {
    timings["totalMs"] = elapsedMs(since: totalStartedAt)
    return buildPasteResult(
      outcome: "verified_failure",
      reason: "paste command failed",
      commandIssued: false,
      target: app,
      before: before,
      after: nil,
      providerRequested: false,
      requestedTypes: [],
      restoredClipboard: originalPasteboard.restore(to: pasteboard),
      error: String(describing: error),
      commandTargetApp: commandTargetApp,
      commandTargetBundleId: commandTargetBundleId,
      timings: timings,
      enhancedAxAttempted: enhancedAxAttempted,
      enhancedAxHelped: enhancedAxHelped
    )
  }

  let waitPasteboardStartedAt = Date()
  _ = waitUntil(Date().addingTimeInterval(1.2)) {
    provider.hasRequestedTypes
  }
  timings["waitPasteboardMs"] = elapsedMs(since: waitPasteboardStartedAt)

  // Grace period before the clipboard restore. A non-empty requestedTypes only
  // proves the target made its FIRST read of our pasteboard — but Chromium /
  // Electron paste pipelines (Claude for Desktop, Cursor, Notion app, etc.)
  // are multi-stage: native side reads .string → IPC → renderer process
  // re-checks pasteboard for richer formats / runs paste handlers, all of
  // which can re-hit the pasteboard. If we restore the user's old clipboard
  // immediately after the first read, those follow-up reads see the OLD
  // content and the user ends up with whatever was on their clipboard before
  // dictation pasted into the target (observed: Claude for Desktop, delta
  // mismatched insertedChars by 3x). We use the longer consumed-pasteboard
  // window for every target: AX validation happens only after clipboard
  // restore, so it can detect a delayed stale read but cannot prevent it. A
  // bundle allowlist is also too brittle for browser PWAs and the long tail of
  // Electron/Chromium apps. Keep a shorter compatibility window when the target
  // has not consumed yet, so slow targets still get a chance to perform their
  // first read without holding the clipboard as long as a confirmed paste.
  let postRequestedGraceStartedAt = Date()
  var firstPasteboardConsumptionAt: Date?
  if provider.hasRequestedTypes {
    firstPasteboardConsumptionAt = postRequestedGraceStartedAt
  } else {
    _ = waitUntil(Date().addingTimeInterval(0.15)) {
      if provider.hasRequestedTypes {
        firstPasteboardConsumptionAt = Date()
        return true
      }
      return false
    }
  }
  if firstPasteboardConsumptionAt == nil && provider.hasRequestedTypes {
    firstPasteboardConsumptionAt = Date()
  }
  let pasteboardWasConsumed = firstPasteboardConsumptionAt != nil
  let postRequestedGraceTargetSeconds = pasteboardWasConsumed ? 0.5 : 0.15
  if let firstPasteboardConsumptionAt {
    let remainingConsumedGraceSeconds = 0.5 - Date().timeIntervalSince(firstPasteboardConsumptionAt)
    if remainingConsumedGraceSeconds > 0 {
      waitWithRunLoop(for: remainingConsumedGraceSeconds)
    }
  }
  timings["postRequestedGraceMs"] = elapsedMs(since: postRequestedGraceStartedAt)
  timings["postRequestedGraceTargetMs"] = Int(postRequestedGraceTargetSeconds * 1000)
  let requestedTypesAfterGrace = provider.requestedTypesSnapshot
  let providerRequestedAfterGrace = !requestedTypesAfterGrace.isEmpty

  // Restoring the user's clipboard only depends on pasteboard consumption, not
  // on whether AX can later prove the target inserted the text. Keep validation
  // after this point so slow/opaque AX never prolongs clipboard replacement.
  let restoreClipboardStartedAt = Date()
  restoredClipboard = originalPasteboard.restore(to: pasteboard)
  timings["restoreClipboardMs"] = elapsedMs(since: restoreClipboardStartedAt)
  timings["timeToRestoreClipboardMs"] = elapsedMs(since: totalStartedAt)

  let postPasteDelayStartedAt = Date()
  var afterSnapshotStartedAt = Date()
  var after = snapshot(for: app)
  var afterSnapshotMs = elapsedMs(since: afterSnapshotStartedAt)
  var classification = classifyPaste(
    before: before,
    after: after,
    insertedChars: options.text.count,
    providerRequested: providerRequestedAfterGrace
  )
  // Cmd+V has already been posted above. This wait only affects validation and
  // fallback timing, not when the target app receives the paste. Native text
  // fields often expose the new AX value immediately, but Electron/Web-based
  // inputs can consume the pasteboard first and update AX a few hundred ms
  // later. Return early only once success is proven; keep polling both
  // unconfirmed and failure evidence to avoid false fallback prompts.
  if classification.outcome != "verified_success" {
    _ = waitUntil(Date().addingTimeInterval(0.5)) {
      afterSnapshotStartedAt = Date()
      after = snapshot(for: app)
      afterSnapshotMs = elapsedMs(since: afterSnapshotStartedAt)
      classification = classifyPaste(
        before: before,
        after: after,
        insertedChars: options.text.count,
        providerRequested: provider.hasRequestedTypes
      )
      return classification.outcome == "verified_success"
    }
  }
  timings["afterSnapshotMs"] = afterSnapshotMs
  let finalRequestedTypes = provider.requestedTypesSnapshot
  let finalProviderRequested = !finalRequestedTypes.isEmpty
  if finalProviderRequested && classification.outcome != "verified_success" {
    _ = waitUntil(Date().addingTimeInterval(0.35)) {
      afterSnapshotStartedAt = Date()
      after = snapshot(for: app)
      afterSnapshotMs = elapsedMs(since: afterSnapshotStartedAt)
      timings["afterSnapshotMs"] = afterSnapshotMs
      classification = classifyPaste(
        before: before,
        after: after,
        insertedChars: options.text.count,
        providerRequested: true
      )
      return classification.outcome == "verified_success"
    }
  }
  timings["postPasteDelayMs"] = elapsedMs(since: postPasteDelayStartedAt)
  timings["totalMs"] = elapsedMs(since: totalStartedAt)

  return buildPasteResult(
    outcome: classification.outcome,
    reason: classification.reason,
    commandIssued: commandIssued,
    target: app,
    before: before,
    after: after,
    providerRequested: finalProviderRequested,
    requestedTypes: finalRequestedTypes,
    restoredClipboard: restoredClipboard,
    error: classification.outcome == "verified_success" ? nil : classification.reason,
    commandTargetApp: commandTargetApp,
    commandTargetBundleId: commandTargetBundleId,
    timings: timings,
    enhancedAxAttempted: enhancedAxAttempted,
    enhancedAxHelped: enhancedAxHelped
  )
}

func classifyPaste(before: Snapshot, after: Snapshot, insertedChars: Int, providerRequested: Bool) -> (outcome: String, reason: String) {
  if isTextRole(before.role),
     let beforeChars = before.valueChars,
     let afterChars = after.valueChars,
     let expectedAfterChars = expectedAfterChars(before: before, insertedChars: insertedChars) {
    // Strict insert: textbook before-length + inserted - selection. Most native
    // text fields land here.
    if afterChars == expectedAfterChars {
      return ("verified_success", "strict AX value length matched expectation \(beforeChars)->\(afterChars)")
    }

    // Some apps (notably Electron contenteditable chat inputs — Claude desktop
    // is the observed example) replace their entire draft on Cmd+V instead of
    // inserting at the cursor. Post-paste AXValue ends up exactly the length
    // of our paste, so our text DID land in the target — the path just wasn't
    // the textbook insert.
    if afterChars == insertedChars {
      return ("verified_success", "AX value replaced-with-paste \(beforeChars)->\(afterChars)")
    }

    // afterChars > beforeChars but != expected: some insertion happened, just
    // not exactly what we predicted. Allow the autoformatter / smart quotes /
    // autocorrect case where the actual delta is close to insertedChars, but
    // demote to unconfirmed when the delta is dramatically smaller — that
    // shape is what we see when a target's paste pipeline reads our clipboard
    // partially and follows up with a stale clipboard read (observed:
    // Chromium / Electron multi-stage paste handlers picking up the user's
    // OLD clipboard content after our restore). Threshold: at least half of
    // insertedChars must have made it in.
    if afterChars > beforeChars {
      let actualDelta = afterChars - beforeChars
      let minAcceptableDelta = max(1, insertedChars / 2)
      if actualDelta >= minAcceptableDelta {
        return ("verified_success", "AX value grew \(beforeChars)->\(afterChars), expected \(expectedAfterChars)")
      }
      return ("unconfirmed", "AX value grew \(beforeChars)->\(afterChars) but delta \(actualDelta) below half of inserted \(insertedChars)")
    }

    // afterChars < beforeChars and != insertedChars: target shrank to
    // something that is NOT just our paste. We cannot prove our text landed.
    // Mark unconfirmed so the controller surfaces the copy fallback instead
    // of silently claiming success — without this, the user can lose their
    // dictation when a target app eats the paste in some opaque way.
    if afterChars < beforeChars {
      return ("unconfirmed", "AX value shrunk \(beforeChars)->\(afterChars), expected \(expectedAfterChars), neither insert nor replaced-with-paste")
    }

    // afterChars == beforeChars: nothing changed. Real failure. The target may
    // have read the pasteboard without accepting input (read-only / disabled /
    // intercepted Cmd+V), so don't let provider evidence alone bless it.
    return ("verified_failure", "strict AX value did not change at \(beforeChars)")
  }

  if isTextRole(after.role),
     let afterChars = after.valueChars,
     afterChars >= insertedChars,
     providerRequested {
    return ("verified_success", "post-paste AX text role has inserted-length-compatible value")
  }

  let beforeRange = before.selectedRangeFingerprint
  let afterRange = after.selectedRangeFingerprint
  let beforeCount = before.numberOfCharacters
  let afterCount = after.numberOfCharacters
  let rangeComparable = beforeRange != nil && afterRange != nil
  let countComparable = beforeCount != nil && afterCount != nil
  let rangeChanged = rangeComparable && beforeRange != afterRange
  let countChanged = countComparable && beforeCount != afterCount

  // "Weak AX fingerprint changed" used to return verified_success on its own,
  // but a bare selection-range or count change is not enough evidence: a
  // simple cursor click, focus refresh, or concurrent user typing all trigger
  // a fingerprint change without our paste actually landing. Require at
  // minimum that the pasteboard provider was queried (proving the target
  // app consumed our text). Additionally, a count change that matches the
  // inserted length is strong enough to accept without provider evidence
  // (e.g. some apps don't read the lazy provider but still inserted text).
  if rangeChanged || countChanged {
    if providerRequested {
      return ("verified_success", "weak AX fingerprint changed and pasteboard consumed")
    }
    if countComparable,
       let bc = beforeCount, let ac = afterCount,
       ac - bc == insertedChars {
      return ("verified_success", "weak AX count delta matches inserted length \(bc)->\(ac)")
    }
    // Fingerprint moved but no consumption evidence and delta doesn't match
    // — could be cursor activity, focus shuffle, or our paste really landing.
    // Stay unconfirmed so the renderer surfaces the copy fallback.
    return ("unconfirmed", "AX fingerprint changed but pasteboard not consumed and count delta inconclusive")
  }
  if rangeComparable || countComparable {
    return ("verified_failure", "AX fingerprint did not change")
  }
  if providerRequested {
    return ("unconfirmed", "pasteboard was consumed but target exposed no verifiable AX state")
  }
  return ("verified_failure", "pasteboard was not consumed and target exposed no verifiable AX state")
}

func buildPasteResult(
  outcome: String,
  reason: String,
  commandIssued: Bool,
  target: NSRunningApplication?,
  before: Snapshot?,
  after: Snapshot?,
  providerRequested: Bool,
  requestedTypes: [String],
  restoredClipboard: Bool,
  error: String?,
  commandTargetApp: String? = nil,
  commandTargetBundleId: String? = nil,
  timings: [String: Int] = [:],
  enhancedAxAttempted: Bool = false,
  enhancedAxHelped: Bool = false
) -> [String: Any] {
  [
    "ok": outcome == "verified_success",
    "method": "paste-verified",
    "outcome": outcome,
    "reason": reason,
    "error": error ?? NSNull(),
    "timings": timings,
    "commandIssued": commandIssued,
    "commandTargetApp": commandTargetApp ?? NSNull(),
    "commandTargetBundleId": commandTargetBundleId ?? NSNull(),
    "providerRequested": providerRequested,
    "requestedTypes": requestedTypes,
    "restoredClipboard": restoredClipboard,
    "targetApp": after?.appName ?? before?.appName ?? target?.localizedName ?? NSNull(),
    "targetBundleId": after?.bundleId ?? before?.bundleId ?? target?.bundleIdentifier ?? NSNull(),
    "targetPid": Int(after?.pid ?? before?.pid ?? target?.processIdentifier ?? 0),
    "focusedRole": after?.role ?? before?.role ?? NSNull(),
    "beforeChars": before?.valueChars ?? NSNull(),
    "afterChars": after?.valueChars ?? NSNull(),
    "beforeSelectedRange": before?.selectedRangeFingerprint ?? NSNull(),
    "afterSelectedRange": after?.selectedRangeFingerprint ?? NSNull(),
    "beforeNumberOfCharacters": before?.numberOfCharacters ?? NSNull(),
    "afterNumberOfCharacters": after?.numberOfCharacters ?? NSNull(),
    "enhancedAxAttempted": enhancedAxAttempted,
    "enhancedAxHelped": enhancedAxHelped
  ]
}

/**
 Writes one JSON line and flushes it immediately.

 stdout is a pipe here, so libc buffers it fully — without the explicit flush an
 early "progress" line would not reach the parent until the process exits, which
 would defeat the whole point of streaming it. The parent treats the LAST JSON
 line as the command result and earlier lines as tagged progress events.
 */
func emitLine(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8) else {
    return
  }
  print(text)
  fflush(stdout)
}

func emit(_ payload: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    if let text = String(data: data, encoding: .utf8) {
      print(text)
      return
    }
    // utf8 conversion of a JSONSerialization output is not expected to fail
    // in practice — handle it explicitly anyway so the helper never crashes
    // out with an empty stdout.
    print(#"{"ok":false,"status":"error","outcome":"verified_failure","error":"emit utf8 conversion failed"}"#)
  } catch {
    let fallback: [String: Any] = [
      "ok": false,
      "status": "error",
      "outcome": "verified_failure",
      "error": "Could not encode helper response: \(error)"
    ]
    if let data = try? JSONSerialization.data(withJSONObject: fallback, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
      print(json)
    } else {
      print("{\"ok\":false,\"status\":\"error\",\"outcome\":\"verified_failure\",\"error\":\"Could not encode helper response\"}")
    }
  }
}

do {
  let options = try parseOptions()
  switch options.command {
  case "capture-target":
    emit(captureTargetPayload(withFocusedFrame: options.withFocusedFrame))
  case "paste-verified":
    emit(pasteVerifiedPayload(options: options))
  case "post-key":
    emit(try keyEventPayload(options: options))
  case "post-scroll":
    emit(try scrollEventPayload(options: options))
  case "hold-scroll":
    try runHoldScroll()
    emit([
      "ok": true,
      "status": "ok",
      "outcome": "verified_success",
      "method": "hold-scroll",
    ])
  default:
    throw HelperError.invalidArgument("Unknown command: \(options.command)")
  }
} catch {
  emit([
    "ok": false,
    "status": "error",
    "outcome": "verified_failure",
    "error": String(describing: error)
  ])
}
