import ActivityKit

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

    // count already includes waiting and unread results. Derive the left-hand
    // number from existing fields so activities encoded by older JS still work.
    var noticeCount: Int { max(0, count - runningCount) }
  }
  var accountId: String
}
