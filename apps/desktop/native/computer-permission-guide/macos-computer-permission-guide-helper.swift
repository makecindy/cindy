import AppKit
import ApplicationServices
import Foundation

private let systemSettingsBundleIdentifier = "com.apple.systempreferences"
private let hostSize = NSSize(width: 500, height: 226)
private let cardFrame = NSRect(x: 68, y: 12, width: 432, height: 152)
private let switchGuideSize = NSSize(width: 196, height: 44)
private let switchTargetGap: CGFloat = 28
private let trackingInterval: TimeInterval = 0.16

/** Emits one compact JSON object per line to the Electron main process. */
private func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

/** Permission state sent by Electron; the helper owns presentation only. */
private struct PermissionUpdate: Decodable {
    let type: String
    let accessibilityGranted: Bool?
    let screenRecordingGranted: Bool?
    let draggedAccessibility: Bool?
    let draggedScreenRecording: Bool?
    let switchTargetX: Double?
    let switchTargetY: Double?
    let switchWindowWidth: Double?
    let switchWindowHeight: Double?
}

/** A panel that can receive a first click without ever becoming key or main. */
private final class PermissionAccessoryPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/** Clear host view; only the visible material card participates in hit testing. */
private final class PassthroughHostView: NSView {
    weak var interactiveView: NSView?

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let interactiveView else { return nil }
        let localPoint = convert(point, to: interactiveView)
        guard interactiveView.bounds.contains(localPoint) else { return nil }
        return interactiveView.hitTest(localPoint)
    }
}

/** Close control that remains clickable while System Settings stays frontmost. */
private final class NonactivatingCloseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        // Keep the click inside this non-activating panel instead of ordering the
        // helper application in front of System Settings after an auth sheet closes.
        NSApp.preventWindowOrdering()
        super.mouseDown(with: event)
    }
}

/** Native app row that starts an AppKit file drag for the real .app bundle. */
private final class DraggableApplicationView: NSView, NSDraggingSource {
    private let appURL: URL
    private let appIcon: NSImage
    private var mouseDownEvent: NSEvent?
    private var didBeginDrag = false
    var dragEnabled = true
    var onDragBegan: (() -> Void)?
    var onDragEnded: ((NSDragOperation) -> Void)?

    init(appURL: URL, appIcon: NSImage) {
        self.appURL = appURL
        self.appIcon = appIcon
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.borderColor = NSColor.white.cgColor
        layer?.borderWidth = 1
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.28
        layer?.shadowRadius = 14
        layer?.shadowOffset = NSSize(width: 0, height: -5)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Computer Use")
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func layout() {
        super.layout()
        layer?.shadowPath = CGPath(
            roundedRect: bounds,
            cornerWidth: 12,
            cornerHeight: 12,
            transform: nil
        )
    }

    override func mouseDown(with event: NSEvent) {
        guard dragEnabled else { return }
        NSApp.preventWindowOrdering()
        mouseDownEvent = event
        didBeginDrag = false
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            animator().alphaValue = 0.82
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragEnabled, !didBeginDrag, let mouseDownEvent else { return }
        let dx = event.locationInWindow.x - mouseDownEvent.locationInWindow.x
        let dy = event.locationInWindow.y - mouseDownEvent.locationInWindow.y
        guard hypot(dx, dy) >= 4 else { return }
        didBeginDrag = true

        // Reassert the real drop target before entering AppKit's nested drag loop.
        NSRunningApplication.runningApplications(withBundleIdentifier: systemSettingsBundleIdentifier)
            .first?
            .activate()

        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        let imageSize = NSSize(width: 64, height: 64)
        item.setDraggingFrame(
            NSRect(
                x: event.locationInWindow.x - imageSize.width / 2,
                y: event.locationInWindow.y - imageSize.height / 2,
                width: imageSize.width,
                height: imageSize.height
            ),
            contents: appIcon
        )
        onDragBegan?()
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        if !didBeginDrag {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                animator().alphaValue = 1
            }
        }
        mouseDownEvent = nil
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }

    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        mouseDownEvent = nil
        didBeginDrag = false
        alphaValue = 1
        onDragEnded?(operation)
    }
}

