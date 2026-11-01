import Foundation
import ApplicationServices
import AppKit
import IOKit.graphics
import Security
import Darwin
import Vision

#if !DESKTOP_INPUT_TEST
// This guard precedes every entrypoint, including selection and permission UI.
guard let inputCaller = DesktopInputCaller.authenticate() else { exit(77) }
#endif

// Both one-shot and persistent queries recheck the OS session on every read.
func clipboardCounter(portable: Bool) -> String {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  guard let session = session, !(session["CGSSessionScreenIsLocked"] as? Bool ?? false) else { return "unavailable" }
  if portable && (NSPasteboard.general.pasteboardItems?.count ?? 0) > 1 { return "unsupported" }
  return String(NSPasteboard.general.changeCount)
}
#if !DESKTOP_INPUT_TEST
if CommandLine.arguments == [CommandLine.arguments[0], "--clipboard-counter"] {
  // Bounded input and idle exit also release the process if Main disappears.
  var bytes: [UInt8] = []
  while true {
    var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    guard poll(&descriptor, 1, 5000) > 0 else { exit(0) }
    var byte: UInt8 = 0
    guard read(STDIN_FILENO, &byte, 1) == 1 else { exit(0) }
    if byte != 10 {
      bytes.append(byte)
      if bytes.count > 32 { exit(2) }
      continue
    }
    autoreleasepool {
      guard inputCaller.code() != nil else { exit(77) }
      let parts = String(bytes: bytes, encoding: .utf8)?.split(separator: " ") ?? []
      guard parts.count == 2, parts[0].count <= 16, UInt64(parts[0]) != nil,
        parts[1] == "0" || parts[1] == "1" else { exit(2) }
      print("\(parts[0]) \(clipboardCounter(portable: parts[1] == "1"))"); fflush(stdout)
    }
    bytes.removeAll(keepingCapacity: true)
  }
}
#endif
// Expose only the clipboard change counter, never clipboard content on stdout.
if CommandLine.arguments.count == 2 && ["--clipboard-version", "--clipboard-content-version"].contains(CommandLine.arguments[1]) {
  let value = clipboardCounter(portable: CommandLine.arguments[1] == "--clipboard-content-version")
  if value == "unavailable" { exit(2) }
  if value == "unsupported" { exit(3) }
  print(value); exit(0)
}

// Read the actual accessibility selection instead of attributing arbitrary
// background pasteboard changes to a copy shortcut.
if CommandLine.arguments.count == 2 && ["--clipboard-selection", "--clipboard-content-selection"].contains(CommandLine.arguments[1]) {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  guard let session = session, !(session["CGSSessionScreenIsLocked"] as? Bool ?? false),
    AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { exit(2) }
  let root = AXUIElementCreateApplication(app.processIdentifier)
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
    let focused = focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { exit(2) }
  let element = focused as! AXUIElement
  var subrole: CFTypeRef?
  _ = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
  guard subrole as? String != "AXSecureTextField" else { exit(2) }
  var raw: CFTypeRef?
  let selectionResult = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &raw)
  var role: CFTypeRef?
  _ = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
  let nonText = CommandLine.arguments[1] == "--clipboard-content-selection"
    && selectionResult == .attributeUnsupported
    && ["AXImage", "AXButton", "AXGroup", "AXScrollArea", "AXList", "AXTable", "AXOutline", "AXRow", "AXCell"].contains(role as? String ?? "")
  // A confirmed empty selection is different from a failed accessibility read.
  guard selectionResult == .success || selectionResult == .noValue || nonText else { exit(2) }
  let selectionText: String? = (selectionResult == .noValue || nonText) ? "" : raw as? String
  guard let text = selectionText, text.utf16.count <= 16384,
    NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
    let data = try? JSONSerialization.data(withJSONObject: ["text": text]),
    let json = String(data: data, encoding: .utf8) else { exit(2) }
  var current: CFTypeRef?
  guard let latest = CGSessionCopyCurrentDictionary() as? [String: Any],
    !(latest["CGSSessionScreenIsLocked"] as? Bool ?? false),
    AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &current) == .success,
    let current = current, CFEqual(current, element) else { exit(2) }
  print(json); exit(0)
}

