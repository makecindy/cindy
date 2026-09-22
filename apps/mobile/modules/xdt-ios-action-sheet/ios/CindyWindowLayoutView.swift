import ExpoModulesCore
import UIKit

/// Transparent probe sharing the React container's bounds and window.
final class CindyWindowLayoutView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private let geometry = CindyWindowGeometry()
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    geometry.onChange = { [weak self] value in
      guard let payload = value as? [String: Any] else { return }
      self?.onGeometryChange(payload)
    }
    addSubview(geometry)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    geometry.frame = bounds
  }
}
