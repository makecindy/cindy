import ExpoModulesCore
import UIKit

/// Background run time for work the person started from a notification button.
/// iOS suspends the app moments after the button is handled; a background task
/// keeps it running for the seconds it takes to reach the computer. The system
/// decides how long that is and may end it early.
public final class CindyBackgroundWorkModule: Module {
  // Touched on the main queue only, like the UIApplication calls below.
  private var tasks: [Int: UIBackgroundTaskIdentifier] = [:]
  private var lastId = 0

  public func definition() -> ModuleDefinition {
    Name("CindyBackgroundWork")

    AsyncFunction("begin") { () -> [String: Int] in
      self.lastId += 1
      let id = self.lastId
      var task = UIBackgroundTaskIdentifier.invalid
      task = UIApplication.shared.beginBackgroundTask(withName: "cindy.notification-action") { [weak self] in
        // Out of time: give the task back or the system terminates the app.
        // Ending it does not depend on this module still being alive, so a
        // task that outlives the module is returned here at the latest.
        self?.tasks.removeValue(forKey: id)
        UIApplication.shared.endBackgroundTask(task)
      }
      guard task != .invalid else { return ["id": 0, "remainingMs": 0] }
      self.tasks[id] = task
      // Unbounded while the app is in the foreground; report that as -1.
      let remaining = UIApplication.shared.backgroundTimeRemaining
      return ["id": id, "remainingMs": remaining > 3_600 ? -1 : Int(max(0, remaining) * 1_000)]
    }.runOnQueue(.main)

    AsyncFunction("end") { (id: Int) in
      self.end(id)
    }.runOnQueue(.main)
  }

  private func end(_ id: Int) {
    guard let task = tasks.removeValue(forKey: id) else { return }
    UIApplication.shared.endBackgroundTask(task)
  }
}
