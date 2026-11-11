import ExpoModulesCore
import UIKit

/// Weak discovery only. React owns the hosts and the five-entry eviction policy.
private enum ResidentHistories {
  static let hosts = NSMapTable<NSString, CindyResidentHistoryHost>(keyOptions: .strongMemory, valueOptions: .weakMemory)
  static let slots = NSHashTable<CindyResidentHistorySlot>.weakObjects()
  static var selectionOrder: UInt64 = 0

  static func selectedSlot(_ key: String) -> CindyResidentHistorySlot? {
    slots.allObjects.filter { $0.surfaceId == key && $0.selected && $0.window != nil }
      .max(by: { $0.selectionOrder < $1.selectionOrder })
  }

  static func attach(_ key: String) {
    guard !key.isEmpty, let host = hosts.object(forKey: key as NSString) else { return }
    if let drawer = host as? CindyTaskDrawerHost {
      drawer.scheduleDock()
      return
    }
    guard let slot = selectedSlot(key) else { return }
    if host.content.superview !== slot {
      host.content.removeFromSuperview()
      slot.addSubview(host.content)
    }
    host.content.frame = slot.bounds
  }
}

/// Fabric continues to own this host at the app root. Only its plain UIKit
/// content container moves, so Fabric's parent/child mounting contract stays intact.
class CindyResidentHistoryHost: ExpoView {
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

/// A drawer crosses native view-controller boundaries (screen <-> Modal).
/// Give its SwiftUI controls one stable parent; moving only their UIViews leaves
/// UIHostingControllers attached to the old Modal and UIKit rejects the move.
final class CindyTaskDrawerHost: CindyResidentHistoryHost {
  private lazy var contentController: UIViewController = {
    let controller = UIViewController()
    controller.view = content
    return controller
  }()
  private var dockScheduled = false

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    _ = contentController
    super.mountChildComponentView(childComponentView, index: index)
  }

  func scheduleDock() {
    guard !dockScheduled else { return }
    dockScheduled = true
    // Geometry can arrive while UIKit enumerates child controllers. Coalesce
    // on the main queue, then resolve the current slot, never a stale capture.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.dockScheduled = false
      self.dock()
    }
  }

  private func dock() {
    let slot = ResidentHistories.selectedSlot(surfaceId)
    // Keep the previous visible window until its successor has real geometry.
    // The JS handoff leaves that window transparent and alive until onDock.
    if slot == nil && content.window != nil { return }
    if let slot, slot.bounds.isEmpty { return }
    var responder: UIResponder? = slot
    while responder != nil && !(responder is UIViewController) { responder = responder?.next }
    let parent = responder as? UIViewController
    let controller = contentController
    let changedSlot = content.superview !== slot
    if controller.parent !== parent || content.superview !== slot {
      let wasVisible = content.window != nil
      if wasVisible { controller.beginAppearanceTransition(false, animated: false) }
      controller.willMove(toParent: nil)
      content.removeFromSuperview()
      controller.removeFromParent()
      if wasVisible { controller.endAppearanceTransition() }
      if let slot, let parent {
        parent.addChild(controller)
        controller.beginAppearanceTransition(true, animated: false)
        slot.addSubview(content)
        controller.didMove(toParent: parent)
        controller.endAppearanceTransition()
      }
    }
    if let slot {
      content.frame = slot.bounds
      if changedSlot && content.superview === slot { slot.onDock([:]) }
    }
  }

  deinit {
    let controller = contentController
    DispatchQueue.main.async {
      controller.willMove(toParent: nil)
      controller.view.removeFromSuperview()
      controller.removeFromParent()
    }
  }
}

/// Lives inside the actual native navigation screen, preserving system back
/// gestures, transitions, native glass underlap and route-owned overlays.
final class CindyResidentHistorySlot: ExpoView {
  let onDock = EventDispatcher()
  var surfaceId = "" { didSet { reconnect() } }
  private(set) var selectionOrder: UInt64 = 0
  var selected = false {
    didSet {
      if selected {
        ResidentHistories.selectionOrder &+= 1
        selectionOrder = ResidentHistories.selectionOrder
      }
      reconnect()
    }
  }
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
    if let drawer = ResidentHistories.hosts.object(forKey: surfaceId as NSString) as? CindyTaskDrawerHost {
      drawer.scheduleDock()
      return
    }
    if window == nil {
      for child in subviews { child.removeFromSuperview() }
    } else { reconnect() }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    for child in subviews { child.frame = bounds }
    // A newly mounted slot may have entered its window before its first layout.
    if let drawer = ResidentHistories.hosts.object(forKey: surfaceId as NSString) as? CindyTaskDrawerHost {
      drawer.scheduleDock()
    }
  }
}
