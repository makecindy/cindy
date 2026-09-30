import ExpoModulesCore
import UIKit

/// Home new-task button → composer pill morph, and the pill → card expansion.
/// The native part only animates; navigation stays in JS.
public class CindyComposerMorphModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyComposerMorph")
    View(CindyComposerMorphSource.self) {
      Events("onAction", "onGeometry")
      Prop("actionDisabled") { (view: CindyComposerMorphSource, disabled: Bool) in view.actionDisabled = disabled }
    }
    View(CindyComposerMorphTarget.self) {
      Events("onComplete")
      Prop("transitionId") { (view: CindyComposerMorphTarget, id: String) in view.transitionId = id; view.setNeedsLayout() }
      Prop("cornerRadius") { (view: CindyComposerMorphTarget, value: Double) in view.targetCornerRadius = value }
      Prop("expandToken") { (view: CindyComposerMorphTarget, token: String) in view.expandToken = token }
    }
  }
}

/// Wraps the floating new-task button. A shield above it takes the touch, so
/// the glass button's own press (grow and brighten) never plays: touch-down
/// starts stretching the circle, touch-up inside opens the page, and a slide-off
/// release springs the pill back. It also reports the button's window frame,
/// which the composer uses as its resting bottom edge and pill height.
final class CindyComposerMorphSource: ExpoView {
  let onAction = EventDispatcher()
  let onGeometry = EventDispatcher()
  var actionDisabled = false { didSet { shield.isHidden = actionDisabled } }
  private let shield = CindyActionShield()
  private var pressOrigin: [String: Any]?
  private var lastFrame = CGRect.null

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    shield.onPressBegan = { [weak self] in self?.pressBegan() }
    shield.onPressEnded = { [weak self] inside in self?.pressEnded(inside: inside) }
    addSubview(shield)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    shield.frame = bounds
    bringSubviewToFront(shield)
    reportGeometry()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    lastFrame = .null
    if window == nil {
      if pressOrigin != nil { CindyComposerMorphAnimation.current?.cancel() }
      pressOrigin = nil
    } else { setNeedsLayout() }
  }
  private func reportGeometry() {
    guard let window, !bounds.isEmpty else { return }
    let rect = convert(bounds, to: window)
    guard rect != lastFrame else { return }
    lastFrame = rect
    onGeometry(CindyComposerMorphAnimation.geometry(rect, in: window, id: "layout"))
  }
  private func pressBegan() {
    guard !actionDisabled, let window, CindyComposerMorphAnimation.current == nil else { return }
    pressOrigin = CindyComposerMorphAnimation.begin(source: self, window: window)
    if pressOrigin == nil { pressOrigin = [:] }
  }
  private func pressEnded(inside: Bool) {
    guard let origin = pressOrigin else { return }
    pressOrigin = nil
    guard inside, !actionDisabled, window != nil else { CindyComposerMorphAnimation.current?.cancel(); return }
    if origin.isEmpty { onAction([:]); return }
    CindyComposerMorphAnimation.current?.commit()
    onAction(["origin": origin])
  }
}

/// A short-lived in-memory handoff. The source screen is never saved to disk.
@MainActor private final class CindyComposerMorphAnimation {
  static var current: CindyComposerMorphAnimation?
  /// Last composer contour per window size. Lets the button start growing on
  /// the tap frame instead of waiting ~300ms for the new page to mount.
  private static var landing: (window: CGSize, rect: CGRect, radius: CGFloat, style: UIUserInterfaceStyle)?
  // iOS-style snappy spring with a visible single bounce: response ≈ 0.36s
  // (stiffness = (2π / response)²). Damping ratio 0.67 overshoots once by
  // ≈ 14pt on the phone's pill, just short of the 16pt screen inset, then
  // settles. The lead, the real glass and the slide-off return share it.
  private static let stiffness: CGFloat = 305
  private static let dampingRatio: CGFloat = 0.67
  private static let omega = stiffness.squareRoot()
  let id = UUID().uuidString
  weak var window: UIWindow?
  weak var glass: UIVisualEffectView?
  weak var content: UIView?
  private var originalCorners: Any?
  private var originalContentAlpha: CGFloat = 1
  private var originalContentClips = false
  private var originalContentRadius: CGFloat = 0
  private(set) var morphSize = CGSize.zero
  let sourceRect: CGRect
  let overlay: UIView
  let backdrop: UIView
  let sourceImage: UIView
  private var lead: UIVisualEffectView?
  private var leadRadius: CGFloat = 0
  private var leadStartedAt: CFTimeInterval = 0
  var timeout: DispatchWorkItem?
  var animator: UIViewPropertyAnimator?
  var leadAnimator: UIViewPropertyAnimator?
  var reveal: UIViewPropertyAnimator?
  var controls: UIViewPropertyAnimator?
  var dissolve: UIViewPropertyAnimator?
  var backgroundObserver: NSObjectProtocol?

