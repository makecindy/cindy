import ExpoModulesCore
import UIKit

/// Home screen icon choice. iOS keeps the selection itself, so nothing is
/// stored here; the icon sets come from plugins/with-app-icons.js.
public final class CindyAppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyAppIcon")

    AsyncFunction("getState") { () -> AppIconState in
      var state = AppIconState()
      state.supported = UIApplication.shared.supportsAlternateIcons
      state.current = UIApplication.shared.alternateIconName
      // What this build was compiled with: newer JavaScript delivered over
      // the air may know icons that this binary does not contain.
      state.available = Self.compiledAlternateIcons()
      // From iOS 18 the home screen shows the dark artwork when its icon
      // style is Dark, or Automatic in dark mode; the default style is light.
      if #available(iOS 18.0, *) { state.darkArtwork = true }
      return state
    }.runOnQueue(.main)

    AsyncFunction("setIcon") { (name: String?, promise: Promise) in
      let application = UIApplication.shared
      guard application.supportsAlternateIcons else {
        promise.reject("ERR_APP_ICON_UNSUPPORTED", "This device cannot change the app icon")
        return
      }
      if let name, !Self.compiledAlternateIcons().contains(name) {
        promise.reject("ERR_APP_ICON_UNKNOWN", "This build does not include that icon")
        return
      }
      guard application.alternateIconName != name else {
        promise.resolve(nil)
        return
      }
      application.setAlternateIconName(name) { error in
        if let error {
          promise.reject("ERR_APP_ICON_FAILED", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)
  }

  private static func compiledAlternateIcons() -> [String] {
    var names = Set<String>()
    for key in ["CFBundleIcons", "CFBundleIcons~ipad"] {
      guard let icons = Bundle.main.object(forInfoDictionaryKey: key) as? [String: Any],
            let alternates = icons["CFBundleAlternateIcons"] as? [String: Any] else { continue }
      names.formUnion(alternates.keys)
    }
    return names.sorted()
  }
}

struct AppIconState: Record {
  @Field var supported = false
  @Field var current: String?
  @Field var available: [String] = []
  @Field var darkArtwork = false
}
