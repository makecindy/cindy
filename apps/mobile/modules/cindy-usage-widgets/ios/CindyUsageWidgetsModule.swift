import ExpoModulesCore
import WidgetKit

/// Writes the widget store into the App Group the widget extension reads, then asks
/// WidgetKit to redraw. The app group is the one expo-sharing already provisions.
public final class CindyUsageWidgetsModule: Module {
  static let fileName = "usage-widget-snapshot.json"
  /// Written by the widgets: computer id -> when a widget set to it last drew (seconds).
  static let pinsKey = "usageWidgetPins"
  static let pinMaxAge: TimeInterval = 2 * 24 * 3600

  private var group: String? {
    Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String
  }

  private func fileURL() throws -> URL {
    guard let group, let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw POSIXError(.ENOENT) }
    return container.appendingPathComponent(Self.fileName)
  }

  public func definition() -> ModuleDefinition {
    Name("CindyUsageWidgets")

    /// iOS granted background time to refresh the widgets (`UsageWidgetBackgroundRefresh`).
    /// Answer with `finishBackgroundRefresh`.
    Events("onBackgroundRefresh")

    // The background task lives on the main queue (`UsageWidgetBackgroundRefresh`).
    OnStartObserving("onBackgroundRefresh") {
      DispatchQueue.main.async { [weak self] in
        let refresh = UsageWidgetBackgroundRefresh.shared
        refresh.onRequest = { [weak self] in self?.sendEvent("onBackgroundRefresh") }
        // A run that arrived while the app was still starting.
        if refresh.pending { self?.sendEvent("onBackgroundRefresh") }
      }
    }

    OnStopObserving("onBackgroundRefresh") {
      DispatchQueue.main.async { UsageWidgetBackgroundRefresh.shared.onRequest = nil }
    }

    AsyncFunction("finishBackgroundRefresh") { (success: Bool) in
      UsageWidgetBackgroundRefresh.shared.finish(success: success)
    }.runOnQueue(.main)

    /// Returns false when the App Group is unavailable (for example a build signed without it).
    Function("writeSnapshot") { (json: String) -> Bool in
      guard let url = try? self.fileURL() else { return false }
      do {
        try Data(json.utf8).write(to: url, options: .atomic)
      } catch {
        return false
      }
      WidgetCenter.shared.reloadAllTimelines()
      return true
    }

    Function("readSnapshot") { () -> String? in
      guard let url = try? self.fileURL(), let data = try? Data(contentsOf: url) else { return nil }
      return String(data: data, encoding: .utf8)
    }

    /// Computers some widget is set to, so the app asks them as well as the automatic one.
    Function("readPinnedDeviceIds") { () -> [String] in
      guard let group = self.group, let defaults = UserDefaults(suiteName: group),
            let pins = defaults.dictionary(forKey: Self.pinsKey) as? [String: Double]
      else { return [] }
      let now = Date().timeIntervalSince1970
      return pins.filter { now - $0.value < Self.pinMaxAge }.map(\.key).sorted()
    }

    Function("clearSnapshot") { () -> Void in
      guard let url = try? self.fileURL() else { return }
      try? FileManager.default.removeItem(at: url)
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
