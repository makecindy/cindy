import AppKit
import ApplicationServices
import Foundation

private let systemSettingsBundleIdentifier = "com.apple.systempreferences"
private let hostSize = NSSize(width: 500, height: 226)
private let cardFrame = NSRect(x: 68, y: 12, width: 432, height: 152)
private let switchGuideSize = NSSize(width: 196, height: 44)
private let switchTargetGap: CGFloat = 28
private let trackingInterval: TimeInterval = 0.16

private enum GuideLocale: String {
    case zhCN = "zh-CN"
    case zhTW = "zh-TW"
    case en
    case ja
    case ko
}

/** Localized native copy selected from the renderer-synchronized app locale. */
private struct GuideCopy {
    let close: String
    let turnThisOn: String
    let pointsToSwitch: String
    let accessibility: String
    let screenRecording: String
    let completeEyebrow: String
    let readyTitle: String
    let step: String
    let turnOnAppTitle: String
    let waiting: String
    let dragTitle: String
    let dragHint: String

    func interpolated(_ template: String, permission: String) -> String {
        template.replacingOccurrences(of: "{{permission}}", with: permission)
    }

    static func resolve(_ locale: GuideLocale) -> GuideCopy {
        switch locale {
        case .zhCN:
            return GuideCopy(
                close: "关闭",
                turnThisOn: "打开这一项",
                pointsToSwitch: "指向开关",
                accessibility: "辅助功能",
                screenRecording: "屏幕录制",
                completeEyebrow: "权限已完成",
                readyTitle: "Computer Use 已就绪",
                step: "打开自动操作电脑",
                turnOnAppTitle: "在「{{permission}}」中打开 CuaDriver",
                waiting: "等待你开启",
                dragTitle: "将 CuaDriver 拖入「{{permission}}」",
                dragHint: "拖拽"
            )
        case .zhTW:
            return GuideCopy(
                close: "關閉",
                turnThisOn: "開啟此項目",
                pointsToSwitch: "指向切換開關",
                accessibility: "輔助使用",
                screenRecording: "螢幕錄製",
                completeEyebrow: "權限設定完成",
                readyTitle: "Computer Use 已準備就緒",
                step: "開啟電腦自動操作",
                turnOnAppTitle: "在「{{permission}}」中開啟 CuaDriver",
                waiting: "等待你開啟",
                dragTitle: "將 CuaDriver 拖曳至「{{permission}}」",
                dragHint: "拖曳"
            )
        case .ja:
            return GuideCopy(
                close: "閉じる",
                turnThisOn: "この項目をオンにする",
                pointsToSwitch: "スイッチを指す",
                accessibility: "アクセシビリティ",
                screenRecording: "画面収録",
                completeEyebrow: "権限の設定完了",
                readyTitle: "Computer Use の準備ができました",
                step: "コンピュータ操作を有効にする",
                turnOnAppTitle: "「{{permission}}」で CuaDriver をオンにする",
                waiting: "操作待ち",
                dragTitle: "CuaDriver を「{{permission}}」にドラッグ",
                dragHint: "ドラッグ"
            )
        case .ko:
            return GuideCopy(
                close: "닫기",
                turnThisOn: "이 항목 켜기",
                pointsToSwitch: "스위치를 가리킴",
                accessibility: "손쉬운 사용",
                screenRecording: "화면 기록",
                completeEyebrow: "권한 설정 완료",
                readyTitle: "Computer Use 준비 완료",
                step: "컴퓨터 자동화 켜기",
                turnOnAppTitle: "{{permission}}에서 CuaDriver 켜기",
                waiting: "켜기 대기",
                dragTitle: "CuaDriver를 {{permission}}으로 드래그",
                dragHint: "드래그"
            )
        case .en:
            return GuideCopy(
                close: "Close",
                turnThisOn: "Turn this on",
                pointsToSwitch: "Points to the switch",
                accessibility: "Accessibility",
                screenRecording: "Screen Recording",
                completeEyebrow: "Permissions complete",
                readyTitle: "Computer Use is ready",
                step: "Open computer automation",
                turnOnAppTitle: "Turn on CuaDriver in {{permission}}",
                waiting: "Waiting for you",
                dragTitle: "Drag CuaDriver into {{permission}}",
                dragHint: "Drag"
            )
        }
    }
}

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
        layer?.borderWidth = 1
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.28
        layer?.shadowRadius = 14
        layer?.shadowOffset = NSSize(width: 0, height: -5)
        updateLayerColors()
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("CuaDriver")
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateLayerColors()
    }

    override func layout() {
        super.layout()
        layer?.shadowPath = CGPath(
            roundedRect: bounds,
            cornerWidth: 12,
            cornerHeight: 12,
            transform: nil
        )
    }

    private func updateLayerColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
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
    private let copy: GuideCopy
    private let closeButton = NonactivatingCloseButton()
    private let instructionLabel = NSTextField(labelWithString: "")
    private let arrowView = NSImageView()
    var onClose: (() -> Void)?

    init(locale: GuideLocale) {
        copy = GuideCopy.resolve(locale)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let root = NSView(frame: NSRect(origin: .zero, size: switchGuideSize))
        root.wantsLayer = true
        view = root

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.image = NSImage(
            systemSymbolName: "xmark.circle.fill",
            accessibilityDescription: copy.close
        )
        closeButton.imageScaling = .scaleProportionallyDown
        closeButton.isBordered = false
        closeButton.contentTintColor = .tertiaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeRequested)
        root.addSubview(closeButton)

        instructionLabel.translatesAutoresizingMaskIntoConstraints = false
        instructionLabel.stringValue = copy.turnThisOn
        instructionLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        instructionLabel.textColor = .controlAccentColor
        instructionLabel.alignment = .right
        root.addSubview(instructionLabel)

        arrowView.translatesAutoresizingMaskIntoConstraints = false
        arrowView.wantsLayer = true
        arrowView.image = NSImage(
            systemSymbolName: "arrow.right",
            accessibilityDescription: copy.pointsToSwitch
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
    private let copy: GuideCopy
    private let materialView = NSVisualEffectView()
    private let eyebrowLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let appNameLabel = NSTextField(labelWithString: "CuaDriver")
    private let dragCoach = NSView()
    private let dragCoachIcon = NSImageView()
    private let dragCoachPill = NSVisualEffectView()
    private let dragCoachLabel = NSTextField(labelWithString: "")
    private let appIconView = NSImageView()
    private let appRow: DraggableApplicationView
    private var permission: Permission = .accessibility
    private var hasBeenDragged = false
    private var closeTimer: Timer?
    var onComplete: (() -> Void)?
    var onDragBegan: ((Permission) -> Void)?
    var onDragEnded: ((Permission, NSDragOperation) -> Void)?

    init(appURL: URL, locale: GuideLocale) {
        self.appURL = appURL
        self.copy = GuideCopy.resolve(locale)
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

            titleLabel.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -16),
            titleLabel.topAnchor.constraint(equalTo: eyebrowLabel.bottomAnchor, constant: 3),
            titleLabel.heightAnchor.constraint(equalToConstant: 28),

            eyebrowLabel.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            eyebrowLabel.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -16),
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
            permissionName = copy.accessibility
        case .screenRecording:
            permissionName = copy.screenRecording
        case .complete:
            permissionName = ""
        }

        if permission == .complete {
            eyebrowLabel.stringValue = copy.completeEyebrow
            titleLabel.stringValue = copy.readyTitle
            statusLabel.stringValue = ""
            appRow.dragEnabled = false
            dragCoach.isHidden = true
            stopDragCoachAnimation()
            return
        }

        eyebrowLabel.stringValue = copy.step
        appRow.dragEnabled = !hasBeenDragged
        if hasBeenDragged {
            titleLabel.stringValue = copy.interpolated(
                copy.turnOnAppTitle,
                permission: permissionName
            )
            statusLabel.stringValue = copy.waiting
            dragCoach.isHidden = true
            stopDragCoachAnimation()
        } else {
            titleLabel.stringValue = copy.interpolated(
                copy.dragTitle,
                permission: permissionName
            )
            statusLabel.stringValue = ""
            dragCoachLabel.stringValue = copy.dragHint
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
    private var authSheetVisible = false
    private var didEstablishFallbackWindowBaseline = false
    private var knownFallbackWindowIDs = Set<CGWindowID>()
    private var fallbackModalWindowIDs = Set<CGWindowID>()

    init(appURL: URL, locale: GuideLocale) {
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
        cardController = PermissionCardController(appURL: appURL, locale: locale)
        switchGuideController = SwitchGuideController(locale: locale)

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .normal
        panel.isFloatingPanel = false
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
        switchPanel.level = .normal
        switchPanel.isFloatingPanel = false
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
              let settingsInfo = systemSettingsWindowInfo(pid: settingsApp.processIdentifier)
        else {
            if !isDragging {
                didEstablishFallbackWindowBaseline = false
                knownFallbackWindowIDs.removeAll()
                fallbackModalWindowIDs.removeAll()
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
        let settingsFrame = settingsInfo.frame
        settingsMissingSince = nil
        didNotifySettingsClosed = false
        let hasModalSheet = resolveModalSheetState(settingsInfo)

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

        // When the auth sheet dismisses (fingerprint/password completed),
        // tell Electron so it can re-probe the permission state immediately.
        if authSheetVisible && !hasModalSheet {
            authSheetVisible = false
            emit(["type": "auth-sheet-dismissed"])
        } else if !authSheetVisible && hasModalSheet {
            authSheetVisible = true
        }

        // Hide while System Settings shows a modal sheet (auth dialog).
        // The panel reappears automatically on the next tick after dismissal.
        if hasModalSheet && !isDragging {
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
            if let desiredFrame = attachedSwitchGuideFrame(settingsFrame: settingsFrame) {
                panel.orderOut(nil)
                if !NSEqualRects(switchPanel.frame, desiredFrame) {
                    switchPanel.setFrame(desiredFrame, display: switchPanel.isVisible, animate: false)
                }
                if !switchPanel.isVisible {
                    switchGuideController.prepareForDisplay()
                    switchPanel.order(.above, relativeTo: settingsInfo.windowNumber)
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
            } else {
                // The row may exist before Accessibility can inspect its
                // checkbox. Keep the full "turn on CuaDriver" card visible
                // until a precise switch target becomes available.
                switchGuideController.prepareForDismissal()
                switchPanel.orderOut(nil)
            }
        case .drag:
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
        }

        let desiredFrame = attachedPanelFrame(settingsFrame: settingsFrame)
        if !NSEqualRects(panel.frame, desiredFrame) {
            panel.setFrame(desiredFrame, display: panel.isVisible, animate: false)
        }
        if !panel.isVisible && !isDragging {
            panel.order(.above, relativeTo: settingsInfo.windowNumber)
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

    /**
     * Prefer explicit AX modal relationships. When AX is unavailable, baseline
     * every existing Settings window and only treat a newly appearing,
     * top-attached sheet candidate during the switch step as modal.
     */
    private func resolveModalSheetState(_ info: SystemSettingsWindowInfo) -> Bool {
        if let hasModalSheet = info.axHasModalSheet {
            didEstablishFallbackWindowBaseline = true
            if hasModalSheet {
                // Seed the geometry fallback while AX is authoritative. If an
                // AX attribute is temporarily unavailable on the next tick,
                // keep the confirmed sheet visible until its window vanishes.
                fallbackModalWindowIDs = info.attachedSheetCandidateWindowIDs
                knownFallbackWindowIDs.formUnion(
                    info.layerZeroWindowIDs.subtracting(fallbackModalWindowIDs)
                )
            } else {
                knownFallbackWindowIDs.formUnion(info.layerZeroWindowIDs)
                fallbackModalWindowIDs.removeAll()
            }
            return hasModalSheet
        }
        if authSheetVisible {
            let hadTrackedFallbackModal = !fallbackModalWindowIDs.isEmpty
            if !hadTrackedFallbackModal {
                fallbackModalWindowIDs = info.attachedSheetCandidateWindowIDs
            }
            fallbackModalWindowIDs.formIntersection(info.layerZeroWindowIDs)
            if !hadTrackedFallbackModal && fallbackModalWindowIDs.isEmpty {
                // AX confirmed the sheet, but Quartz could not identify its
                // window. Do not invent a dismissal from an unknown AX sample.
                return true
            }
            return !fallbackModalWindowIDs.isEmpty
        }
        if !didEstablishFallbackWindowBaseline {
            didEstablishFallbackWindowBaseline = true
            knownFallbackWindowIDs = info.layerZeroWindowIDs
            fallbackModalWindowIDs.removeAll()
            return false
        }
        guard presentation == .switchGuide, !isDragging else {
            knownFallbackWindowIDs.formUnion(info.layerZeroWindowIDs)
            fallbackModalWindowIDs.removeAll()
            return false
        }
        fallbackModalWindowIDs.formUnion(
            info.attachedSheetCandidateWindowIDs.subtracting(knownFallbackWindowIDs)
        )
        fallbackModalWindowIDs.formIntersection(info.layerZeroWindowIDs)
        if fallbackModalWindowIDs.isEmpty {
            knownFallbackWindowIDs.formUnion(info.layerZeroWindowIDs)
        }
        return !fallbackModalWindowIDs.isEmpty
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

private struct SystemSettingsWindowInfo {
    let frame: NSRect
    let windowNumber: Int
    let axHasModalSheet: Bool?
    let layerZeroWindowIDs: Set<CGWindowID>
    let attachedSheetCandidateWindowIDs: Set<CGWindowID>
}

/** Read an AX array without treating an unavailable accessibility tree as modal. */
private func accessibilityElements(
    of element: AXUIElement,
    attribute: CFString
) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let elements = value as? [AXUIElement] else { return nil }
    return elements
}

private func accessibilityRole(of element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXRoleAttribute as CFString,
        &value
    ) == .success else { return nil }
    return value as? String
}

/** Detect actual System Settings sheets when this helper can read the AX tree. */
private func systemSettingsHasModalPresentation(pid: pid_t) -> Bool? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(pid)
    guard let windows = accessibilityElements(
        of: application,
        attribute: kAXWindowsAttribute as CFString
    ) else { return nil }
    var didEncounterUnavailableAttribute = false
    for window in windows {
        if let role = accessibilityRole(of: window) {
            if role == kAXSheetRole as String {
                return true
            }
        } else {
            didEncounterUnavailableAttribute = true
        }
        if let children = accessibilityElements(
            of: window,
            attribute: kAXChildrenAttribute as CFString
        ) {
            for child in children {
                guard let role = accessibilityRole(of: child) else {
                    didEncounterUnavailableAttribute = true
                    continue
                }
                if role == kAXSheetRole as String {
                    return true
                }
            }
        } else {
            didEncounterUnavailableAttribute = true
        }
        var modalValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            window,
            kAXModalAttribute as CFString,
            &modalValue
        ) == .success,
           let isModal = modalValue as? Bool {
            if isModal {
                return true
            }
        } else {
            didEncounterUnavailableAttribute = true
        }
    }
    return didEncounterUnavailableAttribute ? nil : false
}

/**
 * AX is normally unavailable to this accessory helper because the user grants
 * Accessibility to CuaDriver, not to the helper. Return only strict AppKit
 * sheet-shaped candidates here; the coordinator separately requires that the
 * candidate is new and appears during the switch step.
 */
private func systemSettingsAttachedSheetCandidates(
    windows: [(id: CGWindowID, frame: CGRect)],
    mainWindowID: CGWindowID,
    mainFrame: CGRect
) -> Set<CGWindowID> {
    let mainArea = mainFrame.width * mainFrame.height
    guard mainArea > 0 else { return [] }
    return Set(windows.compactMap { candidate -> CGWindowID? in
        guard candidate.id != mainWindowID else { return nil }
        let frame = candidate.frame
        let area = frame.width * frame.height
        guard frame.width >= 180,
              frame.height >= 100,
              area < mainArea * 0.9 else { return nil }
        let intersection = frame.intersection(mainFrame)
        guard !intersection.isNull else { return nil }
        let intersectionArea = intersection.width * intersection.height
        let center = CGPoint(x: frame.midX, y: frame.midY)
        let topAttachmentLimit = mainFrame.minY + min(140, mainFrame.height * 0.25)
        guard mainFrame.contains(center),
              intersectionArea >= area * 0.9,
              abs(frame.midX - mainFrame.midX) <= mainFrame.width * 0.18,
              frame.minY >= mainFrame.minY - 8,
              frame.minY <= topAttachmentLimit else { return nil }
        return candidate.id
    })
}

/** Finds the largest visible layer-zero window owned by System Settings. */
private func systemSettingsWindowInfo(pid: pid_t) -> SystemSettingsWindowInfo? {
    guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    var bestArea: CGFloat = 0
    var bestRect: CGRect?
    var bestWindowID: CGWindowID = 0
    var layerZeroWindows: [(id: CGWindowID, frame: CGRect)] = []
    for info in rawList {
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? NSNumber,
              ownerPID.int32Value == pid,
              let layer = info[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              let windowID = info[kCGWindowNumber as String] as? NSNumber else { continue }
        let cgWindowID = CGWindowID(windowID.intValue)
        layerZeroWindows.append((id: cgWindowID, frame: rect))
        guard rect.width > 360, rect.height > 260 else { continue }
        let area = rect.width * rect.height
        guard area > bestArea else { continue }
        bestArea = area
        bestRect = rect
        bestWindowID = cgWindowID
    }
    guard let cgFrame = bestRect else { return nil }
    return SystemSettingsWindowInfo(
        frame: appKitRect(fromQuartz: cgFrame),
        windowNumber: Int(bestWindowID),
        axHasModalSheet: systemSettingsHasModalPresentation(pid: pid),
        layerZeroWindowIDs: Set(layerZeroWindows.map(\.id)),
        attachedSheetCandidateWindowIDs: systemSettingsAttachedSheetCandidates(
            windows: layerZeroWindows,
            mainWindowID: bestWindowID,
            mainFrame: cgFrame
        )
    )
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
        let locale = CommandLine.arguments.count >= 3
            ? GuideLocale(rawValue: CommandLine.arguments[2]) ?? .en
            : .en
        guard FileManager.default.fileExists(atPath: appURL.path) else {
            emit(["type": "error", "message": "Computer Use.app is unavailable."])
            NSApp.terminate(nil)
            return
        }
        let coordinator = PermissionGuideCoordinator(appURL: appURL, locale: locale)
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
