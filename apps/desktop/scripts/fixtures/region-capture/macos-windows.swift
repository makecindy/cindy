// Owned windows for check-macos-region-snapping.mjs; no user content is read.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let previousApp = NSWorkspace.shared.frontmostApplication
let screen = NSScreen.screens[0]
let target = NSWindow(contentRect: CGRect(x: screen.visibleFrame.minX + 80,
  y: screen.visibleFrame.minY + 80, width: 600, height: 400),
  styleMask: [.titled, .closable], backing: .buffered, defer: false)
target.title = "Cindy region snapping regression"
target.level = .floating
let scroll = NSScrollView(frame: CGRect(x: 30, y: 30, width: 540, height: 300))
scroll.hasVerticalScroller = true
let document = NSView(frame: CGRect(x: 0, y: 0, width: 520, height: 600))
let button = NSButton(title: "Region test", target: nil, action: nil)
button.frame = CGRect(x: 30, y: 30, width: 140, height: 40)
document.addSubview(button)
scroll.documentView = document
target.contentView!.addSubview(scroll)
target.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

final class HalfOpaqueView: NSView {
  override var isOpaque: Bool { false }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.clear.setFill()
    bounds.fill(using: .copy)
    NSColor.windowBackgroundColor.setFill()
    NSRect(x: bounds.midX, y: 0, width: bounds.width / 2, height: bounds.height).fill()
  }
}
// Like the display-wide screenshot panel, the overlay covers more than the
// target window; equal bounds would model an indistinguishable sibling AX window.
let overlay = NSPanel(contentRect: target.frame.insetBy(dx: -10, dy: -10), styleMask: [.borderless, .nonactivatingPanel],
  backing: .buffered, defer: false)
overlay.level = NSWindow.Level(rawValue: target.level.rawValue + 1)
overlay.isOpaque = false
overlay.backgroundColor = .clear
overlay.hasShadow = false
overlay.contentView = HalfOpaqueView(frame: CGRect(origin: .zero, size: overlay.frame.size))
overlay.contentView!.wantsLayer = true

func rect(_ value: CGRect) -> [Double] {
  let top = screen.frame.maxY - value.maxY
  return [value.minX, top, value.maxX, top + value.height]
}
func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data + Data([10]))
}
func state() -> [String: Any] {
  ["frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
   "pointer": [NSEvent.mouseLocation.x, NSEvent.mouseLocation.y]]
}
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    DispatchQueue.main.async {
      switch request["op"] as? String {
      case "overlay":
        overlay.ignoresMouseEvents = request["ignore"] as? Bool ?? false
        overlay.orderFrontRegardless()
        overlay.displayIfNeeded()
      case "hide": overlay.orderOut(nil)
      default: break
      }
      var result = state()
      // Independent reference from a fully running AppKit application. Pixel
      // transparency alone does not guarantee input pass-through on every OS.
      result["transparentHit"] = NSWindow.windowNumber(at: CGPoint(x: target.frame.minX + 80,
        y: target.frame.midY), belowWindowWithWindowNumber: 0)
      result["id"] = request["id"]
      result["hwnd"] = target.windowNumber
      result["overlay"] = overlay.windowNumber
      result["pid"] = ProcessInfo.processInfo.processIdentifier
      result["rect"] = rect(target.frame)
      result["content"] = rect(target.convertToScreen(scroll.frame))
      emit(result)
    }
  }
  DispatchQueue.main.async {
    overlay.orderOut(nil)
    target.orderOut(nil)
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() {
      previousApp?.activate(options: [])
    }
    app.terminate(nil)
  }
}
app.run()