/** Compact pointer shown after the app has been added but its switch is still off. */
private final class SwitchGuideController: NSViewController {
    private let closeButton = NonactivatingCloseButton()
    private let instructionLabel = NSTextField(labelWithString: "")
    private let arrowView = NSImageView()
    var onClose: (() -> Void)?

    private var usesChineseCopy: Bool {
        Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
    }

    override func loadView() {
        let root = NSView(frame: NSRect(origin: .zero, size: switchGuideSize))
        root.wantsLayer = true
        view = root

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.image = NSImage(
            systemSymbolName: "xmark.circle.fill",
            accessibilityDescription: usesChineseCopy ? "关闭" : "Close"
        )
        closeButton.imageScaling = .scaleProportionallyDown
        closeButton.isBordered = false
        closeButton.contentTintColor = .tertiaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeRequested)
        root.addSubview(closeButton)

        instructionLabel.translatesAutoresizingMaskIntoConstraints = false
        instructionLabel.stringValue = usesChineseCopy ? "打开这一项" : "Turn this on"
        instructionLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        instructionLabel.textColor = .controlAccentColor
        instructionLabel.alignment = .right
        root.addSubview(instructionLabel)

        arrowView.translatesAutoresizingMaskIntoConstraints = false
        arrowView.wantsLayer = true
        arrowView.image = NSImage(
            systemSymbolName: "arrow.right",
            accessibilityDescription: usesChineseCopy ? "指向开关" : "Points to the switch"
        )
        arrowView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 19, weight: .semibold)
        arrowView.contentTintColor = .controlAccentColor
        root.addSubview(arrowView)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            closeButton.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 24),
            closeButton.heightAnchor.constraint(equalToConstant: 24),

            instructionLabel.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 8),
            instructionLabel.centerYAnchor.constraint(equalTo: root.centerYAnchor),

            arrowView.leadingAnchor.constraint(equalTo: instructionLabel.trailingAnchor, constant: 10),
            arrowView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -4),
            arrowView.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            arrowView.widthAnchor.constraint(equalToConstant: 28),
            arrowView.heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    func prepareForDisplay() {
        guard isViewLoaded else { return }
        startGuidanceAnimation()
    }

    func prepareForDismissal() {
        guard isViewLoaded else { return }
        arrowView.layer?.removeAllAnimations()
    }

    private func startGuidanceAnimation() {
        arrowView.layer?.removeAllAnimations()
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }

        // One small compositor-only motion guides the eye without obscuring the switch.
        let movement = CAKeyframeAnimation(keyPath: "transform.translation.x")
        movement.values = [0, 6, 0, 0]
        movement.keyTimes = [0, 0.24, 0.48, 1]
        movement.duration = 1.6
        movement.repeatCount = .infinity
        movement.timingFunctions = [
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .linear),
        ]
        arrowView.layer?.add(movement, forKey: "switchGuideMovement")
    }

    @objc private func closeRequested() {
        onClose?()
    }
}

/** Composes the Apple-native material, typography, controls, and drag coach. */
private final class PermissionCardController: NSViewController {
    enum Permission: String {
        case accessibility
        case screenRecording
        case complete
    }

    private let appURL: URL
    private let materialView = NSVisualEffectView()
    private let eyebrowLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let appNameLabel = NSTextField(labelWithString: "CuaDriver")
    private let closeButton = NonactivatingCloseButton()
    private let dragCoach = NSView()
    private let dragCoachIcon = NSImageView()
    private let dragCoachPill = NSVisualEffectView()
    private let dragCoachLabel = NSTextField(labelWithString: "")
    private let appIconView = NSImageView()
    private let appRow: DraggableApplicationView
    private var permission: Permission = .accessibility
    private var hasBeenDragged = false
    private var closeTimer: Timer?
    var onClose: (() -> Void)?
    var onComplete: (() -> Void)?
    var onDragBegan: ((Permission) -> Void)?
    var onDragEnded: ((Permission, NSDragOperation) -> Void)?