// Display configuration is a separate one-shot command; it does not acquire
// input ownership or require Accessibility permission. Only enumerated modes
// can be applied, and changes last for the login session (not permanently).
if CommandLine.arguments.count >= 3 && ["--display-modes", "--display-mode"].contains(CommandLine.arguments[1]) {
  guard let display = UInt32(CommandLine.arguments[2]), CGDisplayIsOnline(display) != 0,
    let modes = CGDisplayCopyAllDisplayModes(display, [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary) as? [CGDisplayMode],
    let current = CGDisplayCopyDisplayMode(display) else { exit(2) }
  if CommandLine.arguments[1] == "--display-modes" {
    var preferred: [String: CGDisplayMode] = [:]
    for mode in modes where mode.isUsableForDesktopGUI() {
      let key = "\(mode.width)x\(mode.height)"
      if let prior = preferred[key], prior.ioDisplayModeID == current.ioDisplayModeID ||
        (mode.ioDisplayModeID != current.ioDisplayModeID && prior.pixelWidth >= mode.pixelWidth && prior.refreshRate >= mode.refreshRate) { continue }
      preferred[key] = mode
    }
    let result = preferred.values.sorted { $0.width == $1.width ? $0.height < $1.height : $0.width < $1.width }.map {
      ["id": String($0.ioDisplayModeID), "width": $0.width, "height": $0.height,
       "current": $0.ioDisplayModeID == current.ioDisplayModeID,
       "native": ($0.ioFlags & UInt32(kDisplayModeNativeFlag)) != 0] as [String: Any]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: result), let json = String(data: data, encoding: .utf8) else { exit(2) }
    print(json); exit(0)
  }
  guard CommandLine.arguments.count == 4, let modeID = UInt32(CommandLine.arguments[3]),
    let mode = modes.first(where: { $0.ioDisplayModeID == modeID && $0.isUsableForDesktopGUI() }) else { exit(2) }
  var config: CGDisplayConfigRef?
  guard CGBeginDisplayConfiguration(&config) == .success, let config = config else { exit(3) }
  guard CGConfigureDisplayWithDisplayMode(config, display, mode, nil) == .success else {
    CGCancelDisplayConfiguration(config); exit(3)
  }
  guard CGCompleteDisplayConfiguration(config, .forSession) == .success else { exit(3) }
  print("ready"); exit(0)
}

// A private event source keeps remote modifiers separate from physical keyboard state.
let source = CGEventSource(stateID: .privateState)
// Never post events from this source: posted F11/arrow flags accumulate in
// a source's state table and must not become defaults for the next letter.
let keyMetadataSource = CGEventSource(stateID: .privateState)
var keys = Set<CGKeyCode>()
var buttons = Set<Int>()
var location = CGPoint.zero
var lastSeen = Date()
var lastClickAt = Date.distantPast
var lastClickLocation = CGPoint.zero
var lastClickButton = -1
var clickCount: Int64 = 0
let lock = NSLock()
let keyCodes: [String: CGKeyCode] = [
  "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,
  "KeyB":11,"KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,
  "Digit1":18,"Digit2":19,"Digit3":20,"Digit4":21,"Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,"Digit7":26,"Minus":27,"Digit8":28,"Digit0":29,
  "BracketRight":30,"KeyO":31,"KeyU":32,"BracketLeft":33,"KeyI":34,"KeyP":35,"Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,"Semicolon":41,"Backslash":42,"Comma":43,"Slash":44,"KeyN":45,"KeyM":46,"Period":47,
  "Tab":48,"Space":49,"Backquote":50,"Backspace":51,"Escape":53,"MetaLeft":55,"ShiftLeft":56,"AltLeft":58,"ControlLeft":59,
  "F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,
  "Insert":114,"Home":115,"PageUp":116,"Delete":117,"End":119,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,
]
func flags() -> CGEventFlags {
  var result: CGEventFlags = []
  for (key, flag) in [(55, CGEventFlags.maskCommand), (56,.maskShift), (58,.maskAlternate), (59,.maskControl)] {
    if keys.contains(CGKeyCode(key)) { result.insert(flag) }
  }
  return result
}
func configureKeyFlags(_ event: CGEvent, _ code: CGKeyCode, _ down: Bool) {
  // Quartz adds intrinsic flags for function keys, arrows and modifier sides.
  // Replace only our managed modifiers; dropping the intrinsic flags prevents
  // system shortcuts such as F11 and Control-Up from matching.
  let metadata = CGEvent(keyboardEventSource: keyMetadataSource, virtualKey: code, keyDown: down)
  var nativeFlags = metadata?.flags ?? []
  nativeFlags.subtract([.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskAlphaShift])
  event.flags = nativeFlags.union(flags())
}
func makeKeyEvent(_ code: CGKeyCode, _ down: Bool) -> CGEvent? {
  let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
  if let event = event { configureKeyFlags(event, code, down) }
  return event
}
func key(_ code: CGKeyCode, _ down: Bool) {
  if down { keys.insert(code) } else { keys.remove(code) }
  makeKeyEvent(code, down)?.post(tap: .cghidEventTap)
  // Give WindowServer time to observe modifier transitions before the next key.
  usleep(8000)
}
func mouse(_ button: Int, _ down: Bool) {
  let b: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
  let type: CGEventType = button == 2 ? (down ? .rightMouseDown : .rightMouseUp) : button == 1 ? (down ? .otherMouseDown : .otherMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
  if down { buttons.insert(button) } else { buttons.remove(button) }
  if down {
    let nearby = hypot(location.x-lastClickLocation.x, location.y-lastClickLocation.y) < 5
    clickCount = button == lastClickButton && nearby && Date().timeIntervalSince(lastClickAt) < 0.5 ? min(3, clickCount + 1) : 1
    lastClickAt = Date(); lastClickLocation = location; lastClickButton = button
  }
  let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: b)
  event?.setIntegerValueField(.mouseEventClickState, value: clickCount)
  event?.flags = flags()
  event?.post(tap: .cghidEventTap)
}
func releaseAll() {
  for b in Array(buttons) { mouse(b, false) }
  for k in Array(keys) { key(k, false) }
}
// ── 代输入 live view: input reaches only one window of one app ──
// Started with `--window <CGWindowID> <pid>`. Pointer positions arrive as 0–1
// fractions of that window and follow it if it moves; a press or hover must land
// where the window is on top, a drag stays inside it, and releases always land.
// Keys and text go only while the app is focused, never to system shortcuts.
struct HandoffConfine { let window: CGWindowID; let pid: Int32 }
var confine: HandoffConfine?
func confineFrame(_ c: HandoffConfine) -> CGRect? {
  guard let infos = CGWindowListCopyWindowInfo([.optionIncludingWindow], c.window) as? [[String: Any]],
    let info = infos.first, (info[kCGWindowOwnerPID as String] as? Int32) == c.pid,
    info[kCGWindowIsOnscreen as String] as? Bool ?? false,
    let raw = info[kCGWindowBounds as String] as? NSDictionary,
    let bounds = CGRect(dictionaryRepresentation: raw), bounds.width >= 1, bounds.height >= 1 else { return nil }
  return bounds
}
/** The app taking keyboard input right now, read live (a CLI tool's NSWorkspace can lag). */
func confineFocusedPid() -> Int32? {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.3)
  guard let app = handoffElement(handoffAttr(system, kAXFocusedApplicationAttribute)) else { return nil }
  var pid: Int32 = 0
  return AXUIElementGetPid(app, &pid) == .success ? pid : nil
}
/**
 * Keys go to the focused window of the focused app. Only the confined window
 * itself may take them: another window of the same app (another browser
 * window) is refused, whatever the live view shows.
 */
