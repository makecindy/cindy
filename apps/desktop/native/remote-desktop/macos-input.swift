import Foundation
import ApplicationServices
import AppKit
import IOKit.graphics
import Security

// libuv creates AF_UNIX socket pairs for child stdio on macOS. Authenticate
// their kernel-supplied audit tokens, not argv, environment, PID alone or a
// caller-supplied secret. All three channels must belong to the same Main.
struct DesktopInputCaller {
  let token: Data
  let parent: pid_t
  let requirement: SecRequirement

  static func signingInfo(_ code: SecCode) -> [String: Any]? {
    var value: SecStaticCode?
    var information: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &value) == errSecSuccess, let value = value,
      SecCodeCopySigningInformation(value, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess else { return nil }
    return information as? [String: Any]
  }

  static func hasSealedHelper(_ code: SecCode, executable: URL) -> Bool {
    var value: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &value) == errSecSuccess, let value = value,
      let bytes = try? Data(contentsOf: executable) else { return false }
    // Bind the shipped pair: a same-team older app must not gain this helper's
    // privileges by transplanting it into an app with weaker Electron fuses.
    return SecCodeValidateFileResource(value,
      "Resources/tools/remote-desktop/cindy-macos-desktop-input" as CFString,
      bytes as CFData, []) == errSecSuccess
  }

  static func peer(_ descriptor: Int32) -> Data? {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(descriptor, 0 /* SOL_LOCAL */, 6 /* LOCAL_PEERTOKEN */, &token, &size) == 0,
      size == MemoryLayout<audit_token_t>.size else { return nil }
    return withUnsafeBytes(of: token) { Data($0) }
  }

  func code() -> SecCode? {
    guard getppid() == parent else { return nil }
    var code: SecCode?
    let attributes = [kSecGuestAttributeAudit: token] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
      let code = code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return nil }
    return code
  }

  static func authenticate() -> DesktopInputCaller? {
    guard let token = peer(STDIN_FILENO), peer(STDOUT_FILENO) == token,
      peer(STDERR_FILENO) == token else { return nil }
    let words = token.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
    let parent = getppid()
    guard parent > 1, words[5] == UInt32(parent), words[1] == geteuid() else { return nil }
    var requirement: SecRequirement?
    let executable: URL
#if DESKTOP_INPUT_DEVELOPMENT
    // Development runs writable JS in generic Electron with an inspector.
    // This is only an exact runtime binding, NOT a production security boundary.
    // Main fills this compile-time value; no environment/CLI downgrade exists.
    let encodedExecutable = "DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE"
    guard let data = Data(base64Encoded: encodedExecutable),
      let value = String(data: data, encoding: .utf8), value.hasPrefix("/") else { return nil }
    executable = URL(fileURLWithPath: value).resolvingSymlinksInPath()
    var expected: SecStaticCode?
    guard SecStaticCodeCreateWithPath(executable as CFURL, [], &expected) == errSecSuccess,
      let expected = expected,
      SecCodeCopyDesignatedRequirement(expected, [], &requirement) == errSecSuccess else { return nil }
#else
    var own: SecCode?
    guard SecCodeCopySelf([], &own) == errSecSuccess, let own = own,
      SecCodeCheckValidity(own, [], nil) == errSecSuccess,
      let info = signingInfo(own),
      let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
      team.range(of: "^[A-Z0-9]+$", options: .regularExpression) != nil,
      let ownExecutable = info[kSecCodeInfoMainExecutable as String] as? URL else { return nil }
    // Only the Main executable in this helper's enclosing, signed app may call
    // it. Another signed application (even from our team) is not Cindy Main.
    var appURL = ownExecutable.resolvingSymlinksInPath()
    for _ in 0..<5 { appURL.deleteLastPathComponent() }
    guard let bundle = Bundle(url: appURL), let identifier = bundle.bundleIdentifier,
      ["com.xd.cindy", "com.xd.cindycn"].contains(identifier),
      let mainExecutable = bundle.executableURL else { return nil }
    executable = mainExecutable.resolvingSymlinksInPath()
    let rule = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess else { return nil }
#endif
    guard let requirement = requirement else { return nil }
    let caller = DesktopInputCaller(token: token, parent: parent, requirement: requirement)
    guard let code = caller.code(), let info = signingInfo(code),
      let actual = info[kSecCodeInfoMainExecutable as String] as? URL,
      actual.resolvingSymlinksInPath() == executable else { return nil }
#if !DESKTOP_INPUT_DEVELOPMENT
    guard let flags = info[kSecCodeInfoFlags as String] as? UInt32,
      flags & 0x10000 /* kSecCodeSignatureRuntime */ != 0,
      flags & 0x0002 /* kSecCodeSignatureAdhoc */ == 0,
      hasSealedHelper(code, executable: ownExecutable) else { return nil }
#endif
    return caller
  }
}

#if !DESKTOP_INPUT_TEST
// This guard precedes every entrypoint, including selection and permission UI.
guard let inputCaller = DesktopInputCaller.authenticate() else { exit(77) }
#endif

// Expose only the clipboard change counter, never clipboard content on stdout.
if CommandLine.arguments.count == 2 && ["--clipboard-version", "--clipboard-content-version"].contains(CommandLine.arguments[1]) {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  guard let session = session, !(session["CGSSessionScreenIsLocked"] as? Bool ?? false) else { exit(2) }
  if CommandLine.arguments[1] == "--clipboard-content-version",
    (NSPasteboard.general.pasteboardItems?.count ?? 0) > 1 { exit(3) }
  print(NSPasteboard.general.changeCount); exit(0)
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
func apply(_ event: [String: Any]) {
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
#if !DESKTOP_INPUT_TEST
if CommandLine.arguments.contains("--check") {
  print(AXIsProcessTrusted() ? "ready" : "permission"); exit(0)
}
if CommandLine.arguments.contains("--request-permission") {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  print(AXIsProcessTrustedWithOptions(options) ? "ready" : "permission"); exit(0)
}
guard AXIsProcessTrusted() else { print("permission"); fflush(stdout); exit(2) }
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
}
lock.lock(); releaseAll(); lock.unlock()
#endif
