// PR #8848: pressing a reminder's resize edge saved its temporary width as a
// preference. JS state/service tests cannot exercise the native pointer poller.
// Native integration tier: real controller handlers, layout events and deferred
// state replay; a notch fixture avoids depending on the Mac having a notch.
// No OS input or preferences are written. Run via test-island-reminder-drag.mjs.
extension AgentIslandController {
  static func checkReminderDrag() {
    guard let screen = NSScreen.main else { fatalError("需要已登录的 macOS 桌面") }
    let savedWidth = 185.0
    let metrics = AgentIslandScreenMetrics(
      displayId: AgentIslandScreenMetricsProvider.displayId(for: screen),
      frame: AgentIslandRect(x: Double(screen.frame.minX), y: Double(screen.frame.minY),
        width: Double(screen.frame.width), height: Double(screen.frame.height)),
      hasNotch: true, notchWidth: savedWidth, topBarHeight: 32, menuBarHeight: 32,
      safeAreaTop: 32, isMain: true, signature: "regression-notch"
    )
    let carrier = AgentIslandCarrierFrame(
      x: Double(screen.frame.width / 2 - 340), y: 0, width: 680, height: 80,
      displayId: metrics.displayId,
      displayBounds: AgentIslandRect(x: 0, y: 0,
        width: Double(screen.frame.width), height: Double(screen.frame.height)),
      contentWidth: savedWidth
    )
    var failures = [String]()
    var cases = 0
    func check(_ condition: Bool, _ message: String) {
      if !condition { failures.append(message); print("FAIL: \(message)") }
    }
    for edge in [PanelPointerHit.resizeLeft, .resizeRight] {
      for scenario in ["click", "held", "vertical", "expiry-while-held", "resize", "resize-and-return", "open-list"] {
        if scenario == "open-list" && edge == .resizeRight { continue }
        cases += 1
        var events = [[String: Any]]()
        let controller = AgentIslandController(eventSink: { events.append($0) })
        var reminder = AgentIslandDisplayState.empty
        reminder.compactReminder = AgentIslandCompactReminder(phase: "completed", until: Date().timeIntervalSince1970 * 1000 + 3000)
        controller.model.state = reminder
        controller.model.screenMetrics = metrics
        controller.model.notchBaselineHeight = 32
        controller.model.hardwareNotchLayoutEnabled = true
        controller.model.preferredContentWidth = CGFloat(savedWidth)
        controller.model.carrierWidth = 680
        controller.lastCarrierFrame = carrier
        controller.lastLayout = AgentIslandLayout.compute(
          state: reminder, availableFrameWidth: 680, locallyHovered: false,
          notchBaselineHeight: 32, screenMetrics: metrics, preferredContentWidth: CGFloat(savedWidth)
        )
        let temporaryWidth = controller.lastLayout.width
        check(temporaryWidth > savedWidth, "fixture exposes a temporary reminder width")
        controller.panel.setFrame(NSRect(x: screen.frame.midX - 340,
          y: screen.frame.maxY - 80, width: 680, height: 80), display: false)
        controller.panel.orderFrontRegardless()
        let start = NSPoint(x: screen.frame.midX, y: screen.frame.maxY - 16)
        let label = "\(edge) \(scenario)"
        check(controller.beginDragInteraction(screenPoint: start,
          hit: scenario == "open-list" ? .menuBar : edge), "\(label): begins")
        if scenario == "open-list" {
          controller.finishPendingMove(screenPoint: start)
          check(events.filter { $0["type"] as? String == "expand" }.count == 1,
            "click still opens the full list")
        } else {
          var point = start
          if scenario != "click" {
            if scenario == "vertical" { point.y -= 20 }
            if scenario.hasPrefix("resize") { point.x += edge == .resizeLeft ? -40 : 40 }
            // The held-pointer poller calls continueDrag even without motion.
            controller.continueDrag(screenPoint: point, interaction: controller.dragInteraction!)
            if scenario == "resize-and-return" { point = start }
            controller.continueDrag(screenPoint: point, interaction: controller.dragInteraction!)
          }
          if scenario == "expiry-while-held" || scenario.hasPrefix("resize") {
            controller.apply(state: .empty, frame: carrier)
          }
          controller.finishDrag(screenPoint: point)
        }
        if scenario == "expiry-while-held" {
          check(controller.lastCarrierFrame?.contentWidth == savedWidth,
            "\(label): deferred frame retains saved preference")
          check(controller.model.preferredContentWidth == CGFloat(savedWidth),
            "\(label): expiry replay restores saved width before another update")
        }
        let layouts = events.filter { $0["type"] as? String == "layout" }
        if scenario.hasPrefix("resize") {
          check(!layouts.isEmpty, "\(label): real resize is saved")
          if let width = layouts.last?["contentWidth"] as? Double {
            let expected = Double(temporaryWidth) + (scenario == "resize" ? 80 : 0)
            check(abs(width - expected) < 0.1, "\(label): final width is \(expected), got \(width)")
            check(controller.model.preferredContentWidth == CGFloat(width),
              "\(label): deferred update keeps actual resize")
          }
          let countBeforeClick = layouts.count
          check(controller.beginDragInteraction(screenPoint: start, hit: edge), "\(label): second gesture begins")
          controller.continueDrag(screenPoint: start, interaction: controller.dragInteraction!)
          controller.finishDrag(screenPoint: start)
          check(events.filter { $0["type"] as? String == "layout" }.count == countBeforeClick,
            "\(label): next gesture does not inherit the previous drag")
        } else {
          check(layouts.isEmpty, "\(label): no layout preferences without horizontal drag")
          controller.apply(state: .empty, frame: carrier)
          check(controller.model.preferredContentWidth == CGFloat(savedWidth),
            "\(label): reminder expiry restores saved width")
        }
        controller.close()
      }
    }
    if !failures.isEmpty { print("Native reminder regression: \(failures.count) failures"); exit(1) }
    print("Native reminder regression: \(cases) scenarios passed")
  }
}
let testApp = NSApplication.shared
testApp.setActivationPolicy(.accessory)
AgentIslandController.checkReminderDrag()
