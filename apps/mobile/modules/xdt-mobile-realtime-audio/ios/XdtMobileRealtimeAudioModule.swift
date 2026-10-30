import AVFoundation
import ExpoModulesCore

private let onAudioChunk = "onAudioChunk"
private let onAudioError = "onAudioError"

public class XdtMobileRealtimeAudioModule: Module {
  private let capture = XdtAudioCapture()
  private var drainTimer: DispatchSourceTimer?
  private var recentChunks: [[String: Any]] = []
  private var captureId = ""
  private var sessionActivatedAt = 0.0
  private var engineStartedAt = 0.0
  private var isCapturing = false
  private var ownsAudioSession = false
  private var targetSampleRate = 16_000.0
  private var interruptionObserver: NSObjectProtocol?
  private var routeChangeObserver: NSObjectProtocol?
  // Deferred AVAudioSession deactivation (keep-alive). Activating the session in
  // .measurement record mode costs ~100-150ms of mic warm-up; consecutive
  // dictations are common, so after a stop we keep the session active for a short
  // window instead of deactivating immediately. The next start()/prewarm() then
  // skips most of the warm-up. The window is short on purpose: while the session
  // stays active with .duckOthers, other apps' audio remains ducked.
  private var deactivateWorkItem: DispatchWorkItem?
  private let sessionKeepAliveSeconds: TimeInterval = 10
  // Serializes every session-state mutation (start / stop / prewarm bodies AND
  // the deferred deactivate work item). Expo AsyncFunction bodies run on the
  // module's background queue while the keep-alive timer would otherwise fire
  // on another queue; DispatchWorkItem.cancel() cannot abort a block that has
  // already started, so an unserialized timer firing exactly at the keep-alive
  // boundary could observe a stale isCapturing == false and deactivate the
  // session right after a concurrent start re-activated it — silently killing
  // the new capture. With every mutation on this one queue that interleaving
  // cannot happen.
  private let sessionStateQueue = DispatchQueue(label: "com.xdtmaker.realtime-audio.session-state")

  public func definition() -> ModuleDefinition {
    Name("XdtMobileRealtimeAudio")

    Events(onAudioChunk, onAudioError)

    AsyncFunction("start") { (options: [String: Any]?) in
      return try self.sessionStateQueue.sync { () -> [String: Any] in
        try self.startCaptureLocked(options: options)
        let session = AVAudioSession.sharedInstance()
        // Port types only: names and UIDs can contain personal information.
        return [
          "inputPortTypes": session.currentRoute.inputs.map { $0.portType.rawValue },
          "inputSampleRate": session.sampleRate,
          "inputChannels": session.inputNumberOfChannels,
          "ioBufferDurationMs": session.ioBufferDuration * 1000,
          "sessionActivatedAt": self.sessionActivatedAt,
          "engineStartedAt": self.engineStartedAt
        ]
      }
    }

    AsyncFunction("stop") {
      self.stopCapture()
    }

    // Additive: old installed binaries still use stop(). Only audio not already
    // delivered to JS is returned; trim to the user's stop time, not bridge arrival.
    AsyncFunction("stopAndDrain") { (afterIndex: Int, stoppedAt: Double) in
      return try self.sessionStateQueue.sync { () -> [[String: Any]] in
        self.stopCaptureLocked(deactivateImmediately: false)
        defer { self.recentChunks.removeAll() }
        guard stoppedAt.isFinite else {
          throw Exception(name: "ERR_AUDIO_STOP_TIME", description: "Invalid microphone stop time.")
        }
        if self.capture.overflowed || (self.recentChunks.first?["chunkIndex"] as? Int ?? 0) > afterIndex + 1 {
          throw Exception(name: "ERR_AUDIO_OVERFLOW", description: "Realtime microphone delivery fell behind.")
        }
        return self.recentChunks.compactMap { chunk in
          guard let index = chunk["chunkIndex"] as? Int, index > afterIndex,
                let capturedAt = chunk["capturedAt"] as? Double,
                let sampleRate = chunk["sampleRate"] as? Double,
                let base64 = chunk["base64Pcm16"] as? String,
                var pcm = Data(base64Encoded: base64) else { return nil }
          let retainedFrames = min(Double(pcm.count / 2), max(0, ((stoppedAt - capturedAt) * sampleRate / 1000).rounded(.down)))
          let frames = Int(retainedFrames)
          guard frames > 0 else { return nil }
          pcm = pcm.prefix(frames * 2)
          var result = chunk
          result["base64Pcm16"] = pcm.base64EncodedString()
          result["durationMs"] = Double(frames) / sampleRate * 1000
          return result
        }
      }
    }

    // Best-effort audio-session warm-up, called on touch-down of the mic button
    // (before the tap that actually starts recording). Configuring + activating
    // the session here means the ~100-150ms warm-up happens while the finger is
    // still down, so capture is live almost immediately on start(). Never throws:
    // a real failure will surface from start() itself.
    AsyncFunction("prewarm") {
      self.prewarmAudioSession()
    }

    // Voice input is foreground-only. Stop both live capture and a speculative
    // prewarm immediately when the app reaches the background; relying on iOS
    // suspension alone leaves the AVAudioSession active during lifecycle races.
    OnAppEntersBackground {
      self.stopCapture(deactivateImmediately: true)
    }

    OnDestroy {
      self.stopCapture(deactivateImmediately: true)
    }
  }

