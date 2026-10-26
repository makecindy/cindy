import ExpoModulesCore
import UIKit

/// Weak discovery by route surface: cached histories must never borrow another
/// route's composer, and React continues to own both native views.
private enum ComposerViewports {
  static let anchors = NSMapTable<NSString, CindyComposerViewportAnchor>(keyOptions: .strongMemory, valueOptions: .weakMemory)
  static let viewports = NSHashTable<CindyKeyboardViewport>.weakObjects()
  static func changed(_ id: String) {
    guard !id.isEmpty else { return }
    for viewport in viewports.allObjects where viewport.composerSurfaceId == id {
      viewport.updateComposerInset()
    }
  }
}

final class CindyComposerViewportAnchor: ExpoView {
  var surfaceId = "" {
    didSet {
      guard oldValue != surfaceId else { return }
      if ComposerViewports.anchors.object(forKey: oldValue as NSString) === self {
        ComposerViewports.anchors.removeObject(forKey: oldValue as NSString)
        ComposerViewports.changed(oldValue)
      }
      ComposerViewports.anchors.setObject(self, forKey: surfaceId as NSString)
      ComposerViewports.changed(surfaceId)
    }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    ComposerViewports.changed(surfaceId)
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    ComposerViewports.changed(surfaceId)
  }
}

