import ExpoModulesCore
import UIKit

public final class CindyNotificationStateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyNotificationState")
    AsyncFunction("retire") { (recipient: String, ids: [String], promise: Promise) in
      NotificationRetirement.retire(["recipientId": recipient, "dismissIds": ids]) { promise.resolve(nil) }
    }
  }
}
public final class CindyNotificationStateSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    guard userInfo["dismissIds"] != nil else { completionHandler(.noData); return }
    NotificationRetirement.retire(userInfo) { completionHandler(.newData) }
  }
}
