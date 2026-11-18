import Foundation
import WidgetKit

// Bridges one JSON command from the N-API shim (addon.mm) to WidgetKit for the Mac desktop
// widgets. WidgetKit takes reload requests from the containing app itself, so this runs in
// the Electron main process. Called on the main thread.

private struct Command: Decodable {
  var action: String
}

/// How many of this app's widgets are on the desktop. WidgetKit answers asynchronously, so
/// `status` reports the last answer (nil before the first) and asks again.
private enum Configurations {
  static let lock = NSLock()
  static var count: Int?
  static var asking = false

  static func refresh() {
    lock.lock()
    if asking {
      lock.unlock()
      return
    }
    asking = true
    lock.unlock()
    WidgetCenter.shared.getCurrentConfigurations { result in
      lock.lock()
      defer { lock.unlock() }
      asking = false
      // A failed query keeps the previous answer rather than reporting none.
      if case .success(let infos) = result { count = infos.count }
    }
  }

  static func current() -> Int? {
    lock.lock()
    defer { lock.unlock() }
    return count
  }
}

private func reply(_ fields: [String: Any]) -> UnsafeMutablePointer<CChar>? {
  let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{}".utf8)
  return strdup(String(decoding: data, as: UTF8.self))
}

@_cdecl("cindy_desktop_widgets_apply")
public func cindyDesktopWidgetsApply(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  guard let command = try? JSONDecoder().decode(Command.self, from: Data(String(cString: input).utf8)) else {
    return reply(["ok": false, "error": "invalid-command"])
  }
  switch command.action {
  case "status":
    // Written into the app's Info.plist by build.mjs together with the extension, so an app
    // without the extension never writes widget data.
    let dataPath = Bundle.main.object(forInfoDictionaryKey: "CindyDesktopWidgetDataPath") as? String
    Configurations.refresh()
    return reply([
      "ok": true,
      "dataPath": dataPath ?? NSNull(),
      "widgets": Configurations.current().map { $0 as Any } ?? NSNull(),
    ])
  case "reload":
    WidgetCenter.shared.reloadAllTimelines()
    return reply(["ok": true])
  default:
    return reply(["ok": false, "error": "unknown-action"])
  }
}
