import ExpoModulesCore
import UIKit

/// Weak discovery only. React owns the hosts and the five-entry eviction policy.
private enum ResidentHistories {
  static let hosts = NSMapTable<NSString, CindyResidentHistoryHost>(keyOptions: .strongMemory, valueOptions: .weakMemory)
  static let slots = NSHashTable<CindyResidentHistorySlot>.weakObjects()

  static func attach(_ key: String) {
    guard !key.isEmpty, let host = hosts.object(forKey: key as NSString),
      let slot = slots.allObjects.last(where: { $0.surfaceId == key && $0.selected && $0.window != nil }) else { return }
    if host.content.superview !== slot {
      host.content.removeFromSuperview()
      slot.addSubview(host.content)
    }
    host.content.frame = slot.bounds
  }
}

/// Fabric continues to own this host at the app root. Only its plain UIKit
/// content container moves, so Fabric's parent/child mounting contract stays intact.
final class CindyResidentHistoryHost: ExpoView {
  let content = UIView()
  var surfaceId = "" {
    didSet {
      if ResidentHistories.hosts.object(forKey: oldValue as NSString) === self {
        ResidentHistories.hosts.removeObject(forKey: oldValue as NSString)
      }
      ResidentHistories.hosts.setObject(self, forKey: surfaceId as NSString)
      ResidentHistories.attach(surfaceId)
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
    if let slot = content.superview { content.frame = slot.bounds }
  }
  deinit {
    content.removeFromSuperview()
    if ResidentHistories.hosts.object(forKey: surfaceId as NSString) === self {
      ResidentHistories.hosts.removeObject(forKey: surfaceId as NSString)
    }
  }
}

/// Lives inside the actual native navigation screen, preserving system back
/// gestures, transitions, native glass underlap and route-owned overlays.
final class CindyResidentHistorySlot: ExpoView {
  var surfaceId = "" { didSet { reconnect() } }
  var selected = false { didSet { reconnect() } }
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    ResidentHistories.slots.add(self)
  }
  private func reconnect() {
    for child in subviews where child !== ResidentHistories.hosts.object(forKey: surfaceId as NSString)?.content {
      child.removeFromSuperview()
    }
    ResidentHistories.attach(surfaceId)
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      for child in subviews { child.removeFromSuperview() }
    } else { reconnect() }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    for child in subviews { child.frame = bounds }
  }
}
