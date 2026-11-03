import ExpoModulesCore
import UIKit

// Like ResidentHistoryHost, Fabric owns the React children at a persistent
// host. Only this plain native container moves into the route's inline slot.
private enum HtmlAppSurfaces {
  static let hosts = NSMapTable<NSString, HtmlAppHost>(keyOptions: .strongMemory, valueOptions: .weakMemory)
  static let slots = NSHashTable<HtmlAppSlot>.weakObjects()

  static func attach(_ key: String) {
    guard !key.isEmpty, let host = hosts.object(forKey: key as NSString) else { return }
    let target: UIView = slots.allObjects.last(where: { $0.surfaceId == key && $0.window != nil }) ?? host
    if host.content.superview !== target {
      host.content.removeFromSuperview()
      target.addSubview(host.content)
    }
    host.content.frame = target.bounds
  }
}

final class HtmlAppHost: ExpoView {
  let content = UIView()
  var surfaceId = "" {
    didSet {
      if HtmlAppSurfaces.hosts.object(forKey: oldValue as NSString) === self {
        HtmlAppSurfaces.hosts.removeObject(forKey: oldValue as NSString)
      }
      HtmlAppSurfaces.hosts.setObject(self, forKey: surfaceId as NSString)
      HtmlAppSurfaces.attach(surfaceId)
    }
  }
  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    content.insertSubview(childComponentView, at: index)
  }
  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    if let target = content.superview { content.frame = target.bounds }
  }
  deinit {
    content.removeFromSuperview()
    if HtmlAppSurfaces.hosts.object(forKey: surfaceId as NSString) === self {
      HtmlAppSurfaces.hosts.removeObject(forKey: surfaceId as NSString)
    }
  }
}

final class HtmlAppSlot: ExpoView {
  var surfaceId = "" { didSet { HtmlAppSurfaces.attach(oldValue); HtmlAppSurfaces.attach(surfaceId) } }
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    HtmlAppSurfaces.slots.add(self)
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    // A removed card parks the very same WebView at its offscreen root host.
    // React does not destroy it until the owner's bounded teardown completes.
    HtmlAppSurfaces.attach(surfaceId)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    for child in subviews { child.frame = bounds }
  }
}