    private var usesChineseCopy: Bool {
        Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
    }

    init(appURL: URL) {
        self.appURL = appURL
        let icon = NSWorkspace.shared.icon(forFile: appURL.path)
        icon.size = NSSize(width: 64, height: 64)
        self.appRow = DraggableApplicationView(appURL: appURL, appIcon: icon)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let root = NSView(frame: NSRect(origin: .zero, size: cardFrame.size))
        root.wantsLayer = true
        view = root

        materialView.translatesAutoresizingMaskIntoConstraints = false
        materialView.material = .hudWindow
        materialView.blendingMode = .behindWindow
        materialView.state = .active
        materialView.wantsLayer = true
        materialView.layer?.cornerRadius = 14
        materialView.layer?.cornerCurve = .continuous
        materialView.layer?.masksToBounds = true
        materialView.layer?.borderWidth = 0.5
        materialView.layer?.borderColor = NSColor.white.withAlphaComponent(0.13).cgColor
        root.addSubview(materialView)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: usesChineseCopy ? "关闭" : "Close"
        )
        closeButton.imageScaling = .scaleProportionallyDown
        closeButton.isBordered = false
        closeButton.bezelStyle = .circular
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeRequested)
        materialView.addSubview(closeButton)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        materialView.addSubview(titleLabel)

        eyebrowLabel.translatesAutoresizingMaskIntoConstraints = false
        eyebrowLabel.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        eyebrowLabel.textColor = .tertiaryLabelColor
        eyebrowLabel.lineBreakMode = .byTruncatingTail
        materialView.addSubview(eyebrowLabel)

        appRow.translatesAutoresizingMaskIntoConstraints = false
        materialView.addSubview(appRow)

        appIconView.translatesAutoresizingMaskIntoConstraints = false
        appIconView.image = NSWorkspace.shared.icon(forFile: appURL.path)
        appIconView.imageScaling = .scaleProportionallyUpOrDown
        appRow.addSubview(appIconView)

        appNameLabel.translatesAutoresizingMaskIntoConstraints = false
        appNameLabel.font = .systemFont(ofSize: 15, weight: .medium)
        appNameLabel.textColor = .labelColor
        appRow.addSubview(appNameLabel)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 12, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .right
        appRow.addSubview(statusLabel)

        root.addSubview(dragCoach)
        configureDragCoach(in: root)

        NSLayoutConstraint.activate([
            materialView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            materialView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            materialView.topAnchor.constraint(equalTo: root.topAnchor),
            materialView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            closeButton.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -12),
            closeButton.topAnchor.constraint(equalTo: materialView.topAnchor, constant: 10),
            closeButton.widthAnchor.constraint(equalToConstant: 28),
            closeButton.heightAnchor.constraint(equalToConstant: 28),

            titleLabel.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),
            titleLabel.topAnchor.constraint(equalTo: eyebrowLabel.bottomAnchor, constant: 3),
            titleLabel.heightAnchor.constraint(equalToConstant: 28),

            eyebrowLabel.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            eyebrowLabel.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),
            eyebrowLabel.topAnchor.constraint(equalTo: materialView.topAnchor, constant: 12),
            eyebrowLabel.heightAnchor.constraint(equalToConstant: 15),

            appRow.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            appRow.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -16),
            appRow.bottomAnchor.constraint(equalTo: materialView.bottomAnchor, constant: -18),
            appRow.heightAnchor.constraint(equalToConstant: 64),

            appIconView.leadingAnchor.constraint(equalTo: appRow.leadingAnchor, constant: 12),
            appIconView.centerYAnchor.constraint(equalTo: appRow.centerYAnchor),
            appIconView.widthAnchor.constraint(equalToConstant: 44),
            appIconView.heightAnchor.constraint(equalToConstant: 44),

            appNameLabel.leadingAnchor.constraint(equalTo: appIconView.trailingAnchor, constant: 12),
            appNameLabel.centerYAnchor.constraint(equalTo: appRow.centerYAnchor),

            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: appNameLabel.trailingAnchor, constant: 8),
            statusLabel.trailingAnchor.constraint(equalTo: appRow.trailingAnchor, constant: -14),
            statusLabel.centerYAnchor.constraint(equalTo: appRow.centerYAnchor),
        ])

        appRow.onDragBegan = { [weak self] in
            guard let self else { return }
            stopDragCoachAnimation()
            dragCoach.isHidden = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                self.materialView.animator().alphaValue = 0.18
            }
            onDragBegan?(permission)
        }
        appRow.onDragEnded = { [weak self] operation in
            guard let self else { return }
            hasBeenDragged = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                self.materialView.animator().alphaValue = 1
            }
            updateCopy()
            onDragEnded?(permission, operation)
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        updateCopy()
    }

    func update(
        accessibilityGranted: Bool,
        screenRecordingGranted: Bool,
        draggedAccessibility: Bool,
        draggedScreenRecording: Bool
    ) {
        closeTimer?.invalidate()
        if !accessibilityGranted {
            permission = .accessibility
            hasBeenDragged = draggedAccessibility
        } else if !screenRecordingGranted {
            permission = .screenRecording
            hasBeenDragged = draggedScreenRecording
        } else {
            permission = .complete
            hasBeenDragged = true
            closeTimer = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: false) { [weak self] _ in
                self?.onComplete?()
            }
        }
        updateCopy()
    }

    private func configureDragCoach(in root: NSView) {
        dragCoach.translatesAutoresizingMaskIntoConstraints = false
        dragCoach.wantsLayer = true

        dragCoachIcon.translatesAutoresizingMaskIntoConstraints = false
        dragCoachIcon.image = NSImage(
            systemSymbolName: "cursorarrow",
            accessibilityDescription: nil
        )
        dragCoachIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 17, weight: .medium)
        dragCoachIcon.contentTintColor = .labelColor
        dragCoach.addSubview(dragCoachIcon)

        dragCoachPill.translatesAutoresizingMaskIntoConstraints = false
        dragCoachPill.material = .popover
        dragCoachPill.blendingMode = .withinWindow
        dragCoachPill.state = .active
        dragCoachPill.wantsLayer = true
        dragCoachPill.layer?.cornerRadius = 13
        dragCoachPill.layer?.cornerCurve = .continuous
        dragCoach.addSubview(dragCoachPill)

        dragCoachLabel.translatesAutoresizingMaskIntoConstraints = false
        dragCoachLabel.font = .systemFont(ofSize: 12, weight: .medium)
        dragCoachLabel.textColor = .labelColor
        dragCoachPill.addSubview(dragCoachLabel)

        NSLayoutConstraint.activate([
            dragCoach.widthAnchor.constraint(equalToConstant: 92),
            dragCoach.heightAnchor.constraint(equalToConstant: 40),
            dragCoach.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            dragCoach.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -30),

            dragCoachIcon.leadingAnchor.constraint(equalTo: dragCoach.leadingAnchor),
            dragCoachIcon.centerYAnchor.constraint(equalTo: dragCoach.centerYAnchor),
            dragCoachIcon.widthAnchor.constraint(equalToConstant: 34),
            dragCoachIcon.heightAnchor.constraint(equalToConstant: 34),

            dragCoachPill.leadingAnchor.constraint(equalTo: dragCoachIcon.trailingAnchor, constant: 4),
            dragCoachPill.centerYAnchor.constraint(equalTo: dragCoach.centerYAnchor),
            dragCoachPill.heightAnchor.constraint(equalToConstant: 26),
            dragCoachPill.widthAnchor.constraint(equalToConstant: 52),

            dragCoachLabel.centerXAnchor.constraint(equalTo: dragCoachPill.centerXAnchor),
            dragCoachLabel.centerYAnchor.constraint(equalTo: dragCoachPill.centerYAnchor),
        ])
    }

    private func updateCopy() {
        guard isViewLoaded else { return }
        let permissionName: String
        switch permission {
        case .accessibility:
            permissionName = usesChineseCopy ? "辅助功能" : "Accessibility"
        case .screenRecording:
            permissionName = usesChineseCopy ? "屏幕录制" : "Screen Recording"
        case .complete:
            permissionName = ""
        }

        if permission == .complete {
            eyebrowLabel.stringValue = usesChineseCopy ? "已完成" : "READY"
            titleLabel.stringValue = usesChineseCopy ? "Computer Use 已就绪" : "Computer Use is ready"
            statusLabel.stringValue = ""
            appRow.dragEnabled = false
            dragCoach.isHidden = true
            stopDragCoachAnimation()
            return
        }

        eyebrowLabel.stringValue = usesChineseCopy
            ? "打开自动操作电脑"
            : "Open computer automation"
        appRow.dragEnabled = !hasBeenDragged
        if hasBeenDragged {
            titleLabel.stringValue = usesChineseCopy
                ? "在「\(permissionName)」中打开 CuaDriver"
                : "Turn on CuaDriver in \(permissionName)"
            statusLabel.stringValue = usesChineseCopy ? "等待你开启" : "Waiting for you"
            dragCoach.isHidden = true
            stopDragCoachAnimation()
        } else {
            titleLabel.stringValue = usesChineseCopy
                ? "将 CuaDriver 拖入「\(permissionName)」"
                : "Drag CuaDriver into \(permissionName)"
            statusLabel.stringValue = ""
            dragCoachLabel.stringValue = usesChineseCopy ? "拖拽" : "Drag"
            dragCoach.isHidden = false
            startDragCoachAnimation()
        }
    }

    private func startDragCoachAnimation() {
        dragCoach.layer?.opacity = 1
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            dragCoach.layer?.removeAllAnimations()
            return
        }
        guard dragCoach.layer?.animation(forKey: "dragCoachPosition") == nil else { return }
        view.layoutSubtreeIfNeeded()
        let base = dragCoach.layer?.position ?? .zero

        // Keep the coach fully visible and make the gesture unmistakable:
        // engage, travel directly toward the app row, hold, then reset softly.
        let position = CAKeyframeAnimation(keyPath: "position")
        position.values = [
            NSValue(point: base),
            NSValue(point: CGPoint(x: base.x - 5, y: base.y + 9)),
            NSValue(point: CGPoint(x: base.x - 32, y: base.y + 62)),
            NSValue(point: CGPoint(x: base.x - 32, y: base.y + 62)),
            NSValue(point: base),
        ]
        position.keyTimes = [0, 0.12, 0.46, 0.62, 1]
        position.duration = 2.0
        position.repeatCount = .infinity
        position.timingFunctions = [
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .linear),
            CAMediaTimingFunction(name: .easeInEaseOut),
        ]
        dragCoach.layer?.add(position, forKey: "dragCoachPosition")

        let pickup = CAKeyframeAnimation(keyPath: "transform.scale")
        pickup.values = [1, 1.05, 1.05, 1.05, 1]
        pickup.keyTimes = position.keyTimes
        pickup.duration = position.duration
        pickup.repeatCount = .infinity
        pickup.timingFunctions = position.timingFunctions
        dragCoach.layer?.add(pickup, forKey: "dragCoachPickup")
    }

    private func stopDragCoachAnimation() {
        dragCoach.layer?.removeAnimation(forKey: "dragCoachPosition")
        dragCoach.layer?.removeAnimation(forKey: "dragCoachPickup")
        dragCoach.layer?.opacity = 1
    }

    @objc private func closeRequested() {
        onClose?()
    }
}