  static func geometry(_ rect: CGRect, in window: UIWindow, id: String) -> [String: Any] {
    ["id": id, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
      "windowWidth": window.bounds.width, "windowHeight": window.bounds.height]
  }
  /// Same rule as expo-glass-effect's `isLiquidGlassAvailable`: without Liquid
  /// Glass the new-task composer mounts no morph target, so no overlay may start.
  private static let liquidGlassAvailable: Bool = {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      return (Bundle.main.infoDictionary?["UIDesignRequiresCompatibility"] as? Bool) != true
    }
    #endif
    return false
  }()
  static func begin(source: UIView, window: UIWindow) -> [String: Any]? {
    current?.finish()
    // No origin → the caller navigates normally, with the regular push animation.
    guard liquidGlassAvailable else { return nil }
    let rect = source.convert(source.bounds, to: window)
    guard window.bounds.contains(rect), !rect.isEmpty,
      let backdrop = window.snapshotView(afterScreenUpdates: false),
      let sourceImage = source.snapshotView(afterScreenUpdates: false) else { return nil }
    let transition = CindyComposerMorphAnimation(window: window, rect: rect, backdrop: backdrop, sourceImage: sourceImage)
    current = transition
    if #available(iOS 26.0, *), !UIAccessibility.isReduceMotionEnabled {
      if let landing, landing.window == window.bounds.size, abs(landing.rect.maxY - rect.maxY) < 2 {
        transition.startLead(to: landing.rect, radius: landing.radius, style: landing.style)
      } else {
        // First open: the compact composer pill is as tall as the button and
        // spans the JS composerGeometry insets, so the circle only stretches
        // sideways. The real glass retargets smoothly if it differs.
        let guess = CGRect(x: 16, y: rect.minY, width: window.bounds.width - 32, height: rect.height)
        transition.startLead(to: guess, radius: rect.height / 2, style: source.traitCollection.userInterfaceStyle)
      }
    }
    return geometry(rect, in: window, id: transition.id)
  }
  init(window: UIWindow, rect: CGRect, backdrop: UIView, sourceImage: UIView) {
    self.window = window; sourceRect = rect; self.backdrop = backdrop; self.sourceImage = sourceImage
    overlay = UIView(frame: window.bounds)
    overlay.accessibilityElementsHidden = true
    // Swallow repeated taps only during the short handoff; route guards remain authoritative.
    overlay.isUserInteractionEnabled = true
    backdrop.frame = overlay.bounds
    overlay.addSubview(backdrop)
    sourceImage.frame = rect
    overlay.addSubview(sourceImage)
    window.addSubview(overlay)
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification,
      object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.finish() } }
  }
  private static func spring(velocity: CGFloat) -> UISpringTimingParameters {
    UISpringTimingParameters(mass: 1, stiffness: stiffness, damping: 2 * dampingRatio * omega,
      initialVelocity: CGVector(dx: velocity, dy: velocity))
  }
  /// Spring progress and velocity (per second, in progress units) after `t`.
  private static func springState(_ t: CFTimeInterval) -> (progress: CGFloat, velocity: CGFloat) {
    let damped = omega * (1 - dampingRatio * dampingRatio).squareRoot()
    let decay = CGFloat(exp(-Double(dampingRatio * omega) * t)), phase = damped * CGFloat(t)
    let progress = 1 - decay * (cos(phase) + dampingRatio * omega / damped * sin(phase))
    return (progress, decay * omega * omega / damped * sin(phase))
  }
  /// The new page is on its way: bound the wait for it to mount. Not armed
  /// while a finger is still down, so a long press cannot time the morph out.
  func commit() {
    guard timeout == nil else { return }
    let timeout = DispatchWorkItem { [weak self] in self?.finish() }
    self.timeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: timeout)
  }
  /// Slide-off release: the stand-in springs back into the button, then the
  /// overlay goes away. Nothing was navigated.
  func cancel() {
    guard let lead, let leadAnimator else { finish(); return }
    leadAnimator.stopAnimation(true)
    self.leadAnimator = nil
    let back = UIViewPropertyAnimator(duration: 0.4, timingParameters: Self.spring(velocity: 0))
    back.addAnimations {
      lead.frame = self.sourceRect
      if #available(iOS 26.0, *) { lead.cornerConfiguration = .corners(radius: .fixed(min(self.sourceRect.width, self.sourceRect.height) / 2)) }
      self.sourceImage.alpha = 1
    }
    back.addCompletion { [weak self] _ in self?.finish() }
    animator = back
    back.startAnimation()
  }
  /// Grows a stand-in glass over the old screen while the new page mounts.
  @available(iOS 26.0, *)
  private func startLead(to rect: CGRect, radius: CGFloat, style: UIUserInterfaceStyle) {
    let lead = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    lead.overrideUserInterfaceStyle = style
    lead.isUserInteractionEnabled = false
    lead.frame = sourceRect
    lead.cornerConfiguration = .corners(radius: .fixed(min(sourceRect.width, sourceRect.height) / 2))
    overlay.insertSubview(lead, belowSubview: sourceImage)
    self.lead = lead; leadRadius = radius
    let animator = UIViewPropertyAnimator(duration: 0.5, timingParameters: Self.spring(velocity: 0))
    animator.addAnimations {
      lead.frame = rect
      lead.cornerConfiguration = .corners(radius: .fixed(radius))
    }
    leadAnimator = animator
    leadStartedAt = CACurrentMediaTime()
    animator.startAnimation()
    UIViewPropertyAnimator(duration: 0.16, curve: .easeOut) { self.sourceImage.alpha = 0 }.startAnimation()
  }
  func run(target: UIView, rect: CGRect, cornerRadius: CGFloat, completion: @escaping () -> Void) {
    guard let window, target.window === window, overlay.bounds.size == window.bounds.size,
      abs(rect.maxY - sourceRect.maxY) < 2 else { finish(); completion(); return }
    guard #available(iOS 26.0, *), !UIAccessibility.isReduceMotionEnabled,
      let glass = target.superview as? UIVisualEffectView, let host = glass.superview,
      glass.effect is UIGlassEffect else { finish(); completion(); return }
    // The composer glass follows the app theme, which can differ from the system one.
    let style = glass.overrideUserInterfaceStyle == .unspecified ? glass.traitCollection.userInterfaceStyle : glass.overrideUserInterfaceStyle
    // A radius above half the height renders as a capsule; interpolate the
    // effective value so the contour never reads as a different shape.
    let cornerRadius = min(cornerRadius, rect.height / 2)
    Self.landing = (window.bounds.size, rect, cornerRadius, style)
    // Grow the real, already-rendered glass. Frame and corner radius animate
    // in the render server, so the contour stays truly round instead of being
    // squashed by a scale transform, and nothing is swapped at the end.
    self.glass = glass
    content = target
    morphSize = host.bounds.size
    originalCorners = glass.cornerConfiguration
    originalContentAlpha = target.alpha
    originalContentClips = target.clipsToBounds
    originalContentRadius = target.layer.cornerRadius
    // Continue from wherever the lead glass is, with its current velocity.
    var from = sourceRect
    var fromRadius = min(sourceRect.width, sourceRect.height) / 2
    var velocity: CGFloat = 0
    if let lead, let leadAnimator {
      let state = Self.springState(CACurrentMediaTime() - leadStartedAt)
      leadAnimator.stopAnimation(true)
      self.leadAnimator = nil
      from = lead.frame
      fromRadius += (leadRadius - fromRadius) * state.progress
      // Relative to the remaining distance (negative after the overshoot); the
      // same spring then continues the lead's exact trajectory to the landing.
      velocity = abs(1 - state.progress) > 0.01 ? state.velocity / (1 - state.progress) : 0
    }
    let start = host.convert(from, from: window)
    let end = host.bounds
    UIView.performWithoutAnimation {
      glass.frame = start
      glass.cornerConfiguration = .corners(radius: .fixed(fromRadius))
      // Keep the controls at their final place and clip them to the growing
      // contour, so they are revealed by the glass instead of floating outside.
      target.bounds.origin = CGPoint(x: start.minX - end.minX, y: start.minY - end.minY)
      target.clipsToBounds = true
      target.layer.cornerCurve = .continuous
      target.layer.cornerRadius = fromRadius
      target.alpha = 0
      lead?.frame = from
      lead?.cornerConfiguration = .corners(radius: .fixed(fromRadius))
      glass.layoutIfNeeded()
    }
    let animator = UIViewPropertyAnimator(duration: 0.5, timingParameters: Self.spring(velocity: velocity))
    animator.addAnimations {
      glass.frame = end
      if let corners = self.originalCorners as? UICornerConfiguration { glass.cornerConfiguration = corners }
      target.bounds.origin = .zero
      target.layer.cornerRadius = cornerRadius
      // The lead tracks the real glass exactly until it is removed.
      self.lead?.frame = rect
      self.lead?.cornerConfiguration = .corners(radius: .fixed(cornerRadius))
    }
    animator.addCompletion { [weak self] position in
      self?.finish()
      if position == .end { completion() }
    }
    self.animator = animator
    // The old screen clears quickly while the lead dematerializes over the
    // real glass tracking it underneath, so the tint eases from the button's
    // to the composer's instead of switching on one frame.
    let reveal = UIViewPropertyAnimator(duration: 0.18, curve: .easeOut) {
      self.backdrop.alpha = 0
      self.sourceImage.alpha = 0
    }
    if let lead {
      let dissolve = UIViewPropertyAnimator(duration: 0.22, curve: .easeInOut) { lead.effect = nil }
      dissolve.addCompletion { [weak self] _ in lead.removeFromSuperview(); if self?.lead === lead { self?.lead = nil } }
      self.dissolve = dissolve
      dissolve.startAnimation(afterDelay: 0.06)
    }
    let controls = UIViewPropertyAnimator(duration: 0.24, curve: .easeOut) { target.alpha = self.originalContentAlpha }
    self.reveal = reveal
    self.controls = controls
    animator.startAnimation()
    reveal.startAnimation()
    controls.startAnimation(afterDelay: 0.1)
  }
  func finish() {
    timeout?.cancel(); timeout = nil
    for running in [animator, leadAnimator, reveal, controls, dissolve] where running?.state == .active { running?.stopAnimation(true) }
    animator = nil; leadAnimator = nil; reveal = nil; controls = nil; dissolve = nil
    UIView.performWithoutAnimation {
      if let glass, let host = glass.superview {
        glass.frame = host.bounds
        if #available(iOS 26.0, *), let corners = originalCorners as? UICornerConfiguration {
          glass.cornerConfiguration = corners
        }
      }
      if let content {
        content.bounds.origin = .zero
        content.clipsToBounds = originalContentClips
        content.layer.cornerRadius = originalContentRadius
        content.alpha = originalContentAlpha
      }
    }
    glass = nil; content = nil; lead = nil
    overlay.removeFromSuperview()
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    backgroundObserver = nil
    if Self.current === self { Self.current = nil }
  }
}