func confineFocusedWindow(_ c: HandoffConfine) -> Bool {
  guard confineFocusedPid() == c.pid, let bounds = confineFrame(c) else { return false }
  let app = AXUIElementCreateApplication(c.pid)
  AXUIElementSetMessagingTimeout(app, 0.3)
  guard let window = handoffElement(handoffAttr(app, kAXFocusedWindowAttribute)), let frame = handoffFrame(window) else { return false }
  return handoffSameFrame(frame, [Double(bounds.minX), Double(bounds.minY), Double(bounds.width), Double(bounds.height)])
}
let confineSystemKeys: Set<String> = ["Tab", "Space", "Backquote", "Escape", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"]
func confined(_ event: [String: Any], _ c: HandoffConfine) -> [String: Any]? {
  switch event["kind"] as? String {
  case "move", "button":
    let up = event["kind"] as? String == "button" && event["down"] as? Bool == false
    guard let frame = confineFrame(c) else {
      // The window is gone: only let go of what is held, where it is.
      return up ? event.merging(["x": Double(location.x), "y": Double(location.y)]) { $1 } : nil
    }
    guard let x = event["x"] as? Double, let y = event["y"] as? Double, x.isFinite, y.isFinite else { return nil }
    let point = CGPoint(x: frame.minX + min(max(x, 0), 1) * (frame.width - 1),
                        y: frame.minY + min(max(y, 0), 1) * (frame.height - 1))
    let result = event.merging(["x": Double(point.x), "y": Double(point.y)]) { $1 }
    if up || !buttons.isEmpty { return result }
    return handoffOwnsPoint(c.pid, point) ? result : nil
  case "key":
    guard let code = event["code"] as? String, let native = keyCodes[code], let down = event["down"] as? Bool else { return nil }
    if !down { return keys.contains(native) ? event : nil }
    if code.hasPrefix("F"), code.count <= 3, Int(code.dropFirst()) != nil { return nil }
    let command = keys.contains(55), control = keys.contains(59)
    if (command || control) && confineSystemKeys.contains(code) || command && control { return nil }
    return confineFocusedWindow(c) ? event : nil
  case "text":
    return confineFocusedWindow(c) ? event : nil
  case "scroll":
    guard let frame = confineFrame(c), frame.contains(location), handoffOwnsPoint(c.pid, location) else { return nil }
    return event
  default:
    return nil
  }
}
func apply(_ event: [String: Any]) {
  if let c = confine, event["kind"] as? String != "release" {
    guard let allowed = confined(event, c) else { return }
    applyEvent(allowed)
  } else {
    applyEvent(event)
  }
}
func applyEvent(_ event: [String: Any]) {
  guard let kind = event["kind"] as? String else { return }
  if kind == "release" { releaseAll(); return }
  if kind == "move" || kind == "button" {
    guard let x = event["x"] as? Double, let y = event["y"] as? Double, x.isFinite, y.isFinite else { return }
    location = CGPoint(x:x,y:y)
    if kind == "button", let button = event["button"] as? Int, let down = event["down"] as? Bool { mouse(button, down) }
    else {
      let b = buttons.contains(0) ? 0 : buttons.contains(2) ? 2 : buttons.contains(1) ? 1 : -1
      let type: CGEventType = b == 0 ? .leftMouseDragged : b == 2 ? .rightMouseDragged : b == 1 ? .otherMouseDragged : .mouseMoved
      let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: b == 2 ? .right : b == 1 ? .center : .left)
      e?.flags = flags(); e?.post(tap: .cghidEventTap)
    }
  } else if kind == "key", let code = event["code"] as? String, let native = keyCodes[code], let down = event["down"] as? Bool {
    key(native, down)
  } else if kind == "scroll", let dy = event["dy"] as? Double, let dx = event["dx"] as? Double {
    CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -Int32(dy), wheel2: -Int32(dx), wheel3: 0)?.post(tap: .cghidEventTap)
  } else if kind == "text", let text = event["text"] as? String {
    // Character boundaries prevent splitting a UTF-16 surrogate pair.
    for character in text.prefix(4096) {
      var units = Array(String(character).utf16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        e?.post(tap: .cghidEventTap)
      }
    }
  }
}

// Armed -> draining -> confirming. Draining lets the input helper release its
// pressed keys/buttons before Main opens a dialog; confirming rejects injection.
// Held initiating keys/buttons are consumed through release (including repeats).
struct PrivacyInputGate {
  var phase = 0
  var swallowed = Set<Int64>()
  mutating func consume(physical: Bool, press: Int64?, down: Bool, trigger: Bool, scroll: Bool = false) -> (Bool, Bool) {
    if !physical { return (phase == 2, false) }
    if scroll {
      let notify = phase == 0
      if notify { phase = 1 }
      return (true, notify)
    }
    if let press = press, swallowed.contains(press) {
      if !down { swallowed.remove(press) }
      return (true, false)
    }
    if phase == 0 && trigger {
      phase = 1
      if let press = press, down { swallowed.insert(press) }
      return (true, true)
    }
    if phase == 1 {
      if let press = press, down { swallowed.insert(press) }
      return (true, false)
    }
    return (false, false)
  }
}

// MARK: - Input handoff (代输入)
// One JSON request on stdin, one JSON reply on stdout. Owner values arrive only
// on stdin and are never printed. Text fields only report whether they contain
// text; secure fields never report a value or length.

let handoffMaxWalked = 6000
let handoffMaxEmitted = 1500
let handoffMaxDepth = 64
let handoffInteresting: Set<String> = [
  "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton",
  "AXCheckBox", "AXRadioButton", "AXRadioGroup", "AXMenuButton", "AXStaticText",
  "AXHeading", "AXWebArea", "AXDateTimeArea", "AXDisclosureTriangle", "AXTabGroup", "AXSearchField",
  "AXMenuItem", "AXSheet",
]

func handoffAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func handoffString(_ element: AXUIElement, _ name: String, limit: Int = 300) -> String? {
  guard let raw = handoffAttr(element, name) else { return nil }
  var text: String?
  if let value = raw as? String { text = value }
  else if let value = raw as? NSAttributedString { text = value.string }
  else if CFGetTypeID(raw) == CFURLGetTypeID() { text = (raw as! URL).absoluteString }
  guard let result = text?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty else { return nil }
  return String(result.prefix(limit))
}
func handoffBool(_ element: AXUIElement, _ name: String) -> Bool? {
  guard let raw = handoffAttr(element, name) else { return nil }
  if let value = raw as? Bool { return value }
  if let value = raw as? NSNumber { return value.boolValue }
  return nil
}
func handoffFrame(_ element: AXUIElement) -> [Double]? {
  var point = CGPoint.zero, size = CGSize.zero
  guard let p = handoffAttr(element, kAXPositionAttribute), let s = handoffAttr(element, kAXSizeAttribute),
    CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID(),
    AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
  return [Double(point.x), Double(point.y), Double(size.width), Double(size.height)]
}
func handoffChildren(_ element: AXUIElement) -> [AXUIElement] {
  guard let raw = handoffAttr(element, kAXChildrenAttribute), let children = raw as? [AXUIElement] else { return [] }
  return children
}
func handoffElement(_ raw: CFTypeRef?) -> AXUIElement? {
  guard let raw = raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return (raw as! AXUIElement)
}
func handoffIsSecure(_ element: AXUIElement) -> Bool {
  handoffString(element, kAXSubroleAttribute) == "AXSecureTextField"
}
/** Identity checked before acting: structure and labels only, never values. */
func handoffFingerprint(_ element: AXUIElement) -> String {
  let titleElement = handoffElement(handoffAttr(element, kAXTitleUIElementAttribute))
  return [
    handoffString(element, kAXRoleAttribute) ?? "",
    handoffString(element, kAXSubroleAttribute) ?? "",
    handoffString(element, kAXTitleAttribute) ?? "",
    handoffString(element, kAXDescriptionAttribute) ?? "",
    handoffString(element, kAXPlaceholderValueAttribute) ?? "",
    titleElement.flatMap { handoffString($0, kAXValueAttribute) ?? handoffString($0, kAXTitleAttribute) } ?? "",
  ].joined(separator: "|")
}
func handoffPrepare(_ app: AXUIElement) {
  AXUIElementSetMessagingTimeout(app, 0.5)
  // Chromium/Electron only build their web accessibility tree for assistive clients.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}
func handoffWindows(_ app: AXUIElement) -> [AXUIElement] {
  guard let raw = handoffAttr(app, kAXWindowsAttribute), let windows = raw as? [AXUIElement] else { return [] }
  return windows
}
func handoffResolveWindow(_ app: AXUIElement, _ request: [String: Any]) -> (AXUIElement, Int)? {
  let windows = handoffWindows(app)
  if let spec = request["window"] as? [String: Any] {
    let title = spec["title"] as? String
    if let index = spec["index"] as? Int, index >= 0, index < windows.count,
      title == nil || handoffString(windows[index], kAXTitleAttribute) ?? "" == title! { return (windows[index], index) }
    if let title = title, let index = windows.firstIndex(where: { handoffString($0, kAXTitleAttribute) ?? "" == title }) {
      return (windows[index], index)
    }
    return nil
  }
  for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
    if let window = handoffElement(handoffAttr(app, name)),
      let index = windows.firstIndex(where: { CFEqual($0, window) }) { return (window, index) }
  }
  return windows.isEmpty ? nil : (windows[0], 0)
}
func handoffResolveRef(_ window: AXUIElement, _ ref: String) -> AXUIElement? {
  var element = window
  for part in ref.split(separator: ".") {
    guard let index = Int(part) else { return nil }
    let children = handoffChildren(element)
    guard index >= 0, index < children.count else { return nil }
    element = children[index]
  }
  return element
}
func handoffNode(_ element: AXUIElement, ref: String, depth: Int, inAlert: Bool) -> [String: Any]? {
  guard let role = handoffString(element, kAXRoleAttribute) else { return nil }
  let subrole = handoffString(element, kAXSubroleAttribute)
  let alertGroup = subrole == "AXApplicationAlert" || subrole == "AXApplicationAlertDialog"
  guard handoffInteresting.contains(role) || alertGroup else { return nil }
  var node: [String: Any] = ["ref": ref, "role": role, "depth": depth, "fp": handoffFingerprint(element)]
  if let subrole = subrole { node["subrole"] = subrole }
  if let title = handoffString(element, kAXTitleAttribute) { node["title"] = title }
  if let description = handoffString(element, kAXDescriptionAttribute) { node["desc"] = description }
  if let placeholder = handoffString(element, kAXPlaceholderValueAttribute) { node["placeholder"] = placeholder }
  if let help = handoffString(element, kAXHelpAttribute) { node["help"] = help }
  if let identifier = handoffString(element, "AXDOMIdentifier", limit: 64) { node["domId"] = identifier }
  if let titleElement = handoffElement(handoffAttr(element, kAXTitleUIElementAttribute)),
    let text = handoffString(titleElement, kAXValueAttribute) ?? handoffString(titleElement, kAXTitleAttribute) {
    node["titleElement"] = text
  }
  node["enabled"] = handoffBool(element, kAXEnabledAttribute) ?? true
  if handoffBool(element, kAXFocusedAttribute) == true { node["focused"] = true }
  if handoffBool(element, "AXRequired") == true { node["required"] = true }
  if let frame = handoffFrame(element) { node["frame"] = frame }
  if inAlert || alertGroup { node["alert"] = true }
  switch role {
  case "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXDateTimeArea":
    if handoffIsSecure(element) {
      node["secure"] = true
    } else if let raw = handoffAttr(element, kAXValueAttribute), let text = raw as? String {
      node["hasValue"] = !text.isEmpty
    }
  case "AXCheckBox", "AXRadioButton":
    if let raw = handoffAttr(element, kAXValueAttribute), let number = raw as? NSNumber { node["checked"] = number.intValue != 0 }
  case "AXPopUpButton", "AXStaticText", "AXHeading":
    if let value = handoffString(element, kAXValueAttribute) { node["value"] = value }
  case "AXWebArea", "AXLink":
    if let url = handoffString(element, kAXURLAttribute, limit: 2048) { node["url"] = url }
  default: break
  }
  if role == "AXPopUpButton" || role == "AXComboBox" {
    let items = handoffMenuItems(element, limit: 200)
    if !items.isEmpty { node["options"] = items }
  }
  if handoffBool(element, kAXExpandedAttribute) == true { node["expanded"] = true }
  return node
}
/** Menu items already exposed under a pop-up (web selects) without opening it. */
func handoffMenuItems(_ element: AXUIElement, limit: Int) -> [String] {
  var result: [String] = []
  var stack: [(AXUIElement, Int)] = handoffChildren(element).map { ($0, 0) }
  while result.count < limit, case let (current, depth)? = stack.popLast() {
    let role = handoffString(current, kAXRoleAttribute)
    if role == "AXMenuItem" || role == "AXListItem" || role == "AXStaticText" && depth > 0 {
      if let title = handoffString(current, kAXTitleAttribute) ?? handoffString(current, kAXValueAttribute)
        ?? handoffString(current, kAXDescriptionAttribute) {
        result.append(title)
        continue
      }
    }
    if depth < 3 { stack.append(contentsOf: handoffChildren(current).reversed().map { ($0, depth + 1) }) }
  }
  return result
}
func handoffSnapshot(_ request: [String: Any]) -> [String: Any] {
  guard let pid = request["pid"] as? Int32 ?? (request["pid"] as? Int).map({ Int32($0) }),
    let running = NSRunningApplication(processIdentifier: pid) else { return ["error": "target_gone"] }
  let app = AXUIElementCreateApplication(pid)
  handoffPrepare(app)
  guard let resolved = handoffResolveWindow(app, request) else { return ["error": "target_gone"] }
  let (window, index) = resolved
  var nodes: [[String: Any]] = []
  var walked = 0
  var stack: [(AXUIElement, String, Int, Bool)] = handoffChildren(window).enumerated().reversed().map { ($0.element, String($0.offset), 1, false) }
  while case let (element, ref, depth, inAlert)? = stack.popLast() {
    walked += 1
    if walked > handoffMaxWalked || nodes.count >= handoffMaxEmitted { break }
    let node = handoffNode(element, ref: ref, depth: depth, inAlert: inAlert)
    if let node = node { nodes.append(node) }
    let role = node?["role"] as? String
    // Interactive leaves: their children are presentation details or menu items read above.
    if ["AXButton", "AXTextField", "AXTextArea", "AXPopUpButton", "AXComboBox", "AXStaticText", "AXCheckBox", "AXRadioButton", "AXSearchField", "AXMenuItem"].contains(role ?? "") { continue }
    if depth >= handoffMaxDepth { continue }
    let alert = inAlert || node?["alert"] as? Bool == true
    let children = handoffChildren(element)
    for (offset, child) in children.enumerated().reversed() { stack.append((child, "\(ref).\(offset)", depth + 1, alert)) }
  }
  var result: [String: Any] = [
    "pid": Int(pid), "app": running.localizedName ?? "", "bundleId": running.bundleIdentifier ?? "",
    "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
    "window": ["index": index, "title": handoffString(window, kAXTitleAttribute) ?? "",
               "frame": handoffFrame(window) ?? [], "modal": handoffBool(window, kAXModalAttribute) ?? false] as [String: Any],
    "nodes": nodes, "truncated": walked > handoffMaxWalked || nodes.count >= handoffMaxEmitted,
  ]
  if let focused = handoffElement(handoffAttr(app, kAXFocusedUIElementAttribute)), handoffIsSecure(focused) {
    result["secureFocused"] = true
  }
  return result
}
/**
 * Whether the agent's next keystrokes would land in a password field: the
 * element at a screen point (top-left origin) of this app, or the app's
 * focused element. Reads roles only, never values.
 */