/** Tracks the real System Settings window and attaches a non-activating panel. */
private final class PermissionGuideCoordinator {
    private enum Presentation {
        case hidden
        case drag
        case switchGuide
        case complete
    }

    private let panel: PermissionAccessoryPanel
    private let switchPanel: PermissionAccessoryPanel
    private let hostView: PassthroughHostView
    private let cardController: PermissionCardController
    private let switchGuideController: SwitchGuideController
    private var timer: Timer?
    private var hasActivatedSettings = false
    private var settingsMissingSince: Date?
    private var didNotifySettingsClosed = false
    private var isDragging = false
    private var presentation: Presentation = .hidden
    private var switchTarget: NSPoint?
    private var switchWindowSize: NSSize?

    init(appURL: URL) {
        panel = PermissionAccessoryPanel(
            contentRect: NSRect(origin: .zero, size: hostSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        switchPanel = PermissionAccessoryPanel(
            contentRect: NSRect(origin: .zero, size: switchGuideSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        hostView = PassthroughHostView(frame: NSRect(origin: .zero, size: hostSize))
        cardController = PermissionCardController(appURL: appURL)
        switchGuideController = SwitchGuideController()

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.worksWhenModal = true
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .transient,
            .ignoresCycle,
        ]
        panel.contentView = hostView

        switchPanel.isOpaque = false
        switchPanel.backgroundColor = .clear
        switchPanel.hasShadow = false
        switchPanel.level = .floating
        switchPanel.isFloatingPanel = true
        switchPanel.hidesOnDeactivate = false
        switchPanel.becomesKeyOnlyIfNeeded = true
        switchPanel.worksWhenModal = true
        switchPanel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .transient,
            .ignoresCycle,
        ]
        switchPanel.contentViewController = switchGuideController

        let card = cardController.view
        card.frame = cardFrame
        card.autoresizingMask = []
        hostView.addSubview(card)
        hostView.interactiveView = card

        cardController.onClose = { [weak self] in
            self?.dismiss(reason: "close-requested")
            emit(["type": "close-requested"])
        }
        switchGuideController.onClose = { [weak self] in
            self?.dismiss(reason: "close-requested")
            emit(["type": "close-requested"])
        }
        cardController.onComplete = { [weak self] in
            self?.dismiss(reason: "permissions-complete")
            emit(["type": "completed"])
            NSApp.terminate(nil)
        }
        cardController.onDragBegan = { [weak self] permission in
            self?.isDragging = true
            emit(["type": "drag-began", "permission": permission.rawValue])
        }
        cardController.onDragEnded = { [weak self] permission, operation in
            guard let self else { return }
            isDragging = false
            if operation.contains(.copy) {
                presentation = .switchGuide
            }
            emit([
                "type": "drag-ended",
                "permission": permission.rawValue,
                "operation": operation.rawValue,
            ])
            refreshAttachment()
        }
    }

    func start() {
        refreshAttachment()
        timer = Timer.scheduledTimer(withTimeInterval: trackingInterval, repeats: true) { [weak self] _ in
            self?.refreshAttachment()
        }
    }

    func apply(_ update: PermissionUpdate) {
        if let x = update.switchTargetX,
           let y = update.switchTargetY,
           x.isFinite,
           y.isFinite,
           x >= 0,
           y >= 0 {
            switchTarget = NSPoint(x: x, y: y)
        } else {
            switchTarget = nil
        }
        if let width = update.switchWindowWidth,
           let height = update.switchWindowHeight,
           width.isFinite,
           height.isFinite,
           width > 0,
           height > 0 {
            switchWindowSize = NSSize(width: width, height: height)
        } else {
            switchWindowSize = nil
        }
        if update.accessibilityGranted != true {
            presentation = update.draggedAccessibility == true ? .switchGuide : .drag
        } else if update.screenRecordingGranted != true {
            presentation = update.draggedScreenRecording == true ? .switchGuide : .drag
        } else {
            presentation = .complete
        }
        cardController.update(
            accessibilityGranted: update.accessibilityGranted == true,
            screenRecordingGranted: update.screenRecordingGranted == true,
            draggedAccessibility: update.draggedAccessibility == true,
            draggedScreenRecording: update.draggedScreenRecording == true
        )
        refreshAttachment()
    }

    func dismiss(reason: String) {
        timer?.invalidate()
        timer = nil
        panel.orderOut(nil)
        switchGuideController.prepareForDismissal()
        switchPanel.orderOut(nil)
        emit(["type": "dismissed", "reason": reason])
    }

    private func refreshAttachment() {
        guard let settingsApp = NSRunningApplication
            .runningApplications(withBundleIdentifier: systemSettingsBundleIdentifier)
            .first,
              let settingsFrame = systemSettingsWindowFrame(pid: settingsApp.processIdentifier)
        else {
            if !isDragging {
                if settingsMissingSince == nil {
                    settingsMissingSince = Date()
                }
                if hasActivatedSettings,
                   !didNotifySettingsClosed,
                   let missingSince = settingsMissingSince,
                   Date().timeIntervalSince(missingSince) >= 0.6 {
                    didNotifySettingsClosed = true
                    emit(["type": "close-requested"])
                    NSApp.terminate(nil)
                    return
                }
            }
            if !isDragging {
                panel.orderOut(nil)
                switchGuideController.prepareForDismissal()
                switchPanel.orderOut(nil)
            }
            return
        }
        settingsMissingSince = nil
        didNotifySettingsClosed = false

        if !hasActivatedSettings {
            hasActivatedSettings = true
            settingsApp.activate()
        }

        let frontmostBundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        guard isDragging || frontmostBundle == systemSettingsBundleIdentifier else {
            panel.orderOut(nil)
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
            return
        }

        switch presentation {
        case .hidden, .complete:
            panel.orderOut(nil)
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
            return
        case .switchGuide:
            panel.orderOut(nil)
            guard let desiredFrame = attachedSwitchGuideFrame(settingsFrame: settingsFrame) else {
                switchGuideController.prepareForDismissal()
                switchPanel.orderOut(nil)
                return
            }
            if !NSEqualRects(switchPanel.frame, desiredFrame) {
                switchPanel.setFrame(desiredFrame, display: switchPanel.isVisible, animate: false)
            }
            if !switchPanel.isVisible {
                switchGuideController.prepareForDisplay()
                switchPanel.orderFrontRegardless()
                emit([
                    "type": "attached",
                    "systemX": settingsFrame.origin.x,
                    "systemY": settingsFrame.origin.y,
                    "systemWidth": settingsFrame.width,
                    "systemHeight": settingsFrame.height,
                    "panelX": desiredFrame.origin.x,
                    "panelY": desiredFrame.origin.y,
                ])
            }
            return
        case .drag:
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
        }

        let desiredFrame = attachedPanelFrame(settingsFrame: settingsFrame)
        if !NSEqualRects(panel.frame, desiredFrame) {
            panel.setFrame(desiredFrame, display: panel.isVisible, animate: false)
        }
        if !panel.isVisible && !isDragging {
            panel.orderFrontRegardless()
            emit([
                "type": "attached",
                "systemX": settingsFrame.origin.x,
                "systemY": settingsFrame.origin.y,
                "systemWidth": settingsFrame.width,
                "systemHeight": settingsFrame.height,
                "panelX": desiredFrame.origin.x,
                "panelY": desiredFrame.origin.y,
            ])
        }
    }

    private func attachedPanelFrame(settingsFrame: NSRect) -> NSRect {
        var origin = NSPoint(
            x: settingsFrame.maxX - hostSize.width,
            y: settingsFrame.midY - cardFrame.midY
        )
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(settingsFrame) }) {
            origin.x = min(max(origin.x, screen.visibleFrame.minX), screen.visibleFrame.maxX - hostSize.width)
            origin.y = min(max(origin.y, screen.visibleFrame.minY), screen.visibleFrame.maxY - hostSize.height)
        }
        return NSRect(origin: origin, size: hostSize)
    }