/// Pulls the compact pill open into the card: the glass grows upward from the
/// pill's contour with its bottom edge fixed, revealing the card's controls.
@MainActor private final class CindyComposerExpand {
  private static var running: [ObjectIdentifier: CindyComposerExpand] = [:]
  private weak var glass: UIVisualEffectView?
  private weak var content: UIView?
  private var corners: Any?
  private var contentClips = false
  private var contentRadius: CGFloat = 0
  private var animator: UIViewPropertyAnimator?

  @available(iOS 26.0, *)
  static func run(content: UIView, from: CGRect, cornerRadius: CGFloat) {
    guard !UIAccessibility.isReduceMotionEnabled, let glass = content.superview as? UIVisualEffectView,
      let host = glass.superview, let window = host.window, glass.effect is UIGlassEffect else { return }
    running[ObjectIdentifier(glass)]?.finish()
    let expand = CindyComposerExpand()
    expand.glass = glass; expand.content = content
    expand.corners = glass.cornerConfiguration
    expand.contentClips = content.clipsToBounds
    expand.contentRadius = content.layer.cornerRadius
    let start = host.convert(from, from: window), end = host.bounds
    let startRadius = min(start.width, start.height) / 2
    UIView.performWithoutAnimation {
      glass.frame = start
      glass.cornerConfiguration = .corners(radius: .fixed(startRadius))
      content.bounds.origin = CGPoint(x: start.minX - end.minX, y: start.minY - end.minY)
      content.clipsToBounds = true
      content.layer.cornerCurve = .continuous
      content.layer.cornerRadius = startRadius
      glass.layoutIfNeeded()
    }
    // Critically damped and brisk: open before the keyboard starts rising.
    let stiffness: CGFloat = 320
    let spring = UISpringTimingParameters(mass: 1, stiffness: stiffness, damping: 2 * stiffness.squareRoot(), initialVelocity: .zero)
    let animator = UIViewPropertyAnimator(duration: 0.35, timingParameters: spring)
    animator.addAnimations {
      glass.frame = end
      if let corners = expand.corners as? UICornerConfiguration { glass.cornerConfiguration = corners }
      content.bounds.origin = .zero
      content.layer.cornerRadius = min(cornerRadius, end.height / 2)
    }
    animator.addCompletion { _ in expand.finish() }
    expand.animator = animator
    running[ObjectIdentifier(glass)] = expand
    animator.startAnimation()
    // Focus early: the keyboard takes a moment to appear, so it starts rising
    // as the card finishes opening. Focusing the native text view directly
    // avoids waiting on a busy JS thread; RN still receives its focus event.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak content] in
      guard let content, content.window != nil, let input = firstTextInput(in: content), !input.isFirstResponder else { return }
      input.becomeFirstResponder()
    }
  }
  private static func firstTextInput(in view: UIView) -> UIView? {
    if let text = view as? UITextView, text.isEditable { return text }
    if let field = view as? UITextField, field.isEnabled { return field }
    for child in view.subviews { if let found = firstTextInput(in: child) { return found } }
    return nil
  }
  func finish() {
    if animator?.state == .active { animator?.stopAnimation(true) }
    animator = nil
    UIView.performWithoutAnimation {
      if let glass, let host = glass.superview {
        glass.frame = host.bounds
        if #available(iOS 26.0, *), let corners = corners as? UICornerConfiguration { glass.cornerConfiguration = corners }
      }
      if let content {
        content.bounds.origin = .zero
        content.clipsToBounds = contentClips
        content.layer.cornerRadius = contentRadius
      }
    }
    if let glass { Self.running[ObjectIdentifier(glass)] = nil }
  }
  static func finish(glassOf content: UIView) {
    guard let glass = content.superview else { return }
    running[ObjectIdentifier(glass)]?.finish()
  }
}

