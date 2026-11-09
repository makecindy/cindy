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
  }
  var accountId: String
}
