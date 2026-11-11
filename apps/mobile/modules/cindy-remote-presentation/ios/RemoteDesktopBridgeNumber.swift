import Foundation
import CoreFoundation

enum RemoteDesktopBridgeNumber {
  /// Expo's untyped JS dictionaries contain Double, not Swift Int. Keep the
  /// wire contract strict: no truncation, booleans or unsafe JS integers.
  static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, abs(value) <= 9_007_199_254_740_991 else { return nil }
    return Int(exactly: value)
  }
}