    /** Convert CuaDriver's window-local, top-left switch point into AppKit space. */
    private func attachedSwitchGuideFrame(settingsFrame: NSRect) -> NSRect? {
        guard let switchTarget else { return nil }
        let scaleX = coordinateScale(
            external: switchWindowSize?.width,
            native: settingsFrame.width
        )
        let scaleY = coordinateScale(
            external: switchWindowSize?.height,
            native: settingsFrame.height
        )
        let target = NSPoint(
            x: settingsFrame.minX + switchTarget.x / scaleX,
            y: settingsFrame.maxY - switchTarget.y / scaleY
        )
        var origin = NSPoint(
            x: target.x - switchTargetGap - switchGuideSize.width,
            y: target.y - switchGuideSize.height / 2
        )
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(settingsFrame) }) {
            origin.x = min(
                max(origin.x, screen.visibleFrame.minX),
                screen.visibleFrame.maxX - switchGuideSize.width
            )
            origin.y = min(
                max(origin.y, screen.visibleFrame.minY),
                screen.visibleFrame.maxY - switchGuideSize.height
            )
        }
        return NSRect(origin: origin, size: switchGuideSize)
    }

    private func coordinateScale(external: CGFloat?, native: CGFloat) -> CGFloat {
        guard let external, native > 0 else { return 1 }
        let ratio = external / native
        // CuaDriver may report Retina window coordinates in backing pixels,
        // while AppKit positions panels in points. Keep normal layouts at 1x
        // and only normalize a clear backing-scale mismatch.
        return ratio > 1.25 ? ratio : 1
    }
}

