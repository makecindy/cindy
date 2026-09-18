import ExpoModulesCore
import AVKit
import WebRTC
import CoreImage

private final class RemoteDesktopSampleBufferView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// Native media surface beneath the existing HTML input overlay. HTML supplies
/// its exact fitted/zoomed rectangle; pixels never cross the React bridge.
final class RemoteDesktopVideoView: ExpoView, AVPictureInPictureControllerDelegate,
  AVPictureInPictureSampleBufferPlaybackDelegate {
  let onMessage = EventDispatcher()
  private let videoSurface = RemoteDesktopSampleBufferView()
  private var presentationDisplay: AVSampleBufferDisplayLayer { videoSurface.displayLayer }
  private let display = AVSampleBufferDisplayLayer()
  private let canvas = CALayer()
  override var backgroundColor: UIColor? {
    didSet { canvas.backgroundColor = backgroundColor?.cgColor }
  }
  private let backdrop = CALayer()
  private let backdropContext = CIContext(options: [.cacheIntermediates: false])
  private var backdropActive = false
  private var backdropFillHeight = false
  private var backdropTime: CFTimeInterval = 0
  private var pip: AVPictureInPictureController?
  private var receiver: RemoteDesktopReceiver?
  private var configuration: [String: Any]?
  private var retryTimer: Timer?
  private var stableTimer: Timer?
  private var retries = 0
  private var presenting = false
  private var presentationAuthorized = false
  private var startingPresentation = false
  var inlineVisible = true {
    didSet {
      updateInlineVisibility()
      if !inlineVisible { inlineFrameReady = false }
      if inlineVisible && !oldValue {
        if let latestFrame { render(latestFrame) }
        refreshBackdrop()
      }
      completeInlineRestoreIfVisible()
    }
  }
  private func updateInlineVisibility() {
    // Keep the source ready until PiP has actually started. Once detached,
    // hide the native source itself, not just its React parent's opacity.
    // The layer, receiver and PiP controller remain attached and alive.
    isHidden = !inlineVisible && presenting
  }
  private var wantsPresentation = false
  private var automaticPresentation = false
  private var restoreCompletion: ((Bool) -> Void)?
  private var restoreGeneration = 0
  private var inlineRestoreRequested = false
  private var restoringInterface = false
  private var lastCapability: Bool?
  private var latestFrame: RTCVideoFrame?
  private var inlineFrameReady = false
  private var renderedFrames = 0
  private var playbackReady = false {
    didSet {
      guard playbackReady != oldValue else { return }
      // AVKit caches the sample-buffer delegate's state. Publish the real
      // transition from no content to live playback, and invalidate on teardown.
      pip?.invalidatePlaybackState()
    }
  }
  private var pool: CVPixelBufferPool?
  private var poolSize = CGSize.zero
  private var backgroundGeneration = 0
  private var backgroundObserver: NSObjectProtocol?
  private var foregroundObserver: NSObjectProtocol?
  private var inactiveObserver: NSObjectProtocol?
  private var pipObservation: NSKeyValueObservation?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    isUserInteractionEnabled = false
    display.videoGravity = .resizeAspect
    presentationDisplay.videoGravity = .resizeAspect
    // AVKit keeps a stable viewport-sized projection of the same decoded frame.
    // The inline layer remains free to follow the viewer's pan/zoom rectangle.
    addSubview(videoSurface)
    canvas.backgroundColor = (backgroundColor ?? .systemBackground).cgColor
    layer.addSublayer(canvas)
    backdrop.opacity = 0.72
    layer.addSublayer(backdrop)
    layer.addSublayer(display)
    if AVPictureInPictureController.isPictureInPictureSupported() {
      pip = AVPictureInPictureController(contentSource: .init(sampleBufferDisplayLayer: presentationDisplay, playbackDelegate: self))
      pip?.delegate = self
      pip?.requiresLinearPlayback = true
      // System readiness is separate from host authorization; challenge replies
      // remain gated until the host has confirmed view-only access.
      pip?.canStartPictureInPictureAutomaticallyFromInline = false
      pipObservation = pip?.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.reportCapability() }
      }
    }
    inactiveObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.reportPresentationState("willResignActive")
      // The source scene has already resigned active by this notification,
      // even when UIApplication still reports .active. A manual start here is
      // rejected by AVKit and its failure can cancel the automatic handoff.
      // Automatic entry was armed while inline; let AVKit own this transition.
    }
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.backgroundGeneration += 1
      let generation = self.backgroundGeneration
      self.reportPresentationState("didEnterBackground")
      if !self.presentationAuthorized || self.pip?.isPictureInPictureActive != true {
        if self.automaticPresentation || self.wantsPresentation {
          // AVKit may finish the automatic transition after background entry.
          // A failed transition must still release media without relying on JS.
          let current = self.receiver
          DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak current] in
            guard let self, let current, self.receiver === current,
                  self.backgroundGeneration == generation,
                  UIApplication.shared.applicationState != .active,
                  !(self.presentationAuthorized && self.pip?.isPictureInPictureActive == true) else { return }
            self.suspend()
          }
        } else { self.suspend() }
      }
    }
    foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      // JS may not receive the PiP stop callback until foreground. Replay the
      // actual native state so it cannot retain a stale presentation exemption.
      guard let self else { return }
      self.backgroundGeneration += 1
      if let epoch = self.configuration?["epoch"] as? String {
        self.emit(["type": "presentation", "epoch": epoch, "active": self.presenting])
      }
      self.reportCapability()
      self.reportPresentationState("didBecomeActive")
      if self.inlineVisible, let frame = self.latestFrame { self.render(frame) }
      self.refreshBackdrop()
    }
  }
  deinit {
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
    if let inactiveObserver { NotificationCenter.default.removeObserver(inactiveObserver) }
    retryTimer?.invalidate()
    stableTimer?.invalidate()
    receiver?.stop()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    reportPresentationState(window == nil ? "sourceDetached" : "sourceAttached")
    if window == nil { stop() }
  }
  func receive(_ message: [String: Any]) {
    let type = message["type"] as? String
    if type == "init" {
      stop()
      configuration = message
      retries = 0
      connect()
      return
    }
    guard let config = configuration, message["epoch"] as? String == config["epoch"] as? String else { return }
    switch type {
    case "stop": stop()
    case "pipPolicy":
      automaticPresentation = message["enabled"] as? Bool == true
      if let preparing = message["preparing"] as? Bool { wantsPresentation = preparing }
      if let authorized = message["authorized"] as? Bool { presentationAuthorized = authorized }
      else if !automaticPresentation { presentationAuthorized = false }
      pip?.canStartPictureInPictureAutomaticallyFromInline = automaticPresentation
      if presentationAuthorized { receiver?.replyToViewChallenge() }
      reportPresentationState("policy")
    case "restorePresentation":
      guard restoreCompletion != nil, !inlineRestoreRequested else { return }
      inlineRestoreRequested = true
      reportPresentationState("restoreRequested")
      setNeedsLayout()
      waitForInlineRestore(generation: restoreGeneration)
    case "videoSettings":
      configuration?.merge(message) { _, new in new }
      retries = 0
      connect()
    case "nativeViewport":
      guard let x = message["x"] as? Double, let y = message["y"] as? Double,
            let width = message["width"] as? Double, let height = message["height"] as? Double,
            [x, y, width, height].allSatisfy({ $0.isFinite }), width > 0, height > 0 else { return }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      display.frame = CGRect(x: x, y: y, width: width, height: height)
      let fill = message["fillHeight"] as? Bool == true
      if fill != backdropFillHeight {
        backdropFillHeight = fill
        refreshBackdrop()
      }
      CATransaction.commit()
    case "presentation":
      if message["enabled"] as? Bool == true {
        startSystemPresentation()
      } else {
        presentationAuthorized = false
        wantsPresentation = false
        presenting = false
        pip?.stopPictureInPicture()
      }
    case "resume":
      if let latestFrame { render(latestFrame) }
      if receiver == nil { connect() }
      receiver?.post("presentation", ["active": presenting])
    default: receiver?.receive(message)
    }
  }
  private func connect() {
    playbackReady = false
    inlineFrameReady = false
    retryTimer?.invalidate()
    stableTimer?.invalidate()
    stableTimer = nil
    receiver?.stop()
    receiver = nil
    guard let config = configuration, let epoch = config["epoch"] as? String,
          UIApplication.shared.applicationState == .active else { return }
    let current = RemoteDesktopReceiver(epoch: epoch, audio: config["audio"] as? Bool == true,
                                        trickle: config["trickleIce"] as? Bool == true,
                                        net: config["net"] as? [String: Any] ?? [:])
    receiver = current
    lastCapability = nil
    current.isPresenting = { [weak self] in self?.presenting == true && self?.pip?.isPictureInPictureActive == true }
    current.isPresentationAuthorized = { [weak self] in self?.presentationAuthorized == true }
    current.onFrame = { [weak self, weak current] frame in
      guard let self, let current, self.receiver === current else { return false }
      guard self.render(frame, liveFrame: true) else { return false }
      self.latestFrame = frame
      self.completeInlineRestoreIfVisible()
      self.reportCapability()
      return true
    }
    current.emit = { [weak self, weak current] event in
      guard let self, let current, self.receiver === current else { return }
      self.emit(event)
      if event["type"] as? String == "streaming", self.stableTimer == nil {
        let stableMs = (config["net"] as? [String: Any])?["stableMs"] as? Double ?? 30_000
        self.stableTimer = Timer.scheduledTimer(withTimeInterval: stableMs / 1000, repeats: false) { [weak self, weak current] _ in
          guard let self, let current, self.receiver === current else { return }
          self.retries = 0
        }
      }
      if event["type"] as? String == "reconnecting" || event["type"] as? String == "fallback" {
        self.stableTimer?.invalidate()
        self.stableTimer = nil
      }
      if event["type"] as? String == "fallback" {
        self.playbackReady = false
        self.presentationAuthorized = false
        self.backdropActive = false
        self.backdrop.contents = nil
        self.backdropTime = 0
        self.wantsPresentation = false
        self.presenting = false
        self.pip?.stopPictureInPicture()
        self.receiver = nil
        let delays = (config["net"] as? [String: Any])?["retryMs"] as? [Double] ?? [1000, 3000, 8000]
        if event["retry"] as? Bool != false, self.retries < delays.count {
          let delay = delays[self.retries] / 1000
          self.retries += 1
          self.retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in self?.connect() }
        }
      }
    }
    current.begin(fallbackServers: config["iceServers"] as? [[String: Any]] ?? [])
  }
  func sendInput(_ message: [String: Any]) -> Bool {
    guard !presenting, message["epoch"] as? String == configuration?["epoch"] as? String else { return false }
    return receiver?.sendInput(message) == true
  }
  private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let json = String(data: data, encoding: .utf8) else { return }
    onMessage(["data": json])
  }
  private func reportCapability() {
    let supported = pip?.isPictureInPicturePossible == true && playbackReady
    guard supported != lastCapability else { return }
    lastCapability = supported
    receiver?.post("pipCapability", ["supported": supported])
  }
  private func suspend() {
    let saved = configuration
    let current = receiver
    current?.post("presentation", ["active": false])
    current?.post("fallback", ["retry": false, "reason": "background"])
    // The synchronous fallback observer detaches receiver; retain the old owner
    // until its tracks, channel and pending callbacks have been explicitly stopped.
    current?.stop()
    stop()
    configuration = saved
  }
  private func stop() {
    playbackReady = false
    // Stop pongs before asynchronous AVKit callbacks, even with JS suspended.
    presentationAuthorized = false
    startingPresentation = false
    presenting = false
    updateInlineVisibility()
    wantsPresentation = false
    automaticPresentation = false
    restoringInterface = false
    inlineRestoreRequested = false
    restoreGeneration += 1
    pip?.canStartPictureInPictureAutomaticallyFromInline = false
    let completion = restoreCompletion
    restoreCompletion = nil
    completion?(false)
    retryTimer?.invalidate()
    retryTimer = nil
    stableTimer?.invalidate()
    stableTimer = nil
    receiver?.stop()
    receiver = nil
    configuration = nil
    pip?.stopPictureInPicture()
    display.flushAndRemoveImage()
    presentationDisplay.flushAndRemoveImage()
    inlineFrameReady = false
    backdropActive = false
    backdrop.contents = nil
    backdropTime = 0
    latestFrame = nil
    pool = nil
  }
  @discardableResult private func render(_ frame: RTCVideoFrame, liveFrame: Bool = false) -> Bool {
    guard let buffer = pixelBuffer(frame) else { return false }
    var format: CMVideoFormatDescription?
    guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format) == noErr,
          let format else { return false }
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
          let sample else { return false }
    // Live remote desktop has no seekable timeline; display every decoded frame
    // immediately rather than accumulating latency behind presentation timestamps.
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
      let entry = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(entry, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    if presentationDisplay.status == .failed {
      playbackReady = false
      presentationDisplay.flush()
    }
    let projected = presentationDisplay.isReadyForMoreMediaData
    if projected {
      presentationDisplay.enqueue(sample)
      if liveFrame { playbackReady = true; renderedFrames += 1 }
    }
    // The second renderer shares the sample buffer; no second decode or copy.
    // Only the system projection consumes frames while inline is not visible.
    let needsInline = inlineVisible && UIApplication.shared.applicationState == .active
    var renderedInline = false
    if needsInline {
      if display.status == .failed { display.flush() }
      if display.isReadyForMoreMediaData {
        display.enqueue(sample)
        inlineFrameReady = true
        renderedInline = true
      }
    }
    // Replaying the last main frame after fallback must not revive its backdrop.
    if liveFrame { backdropActive = true }
    renderBackdrop(buffer)
    return needsInline ? renderedInline : projected
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    // Match the HTML ambient canvas overscan without moving the main picture.
    backdrop.frame = bounds.insetBy(dx: -bounds.width * 0.06, dy: -bounds.height * 0.06)
    canvas.frame = bounds
    videoSurface.frame = bounds
    CATransaction.commit()
    refreshBackdrop()
    completeInlineRestoreIfVisible()
  }

  private func refreshBackdrop() {
    guard backdropActive, inlineVisible, UIApplication.shared.applicationState == .active,
          let latestFrame, let buffer = pixelBuffer(latestFrame) else { return }
    backdropTime = 0
    renderBackdrop(buffer)
  }

  private func renderBackdrop(_ buffer: CVPixelBuffer) {
    guard backdropActive, inlineVisible, UIApplication.shared.applicationState == .active,
          bounds.width > 0, bounds.height > 0 else { return }
    let now = CACurrentMediaTime()
    // A blurred ambient image needs neither full desktop resolution nor 60 fps.
    guard now - backdropTime >= 1.0 / 15 else { return }
    backdropTime = now
    let image = RemoteDesktopBackdrop.image(source: CIImage(cvPixelBuffer: buffer),
      size: bounds.size, fillHeight: backdropFillHeight, context: backdropContext)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    backdrop.contents = image
    CATransaction.commit()
  }

  private func pixelBuffer(_ frame: RTCVideoFrame) -> CVPixelBuffer? {
    if let native = frame.buffer as? RTCCVPixelBuffer,
       native.width == CVPixelBufferGetWidth(native.pixelBuffer),
       native.height == CVPixelBufferGetHeight(native.pixelBuffer),
       native.cropX == 0, native.cropY == 0,
       native.cropWidth == native.width, native.cropHeight == native.height {
      return native.pixelBuffer
    }
    let source = frame.buffer.toI420()
    let width = Int(source.width), height = Int(source.height)
    let size = CGSize(width: width, height: height)
    if pool == nil || poolSize != size {
      poolSize = size
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
      CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
    }
    guard let pool else { return nil }
    var output: CVPixelBuffer?
    let limits = [kCVPixelBufferPoolAllocationThresholdKey as String: 4] as CFDictionary
    guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nil, pool, limits, &output) == kCVReturnSuccess,
          let output else { return nil }
    CVPixelBufferLockBaseAddress(output, [])
    defer { CVPixelBufferUnlockBaseAddress(output, []) }
    guard let y = CVPixelBufferGetBaseAddressOfPlane(output, 0), let uv = CVPixelBufferGetBaseAddressOfPlane(output, 1) else { return nil }
    for row in 0..<height {
      memcpy(y.advanced(by: row * CVPixelBufferGetBytesPerRowOfPlane(output, 0)), source.dataY.advanced(by: row * Int(source.strideY)), width)
    }
    for row in 0..<((height + 1) / 2) {
      let destination = uv.advanced(by: row * CVPixelBufferGetBytesPerRowOfPlane(output, 1)).assumingMemoryBound(to: UInt8.self)
      let u = source.dataU.advanced(by: row * Int(source.strideU))
      let v = source.dataV.advanced(by: row * Int(source.strideV))
      for column in 0..<((width + 1) / 2) {
        destination[column * 2] = u[column]
        destination[column * 2 + 1] = v[column]
      }
    }
    return output
  }
  private func startSystemPresentation() {
    guard !startingPresentation, pip?.isPictureInPictureActive != true else { return }
    guard let pip, pip.isPictureInPicturePossible, playbackReady else {
      reportPresentationFailure("not-ready")
      return
    }
    guard window?.windowScene?.activationState == .foregroundActive else {
      reportPresentationFailure("scene-not-active")
      return
    }
    startingPresentation = true
    wantsPresentation = true
    reportPresentationState("explicitStart")
    pip.startPictureInPicture()
  }
  func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
    startingPresentation = true
    if automaticPresentation { wantsPresentation = true }
    reportPresentationState("willStart")
    receiver?.post("presentationStarting")
  }
  func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
    startingPresentation = false
    guard wantsPresentation || automaticPresentation, receiver != nil else {
      controller.stopPictureInPicture(); return
    }
    presenting = true
    updateInlineVisibility()
    receiver?.replyToViewChallenge()
    receiver?.post("presentation", ["active": true])
  }
  func pictureInPictureControllerWillStopPictureInPicture(_ controller: AVPictureInPictureController) {
    reportPresentationState("willStop")
    presentationAuthorized = false
    wantsPresentation = false
    presenting = false
  }
  func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
    startingPresentation = false
    updateInlineVisibility()
    receiver?.post("presentation", ["active": false])
    if UIApplication.shared.applicationState != .active && !restoringInterface { suspend() }
    restoringInterface = false
    // Returning inline keeps live playback running. Refresh the delegate state
    // after AVKit has finished its PiP stop transition.
    controller.invalidatePlaybackState()
  }
  func pictureInPictureController(_ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
    startingPresentation = false
    wantsPresentation = false
    presenting = false
    updateInlineVisibility()
    reportPresentationFailure("avkit", error: error as NSError)
  }
  private func sourceVisibility() -> (visible: Bool, opacity: CGFloat) {
    var visible = true
    var opacity: CGFloat = 1
    var ancestor: UIView? = self
    while let view = ancestor {
      visible = visible && !view.isHidden
      opacity *= view.alpha
      ancestor = view.superview
    }
    return (visible, opacity)
  }
  private func waitForInlineRestore(generation: Int) {
    guard restoreGeneration == generation, inlineRestoreRequested, restoreCompletion != nil else { return }
    completeInlineRestoreIfVisible()
    guard restoreCompletion != nil else { return }
    // Parent-only opacity commits need not deliver layout or a new video frame.
    // This check ends with the existing five-second restore deadline.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      self?.waitForInlineRestore(generation: generation)
    }
  }
  private func completeInlineRestoreIfVisible() {
    guard inlineRestoreRequested, let completion = restoreCompletion,
          inlineVisible, inlineFrameReady, window != nil, !bounds.isEmpty,
          !display.bounds.isEmpty, !presentationDisplay.bounds.isEmpty,
          window?.windowScene?.activationState == .foregroundActive else { return }
    let visibility = sourceVisibility()
    guard visibility.visible, visibility.opacity >= 0.99 else { return }
    inlineRestoreRequested = false
    restoreCompletion = nil
    reportPresentationState("restoreCompletion")
    completion(true)
  }
  private func reportPresentationState(_ event: String, error: NSError? = nil) {
    let (visible, opacity) = sourceVisibility()
    let audio = AVAudioSession.sharedInstance()
    var fields: [String: Any] = [
      "event": event, "nativeState": UIApplication.shared.applicationState.rawValue,
      "sceneState": window?.windowScene?.activationState.rawValue ?? -2,
      "armed": automaticPresentation, "authorized": presentationAuthorized,
      "possible": pip?.isPictureInPicturePossible == true,
      "suspended": pip?.isPictureInPictureSuspended == true,
      "active": pip?.isPictureInPictureActive == true, "starting": wantsPresentation,
      "inlineVisible": inlineVisible, "sourceHidden": isHidden,
      "inWindow": window != nil, "ancestorsVisible": visible, "opacity": opacity,
      "width": bounds.width, "height": bounds.height,
      "layerWidth": display.bounds.width, "layerHeight": display.bounds.height,
      "sourceX": videoSurface.frame.minX, "sourceY": videoSurface.frame.minY,
      "sourceWidth": videoSurface.bounds.width, "sourceHeight": videoSurface.bounds.height,
      "surfaceHidden": videoSurface.isHidden, "surfaceOpacity": videoSurface.alpha,
      "inlineFrameReady": inlineFrameReady, "renderedFrames": renderedFrames,
      "hasFrame": latestFrame != nil, "playbackReady": playbackReady, "restoring": restoringInterface,
      "audioCategory": audio.category.rawValue, "audioMode": audio.mode.rawValue,
      "rtcAudioActive": RTCAudioSession.sharedInstance().isActive,
      "rtcAudioActivations": RTCAudioSession.sharedInstance().activationCount,
    ]
    if let error { fields["domain"] = error.domain; fields["code"] = error.code }
    receiver?.post("presentationDiagnostic", fields)
  }
  private func reportPresentationFailure(_ reason: String, error: NSError? = nil) {
    var fields: [String: Any] = [
      "reason": reason, "nativeState": UIApplication.shared.applicationState.rawValue,
      "sceneState": window?.windowScene?.activationState.rawValue ?? -2,
      "possible": pip?.isPictureInPicturePossible == true,
      "active": pip?.isPictureInPictureActive == true, "hasFrame": latestFrame != nil,
      "armed": automaticPresentation, "authorized": presentationAuthorized,
    ]
    fields["rtcAudioActive"] = RTCAudioSession.sharedInstance().isActive
    fields["rtcAudioActivations"] = RTCAudioSession.sharedInstance().activationCount
    if let error {
      fields["domain"] = error.domain; fields["code"] = error.code
      fields["description"] = String(error.localizedDescription.prefix(400))
      if let reason = error.localizedFailureReason { fields["failureReason"] = String(reason.prefix(400)) }
      if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
        fields["underlyingDomain"] = underlying.domain
        fields["underlyingCode"] = underlying.code
        fields["underlyingDescription"] = String(underlying.localizedDescription.prefix(400))
      }
    }
    receiver?.post("presentationFailed", fields)
    presentationAuthorized = false
  }
  func pictureInPictureController(_ controller: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
    let previous = restoreCompletion
    restoreCompletion = nil
    inlineRestoreRequested = false
    previous?(false)
    restoreCompletion = completionHandler
    inlineRestoreRequested = false
    restoringInterface = true
    restoreGeneration += 1
    let generation = restoreGeneration
    receiver?.post("presentationRestore", ["inlineVisible": inlineVisible, "sourceHidden": isHidden])
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self, self.restoreGeneration == generation else { return }
      let completion = self.restoreCompletion
      self.restoreCompletion = nil
      self.inlineRestoreRequested = false
      if completion != nil { self.reportPresentationState("restoreTimeout") }
      completion?(false)
    }
  }
  func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {
    reportPresentationState(playing ? "setPlayingTrue" : "setPlayingFalse")
    if !playing { wantsPresentation = false; presenting = false; controller.stopPictureInPicture() }
  }
  func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
    playbackReady ? CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity) : .invalid
  }
  func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool { !playbackReady }
  func pictureInPictureController(_ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}
  func pictureInPictureController(_ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion: @escaping () -> Void) { completion() }
}
