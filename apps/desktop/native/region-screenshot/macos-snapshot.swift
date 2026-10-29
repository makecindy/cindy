// Region screenshot snapshot helper (macOS).
//
// Same line protocol as the Windows helper (one JSON request per stdin line,
// one JSON line back). Rectangles are global points [left, top, right, bottom]
// with the origin at the top-left of the primary display, which is Electron's
// DIP space.
//
// - {"id":1,"op":"windows"}  on-screen windows, front to back (with owner pid).
// - {"id":2,"op":"elements","pid":P,"x":X,"y":Y}  accessibility elements of
//   that app under the point, innermost first. Hit-test the application and
//   walk its parents, with a bounded window-tree fallback. Needs Accessibility;
//   without it the answer is empty and the overlay snaps to windows only.
// - {"id":6,"op":"window-at","x":X,"y":Y,"exclude":[N]}  mouse hit window,
//   excluding only this screenshot's overlay window numbers.
// - {"id":3,"op":"frontmost"} / {"id":4,"op":"activate","pid":P}  remember and
//   give focus back to the app the user was in before the screenshot.
// - {"id":5,"op":"screens"}  per display the top inset taken by the camera
//   housing (notch), also while the menu bar is hidden.
//
// Geometry, process ids and explicitly requested physical key labels only.

import AppKit
import ApplicationServices
import Foundation

let elementBudget: TimeInterval = 0.25
let maxDepth = 40
let minSide: CGFloat = 4
/// Windows at or above the Dock level (Dock, menu bar, status items, Control
/// Centre, cursor and shield windows) are system chrome, not snap targets.
let maxSnapLayer = Int(CGWindowLevelForKey(.dockWindow))
var elementDeadline: Date?

// Window-targeted posting needs both the window number and its coordinate
// stamp. Without the latter, Chromium silently drops the wheel event. Keep
// this optional SPI dynamically resolved: unsupported systems fail closed,
// never fall back to the HID tap (which moves the user's system pointer).
// CGPoint's two CGFloat fields use the same ABI as two Doubles on macOS.
typealias SetScrollWindowLocation = @convention(c) (CGEvent, Double, Double) -> Void
let setScrollWindowLocation: SetScrollWindowLocation? = {
  guard let framework = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY | RTLD_LOCAL),
    let symbol = dlsym(framework, "CGEventSetWindowLocation") else { return nil }
  return unsafeBitCast(symbol, to: SetScrollWindowLocation.self)
}()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func rectArray(_ rect: CGRect) -> [Double] {
  [Double(rect.minX), Double(rect.minY), Double(rect.maxX), Double(rect.maxY)]
}

func onScreenWindows() -> [[String: Any]] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  var result: [[String: Any]] = []
  for info in list {
    let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1
    if alpha <= 0.01 { continue }
    let layer = (info[kCGWindowLayer as String] as? Int) ?? 0
    if layer < 0 || layer >= maxSnapLayer { continue }
    if (info[kCGWindowOwnerName as String] as? String) == "Window Server" { continue }
    guard let bounds = info[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
      rect.width >= minSide, rect.height >= minSide,
      let number = info[kCGWindowNumber as String] as? Int,
      let pid = info[kCGWindowOwnerPID as String] as? Int
    else { continue }
    result.append(["hwnd": number, "pid": pid, "rect": rectArray(rect)])
  }
  return result
}

func scrollInputTarget(_ point: CGPoint) -> [String: Any]? {
  guard AXIsProcessTrusted() else { return nil }
  // A transparent, input-ignoring window can still be first in CGWindow order.
  // Resolve its receiving app through AX before choosing that app's front window.
  // Only retry our own overlay while WindowServer applies ignoresMouseEvents.
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.05)
  var hitPid: pid_t = 0
  for attempt in 0..<11 {
    var hit: AXUIElement?
    AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit)
    hitPid = 0
    if let hit = hit { AXUIElementGetPid(hit, &hitPid) }
    if hitPid != getppid() || attempt == 10 { break }
    usleep(10000)
  }
  guard hitPid > 0 else { return nil }
  return onScreenWindows().first { window in
    guard window["pid"] as? Int == Int(hitPid) else { return false }
    guard let rect = window["rect"] as? [Double] else { return false }
    return point.x >= rect[0] && point.x < rect[2] && point.y >= rect[1] && point.y < rect[3]
  }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  if let deadline = elementDeadline {
    let remaining = deadline.timeIntervalSinceNow
    guard remaining > 0 else { return nil }
    // AX 的超时是逐对象设置，应用对象上的值不会保护子元素调用。
    AXUIElementSetMessagingTimeout(element, Float(min(0.05, remaining)))
  }
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}

func frame(of element: AXUIElement) -> CGRect? {
  guard let position = attribute(element, kAXPositionAttribute),
    let size = attribute(element, kAXSizeAttribute),
    CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
  else { return nil }
  let rect = CGRect(origin: point, size: extent)
  return rect.width >= minSide && rect.height >= minSide ? rect : nil
}

