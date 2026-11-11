import ActivityKit
import Foundation

// Compiled by both the app module and WidgetKit extension; never duplicate this schema.
struct CindyAgentActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var status: String
    var title: String
    var detail: String
    var count: Int
    var runningCount: Int
    var attentionCount: Int
    var url: String
    var staleDetail: String
    // Unix seconds. Optional so existing APNs payloads and installed activities decode.
    var confirmedAt: Double?

    var freshnessInterval: TimeInterval {
      // Long tasks routinely outlive a brief lock-screen visit. Preserve a useful
      // snapshot without claiming it stays live indefinitely. Foreground loss of
      // confirmation still expires immediately; background suspension does not.
      // A waiting headline may coexist with running tasks in this aggregate.
      if runningCount > 0 || status == "running" { return 15 * 60 }
      if attentionCount > 0 || status == "attention" { return 60 * 60 }
      return status == "completed" || status == "error" ? 4 * 60 * 60 : 180
    }

    // count already includes waiting and unread results. Derive the left-hand
    // number from existing fields so activities encoded by older JS still work.
    var noticeCount: Int { max(0, count - runningCount) }
  }
  var accountId: String
}
