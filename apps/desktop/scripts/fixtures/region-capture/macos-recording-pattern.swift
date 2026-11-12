// Explicit live-capture benchmark only. A generated pattern covers one display;
// no desktop image is persisted. EOF closes it without activating another app.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.screens[0]
final class Pattern: NSView {
  var tick = 0
  var moving = false
  override var isOpaque: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    for row in 0..<12 { for col in 0..<20 {
      NSColor(calibratedRed: CGFloat((col * 13 + tick * 3) % 256) / 255,
        green: CGFloat((row * 23 + tick) % 256) / 255,
        blue: CGFloat((row + col) % 12) / 12, alpha: 1).setFill()
      NSRect(x: CGFloat(col) * bounds.width / 20, y: CGFloat(row) * bounds.height / 12,
        width: bounds.width / 20 + 1, height: bounds.height / 12 + 1).fill()
    } }
    ("Cindy capture performance test — synthetic pixels" as NSString).draw(at: NSPoint(x: 80, y: 80),
      withAttributes: [.font: NSFont.systemFont(ofSize: 28), .foregroundColor: NSColor.white])
  }
}
let window = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 1)
window.ignoresMouseEvents = true
window.hasShadow = false
window.isOpaque = true
let pattern = Pattern(frame: NSRect(origin: .zero, size: screen.frame.size))
window.contentView = pattern
window.orderFrontRegardless()
window.displayIfNeeded()
let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
  if pattern.moving { pattern.tick += 1; pattern.needsDisplay = true }
}
func emit(_ object: [String: Any]) {
  let bytes = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(bytes + Data([10]))
}
emit(["display": screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]!,
  "width": screen.frame.width, "height": screen.frame.height, "scale": screen.backingScaleFactor,
  "window": window.windowNumber, "pid": getpid()])
DispatchQueue.global().async {
  while let command = readLine() {
    DispatchQueue.main.async {
      pattern.moving = command == "moving"
      if command == "static" { pattern.tick = 0; pattern.needsDisplay = true; window.displayIfNeeded() }
      emit(["state": command])
    }
  }
  DispatchQueue.main.async { timer.invalidate(); window.orderOut(nil); app.terminate(nil) }
}
app.run()