func children(of element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// AppKit skips transparent pixels and windows that ignore mouse events.
/// Only Cindy's screenshot overlays are excluded explicitly; an unknown front
/// window must still block the captured windows behind it.
func windowAt(point: CGPoint, excluding: Set<Int>) -> Int {
  let cocoaPoint = CGPoint(x: point.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - point.y)
  var below = 0
  for _ in 0..<(excluding.count + 1) {
    let hit = NSWindow.windowNumber(at: cocoaPoint, belowWindowWithWindowNumber: below)
    if hit == 0 || hit == below { return 0 }
    if !excluding.contains(hit) { return hit }
    below = hit
  }
  return 0
}

func matches(_ a: CGRect, _ b: CGRect) -> Bool {
  abs(a.minX - b.minX) < 2 && abs(a.minY - b.minY) < 2
    && abs(a.width - b.width) < 2 && abs(a.height - b.height) < 2
}

/// Smallest element among `candidates` whose frame contains the point.
func smallest(_ candidates: [AXUIElement], containing point: CGPoint) -> (AXUIElement, CGRect)? {
  var best: (AXUIElement, CGRect)?
  for candidate in candidates {
    if let deadline = elementDeadline, deadline <= Date() { break }
    guard let rect = frame(of: candidate), rect.contains(point) else { continue }
    if best == nil || rect.width * rect.height < best!.1.width * best!.1.height {
      best = (candidate, rect)
    }
  }
  return best
}

func elementChain(pid: pid_t, point: CGPoint, bounds: CGRect?) -> [String: Any] {
  guard AXIsProcessTrusted() else { return ["rects": []] }
  let started = Date()
  elementDeadline = started.addingTimeInterval(elementBudget)
  defer { elementDeadline = nil }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.05)
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success,
    let hit = hit
  {
    var current = hit
    var visited: [AXUIElement] = []
    var chain: [CGRect] = []
    var document: CGRect?
    var scroll: CGRect?
    for _ in 0..<maxDepth {
      if elementDeadline!.timeIntervalSinceNow <= 0 || visited.contains(where: { CFEqual($0, current) }) { break }
      visited.append(current)
      let rect = frame(of: current)
      if let rect = rect, rect.contains(point), chain.last != rect {
        chain.append(rect)
      }
      let role = attribute(current, kAXRoleAttribute) as? String
      if let rect = rect, rect.contains(point) {
        if role == "AXWebArea" { document = rect }
        if role == kAXScrollAreaRole { scroll = rect }
      }
      if role == kAXWindowRole {
        // The app may own both the target and our screenshot overlay. Never use
        // a hit from another window of that app (or an overlapping sibling).
        if let rect = rect, bounds.map({ matches(rect, $0) }) ?? true {
          var result: [String: Any] = ["rects": chain.map(rectArray)]
          result["preferredRect"] = rectArray(document ?? scroll ?? rect)
          return result
        }
        break
      }
      guard let parent = attribute(current, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID()
      else { break }
      current = parent as! AXUIElement
    }
  }
  let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  let matching = windows.filter { window in
    guard let rect = frame(of: window) else { return false }
    return bounds.map { matches(rect, $0) } ?? rect.contains(point)
  }
  guard let root = smallest(matching, containing: point) else { return ["rects": []] }
  var pending: [(AXUIElement, [CGRect], CGRect?, CGRect?, Int)] = [(root.0, [root.1], nil, nil, 0)]
  var best: [CGRect] = []
  var preferred: CGRect?
  var bestIsDocument = false
  var visited = 0
  while let (current, chain, document, scroll, depth) = pending.popLast() {
    if Date().timeIntervalSince(started) > elementBudget || visited >= 256 { break }
    visited += 1
    if (document != nil && !bestIsDocument) || ((document != nil) == bestIsDocument && chain.count > best.count) {
      best = chain; preferred = document ?? scroll; bestIsDocument = document != nil
    }
    if depth >= maxDepth { continue }
    var candidates: [(AXUIElement, CGRect)] = []
    for child in children(of: current).prefix(512) {
      if Date().timeIntervalSince(started) > elementBudget { break }
      if let rect = frame(of: child), rect.contains(point) { candidates.append((child, rect)) }
    }
    candidates.sort { $0.1.width * $0.1.height < $1.1.width * $1.1.height }
    for (child, rect) in candidates.reversed() {
      let role = attribute(child, kAXRoleAttribute) as? String
      var next = chain
      if next.last != rect { next.append(rect) }
      pending.append((child, next, document ?? (role == "AXWebArea" ? rect : nil),
        scroll ?? (role == kAXScrollAreaRole ? rect : nil), depth + 1))
    }
  }
  var result: [String: Any] = ["rects": best.reversed().map(rectArray)]
  result["preferredRect"] = rectArray(preferred ?? root.1)
  return result
}

func screenInsets() -> [[String: Any]] {
  NSScreen.screens.compactMap { screen in
    guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    else { return nil }
    var top: CGFloat = 0
    if #available(macOS 12.0, *) { top = screen.safeAreaInsets.top }
    return ["id": number.uint32Value, "top": Double(top)]
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  guard let data = line.data(using: .utf8),
    let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else { continue }
  let id = request["id"] ?? NSNull()
  switch request["op"] as? String {
  case "scroll-target":
    guard let x = (request["x"] as? NSNumber)?.doubleValue,
      let y = (request["y"] as? NSNumber)?.doubleValue, x.isFinite, y.isFinite,
      let target = scrollInputTarget(CGPoint(x: x, y: y))
    else { emit(["id": id, "ok": false]); continue }
    emit(["id": id, "hwnd": target["hwnd"]!, "pid": target["pid"]!])
  case "scroll":
    guard AXIsProcessTrusted(),
      let setScrollWindowLocation = setScrollWindowLocation,
      let pid = (request["pid"] as? NSNumber)?.int32Value,
      let windowId = (request["hwnd"] as? NSNumber)?.intValue,
      let x = (request["x"] as? NSNumber)?.doubleValue,
      let y = (request["y"] as? NSNumber)?.doubleValue,
      let delta = (request["delta"] as? NSNumber)?.int32Value,
      x.isFinite, y.isFinite, delta >= -120, delta < 0,
      let source = CGEventSource(stateID: .combinedSessionState),
      let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)
    else { emit(["id": id, "ok": false]); continue }
    let point = CGPoint(x: x, y: y)
    // Revalidate the same captured window on every step. Covering it with a
    // different input window stops scrolling instead of redirecting the event.
    guard let target = scrollInputTarget(point),
      target["hwnd"] as? Int == windowId, target["pid"] as? Int == Int(pid)
    else { emit(["id": id, "ok": false]); continue }
    event.location = point
    event.flags = []
    // CoreGraphics' windowNumber field (51) is not in the public Swift enum.
    // The coordinate stamp is screen-space, despite the SPI's name; routing
    // derives the receiving window's local point. Post exactly once to the
    // revalidated owner, without moving the cursor or changing focus.
    event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(windowId))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
    setScrollWindowLocation(event, x, y)
    event.postToPid(pid)
    emit(["id": id, "ok": true])
  case "keys":
    if !CGPreflightListenEventAccess() {
      emit(["id": id, "keys": NSNull()])
      continue
    }
    let labels: [(CGKeyCode, String)] = [
      (55,"⌘"),(56,"⇧"),(58,"⌥"),(59,"⌃"),(36,"Return"),(48,"Tab"),(49,"Space"),(51,"Delete"),
      (123,"←"),(124,"→"),(125,"↓"),(126,"↑"),
      (0,"A"),(1,"S"),(2,"D"),(3,"F"),(4,"H"),(5,"G"),(6,"Z"),(7,"X"),(8,"C"),(9,"V"),
      (11,"B"),(12,"Q"),(13,"W"),(14,"E"),(15,"R"),(16,"Y"),(17,"T"),
      (18,"1"),(19,"2"),(20,"3"),(21,"4"),(22,"6"),(23,"5"),(25,"9"),(26,"7"),(28,"8"),(29,"0"),
      (31,"O"),(32,"U"),(34,"I"),(35,"P"),(37,"L"),(38,"J"),(40,"K"),(45,"N"),(46,"M")
    ]
    emit(["id": id, "keys": Array(labels.filter { CGEventSource.keyState(.combinedSessionState, key: $0.0) }.prefix(8).map { $0.1 })])
  case "windows":
    emit(["id": id, "windows": onScreenWindows()])
  case "window-at":
    if let x = (request["x"] as? NSNumber)?.doubleValue,
      let y = (request["y"] as? NSNumber)?.doubleValue, x.isFinite, y.isFinite
    {
      let excluded = Set(request["exclude"] as? [Int] ?? [])
      emit(["id": id, "hwnd": windowAt(point: CGPoint(x: x, y: y), excluding: excluded)])
    } else {
      emit(["id": id, "error": "invalid-request"])
    }
  case "screens":
    emit(["id": id, "screens": screenInsets()])
  case "elements":
    if let pid = (request["pid"] as? NSNumber)?.int32Value,
      let x = (request["x"] as? NSNumber)?.doubleValue,
      let y = (request["y"] as? NSNumber)?.doubleValue, x.isFinite, y.isFinite
    {
      let rect = request["rect"] as? [Double]
      let bounds = rect.flatMap { r -> CGRect? in
        guard r.count == 4, r.allSatisfy({ $0.isFinite }), r[2] > r[0], r[3] > r[1] else { return nil }
        return CGRect(x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1])
      }
      var result = elementChain(pid: pid, point: CGPoint(x: x, y: y), bounds: bounds)
      result["id"] = id
      emit(result)
    } else {
      emit(["id": id, "error": "invalid-request"])
    }
  case "frontmost":
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    emit(["id": id, "pid": pid.map { Int($0) } ?? NSNull()])
  case "activate":
    if let pid = (request["pid"] as? NSNumber)?.int32Value,
      let app = NSRunningApplication(processIdentifier: pid)
    {
      emit(["id": id, "ok": app.activate(options: [])])
    } else {
      emit(["id": id, "ok": false])
    }
  default:
    emit(["id": id, "error": "unknown-op"])
  }
}