func handoffSecureTarget(_ request: [String: Any]) -> [String: Any] {
  guard let pid = request["pid"] as? Int32 ?? (request["pid"] as? Int).map({ Int32($0) }),
    NSRunningApplication(processIdentifier: pid) != nil else { return ["error": "target_gone"] }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  var element: AXUIElement?
  if let point = request["point"] as? [Double], point.count == 2 {
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(app, Float(point[0]), Float(point[1]), &hit) == .success { element = hit }
  } else {
    element = handoffElement(handoffAttr(app, kAXFocusedUIElementAttribute))
  }
  // A secure field may report an inner text element at the point; check two parents.
  var current = element
  for _ in 0..<3 {
    guard let candidate = current else { break }
    if handoffIsSecure(candidate) { return ["secure": true] }
    current = handoffElement(handoffAttr(candidate, kAXParentAttribute))
  }
  return ["secure": false]
}
func handoffWindowList(_ request: [String: Any] = [:]) -> [String: Any] {
  var pids = Set<Int32>()
  if let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
    for info in infos where (info[kCGWindowLayer as String] as? Int) == 0 {
      if let pid = info[kCGWindowOwnerPID as String] as? Int32 { pids.insert(pid) }
    }
  }
  // An app with only minimized windows has nothing on screen (macOS may even report it hidden), yet the step may wait in one of them.
  let onScreen = pids
  if request["background"] as? Bool == true {
    for running in NSWorkspace.shared.runningApplications where running.activationPolicy == .regular {
      pids.insert(running.processIdentifier)
    }
  }
  var apps: [[String: Any]] = []
  for pid in pids {
    guard let running = NSRunningApplication(processIdentifier: pid), running.activationPolicy == .regular else { continue }
    let element = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(element, 0.3)
    let focused = handoffElement(handoffAttr(element, kAXFocusedWindowAttribute))
    let windows = handoffWindows(element).enumerated().map { offset, window -> [String: Any] in
      ["index": offset, "title": handoffString(window, kAXTitleAttribute) ?? "",
       "frame": handoffFrame(window) ?? [], "focused": focused.map { CFEqual($0, window) } ?? false,
       "minimized": handoffBool(window, kAXMinimizedAttribute) ?? false]
    }
    // Without `background`, an app is listed only while it has something on screen. With it, every
    // app is, even with no window at all: that is how a closed last window is told from a hidden one.
    if request["background"] as? Bool != true && !onScreen.contains(pid) { continue }
    apps.append(["pid": Int(pid), "app": running.localizedName ?? "", "bundleId": running.bundleIdentifier ?? "",
                 "windows": windows])
  }
  // Read fresh (see handoffFrontPid): NSWorkspace can name another app in this short-lived process.
  return ["frontmost": Int(handoffFrontPid() ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0), "apps": apps]
}
let handoffSource = CGEventSource(stateID: .privateState)
func handoffKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: handoffSource, virtualKey: code, keyDown: down)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
    usleep(6000)
  }
}
/// Typed keys travel through the window server's queue, while an accessibility press reaches the
/// app at once: give the queue time to drain so a press right after cannot overtake the last keys.
func handoffTypeAndSettle(_ text: String) {
  handoffType(text)
  usleep(useconds_t(min(1_500_000, 300_000 + 10_000 * text.count)))
}
func handoffType(_ text: String) {
  for character in text {
    var units = Array(String(character).utf16)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: handoffSource, virtualKey: 0, keyDown: down)
      event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      event?.post(tap: .cghidEventTap)
    }
    usleep(4000)
  }
}
func handoffClick(_ frame: [Double]) {
  guard frame.count == 4, frame[2] > 0, frame[3] > 0 else { return }
  let point = CGPoint(x: frame[0] + frame[2] / 2, y: frame[1] + frame[3] / 2)
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    let event = CGEvent(mouseEventSource: handoffSource, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.setIntegerValueField(.mouseEventClickState, value: 1)
    event?.post(tap: .cghidEventTap)
    usleep(20000)
  }
}
func handoffFocused(_ app: AXUIElement, is element: AXUIElement) -> Bool {
  guard let focused = handoffElement(handoffAttr(app, kAXFocusedUIElementAttribute)) else { return false }
  return CFEqual(focused, element)
}
/// The app that takes typed keys right now, read fresh from accessibility: this short-lived
/// process never runs its event loop, so NSWorkspace's frontmost app goes stale inside it.
func handoffFrontPid() -> Int32? {
  let system = AXUIElementCreateSystemWide()
  for _ in 0..<3 {
    if let focused = handoffElement(handoffAttr(system, kAXFocusedApplicationAttribute)) {
      var pid: pid_t = 0
      if AXUIElementGetPid(focused, &pid) == .success { return pid }
    }
    usleep(20000)
  }
  return nil
}
func handoffWaitFront(_ pid: Int32, _ seconds: Double) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while handoffFrontPid() != pid {
    if Date() >= deadline { return false }
    usleep(40000)
  }
  return true
}
/// A minimized window draws nothing and takes no input: bring it back and let the Dock animation finish.
func handoffRestore(_ window: AXUIElement) {
  guard handoffBool(window, kAXMinimizedAttribute) == true else { return }
  AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
  let deadline = Date().addingTimeInterval(1.0)
  while handoffBool(window, kAXMinimizedAttribute) == true && Date() < deadline { usleep(40000) }
  usleep(300000)
}
/// Bring the window forward. Reports whether its app now takes keys: typing must never go anywhere else.
@discardableResult
func handoffActivate(_ pid: Int32, _ window: AXUIElement) -> Bool {
  handoffRestore(window)
  let front = handoffFrontPid() == pid
  if !front {
    _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  }
  AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  if front || handoffWaitFront(pid, 0.6) { return true }
  // macOS may refuse to bring another app forward for a background helper. A click on the window's
  // own title bar still does, as the owner's click would; only when that spot is the bare window.
  guard let frame = handoffFrame(window), frame[2] > 60, frame[3] > 30 else { return false }
  let point = CGPoint(x: frame[0] + frame[2] / 2, y: frame[1] + 8)
  var hit: AXUIElement?
  guard handoffOwnsPoint(pid, point),
    AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &hit) == .success,
    let spot = hit, ["AXWindow", "AXStaticText"].contains(handoffString(spot, kAXRoleAttribute) ?? "")
  else { return false }
  handoffClick([point.x - 0.5, point.y - 0.5, 1, 1])
  return handoffWaitFront(pid, 1.0)
}
/// A synthesized click lands on whatever is on top there: only click where this app's window is.
func handoffClickOwned(_ pid: Int32, _ frame: [Double]) -> Bool {
  guard frame.count == 4, handoffOwnsPoint(pid, CGPoint(x: frame[0] + frame[2] / 2, y: frame[1] + frame[3] / 2)) else { return false }
  handoffClick(frame)
  return true
}
func handoffFocus(_ app: AXUIElement, _ element: AXUIElement) -> Bool {
  AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  usleep(80000)
  if handoffFocused(app, is: element) { return true }
  var pid: pid_t = 0
  if AXUIElementGetPid(app, &pid) == .success, let frame = handoffFrame(element), handoffClickOwned(pid, frame) { usleep(120000) }
  return handoffFocused(app, is: element)
}
func handoffAct(_ request: [String: Any]) -> [String: Any] {
  guard let pid = request["pid"] as? Int32 ?? (request["pid"] as? Int).map({ Int32($0) }),
    NSRunningApplication(processIdentifier: pid) != nil else { return ["error": "target_gone"] }
  let app = AXUIElementCreateApplication(pid)
  handoffPrepare(app)
  guard let window = handoffResolveWindow(app, request)?.0 else { return ["error": "target_gone"] }
  guard let ref = request["ref"] as? String, ref.count <= 512,
    let element = handoffResolveRef(window, ref) else { return ["error": "stale"] }
  if let expected = request["fp"] as? String, handoffFingerprint(element) != expected { return ["error": "stale"] }
  if handoffBool(element, kAXEnabledAttribute) == false { return ["error": "disabled"] }
  let kind = request["kind"] as? String ?? ""
  let front = handoffActivate(pid, window)
  switch kind {
  case "press":
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
      guard let frame = handoffFrame(element), handoffClickOwned(pid, frame) else { return ["error": "action_failed"] }
    }
    return ["ok": true]
  case "text":
    guard let value = request["value"] as? String, value.utf16.count <= 4096 else { return ["error": "invalid"] }
    let secure = handoffIsSecure(element)
    if !secure, AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success,
      (handoffAttr(element, kAXValueAttribute) as? String) == value {
      _ = handoffFocus(app, element)
      return ["ok": true, "method": "set"]
    }
    // Keys go to whichever app is in front: never type unless it is this one.
    guard front, handoffFocus(app, element), handoffFrontPid() == pid else { return ["error": "focus_failed"] }
    handoffKey(0, flags: .maskCommand) // select all
    handoffKey(51) // delete
    guard handoffFocused(app, is: element), handoffFrontPid() == pid else { return ["error": "focus_failed"] }
    handoffTypeAndSettle(value)
    guard handoffFocused(app, is: element) else { return ["error": "focus_lost"] }
    if secure {
      if let count = handoffAttr(element, kAXNumberOfCharactersAttribute) as? NSNumber {
        return count.intValue == value.count ? ["ok": true, "method": "typed"] : ["error": "verify_failed"]
      }
      return ["ok": true, "method": "typed", "unverified": true]
    }
    return (handoffAttr(element, kAXValueAttribute) as? String) == value
      ? ["ok": true, "method": "typed"] : ["ok": true, "method": "typed", "unverified": true]
  case "key":
    guard let name = request["value"] as? String, let code: CGKeyCode = ["return": 36, "escape": 53, "tab": 48][name]
    else { return ["error": "invalid"] }
    if name == "return", !handoffFocused(app, is: element) { _ = handoffFocus(app, element) }
    guard front, handoffFrontPid() == pid else { return ["error": "focus_failed"] }
    handoffKey(code)
    return ["ok": true]
  default:
    return ["error": "invalid"]
  }
}
// ── Screenshot steps: a step the owner answers on a picture of the window ──
let handoffEditableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
func handoffPid(_ request: [String: Any]) -> Int32? {
  request["pid"] as? Int32 ?? (request["pid"] as? Int).map({ Int32($0) })
}
func handoffNumbers(_ raw: Any?, count: Int) -> [Double]? {
  guard let values = raw as? [Any], values.count == count else { return nil }
  let numbers = values.compactMap { ($0 as? NSNumber)?.doubleValue }
  return numbers.count == count && numbers.allSatisfy({ $0.isFinite }) ? numbers : nil
}
func handoffSameFrame(_ a: [Double]?, _ b: [Double]) -> Bool {
  guard let a = a, a.count == 4, b.count == 4 else { return false }
  return zip(a, b).allSatisfy { abs($0 - $1) <= 1 }
}
/** Bring the window to the front so it can be photographed, and report where it is. */
func handoffRaise(_ request: [String: Any]) -> [String: Any] {
  guard let pid = handoffPid(request), NSRunningApplication(processIdentifier: pid) != nil else { return ["error": "target_gone"] }
  let app = AXUIElementCreateApplication(pid)
  handoffPrepare(app)
  guard let window = handoffResolveWindow(app, request)?.0 else { return ["error": "target_gone"] }
  handoffActivate(pid, window)
  usleep(180000)
  guard let frame = handoffFrame(window), frame[2] > 0, frame[3] > 0 else { return ["error": "target_gone"] }
  var result: [String: Any] = ["frame": frame]
  if let id = handoffWindowID(pid, frame) { result["windowId"] = Int(id) }
  return result
}
/** The window server's id for this app's window at this frame, for a live view of just that window. */
func handoffWindowID(_ pid: Int32, _ frame: [Double]) -> CGWindowID? {
  guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  for info in infos where (info[kCGWindowLayer as String] as? Int) == 0 && (info[kCGWindowOwnerPID as String] as? Int32) == pid {
    guard let raw = info[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw),
      handoffSameFrame([Double(bounds.minX), Double(bounds.minY), Double(bounds.width), Double(bounds.height)], frame),
      let id = info[kCGWindowNumber as String] as? Int, id > 0 else { continue }
    return CGWindowID(id)
  }
  return nil
}
/** The window-server id of the app's window at this frame, without bringing it forward (watching a code). */
func handoffWindowIDFor(_ request: [String: Any]) -> [String: Any] {
  guard let pid = handoffPid(request), NSRunningApplication(processIdentifier: pid) != nil,
    let frame = request["frame"] as? [Double], frame.count == 4, frame.allSatisfy({ $0.isFinite }) else { return ["error": "target_gone"] }
  guard let id = handoffWindowID(pid, frame) else { return ["error": "target_gone"] }
  return ["windowId": Int(id)]
}
/** Whether the app's focused element takes typing, and whether it is a password field. Roles only. */
func handoffFocusedField(_ request: [String: Any]) -> [String: Any] {
  guard let pid = handoffPid(request), NSRunningApplication(processIdentifier: pid) != nil else { return ["error": "target_gone"] }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  guard let focused = handoffElement(handoffAttr(app, kAXFocusedUIElementAttribute)) else { return ["editable": false, "secure": false] }
  let secure = handoffIsSecure(focused)
  let editable = secure || handoffEditableRoles.contains(handoffString(focused, kAXRoleAttribute) ?? "")
  return ["editable": editable, "secure": secure]
}
/** The frontmost on-screen window under a point belongs to this app (a click there reaches it). */
func handoffOwnsPoint(_ pid: Int32, _ point: CGPoint) -> Bool {
  guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
  for info in infos {
    if (info[kCGWindowAlpha as String] as? Double ?? 1) <= 0.01 { continue }
    guard let raw = info[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: raw), bounds.contains(point) else { continue }
    return (info[kCGWindowOwnerPID as String] as? Int32) == pid
  }
  return false
}
/**
 * Owner input on a screenshot step. The window must still be where it was
 * photographed; a tap must land inside it and on top; typing goes to the
 * focused field only, and a password goes only into a password field.
 */