  private func prewarmAudioSession() {
    sessionStateQueue.sync {
      self.prewarmAudioSessionLocked()
    }
  }

  // Must run on sessionStateQueue.
  private func prewarmAudioSessionLocked() {
    cancelScheduledDeactivateLocked()
    if isCapturing {
      return
    }
    // A prewarm is speculative: the press may never turn into a recording
    // (drag-out, cancelled tap, permission denied/pending). Schedule the same
    // keep-alive deactivation as stopCapture() on EVERY exit below — the
    // cancel above may have removed the only pending cleanup from a previous
    // window, so returning without rescheduling (including the
    // permission-denied early return) would leave an activated session ducking
    // other audio indefinitely; a subsequent start() cancels the timer.
    defer { scheduleDeactivateLocked() }
    let session = AVAudioSession.sharedInstance()
    if session.recordPermission == .denied {
      return
    }
    do {
      try activateAudioSessionLocked(session)
      installAudioSessionObservers()
      // Deliberately do NOT touch the engine here: engine.prepare() with no
      // attached nodes raises an uncatchable NSException (AVAudioEngineGraph
      // Initialize: inputNode != nullptr || outputNode != nullptr). Session
      // activation is the dominant warm-up cost; the engine spins up in start().
    } catch {
      // Best-effort only; start() reports configuration failures.
    }
  }