/// The list keeps its Fabric frame throughout keyboard motion. Insets and the
/// pinned end offset are written together on the main thread, not reconstructed
/// from delayed JS onLayout events. A finite display link also sees content-size
/// changes during the transition (for example the composer accepting a suggestion).
final class CindyKeyboardViewport: ExpoView {
  let onKeyboardTransition = EventDispatcher()
  let onViewportInsetChange = EventDispatcher()
  var enabled = false {
    didSet { if !enabled { finish(reset: true) } else { updateComposerInset() } }
  }
  var composerSurfaceId = "" { didSet { updateComposerInset() } }
  var composerContentPadding: CGFloat = 0 { didSet { updateComposerInset() } }
  var followLatest = false {
    didSet { if !followLatest { following = false } }
  }
  private weak var scroll: UIScrollView?
  private let progress = UIView()
  private var displayLink: CADisplayLink?
  private var bottomInset: CGFloat = 0
  private var baseInset: CGFloat = 0
  private var composerInset: CGFloat = 0
  private var managedInset: CGFloat = 0
  private var following = false
  private var generation = 0
  private var keyboardAnimating = false
  private var reservationVelocity: CGFloat = 0
  private var reservationTimestamp: CFTimeInterval = 0
  private let traceMotion = ProcessInfo.processInfo.environment["CINDY_MESSAGE_MOTION_TRACE"] == "1"

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    progress.isUserInteractionEnabled = false
    progress.alpha = 0
    addSubview(progress)
    ComposerViewports.viewports.add(self)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
      name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
  }

  private func findScroll(_ view: UIView) -> UIScrollView? {
    if let scroll = view as? UIScrollView { return scroll }
    for child in view.subviews {
      if let scroll = findScroll(child) { return scroll }
    }
    return nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { finish(reset: true) } else { updateComposerInset() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    updateComposerInset()
  }

  fileprivate func updateComposerInset() {
    guard enabled, window != nil, let list = findScroll(self) else { return }
    scroll = list
    let anchor = ComposerViewports.anchors.object(forKey: composerSurfaceId as NSString)
    let height = anchor?.window === window ? anchor?.bounds.height ?? 0 : 0
    let next = max(0, height - composerContentPadding)
    guard abs(next - composerInset) > 0.1 else { return }
    // Test distance before changing the range. A reader's position stays fixed;
    // only a pinned tail follows the composer, including its animated collapse.
    let distance = list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height - list.contentOffset.y
    let wasFollowing = following
    if displayLink == nil {
      following = followLatest && !list.isTracking && !list.isDragging && !list.isDecelerating && distance < 64
    }
    baseInset = list.contentInset.bottom - managedInset
    composerInset = next
    apply(bottomInset)
    if displayLink == nil { following = wasFollowing }
    onViewportInsetChange([
      "bottom": list.contentInset.bottom, "offsetY": list.contentOffset.y,
      "viewportHeight": list.bounds.height - list.adjustedContentInset.bottom - list.adjustedContentInset.top,
      "contentHeight": list.contentSize.height,
    ])
  }

  @objc private func keyboardChanged(_ notification: Notification) {
    guard enabled, let window, let info = notification.userInfo,
      let frame = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
      let list = findScroll(self) else { return }
    scroll = list
    let localFrame = window.convert(frame, from: window.screen.coordinateSpace)
    // The wrapper includes a non-overlay composer in group chats. Its bottom,
    // rather than the shorter list's bottom, is the keyboard's resting edge.
    let viewport = convert(bounds, to: window)
    // Floating keyboards do not remove a full-width strip from the viewport.
    let overlapsBottom = localFrame.maxY >= viewport.maxY - 1
      && localFrame.minX <= viewport.minX + 1 && localFrame.maxX >= viewport.maxX - 1
      && localFrame.intersects(viewport)
    let end = overlapsBottom ? max(0, viewport.maxY - localFrame.minY) : 0
    if displayLink == nil && abs(end - bottomInset) < 0.1 { return }
    let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
    let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 0
    let current = progress.layer.presentation()?.frame.minY ?? bottomInset
    generation += 1
    let run = generation
    keyboardAnimating = true
    reservationTimestamp = CACurrentMediaTime()
    progress.layer.removeAllAnimations()
    progress.frame = CGRect(x: 0, y: current, width: 1, height: 1)
    baseInset = list.contentInset.bottom - managedInset
    let distance = list.contentSize.height + list.adjustedContentInset.bottom
      - list.bounds.height - list.contentOffset.y
    following = followLatest && !list.isTracking && !list.isDragging && !list.isDecelerating && distance < 64
    onKeyboardTransition(["active": true, "bottom": baseInset + composerInset + end])
    if displayLink == nil {
      // CADisplayLink retains its target. The completion/detach path must invalidate it.
      let link = CADisplayLink(target: self, selector: #selector(tick))
      // Reanimated's keyboard observer requests 120 Hz. Using UIKit's default
      // cadence here skips dock positions on ProMotion: the dock moves on one
      // frame and the content offset catches up by two frames on the next.
      // Request the same cadence; the system still selects the device's rate.
      link.preferredFramesPerSecond = 120
      link.add(to: .main, forMode: .common)
      displayLink = link
    }
    UIView.animate(withDuration: duration, delay: 0,
      options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction],
      animations: { self.progress.frame.origin.y = end },
      completion: { [weak self] _ in
        guard let self, self.generation == run else { return }
        self.keyboardAnimating = false
        self.apply(end)
      })
  }

  @objc private func tick() {
    // The first display tick can precede Core Animation's transaction commit.
    // No presentation frame means keep the current inset, not jump to the end
    // and move backwards once the presentation layer appears on the next tick.
    if let presentation = progress.layer.presentation() {
      apply(presentation.frame.minY)
    } else if !keyboardAnimating {
      apply(progress.frame.minY)
    }
  }

  private func composerReservation(in list: UIScrollView) -> CGFloat? {
    guard let window, let anchor = ComposerViewports.anchors.object(forKey: composerSurfaceId as NSString),
      anchor.window === window else { return nil }
    // The dock already follows the keyboard on the UI thread. Measure that
    // actual transformed surface instead of synthesizing a second keyboard
    // curve and adding it to the dock height. The two clocks can disagree by
    // tens of points during dismissal or simultaneous composer collapse.
    let top = anchor.convert(anchor.bounds, to: window).minY
    let bottom = list.convert(list.bounds, to: window).maxY
    return max(0, bottom - top - composerContentPadding)
  }

  private func apply(_ inset: CGFloat, reset: Bool = false) {
    guard let list = scroll else { return }
    bottomInset = max(0, inset)
    let destination = reset ? 0 : (composerReservation(in: list) ?? (composerInset + bottomInset))
    if !reset && displayLink != nil && !UIAccessibility.isReduceMotionEnabled {
      // Fabric can deliver several dock positions in one display interval.
      // Applying each as a scroll command exposes a 60–85 pt step even without
      // recording. Keep one continuous reservation on the UI thread; the inset
      // and its reading-position compensation always use that same value.
      let now = CACurrentMediaTime()
      let dt = CGFloat(min(max(now - reservationTimestamp, 0), 0.064))
      reservationTimestamp = now
      let omega: CGFloat = 30
      let displacement = managedInset - destination
      let tangent = reservationVelocity + omega * displacement
      let decay = exp(-omega * dt)
      managedInset = destination + (displacement + tangent * dt) * decay
      reservationVelocity = (reservationVelocity - omega * tangent * dt) * decay
      if abs(managedInset - destination) < 0.1 && abs(reservationVelocity) < 1 {
        managedInset = destination
        reservationVelocity = 0
      }
    } else {
      managedInset = destination
      reservationVelocity = 0
    }
    var content = list.contentInset
    let previousBottom = content.bottom
    let previousOffset = list.contentOffset.y
    content.bottom = baseInset + managedInset
    list.contentInset = content
    var indicators = list.verticalScrollIndicatorInsets
    indicators.bottom = content.bottom
    list.verticalScrollIndicatorInsets = indicators
    if list.isTracking || list.isDragging || list.isDecelerating { following = false }
    if following {
      // Own only viewport motion. A send can insert an estimated virtual row
      // during keyboard dismissal; seeking the entire content end on every
      // display tick turns that estimate into an immediate visible jump. Keep
      // the reading anchor relative to the moving dock, then let the single
      // message follower resume content growth when this transition ends.
      let offset = max(-list.adjustedContentInset.top, previousOffset + content.bottom - previousBottom)
      list.setContentOffset(CGPoint(x: list.contentOffset.x, y: offset), animated: false)
    }
    if traceMotion {
      NSLog("MOTION_VIEWPORT t=%.6f inset=%.3f previous=%.3f offsetBefore=%.3f offsetAfter=%.3f content=%.3f follow=%d",
        CACurrentMediaTime(), content.bottom, previousBottom, previousOffset, list.contentOffset.y, list.contentSize.height, following ? 1 : 0)
    }
    if !reset && displayLink != nil && !keyboardAnimating
      && abs(managedInset - destination) < 0.1 && abs(reservationVelocity) < 1 {
      finish(reset: false)
    }
  }

  private func finish(reset: Bool) {
    guard displayLink != nil || bottomInset != 0 || composerInset != 0 else { return }
    generation += 1
    keyboardAnimating = false
    displayLink?.invalidate()
    displayLink = nil
    if reset {
      progress.layer.removeAllAnimations()
      following = false
      composerInset = 0
      apply(0, reset: true)
      progress.frame.origin.y = 0
    }
    onKeyboardTransition(["active": false, "bottom": baseInset + managedInset])
  }

  deinit {
    displayLink?.invalidate()
    NotificationCenter.default.removeObserver(self)
  }
}