/** Finds the largest visible layer-zero window owned by System Settings. */
private func systemSettingsWindowFrame(pid: pid_t) -> NSRect? {
    guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    var candidates: [CGRect] = []
    for info in rawList {
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? NSNumber,
              ownerPID.int32Value == pid,
              let layer = info[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rect.width > 360,
              rect.height > 260 else { continue }
        candidates.append(rect)
    }
    guard let cgFrame = candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
        return nil
    }
    return appKitRect(fromQuartz: cgFrame)
}

/** Converts Quartz top-left coordinates through the matching physical display. */
private func appKitRect(fromQuartz quartzRect: CGRect) -> NSRect {
    for screen in NSScreen.screens {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
            as? NSNumber else { continue }
        let displayBounds = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
        guard displayBounds.intersects(quartzRect) else { continue }
        let scale = max(
            1,
            min(
                screen.backingScaleFactor,
                displayBounds.width / max(screen.frame.width, 1)
            )
        )
        return NSRect(
            x: screen.frame.minX + (quartzRect.minX - displayBounds.minX) / scale,
            y: screen.frame.maxY - (quartzRect.minY - displayBounds.minY) / scale
                - quartzRect.height / scale,
            width: quartzRect.width / scale,
            height: quartzRect.height / scale
        )
    }
    let desktopTop = NSScreen.screens.map(\.frame.maxY).max() ?? 0
    return NSRect(
        x: quartzRect.minX,
        y: desktopTop - quartzRect.maxY,
        width: quartzRect.width,
        height: quartzRect.height
    )
}

