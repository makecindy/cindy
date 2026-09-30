// Compile with modules/cindy-remote-presentation/ios/RemoteDesktopBridgeNumber.swift.
import Foundation

@main
enum RemoteDesktopBridgeNumberTest {
  static func main() {
    // Actual Expo getAny representation, unlike JSONSerialization's NSNumber.
    let reply: [String: Any] = ["exchangeId": Double(1), "next": Double(16),
      "candidates": [["sdpMLineIndex": Double(0)]]]
    precondition(reply["exchangeId"] as? Int == nil)
    precondition(RemoteDesktopBridgeNumber.integer(reply["exchangeId"]) == 1)
    precondition(RemoteDesktopBridgeNumber.integer(reply["next"]) == 16)
    let candidates = reply["candidates"] as! [[String: Any]]
    precondition(RemoteDesktopBridgeNumber.integer(candidates[0]["sdpMLineIndex"]) == 0)
    for value: Any in [Int(12), Double(12), NSNumber(value: 12)] {
      precondition(RemoteDesktopBridgeNumber.integer(value) == 12)
    }
    for value: Any in [true, false, NSNumber(value: true), "1", Double.nan,
                       Double.infinity, Double(1.5), Double(9_007_199_254_740_992)] {
      precondition(RemoteDesktopBridgeNumber.integer(value) == nil)
    }
    precondition(RemoteDesktopBridgeNumber.integer(nil) == nil)
    print("Remote desktop bridge numeric regression passed")
  }
}
