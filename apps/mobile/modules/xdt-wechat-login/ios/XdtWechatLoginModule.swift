import ExpoModulesCore

/** JavaScript-facing WeChat native login module. */
public class XdtWechatLoginModule: Module {
  public func definition() -> ModuleDefinition {
    Name("XdtWechatLogin")
    Events("onWechatLaunch")

    OnStartObserving("onWechatLaunch") {
      DispatchQueue.main.async {
        XdtWechatAuthCoordinator.shared.onLaunch = { [weak self] in
          self?.sendEvent("onWechatLaunch", [:])
        }
      }
    }

    OnStopObserving("onWechatLaunch") {
      DispatchQueue.main.async { XdtWechatAuthCoordinator.shared.onLaunch = nil }
    }

    AsyncFunction("consumeWechatLaunchInfos") { (promise: Promise) in
      DispatchQueue.main.async {
        promise.resolve(XdtWechatAuthCoordinator.shared.consumeLaunchInfos())
      }
    }

    AsyncFunction("isWechatInstalled") { () -> Bool in
      XdtWechatAuthCoordinator.shared.isInstalled()
    }

    AsyncFunction("requestWechatAuthCode") { (options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        XdtWechatAuthCoordinator.shared.request(options: options, promise: promise)
      }
    }

    AsyncFunction("cancelWechatAuthRequest") { () in
      DispatchQueue.main.async {
        XdtWechatAuthCoordinator.shared.cancel()
      }
    }
  }
}
