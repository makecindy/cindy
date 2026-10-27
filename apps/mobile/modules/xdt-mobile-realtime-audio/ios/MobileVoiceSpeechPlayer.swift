import AVFoundation
import ExpoModulesCore
import UIKit

/** One foreground reply. Every mutation, including delegate callbacks, uses main. */
final class MobileVoiceSpeechPlayer: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private let prepareAudio: () throws -> Void
  private let releaseAudio: () -> Void
  private var utterance: AVSpeechUtterance?
  private var requestId: String?
  private var promise: Promise?
  private var watchdog: DispatchWorkItem?
  private var observers: [NSObjectProtocol] = []

  init(prepareAudio: @escaping () throws -> Void, releaseAudio: @escaping () -> Void) {
    self.prepareAudio = prepareAudio
    self.releaseAudio = releaseAudio
    super.init()
    synthesizer.delegate = self
    synthesizer.usesApplicationAudioSession = true
  }

  func speak(options: [String: Any], promise: Promise) {
    stop()
    guard let id = options["requestId"] as? String, !id.isEmpty,
          let text = options["text"] as? String, !text.isEmpty, text.utf16.count <= 4000 else {
      promise.reject("ERR_VOICE_SPEECH_INPUT", "Speech requires a request ID and 1–4000 characters.")
      return
    }
    guard UIApplication.shared.applicationState == .active else {
      promise.resolve("cancelled")
      return
    }
    do {
      try prepareAudio()
    } catch {
      releaseAudio()
      promise.reject("ERR_VOICE_SPEECH_AUDIO", "The audio session could not start spoken replies.")
      return
    }
    let utterance = AVSpeechUtterance(string: text)
    if let language = options["language"] as? String {
      utterance.voice = AVSpeechSynthesisVoice(language: language)
    }
    self.utterance = utterance
    self.requestId = id
    self.promise = promise
    observeInterruptions()
    // AVSpeechSynthesizer has no error delegate. Bound missing-voice/startup
    // failures instead of leaving the conversation waiting forever.
    armWatchdog(seconds: 15)
    synthesizer.speak(utterance)
  }

  func stop(requestId: String? = nil) {
    if let requestId, requestId != self.requestId { return }
    finish(result: "cancelled")
  }

  private func finish(result: String? = nil, error: String? = nil) {
    guard let pending = promise else { return }
    promise = nil
    requestId = nil
    utterance = nil
    watchdog?.cancel()
    watchdog = nil
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
    // Clear ownership before stopSpeaking: its didCancel callback may be synchronous.
    synthesizer.stopSpeaking(at: .immediate)
    releaseAudio()
    if let error {
      pending.reject("ERR_VOICE_SPEECH_FAILED", error)
    } else {
      pending.resolve(result ?? "done")
    }
  }

  private func armWatchdog(seconds: TimeInterval) {
    watchdog?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.finish(error: "Spoken reply did not finish. Check the installed system voices.")
    }
    watchdog = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  private func observeInterruptions() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
      object: nil, queue: .main) { [weak self] notification in
        if let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
           type == AVAudioSession.InterruptionType.began.rawValue {
          self?.stop()
        }
      })
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
      object: nil, queue: .main) { [weak self] notification in
        if let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
           reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
          self?.stop()
        }
      })
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard self?.utterance === utterance else { return }
      self?.armWatchdog(seconds: 600)
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard self?.utterance === utterance else { return }
      self?.finish(result: "done")
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard self?.utterance === utterance else { return }
      self?.finish(result: "cancelled")
    }
  }
}
