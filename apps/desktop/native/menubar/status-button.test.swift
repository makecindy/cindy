import AppKit

// Issue #9019: exercise the production presentation on a real, offscreen NSButton.
// Existing TS tests cover host messages, not AppKit invalidations. Equal setters still
// matter here: counting their writes catches the reported redraw trigger even when
// the final pixels are unchanged. The minimal regression is the same view applied twice.
// Tier: explicit macOS native integration (Swift/AppKit), outside the unit pool.
// No status item, panel, account, IPC, or running Cindy instance is created.

struct ButtonWrites: Equatable {
  var image = 0
  var title = 0
  var position = 0
  var label = 0
  var tooltip = 0
}

/// Records writes at the real AppKit boundary without replacing its property behavior.
@MainActor
final class RecordingButton: NSButton {
  var writes = ButtonWrites()
  override var image: NSImage? { didSet { writes.image += 1 } }
  override var attributedTitle: NSAttributedString { didSet { writes.title += 1 } }
  override var imagePosition: NSControl.ImagePosition { didSet { writes.position += 1 } }
  override var toolTip: String? { didSet { writes.tooltip += 1 } }
  override func setAccessibilityLabel(_ label: String?) {
    writes.label += 1
    super.setAccessibilityLabel(label)
  }
}

@main
@MainActor
enum StatusButtonTests {
  static func main() throws {
    NSApplication.shared.setActivationPolicy(.prohibited)
    for appearance in [NSAppearance.Name.aqua, .darkAqua] {
      let button = RecordingButton(frame: NSRect(x: 0, y: 0, width: 100, height: 22))
      button.appearance = NSAppearance(named: appearance)
      let dark = appearance == .darkAqua
      let initial = try view()
      StatusButtonPresentation.update(button, view: initial)
      check(button.image != nil && button.image === Logos.statusIcon(dark: dark), "initial icon")
      check(button.attributedTitle.string == "\u{2009}42%", "initial title")
      check(button.imagePosition == .imageLeading, "initial layout")
      check(button.accessibilityLabel() == "Cindy, 42%", "initial accessibility label")
      check(button.toolTip == "Quota available", "initial tooltip")

      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: try view())
      check(button.writes == ButtonWrites(), "identical update must not write any property")
      // A changing preview/timestamp must still reach the panel, without repainting its icon.
      StatusButtonPresentation.update(button, view: try view(preview: "New task output", activityTime: 2))
      check(button.writes == ButtonWrites(), "panel-only update must not write any status property")

      StatusButtonPresentation.update(button, view: try view(title: "43%", attention: 2))
      check(button.writes == ButtonWrites(title: 1, label: 1), "title/count change must only write text and label")
      check(button.attributedTitle.string == "\u{2009}2 · 43%", "unread count and quota remain visible")
      check(button.accessibilityLabel() == "Cindy, 2 · 43%", "accessibility follows title")
      let font = button.attributedTitle.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
      check(font == NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular), "title keeps its font")

      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: try view(title: "43%", attention: 2, headline: "Updated quota"))
      check(button.writes == ButtonWrites(tooltip: 1), "headline-only change must only write tooltip")
      check(button.toolTip == "Updated quota", "tooltip stays fresh")

      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: try view(title: "43%", attention: 2, headline: "Updated quota", controlled: true))
      check(button.writes == ButtonWrites(image: 1), "remote control must only change icon")
      check(button.image === Logos.statusIcon(dark: dark, controlled: true), "remote-control dot appears")
      button.writes = ButtonWrites()
      StatusButtonPresentation.updateIcon(button, controlled: true)
      check(button.writes == ButtonWrites(), "unchanged appearance notification is a no-op")
      button.appearance = NSAppearance(named: dark ? .aqua : .darkAqua)
      StatusButtonPresentation.updateIcon(button, controlled: true)
      check(button.writes == ButtonWrites(image: 1), "appearance changes only icon without a new view")
      check(button.image === Logos.statusIcon(dark: !dark, controlled: true), "appearance switch preserves control dot")
      button.writes = ButtonWrites()
      StatusButtonPresentation.updateIcon(button, controlled: false)
      check(button.writes == ButtonWrites(image: 1), "disconnect updates icon immediately")
      check(button.image === Logos.statusIcon(dark: !dark), "remote-control dot clears")

      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: try view(title: "", headline: "Updated quota"))
      check(button.writes == ButtonWrites(title: 1, position: 1, label: 1), "icon-only mode clears title and layout")
      check(button.attributedTitle.string.isEmpty && button.imagePosition == .imageOnly, "icon-only result")
      check(button.accessibilityLabel() == "Cindy", "icon-only accessibility label")
      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: try view(title: "", headline: "Updated quota"))
      check(button.writes == ButtonWrites(), "repeated icon-only update is a no-op")
      StatusButtonPresentation.update(button, view: try view(title: "7", headline: "Updated quota"))
      check(button.writes == ButtonWrites(title: 1, position: 1, label: 1), "text mode restores layout")
      check(button.imagePosition == .imageLeading && button.attributedTitle.string == "\u{2009}7", "text mode restored")

      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: nil)
      check(button.writes == ButtonWrites(title: 1, position: 1, label: 1, tooltip: 1), "empty view clears stale text")
      check(button.toolTip == nil && button.accessibilityLabel() == "Cindy", "empty view clears tooltip and accessibility")
      button.writes = ButtonWrites()
      StatusButtonPresentation.update(button, view: nil)
      check(button.writes == ButtonWrites(), "repeated empty view is a no-op")
    }
    print("PASS: status button updates in Light and Dark")
  }

  static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    // precondition remains active in the optimized build used by this test.
    precondition(condition(), message)
  }

  static func view(title: String = "42%", attention: Int = 0, headline: String = "Quota available",
                   controlled: Bool = false, preview: String = "Working", activityTime: Double = 1) throws -> MBView {
    let json: [String: Any] = [
      "locale": "en", "moneySymbol": "$", "strings": [:] as [String: String],
      "statusTextByMode": ["lowest": title], "attentionCount": attention,
      "remotelyControlled": controlled, "headlinePrimary": headline,
      "activities": [["sessionId": "test", "title": "Task", "logoSvg": "", "companion": false,
                      "attention": false, "phase": "running", "preview": preview, "status": "Running",
                      "lastActivityAtMs": activityTime] as [String: Any]],
      "sources": [], "details": [:] as [String: String], "taskSummary": "", "tasks": [], "manage": [],
      "usage": ["days": [], "scopes": [:] as [String: String]] as [String: Any],
      "settings": ["enabled": true, "order": [], "hidden": [], "shown": [], "statusText": "lowest",
                   "lowAlert": false, "privacy": false, "scope": "local"] as [String: Any],
    ]
    return try JSONDecoder().decode(MBView.self, from: JSONSerialization.data(withJSONObject: json))
  }
}
