import BackgroundTasks
import ExpoModulesCore
import UIKit
import WidgetKit

/// Lets the widgets get new data while the app is not open. The widgets cannot reach a computer
/// themselves, so the app asks iOS for background refresh time (`BGAppRefreshTask`) whenever it
/// leaves the screen with a widget on the home or lock screen. When iOS grants it, the app (the
/// signed-in tree, `UsageWidgetBridge`) briefly connects, asks the computers and writes the store.
/// iOS decides when and how often that happens, from how the phone is used.
final class UsageWidgetBackgroundRefresh {
  static let shared = UsageWidgetBackgroundRefresh()

  /// Written by `with-usage-widgets.js` with the permitted task identifier.
  static var identifier: String? {
    Bundle.main.object(forInfoDictionaryKey: "CindyUsageWidgetRefreshTaskId") as? String
  }

  /// Earliest next run; iOS usually waits longer.
  private static let interval: TimeInterval = 15 * 60

  // Touched on the main queue only.
  private var task: BGAppRefreshTask?
  /// Set while JS listens (`CindyUsageWidgetsModule`); a run that arrives earlier waits for it.
  var onRequest: (() -> Void)?

  var pending: Bool { task != nil }

  /// Must happen before the app finishes launching.
  func register() {
    guard let identifier = Self.identifier else { return }
    BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
      guard let self, let task = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      self.received(task)
    }
  }

  private func received(_ task: BGAppRefreshTask) {
    self.task?.setTaskCompleted(success: false)
    // Started on a locked phone: the signed-in tree waits for the person (lockedLaunchGate.ts),
    // so nobody would carry it out.
    guard UIApplication.shared.isProtectedDataAvailable else {
      task.setTaskCompleted(success: false)
      schedule()
      return
    }
    self.task = task
    task.expirationHandler = { [weak self] in
      DispatchQueue.main.async { self?.finish(success: false) }
    }
    onRequest?()
  }

  func finish(success: Bool) {
    guard let task else { return }
    self.task = nil
    task.setTaskCompleted(success: success)
    schedule()
  }

  /// Asks for the next run only while some widget is placed; otherwise withdraws it.
  func schedule() {
    guard let identifier = Self.identifier else { return }
    WidgetCenter.shared.getCurrentConfigurations { result in
      guard case .success(let widgets) = result else { return }
      DispatchQueue.main.async {
        guard !widgets.isEmpty else {
          BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
          return
        }
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: Self.interval)
        // Replaces an earlier request with the same identifier.
        try? BGTaskScheduler.shared.submit(request)
      }
    }
  }
}

public class CindyUsageWidgetsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UsageWidgetBackgroundRefresh.shared.register()
    return true
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    UsageWidgetBackgroundRefresh.shared.schedule()
  }
}