func handoffPointer(_ request: [String: Any]) -> [String: Any] {
  guard let pid = handoffPid(request), NSRunningApplication(processIdentifier: pid) != nil else { return ["error": "target_gone"] }
  let app = AXUIElementCreateApplication(pid)
  handoffPrepare(app)
  guard let window = handoffResolveWindow(app, request)?.0 else { return ["error": "target_gone"] }
  guard let expected = handoffNumbers(request["windowFrame"], count: 4) else { return ["error": "invalid"] }
  let front = handoffActivate(pid, window)
  usleep(120000)
  guard handoffSameFrame(handoffFrame(window), expected) else { return ["error": "moved"] }
  switch request["kind"] as? String {
  case "tap":
    guard let point = handoffNumbers(request["point"], count: 2), let area = handoffNumbers(request["area"], count: 4),
      CGRect(x: area[0], y: area[1], width: area[2], height: area[3]).contains(CGPoint(x: point[0], y: point[1]))
    else { return ["error": "invalid"] }
    let target = CGPoint(x: point[0], y: point[1])
    guard handoffOwnsPoint(pid, target) else { return ["error": "covered"] }
    handoffClick([target.x - 0.5, target.y - 0.5, 1, 1])
    return ["ok": true]
  case "type":
    guard let value = request["value"] as? String, value.utf16.count <= 4096 else { return ["error": "invalid"] }
    guard let focused = handoffElement(handoffAttr(app, kAXFocusedUIElementAttribute)) else { return ["error": "focus_failed"] }
    let secure = handoffIsSecure(focused)
    let wantsSecure = request["secure"] as? Bool ?? false
    guard secure || handoffEditableRoles.contains(handoffString(focused, kAXRoleAttribute) ?? "") else { return ["error": "focus_failed"] }
    // A password typed for a password field never lands in a visible one, and the reverse.
    guard secure == wantsSecure else { return ["error": "moved"] }
    guard front, handoffFrontPid() == pid else { return ["error": "focus_failed"] }
    handoffTypeAndSettle(value)
    if request["submit"] as? Bool == true { handoffKey(36) }
    return ["ok": true]
  default:
    return ["error": "invalid"]
  }
}
func handoffRespond(_ value: [String: Any]) -> Never {
  guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { exit(2) }
  print(json); fflush(stdout); exit(0)
}