final class CindyComposerMorphTarget: ExpoView {
  let onComplete = EventDispatcher()
  var transitionId = ""
  var targetCornerRadius: Double = 0
  /// Changes when JS opens the pill; the next taller layout is animated.
  var expandToken = "" {
    didSet {
      guard expandToken != oldValue, !expandToken.isEmpty else { return }
      expandFrom = lastRect
      expandArmedAt = CACurrentMediaTime()
    }
  }
  private var lastRect: CGRect?
  private var expandFrom: CGRect?
  private var expandArmedAt: CFTimeInterval = 0
  private var started = ""
  private func expandIfArmed() {
    guard let window else { lastRect = nil; return }
    let rect = convert(bounds, to: window)
    if let from = expandFrom, rect.size != from.size {
      expandFrom = nil
      // Only the pill→card change: taller, same bottom edge, no entry morph.
      if #available(iOS 26.0, *), CACurrentMediaTime() - expandArmedAt < 0.6, rect.height > from.height + 1,
        abs(rect.maxY - from.maxY) < 2, CindyComposerMorphAnimation.current == nil, let content = superview {
        CindyComposerExpand.run(content: content, from: from, cornerRadius: targetCornerRadius)
      }
    } else if rect.size != lastRect?.size, let content = superview {
      // Any other resize (typing, keyboard) keeps its ordinary layout.
      CindyComposerExpand.finish(glassOf: content)
    }
    lastRect = rect
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    expandIfArmed()
    if started == transitionId, let window, let transition = CindyComposerMorphAnimation.current,
      transition.id == transitionId, (transition.overlay.bounds.size != window.bounds.size
        || (transition.glass != nil && transition.morphSize != bounds.size)) {
      transition.finish()
      onComplete([:])
    }
    guard !transitionId.isEmpty, started != transitionId, window != nil, !bounds.isEmpty else { return }
    let id = transitionId
    DispatchQueue.main.async { [weak self] in
      guard let self, self.started != id, self.transitionId == id, let window = self.window,
        let target = self.superview else { return }
      self.started = id
      let complete = { [weak self] in
        guard let self, self.window != nil else { return }
        self.onComplete([:])
      }
      guard let transition = CindyComposerMorphAnimation.current, transition.id == id else { complete(); return }
      transition.run(target: target, rect: self.convert(self.bounds, to: window), cornerRadius: self.targetCornerRadius, completion: complete)
    }
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil, CindyComposerMorphAnimation.current?.id == transitionId { CindyComposerMorphAnimation.current?.finish() }
  }
}

/// Invisible touch target over the new-task button. VoiceOver keeps using the
/// real button underneath (its JS onPress opens the page), so it is not an element.
private final class CindyActionShield: UIControl {
  var onPressBegan: (() -> Void)?
  var onPressEnded: ((Bool) -> Void)?
  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    addTarget(self, action: #selector(began), for: .touchDown)
    addTarget(self, action: #selector(endedInside), for: .touchUpInside)
    addTarget(self, action: #selector(endedOutside), for: [.touchUpOutside, .touchCancel])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
  @objc private func began() { onPressBegan?() }
  @objc private func endedInside() { onPressEnded?(true) }
  @objc private func endedOutside() { onPressEnded?(false) }
}