/** AppKit process entry point and newline-delimited command reader. */
private final class PermissionGuideApplicationDelegate: NSObject, NSApplicationDelegate {
    private var coordinator: PermissionGuideCoordinator?
    private var inputBuffer = Data()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard CommandLine.arguments.count >= 2 else {
            emit(["type": "error", "message": "Missing Computer Use.app path."])
            NSApp.terminate(nil)
            return
        }
        let appURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        guard FileManager.default.fileExists(atPath: appURL.path) else {
            emit(["type": "error", "message": "Computer Use.app is unavailable."])
            NSApp.terminate(nil)
            return
        }
        let coordinator = PermissionGuideCoordinator(appURL: appURL)
        self.coordinator = coordinator
        coordinator.start()
        beginReadingCommands()
        emit(["type": "ready"])
    }

    func applicationWillTerminate(_ notification: Notification) {
        FileHandle.standardInput.readabilityHandler = nil
        coordinator?.dismiss(reason: "terminated")
    }

    private func beginReadingCommands() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            DispatchQueue.main.async { self?.consume(data) }
        }
    }

    private func consume(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 0x0A) {
            let line = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let update = try? JSONDecoder().decode(PermissionUpdate.self, from: line) else { continue }
            if update.type == "dismiss" {
                coordinator?.dismiss(reason: "electron-dismissed")
                NSApp.terminate(nil)
            } else if update.type == "update" {
                coordinator?.apply(update)
            }
        }
    }
}

private let application = NSApplication.shared
private let delegate = PermissionGuideApplicationDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.finishLaunching()
application.run()
