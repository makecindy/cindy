// #11429: exercise the complete production card and host on real AppKit views.
// TS host tests cover IPC, not AppKit's parent-coordinate hitTest contract.
// Minimal failure: the icon at the left of a card offset by (68, 12) is missed.
// Tier: explicit macOS native integration; no visible windows, TCC or OS input.
// Run: node apps/desktop/native/computer-permission-guide/test.mjs
private enum PermissionGuideHitTests {
    static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        var failures = [String]()
        var checks = 0
        func check(_ condition: Bool, _ message: String) {
            checks += 1
            if !condition { failures.append(message); print("FAIL: \(message)") }
        }
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for origin in [NSPoint.zero, NSPoint(x: 37, y: 21)] {
                let controller = PermissionCardController(
                    appURL: URL(fileURLWithPath: "/System/Applications/Calculator.app"), locale: .en
                )
                let host = PassthroughHostView(frame: NSRect(origin: .zero, size: hostSize))
                let parent = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
                host.frame.origin = origin
                parent.addSubview(host)
                host.appearance = NSAppearance(named: appearance)
                func hit(_ point: NSPoint) -> NSView? {
                    host.hitTest(host.convert(point, to: parent))
                }
                let card = controller.view
                card.frame = cardFrame
                host.addSubview(card)
                host.interactiveView = card
                host.layoutSubtreeIfNeeded()

                func findRow(_ view: NSView) -> DraggableApplicationView? {
                    if let row = view as? DraggableApplicationView { return row }
                    return view.subviews.lazy.compactMap { findRow($0) }.first
                }
                guard let row = findRow(card) else { fatalError("Production card has no app row") }
                check(row.frame.width == 400 && row.frame.height == 64, "real app row layout")
                for (name, point) in [
                    ("icon", NSPoint(x: 34, y: 32)),
                    ("blank", NSPoint(x: 240, y: 32)),
                    ("lower edge", NSPoint(x: 120, y: 5)),
                ] {
                    let inHost = row.convert(point, to: host)
                    let expected = card.hitTest(inHost)
                    check(expected === row || expected?.isDescendant(of: row) == true,
                          "\(name): fixture is inside the production row")
                    check(hit(inHost) === expected, "\(appearance.rawValue) \(name): routes to the row")
                }
                let rightPoint = NSPoint(x: cardFrame.maxX - 10, y: cardFrame.minY + 50)
                check(hit(rightPoint) === card.hitTest(rightPoint), "right side retains native routing")
                check(hit(NSPoint(x: 10, y: 10)) == nil, "outside card passes through")
                let titlePoint = NSPoint(x: cardFrame.midX, y: cardFrame.maxY - 40)
                check(hit(titlePoint) === card.hitTest(titlePoint), "title retains native routing")
                card.isHidden = true
                check(hit(NSPoint(x: cardFrame.midX, y: cardFrame.midY)) == nil,
                      "hidden card passes through")
                card.isHidden = false
                host.interactiveView = nil
                check(hit(titlePoint) == nil, "missing card passes through")
            }
        }
        print("\(checks) AppKit checks; \(failures.count) failures")
        if !failures.isEmpty { exit(1) }
    }
}

PermissionGuideHitTests.main()