/// 代输入 scan-to-sign-in: the QR codes in one photographed window, with what
/// each says and where it sits (fractions of the picture, top-left origin).
/// The picture arrives in memory and is never written anywhere.
func handoffDetectQr(_ data: Data) -> [[String: Any]] {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return [] }
  let request = VNDetectBarcodesRequest()
  request.symbologies = [.qr]
  guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil else { return [] }
  var found: [[String: Any]] = []
  var seen = Set<String>()
  for case let code as VNBarcodeObservation in request.results ?? [] {
    guard let text = code.payloadStringValue, !text.isEmpty, text.utf16.count <= 2048, seen.insert(text).inserted else { continue }
    let box = code.boundingBox
    found.append(["text": text, "box": [Double(box.minX), Double(1 - box.maxY), Double(box.width), Double(box.height)]])
    if found.count >= 8 { break }
  }
  return found
}

#if !DESKTOP_INPUT_TEST
if CommandLine.arguments.contains("--check") {
  print(AXIsProcessTrusted() ? "ready" : "permission"); exit(0)
}
if CommandLine.arguments == [CommandLine.arguments[0], "--handoff-qr"] {
  // One photographed window (JPEG) on stdin: its byte length on a line, then the bytes. Main keeps
  // stdin open (closing it would fail the caller check), so the length marks the end. The reply says
  // only what QR codes it shows.
  let limit = 24 << 20
  var header: [UInt8] = []
  while header.count <= 12 {
    var byte: UInt8 = 0
    guard read(STDIN_FILENO, &byte, 1) == 1 else { break }
    if byte == 10 { break }
    header.append(byte)
  }
  guard let length = Int(String(decoding: header, as: UTF8.self)), length > 0, length <= limit else {
    handoffRespond(["error": "invalid"])
  }
  var data = Data()
  var chunk = [UInt8](repeating: 0, count: 65536)
  while data.count < length {
    let count = read(STDIN_FILENO, &chunk, min(chunk.count, length - data.count))
    if count <= 0 { break }
    data.append(chunk, count: count)
  }
  guard data.count == length, let session = CGSessionCopyCurrentDictionary() as? [String: Any],
    !(session["CGSSessionScreenIsLocked"] as? Bool ?? false) else { handoffRespond(["error": "unavailable"]) }
  handoffRespond(["codes": handoffDetectQr(data)])
}
if CommandLine.arguments.contains("--lock-state") {
  guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
    state[kCGSessionLoginDoneKey as String] as? Bool == true else { print("unavailable"); exit(0) }
  print(state["CGSSessionScreenIsLocked"] as? Bool == true ? "locked" : "unlocked"); exit(0)
}
if CommandLine.arguments.contains("--request-permission") {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  print(AXIsProcessTrustedWithOptions(options) ? "ready" : "permission"); exit(0)
}
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--lock-screen" {
  func ownedSession() -> [String: Any]? {
    guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
      (state[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == geteuid(),
      state[kCGSessionOnConsoleKey as String] as? Bool == true,
      state[kCGSessionLoginDoneKey as String] as? Bool == true else { return nil }
    return state
  }
  guard let state = ownedSession(), inputCaller.code() != nil else { exit(2) }
  if state["CGSSessionScreenIsLocked"] as? Bool == true { print("locked"); exit(0) }
  guard AXIsProcessTrusted(), ownedSession() != nil else { exit(2) }
  // Fixed system lock shortcut. No password, shell command or caller-provided key.
  key(59, true); key(55, true); key(12, true)
  key(12, false); key(55, false); key(59, false)
  let deadline = Date().addingTimeInterval(3)
  while Date() < deadline {
    guard let current = ownedSession(), inputCaller.code() != nil else { exit(2) }
    if current["CGSSessionScreenIsLocked"] as? Bool == true { print("locked"); exit(0) }
    usleep(50_000)
  }
  exit(2)
}
guard AXIsProcessTrusted() else { print("permission"); fflush(stdout); exit(2) }
if CommandLine.arguments == [CommandLine.arguments[0], "--handoff"] {
  // A single bounded request; values stay on stdin and are never echoed.
  var bytes: [UInt8] = []
  while bytes.count <= 65536 {
    var byte: UInt8 = 0
    guard read(STDIN_FILENO, &byte, 1) == 1 else { break }
    if byte == 10 { break }
    bytes.append(byte)
  }
  guard bytes.count <= 65536, let request = try? JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any],
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { handoffRespond(["error": "unavailable"]) }
  bytes.withUnsafeMutableBufferPointer { buffer in for i in buffer.indices { buffer[i] = 0 } }
  // A locked screen is never read or typed into; the owner unlocks the computer first.
  if session["CGSSessionScreenIsLocked"] as? Bool ?? false { handoffRespond(["error": "locked"]) }
  switch request["op"] as? String {
  case "windows": handoffRespond(handoffWindowList(request))
  case "snapshot": handoffRespond(handoffSnapshot(request))
  case "act": handoffRespond(handoffAct(request))
  case "secure": handoffRespond(handoffSecureTarget(request))
  case "raise": handoffRespond(handoffRaise(request))
  case "windowid": handoffRespond(handoffWindowIDFor(request))
  case "focused": handoffRespond(handoffFocusedField(request))
  case "pointer": handoffRespond(handoffPointer(request))
  default: handoffRespond(["error": "invalid"])
  }
}
if CommandLine.arguments == [CommandLine.arguments[0], "--privacy-input"] {
  var heartbeat = Date()
  var previousApp: NSRunningApplication?
  let events: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
    .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
    .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
  let mask = events.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
  // Context remains alive on this run loop until process exit; callbacks never
  // wait on stdin, Main or network and never print event contents.
  let context = UnsafeMutablePointer<PrivacyInputGate>.allocate(capacity: 1)
  context.initialize(to: PrivacyInputGate())
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
    options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, info in
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        print("error"); fflush(stdout); exit(2)
      }
      let state = info!.assumingMemoryBound(to: PrivacyInputGate.self)
      let physical = event.getIntegerValueField(.eventSourceUnixProcessID) == 0
        && event.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue)
      let key = type == .keyDown || type == .keyUp
      let mouseDown = [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type)
      let mouseUp = [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type)
      let press: Int64? = key ? event.getIntegerValueField(.keyboardEventKeycode)
        : (mouseDown || mouseUp ? 100000 + event.getIntegerValueField(.mouseEventButtonNumber) : nil)
      let (consume, notify) = state.pointee.consume(physical: physical, press: press,
        down: type == .keyDown || mouseDown, trigger: type == .keyDown || mouseDown || type == .flagsChanged, scroll: type == .scrollWheel)
      if notify { print("local-input"); fflush(stdout) }
      return consume ? nil : Unmanaged.passUnretained(event)
    }, userInfo: context), let runSource = CFMachPortCreateRunLoopSource(nil, tap, 0) else {
      print("error"); fflush(stdout); exit(2)
    }
  CFRunLoopAddSource(CFRunLoopGetMain(), runSource, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  print("ready"); fflush(stdout)
  DispatchQueue.global().async {
    while let command = readLine() {
      guard command.utf8.count <= 16 else { exit(2) }
      DispatchQueue.main.async {
        heartbeat = Date()
        switch command {
        case "ping": break
        case "confirm":
          previousApp = NSWorkspace.shared.frontmostApplication
          context.pointee.phase = 2; print("confirmed"); fflush(stdout)
        case "resume":
          _ = previousApp?.activate(options: [.activateIgnoringOtherApps])
          previousApp = nil
          context.pointee.phase = 0; print("ready"); fflush(stdout)
        default: exit(2)
        }
      }
    }
    exit(0) // Process exit removes the tap, even if Main died with a dialog up.
  }
  let timer = DispatchSource.makeTimerSource(queue: .main)
  timer.schedule(deadline: .now() + 1, repeating: 1)
  timer.setEventHandler {
    if Date().timeIntervalSince(heartbeat) > 5 || inputCaller.code() == nil || !AXIsProcessTrusted() { exit(2) }
  }
  timer.resume()
  CFRunLoopRun()
  exit(0)
}
if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--window" {
  guard let window = UInt32(CommandLine.arguments[2]), window > 0,
    let pid = Int32(CommandLine.arguments[3]), pid > 0 else { exit(2) }
  confine = HandoffConfine(window: window, pid: pid)
}
print("ready"); fflush(stdout)
let watchdog = DispatchSource.makeTimerSource(queue: .global())
watchdog.schedule(deadline: .now() + 1, repeating: 1)
watchdog.setEventHandler {
  lock.lock(); defer { lock.unlock() }
  if inputCaller.code() == nil { releaseAll(); exit(77) }
  if !AXIsProcessTrusted() { releaseAll(); print("error"); fflush(stdout); exit(2) }
  if Date().timeIntervalSince(lastSeen) > 5 { releaseAll() }
}
watchdog.resume()
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termination.setEventHandler { lock.lock(); releaseAll(); lock.unlock(); exit(0) }
termination.resume()
while let line = readLine() {
  guard inputCaller.code() != nil else { lock.lock(); releaseAll(); lock.unlock(); exit(77) }
  guard line.utf8.count <= 65536, let data = line.data(using: .utf8), let events = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { continue }
  lock.lock(); lastSeen = Date()
  for event in events { apply(event) }
  lock.unlock()
  print("ok"); fflush(stdout)
}
lock.lock(); releaseAll(); lock.unlock()
#endif
