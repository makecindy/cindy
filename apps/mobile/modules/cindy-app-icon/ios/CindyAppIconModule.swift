import ExpoModulesCore
import UIKit

/// 读取并切换 iOS 备选应用图标。
///
/// 备选图标必须由构建期的 config plugin 写进 `Images.xcassets` 并登记到
/// `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`；运行时只能切换系统已登记的图标。
public final class CindyAppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyAppIcon")

    // UIApplication 的属性只能在主线程访问。
    AsyncFunction("supportsAlternateIcons") { () -> Bool in
      UIApplication.shared.supportsAlternateIcons
    }.runOnQueue(.main)

    AsyncFunction("getAlternateIconName") { () -> String? in
      UIApplication.shared.alternateIconName
    }.runOnQueue(.main)

    AsyncFunction("setAlternateIconName") { (name: String?, promise: Promise) in
      guard UIApplication.shared.supportsAlternateIcons else {
        promise.reject(
          "ERR_ALTERNATE_ICON_UNSUPPORTED",
          "This device does not support alternate app icons."
        )
        return
      }
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error {
          promise.reject("ERR_ALTERNATE_ICON_SET", error.localizedDescription)
        } else {
          promise.resolve()
        }
      }
    }.runOnQueue(.main)
  }
}
