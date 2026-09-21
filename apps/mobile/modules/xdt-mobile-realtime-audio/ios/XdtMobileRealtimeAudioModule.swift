import AVFoundation
import ExpoModulesCore

private let onAudioChunk = "onAudioChunk"
private let onAudioError = "onAudioError"

public class XdtMobileRealtimeAudioModule: Module {
  private let engine = AVAudioEngine()
  private var isCapturing = false
  private var ownsAudioSession = false
  private var targetSampleRate = 16_000.0
  private var chunkIndex = 0
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
      try self.startCapture(options: options)
    }

    AsyncFunction("stop") {
      self.stopCapture()
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
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
      try session.setActive(true)
      ownsAudioSession = true
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

  private func startCapture(options: [String: Any]?) throws {
    try sessionStateQueue.sync {
      try self.startCaptureLocked(options: options)
    }
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
    let bufferSize = AVAudioFrameCount(integerOption(options, key: "bufferSize") ?? 2048)

    let session = AVAudioSession.sharedInstance()
    if session.recordPermission == .denied {
      // A pressIn prewarm may already have activated the session; keep the
      // deactivation scheduled on every failed start so an aborted start never
      // leaves the session active (and other apps ducked) indefinitely.
      scheduleDeactivateLocked()
      throw Exception(name: "ERR_MIC_PERMISSION_DENIED", description: "Microphone permission is required for realtime voice input.")
    }

    do {
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
      try session.setActive(true)
      ownsAudioSession = true
    } catch {
      scheduleDeactivateLocked()
      throw Exception(name: "ERR_AUDIO_SESSION", description: "Failed to configure audio session: \(error.localizedDescription)")
    }

    installAudioSessionObservers()

    let inputNode = engine.inputNode
    let inputFormat = inputNode.inputFormat(forBus: 0)
    chunkIndex = 0
    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, time in
      self?.handleInputBuffer(buffer, time: time)
    }

    do {
      engine.prepare()
      try engine.start()
      isCapturing = true
    } catch {
      removeAudioSessionObservers()
      inputNode.removeTap(onBus: 0)
      scheduleDeactivateLocked()
      throw Exception(name: "ERR_AUDIO_ENGINE_START", description: "Failed to start realtime audio engine: \(error.localizedDescription)")
    }
  }

  private func stopCapture(deactivateImmediately: Bool = false) {
    sessionStateQueue.sync {
      self.stopCaptureLocked(deactivateImmediately: deactivateImmediately)
    }
  }

  // Must run on sessionStateQueue.
  private func stopCaptureLocked(deactivateImmediately: Bool) {
    removeAudioSessionObservers()
    if engine.isRunning {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
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

  private func handleInputBuffer(_ buffer: AVAudioPCMBuffer, time: AVAudioTime) {
    guard let channelData = buffer.floatChannelData else {
      emitError("Realtime audio input did not provide float PCM samples.")
      return
    }
    let frameCount = Int(buffer.frameLength)
    guard frameCount > 0 else {
      return
    }

    let inputSampleRate = buffer.format.sampleRate
    let channelCount = max(1, Int(buffer.format.channelCount))
    let targetFrameCount = max(1, Int((Double(frameCount) * targetSampleRate / inputSampleRate).rounded(.down)))
    var pcm = Data(capacity: targetFrameCount * 2)
    let scale = inputSampleRate / targetSampleRate

    for targetIndex in 0..<targetFrameCount {
      let sourceIndex = min(frameCount - 1, Int(Double(targetIndex) * scale))
      var mono: Float = 0
      for channelIndex in 0..<channelCount {
        mono += channelData[channelIndex][sourceIndex]
      }
      mono /= Float(channelCount)
      let clamped = max(-1, min(1, mono))
      var sample = Int16(clamped * Float(Int16.max)).littleEndian
      withUnsafeBytes(of: &sample) { bytes in
        pcm.append(contentsOf: bytes)
      }
    }

    let capturedAt = Date().timeIntervalSince1970 * 1000
    let index = chunkIndex
    chunkIndex += 1
    let durationMs = Double(targetFrameCount) / targetSampleRate * 1000
    let payload: [String: Any] = [
      "base64Pcm16": pcm.base64EncodedString(),
      "capturedAt": capturedAt,
      "chunkIndex": index,
      "sampleRate": Int(targetSampleRate),
      "durationMs": durationMs
    ]

    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(onAudioChunk, payload)
    }
  }

  private func emitError(_ message: String) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(onAudioError, ["message": message])
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
    guard isCapturing else {
      return
    }
    let rawType = unsignedIntegerValue(notification.userInfo?[AVAudioSessionInterruptionTypeKey])
    guard rawType == AVAudioSession.InterruptionType.began.rawValue else {
      return
    }
    emitError("Realtime voice input was interrupted by the system.")
    stopCapture(deactivateImmediately: true)
  }

  private func handleAudioRouteChange(_ notification: Notification) {
    guard isCapturing else {
      return
    }
    let rawReason = unsignedIntegerValue(notification.userInfo?[AVAudioSessionRouteChangeReasonKey])
    guard rawReason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else {
      return
    }
    emitError("Realtime voice input microphone route became unavailable.")
    stopCapture(deactivateImmediately: true)
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

private func integerOption(_ options: [String: Any]?, key: String) -> Int? {
  if let value = options?[key] as? Int {
    return value
  }
  if let value = options?[key] as? Double {
    return Int(value)
  }
  if let value = options?[key] as? NSNumber {
    return value.intValue
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
