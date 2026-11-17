import CoreHaptics
import ExpoModulesCore
import UIKit

public final class CindyHapticsModule: Module {
  private var lastFeedback: TimeInterval = -.infinity
  private weak var feedbackView: UIView?
  private var selection: UISelectionFeedbackGenerator?
  private var impact: UIImpactFeedbackGenerator?

  public func definition() -> ModuleDefinition {
    Name("CindyHaptics")
    AsyncFunction("play") { (kind: String) -> Bool in
      guard kind == "selection" || kind == "commit",
            CHHapticEngine.capabilitiesForHardware().supportsHaptics,
            UIApplication.shared.applicationState == .active else { return false }
      guard let window = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive })?
        .windows.first(where: { $0.isKeyWindow }) else { return false }
      if self.feedbackView !== window {
        self.releaseFeedback()
        self.feedbackView = window
        // Create on the main queue and associate feedback with the active scene.
        if #available(iOS 17.5, *) {
          self.selection = UISelectionFeedbackGenerator(view: window)
          self.impact = UIImpactFeedbackGenerator(style: .light, view: window)
        } else {
          self.selection = UISelectionFeedbackGenerator()
          self.impact = UIImpactFeedbackGenerator(style: .light)
        }
      }
      let now = ProcessInfo.processInfo.systemUptime
      guard now - self.lastFeedback >= 0.08 else { return false }
      self.lastFeedback = now
      // UIKit keeps system haptic policy in control. Never fall back to AudioServices vibration.
      if kind == "selection" {
        self.selection?.selectionChanged()
        self.selection?.prepare()
      } else {
        self.impact?.impactOccurred()
        self.impact?.prepare()
      }
      return true
    }.runOnQueue(.main)
    OnDestroy { [weak self] in
      // UIKit retains view-attached generators as interactions. Dropping our
      // references alone does not detach them from a surviving window.
      guard let self else { return }
      DispatchQueue.main.async { self.releaseFeedback() }
    }
  }

  private func releaseFeedback() {
    if #available(iOS 17.5, *) {
      if let selection { feedbackView?.removeInteraction(selection) }
      if let impact { feedbackView?.removeInteraction(impact) }
    }
    selection = nil
    impact = nil
    feedbackView = nil
  }
}
