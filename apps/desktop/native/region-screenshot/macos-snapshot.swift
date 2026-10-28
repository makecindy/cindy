// Region screenshot snapshot helper (macOS).
//
// Same line protocol as the Windows helper (one JSON request per stdin line,
// one JSON line back). Rectangles are global points [left, top, right, bottom]
// with the origin at the top-left of the primary display, which is Electron's
// DIP space.
//
// - {"id":1,"op":"windows"}  on-screen windows, front to back (with owner pid).
// - {"id":2,"op":"elements","pid":P,"x":X,"y":Y}  accessibility elements of
//   that app under the point, innermost first. The tree is walked from the
//   app's windows instead of hit-testing the screen, because Cindy's overlay
//   covers the screen. Needs the Accessibility permission; without it the
//   answer is empty and the overlay snaps to windows only.
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

func elementChain(pid: pid_t, point: CGPoint) -> [[Double]] {
  guard AXIsProcessTrusted() else { return [] }
  let started = Date()
  elementDeadline = started.addingTimeInterval(elementBudget)
  defer { elementDeadline = nil }
  let app = AXUIElementCreateApplication(pid)
  let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  guard var current = smallest(windows, containing: point) else { return [] }
  var chain: [CGRect] = [current.1]
  for _ in 0..<maxDepth {
    if Date().timeIntervalSince(started) > elementBudget { break }
    guard let next = smallest(children(of: current.0), containing: point) else { break }
    if next.1 != chain.last { chain.append(next.1) }
    current = next
  }
  return chain.reversed().map(rectArray)
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
  case "scroll":
    guard AXIsProcessTrusted(),
      let pid = (request["pid"] as? NSNumber)?.int32Value,
      let x = (request["x"] as? NSNumber)?.doubleValue,
      let y = (request["y"] as? NSNumber)?.doubleValue,
      let delta = (request["delta"] as? NSNumber)?.int32Value,
      x.isFinite, y.isFinite, delta >= -120, delta < 0,
      let source = CGEventSource(stateID: .combinedSessionState),
      let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)
    else { emit(["id": id, "ok": false]); continue }
    let point = CGPoint(x: x, y: y)
    var hit: AXUIElement?
    AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit)
    var hitPid: pid_t = 0
    if let hit = hit { AXUIElementGetPid(hit, &hitPid) }
    guard hitPid == pid else { emit(["id": id, "ok": false]); continue }
    event.location = point
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
  case "screens":
    emit(["id": id, "screens": screenInsets()])
  case "elements":
    if let pid = (request["pid"] as? NSNumber)?.int32Value,
      let x = (request["x"] as? NSNumber)?.doubleValue,
      let y = (request["y"] as? NSNumber)?.doubleValue
    {
      emit(["id": id, "rects": elementChain(pid: pid, point: CGPoint(x: x, y: y))])
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
