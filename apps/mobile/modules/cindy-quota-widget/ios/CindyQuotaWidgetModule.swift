import ExpoModulesCore
import WidgetKit

public final class CindyQuotaWidgetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyQuotaWidget")
    Function("writeSnapshot") { (json: String) throws in
      try QuotaSnapshotStore.save(json)
      WidgetCenter.shared.reloadAllTimelines()
    }
    Function("clearSnapshot") { () throws in
      try QuotaSnapshotStore.clear()
      WidgetCenter.shared.reloadAllTimelines()
    }
    Function("setPresentation") { (locale: String, appearance: String) in
      guard ["en", "zh-CN", "zh-TW", "ja", "ko"].contains(locale), ["system", "light", "dark"].contains(appearance) else { return }
      guard let defaults = QuotaSnapshotStore.defaults else { return }
      if defaults.string(forKey: "locale") == locale && defaults.string(forKey: "appearance") == appearance { return }
      defaults.set(locale, forKey: "locale")
      defaults.set(appearance, forKey: "appearance")
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