  // Must run on sessionStateQueue. The work item also executes on
  // sessionStateQueue, so it can never interleave with a concurrent
  // start/stop/prewarm (see sessionStateQueue).
  private func scheduleDeactivateLocked() {
    cancelScheduledDeactivateLocked()
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else {
        return
      }
      self.deactivateWorkItem = nil
      if self.isCapturing {
        return
      }
      self.deactivateOwnedSessionLocked()
      self.removeAudioSessionObservers()
    }
    deactivateWorkItem = workItem
    sessionStateQueue.asyncAfter(deadline: .now() + sessionKeepAliveSeconds, execute: workItem)
  }

  private func cancelScheduledDeactivateLocked() {
    deactivateWorkItem?.cancel()
    deactivateWorkItem = nil
  }

  // AVAudioSession is shared with remote desktop PiP and other playback. A
  // background notification is not ownership: never release a session we did
  // not activate, or one whose configuration has since been taken over.
  private func deactivateOwnedSessionLocked() {
    guard ownsAudioSession else { return }
    ownsAudioSession = false
    let session = AVAudioSession.sharedInstance()
    // iOS may add mixWithOthers implicitly when duckOthers is requested.
    guard session.category == .playAndRecord, session.mode == .measurement,
          session.categoryOptions.subtracting(.mixWithOthers) == [.duckOthers, .defaultToSpeaker] else { return }
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
  }

  // Must run on sessionStateQueue.
  private func startCaptureLocked(options: [String: Any]?) throws {
    cancelScheduledDeactivateLocked()
    if isCapturing {
      return
    }

    if let sampleRate = numericOption(options, key: "sampleRate"), sampleRate > 0 {
      targetSampleRate = sampleRate
    }
    captureId = options?["captureId"] as? String ?? ""
    recentChunks.removeAll()

    let session = AVAudioSession.sharedInstance()
    if session.recordPermission == .denied {
      // A pressIn prewarm may already have activated the session; keep the
      // deactivation scheduled on every failed start so an aborted start never
      // leaves the session active (and other apps ducked) indefinitely.
      scheduleDeactivateLocked()
      throw Exception(name: "ERR_MIC_PERMISSION_DENIED", description: "Microphone permission is required for realtime voice input.")
    }

    do {
      try activateAudioSessionLocked(session)
    } catch {
      scheduleDeactivateLocked()
      throw Exception(name: "ERR_AUDIO_SESSION", description: "Failed to configure audio session: \(error.localizedDescription)")
    }

    installAudioSessionObservers()

    do {
      _ = try capture.start(withSampleRate: targetSampleRate)
      engineStartedAt = Date().timeIntervalSince1970 * 1000
      isCapturing = true
      let timer = DispatchSource.makeTimerSource(queue: sessionStateQueue)
      timer.schedule(deadline: .now(), repeating: .milliseconds(5), leeway: .milliseconds(1))
      timer.setEventHandler { [weak self] in
        guard let self else { return }
        self.collectChunksLocked(emit: true)
        if self.capture.overflowed {
          self.emitError("Realtime microphone delivery fell behind.")
          self.stopCaptureLocked(deactivateImmediately: true)
        }
      }
      drainTimer = timer
      timer.resume()
    } catch {
      removeAudioSessionObservers()
      capture.stop()
      scheduleDeactivateLocked()
      throw Exception(name: "ERR_AUDIO_ENGINE_START", description: "Failed to start realtime audio engine: \(error.localizedDescription)")
    }
  }

  private func activateAudioSessionLocked(_ session: AVAudioSession) throws {
    // Reuse only our live, unchanged session. Interruptions and route loss clear
    // ownership; another playback feature's configuration never counts as warm.
    let matches = session.category == .playAndRecord && session.mode == .measurement
      && session.categoryOptions.subtracting(.mixWithOthers) == [.duckOthers, .defaultToSpeaker]
    if !ownsAudioSession || !matches {
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
      // A preference, not a promise: report the actual period after activation.
      try? session.setPreferredIOBufferDuration(0.010)
      try session.setActive(true)
      ownsAudioSession = true
    }
    sessionActivatedAt = Date().timeIntervalSince1970 * 1000
  }

  private func collectChunksLocked(emit: Bool) {
    for raw in capture.drain() {
      var chunk = raw as! [String: Any]
      chunk["captureId"] = captureId
      recentChunks.append(chunk)
      if recentChunks.count > 128 { recentChunks.removeFirst() }
      if emit {
        let payload = chunk
        DispatchQueue.main.async { [weak self] in self?.sendEvent(onAudioChunk, payload) }
      }
    }
  }

  private func stopCapture(deactivateImmediately: Bool = false) {
    sessionStateQueue.sync {
      self.stopCaptureLocked(deactivateImmediately: deactivateImmediately)
    }
  }

  // Must run on sessionStateQueue.
  private func stopCaptureLocked(deactivateImmediately: Bool) {
    if deactivateImmediately { removeAudioSessionObservers() }
    drainTimer?.cancel()
    drainTimer = nil
    capture.stop()
    collectChunksLocked(emit: false)
    isCapturing = false
    if deactivateImmediately {
      // System interruptions and teardown must release the session right away —
      // holding a keep-alive claim on a session the system just reclaimed (or
      // while the module is being destroyed) serves nobody.
      cancelScheduledDeactivateLocked()
      deactivateOwnedSessionLocked()
    } else {
      scheduleDeactivateLocked()
    }
  }

  private func emitError(_ message: String) {
    let id = captureId
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(onAudioError, ["message": message, "captureId": id])
    }
  }

  private func installAudioSessionObservers() {
    removeAudioSessionObservers()
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    interruptionObserver = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: session,
      queue: .main
    ) { [weak self] notification in
      self?.handleAudioSessionInterruption(notification)
    }
    routeChangeObserver = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: session,
      queue: .main
    ) { [weak self] notification in
      self?.handleAudioRouteChange(notification)
    }
  }

  private func removeAudioSessionObservers() {
    let center = NotificationCenter.default
    if let observer = interruptionObserver {
      center.removeObserver(observer)
      interruptionObserver = nil
    }
    if let observer = routeChangeObserver {
      center.removeObserver(observer)
      routeChangeObserver = nil
    }
  }

  private func handleAudioSessionInterruption(_ notification: Notification) {
    let rawType = unsignedIntegerValue(notification.userInfo?[AVAudioSessionInterruptionTypeKey])
    guard rawType == AVAudioSession.InterruptionType.began.rawValue else {
      return
    }
    sessionStateQueue.async { [weak self] in
      guard let self else { return }
      if self.isCapturing { self.emitError("Realtime voice input was interrupted by the system.") }
      self.stopCaptureLocked(deactivateImmediately: true)
    }
  }

  private func handleAudioRouteChange(_ notification: Notification) {
    let rawReason = unsignedIntegerValue(notification.userInfo?[AVAudioSessionRouteChangeReasonKey])
    guard rawReason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else {
      return
    }
    sessionStateQueue.async { [weak self] in
      guard let self else { return }
      if self.isCapturing { self.emitError("Realtime voice input microphone route became unavailable.") }
      self.stopCaptureLocked(deactivateImmediately: true)
    }
  }
}

private func numericOption(_ options: [String: Any]?, key: String) -> Double? {
  if let value = options?[key] as? Double {
    return value
  }
  if let value = options?[key] as? Int {
    return Double(value)
  }
  if let value = options?[key] as? NSNumber {
    return value.doubleValue
  }
  return nil
}

private func unsignedIntegerValue(_ value: Any?) -> UInt? {
  if let value = value as? UInt {
    return value
  }
  if let value = value as? Int {
    return UInt(value)
  }
  if let value = value as? NSNumber {
    return value.uintValue
  }
  return nil
}
